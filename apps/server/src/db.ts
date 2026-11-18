import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { asc, gt, max } from "drizzle-orm";
import {
	type BetterSQLite3Database,
	drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Broadcast, ReadLog, Subscription } from "./broadcast.ts";
import { Seq, type ServerEvent, StoredEvent } from "./events.ts";
import { events } from "./schema.ts";

type Drizzle = BetterSQLite3Database;

export type Tx = Parameters<Parameters<Drizzle["transaction"]>[0]>[0];

export type Reader = Pick<Drizzle, "select" | "selectDistinct" | "$count">;

export interface Change<T> {
	readonly value: T;
	readonly events: readonly ServerEvent[];
}

export interface Database {
	readonly read: Reader;
	/**
	 * Runs `write` in one BEGIN IMMEDIATE transaction and appends its events to
	 * the log in the same transaction. After COMMIT it publishes the stored
	 * events and returns `value`. If anything throws, nothing is written or
	 * published. A commit inside another commit's `write` throws, because it
	 * would publish before the outer transaction commits.
	 */
	commit<T>(write: (tx: Tx) => Change<T>): T;
	/**
	 * The stored events after `after`, then every later commit, with none missed
	 * or repeated. Without `after`, or with one past the head, it starts at the head.
	 * Inside a commit's `write` it throws: there it could capture an uncommitted
	 * seq, which a rollback lets SQLite reuse.
	 */
	follow(after?: Seq): { readonly cursor: Seq; readonly events: Subscription };
	/** Ends every follow, then closes the file. */
	close(): void;
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Opens or creates the SQLite file and applies pending migrations before returning. */
export function openDatabase(path: string, broadcast: Broadcast): Database {
	const sqlite = new BetterSqlite3(path);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.pragma("busy_timeout = 5000");
	const db = drizzle({ client: sqlite });
	migrate(db, { migrationsFolder });
	let committing = false;
	const readLog: ReadLog = (after, limit) => {
		if (committing) {
			throw new Error("reading the log cannot run inside a commit's write");
		}
		if (!sqlite.open) return [];
		return eventsAfter(db, after, limit);
	};

	return {
		read: db,
		commit(write) {
			if (committing) {
				throw new Error("commit cannot run inside another commit's write");
			}
			committing = true;
			try {
				const { value, stored } = db.transaction(
					(tx) => {
						const { value, events: pending } = write(tx);
						const at = new Date().toISOString();
						const stored = pending.map(({ type, ...data }) =>
							toStoredEvent(
								tx.insert(events).values({ type, at, data }).returning().get(),
							),
						);
						return { value, stored };
					},
					{ behavior: "immediate" },
				);
				if (stored.length > 0) broadcast.publish();
				return value;
			} finally {
				committing = false;
			}
		},
		follow(after) {
			if (committing) {
				throw new Error("follow cannot run inside a commit's write");
			}
			const head = headSeq(db);
			const cursor = after === undefined || after > head ? head : after;
			return { cursor, events: broadcast.subscribe(cursor, readLog) };
		},
		close() {
			broadcast.close();
			if (sqlite.open) sqlite.close();
		},
	};
}

function headSeq(read: Reader): Seq {
	const row = read
		.select({ head: max(events.seq) })
		.from(events)
		.get();
	return Seq.parse(row?.head ?? 0);
}

/** Up to `limit` stored events after `after`, in seq order. To page, pass the last seq back as `after`. */
export function eventsAfter(
	read: Reader,
	after: Seq,
	limit: number,
): StoredEvent[] {
	return read
		.select()
		.from(events)
		.where(gt(events.seq, after))
		.orderBy(asc(events.seq))
		.limit(limit)
		.all()
		.map(toStoredEvent);
}

function toStoredEvent(row: typeof events.$inferSelect): StoredEvent {
	return StoredEvent.parse({
		...row.data,
		type: row.type,
		seq: row.seq,
		at: row.at,
	});
}
