import { setTimeout as delay } from "node:timers/promises";
import { expect, expectTypeOf, onTestFinished, test } from "vitest";
import { createBroadcast } from "../src/broadcast.ts";
import { type Database, eventsAfter, openDatabase } from "../src/db.ts";
import { Seq, type StoredEvent } from "../src/events.ts";
import { events } from "../src/schema.ts";
import { tempDbPath } from "./support.ts";

function open(path: string) {
	const broadcast = createBroadcast();
	const db = openDatabase(path, broadcast);
	onTestFinished(() => db.close());
	const { events } = db.follow();
	const followed = async () => {
		broadcast.close();
		const received: StoredEvent[] = [];
		for await (const event of events) received.push(event);
		return received;
	};
	return { db, followed };
}

const started = { type: "server.started" } as const;

test("committed events survive reopening the file, in seq order", async () => {
	const path = tempDbPath();
	const first = open(path);
	const value = first.db.commit(() => ({
		value: "ok",
		events: [started, started],
	}));
	expect(value, "commit returns the write's value").toBe("ok");
	const written = eventsAfter(first.db.read, Seq.parse(0), 10);
	expect(written.map((e) => e.seq)).toEqual([1, 2]);
	expect(await first.followed(), "a follower receives each event once").toEqual(
		written,
	);
	first.db.close();

	const second = open(path);
	expect(eventsAfter(second.db.read, Seq.parse(0), 10)).toEqual(written);
});

test("a commit that throws writes nothing and publishes nothing", async () => {
	const { db, followed } = open(tempDbPath());
	expect(() =>
		db.commit((tx) => {
			tx.insert(events)
				.values({
					type: "server.started",
					at: new Date().toISOString(),
					data: {},
				})
				.run();
			throw new Error("write failed");
		}),
	).toThrow("write failed");
	db.commit(() => ({ value: undefined, events: [started] }));

	const log = eventsAfter(db.read, Seq.parse(0), 10);
	expect(
		log.map((e) => e.seq),
		"the rolled-back row left no seq behind",
	).toEqual([1]);
	expect(await followed()).toEqual(log);
});

test("a commit inside another commit publishes nothing when the outer one rolls back", async () => {
	const { db, followed } = open(tempDbPath());
	expect(() =>
		db.commit(() => {
			db.commit(() => ({ value: undefined, events: [started] }));
			throw new Error("outer write failed");
		}),
	).toThrow();

	expect(
		eventsAfter(db.read, Seq.parse(0), 10),
		"the outer rollback left no event behind",
	).toEqual([]);
	expect(
		await followed(),
		"a follower never sees an event the log does not hold",
	).toEqual([]);
});

test("a commit that lands while a follower yields its last page is delivered without another commit", async () => {
	const broadcast = createBroadcast();
	const db = openDatabase(tempDbPath(), broadcast);
	onTestFinished(() => db.close());
	db.commit(() => ({ value: undefined, events: [started, started, started] }));
	const { events: subscription } = db.follow(Seq.parse(0));
	onTestFinished(() => subscription.close());
	const iterator = subscription[Symbol.asyncIterator]();
	const pull = async () => (await iterator.next()).value?.seq;

	expect(await pull()).toBe(1);
	db.commit(() => ({ value: undefined, events: [started] }));
	expect(
		[await pull(), await pull(), await pull()],
		"the commit during the yield loop arrives although its publish found no parked waker",
	).toEqual([2, 3, 4]);

	const pending = pull();
	await delay(0);
	db.commit(() => ({ value: undefined, events: [started] }));
	await expect(pending, "a parked follower wakes on commit").resolves.toBe(5);
});

test("a follower receives a backlog larger than a page, then later commits, each once and in order", async () => {
	const broadcast = createBroadcast();
	const db = openDatabase(tempDbPath(), broadcast);
	onTestFinished(() => db.close());
	const backlog = Array.from({ length: 600 }, () => started);
	db.commit(() => ({ value: undefined, events: backlog }));
	const { events: subscription } = db.follow(Seq.parse(0));
	onTestFinished(() => subscription.close());
	const iterator = subscription[Symbol.asyncIterator]();

	const seqs: number[] = [];
	for (let pulled = 0; pulled < 612; pulled += 1) {
		if (pulled > 0 && pulled % 50 === 0) {
			db.commit(() => ({ value: undefined, events: [started] }));
		}
		const { value } = await iterator.next();
		if (value) seqs.push(value.seq);
	}
	expect(seqs).toEqual(Array.from({ length: 612 }, (_, i) => i + 1));
});

test("follow inside a commit's write throws", () => {
	const { db } = open(tempDbPath());
	expect(() =>
		db.commit(() => {
			db.follow();
			return { value: undefined, events: [] };
		}),
	).toThrow("follow cannot run inside a commit's write");
});

test("eventsAfter returns at most limit events, in seq order, after the given seq", () => {
	const { db } = open(tempDbPath());
	db.commit(() => ({
		value: undefined,
		events: [started, started, started, started, started],
	}));
	expect(eventsAfter(db.read, Seq.parse(2), 2).map((e) => e.seq)).toEqual([
		3, 4,
	]);
});

test("writes outside commit and async writes do not compile", () => {
	expectTypeOf<Database["read"]>().not.toHaveProperty("insert");
	expectTypeOf<Database["read"]>().not.toHaveProperty("delete");
	const asyncWrite = (db: Database) =>
		// @ts-expect-error a write callback must be synchronous
		db.commit(async () => ({ value: 1, events: [] }));
	expectTypeOf(asyncWrite).toBeFunction();
});
