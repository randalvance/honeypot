import type { Seq, StoredEvent } from "./events.ts";

/**
 * Up to `limit` stored events with seq greater than `after`, in seq order.
 * Every row it returns is committed, and every commit that adds rows calls
 * `publish()` right after COMMIT on the same tick.
 */
export type ReadLog = (after: Seq, limit: number) => readonly StoredEvent[];

/**
 * The stored events after the cursor it starts at, then every later commit, in
 * seq order, each once. It holds at most one page of the log however slowly it
 * is read. `close()` ends iteration at the next pull, for a client that went
 * away. After `Broadcast.close()`, iteration ends once the log is drained.
 */
export interface Subscription extends AsyncIterable<StoredEvent> {
	close(): void;
}

export interface Broadcast {
	/** Rows were committed. Wakes every follower parked at the tail. */
	publish(): void;
	/** Follows the log from `after`, one page through `read` per pull. Reads nothing until the first pull. */
	subscribe(after: Seq, read: ReadLog): Subscription;
	/** Every subscription, and every later one at birth, ends once it drains to the tail. */
	close(): void;
}

const pageSize = 256;

interface Member extends Subscription {
	wake(): void;
}

export function createBroadcast(): Broadcast {
	const members = new Set<Member>();
	let closed = false;
	return {
		publish() {
			for (const member of members) member.wake();
		},
		subscribe(after, read) {
			const member = createMember(after, read, {
				isClosed: () => closed,
				onEnd: () => members.delete(member),
			});
			members.add(member);
			return member;
		},
		close() {
			closed = true;
			for (const member of members) member.wake();
		},
	};
}

function createMember(
	after: Seq,
	read: ReadLog,
	{ isClosed, onEnd }: { isClosed: () => boolean; onEnd: () => void },
): Member {
	let aborted = false;
	let waker: (() => void) | undefined;
	const wake = () => {
		const woken = waker;
		waker = undefined;
		woken?.();
	};
	async function* run(): AsyncGenerator<StoredEvent> {
		let cursor = after;
		try {
			while (!aborted) {
				const page = read(cursor, pageSize);
				if (page.length === 0) {
					if (isClosed()) return;
					// No await before the waker exists, or a commit could land unseen between the empty read and the park.
					await new Promise<void>((resolve) => {
						waker = resolve;
					});
					continue;
				}
				for (const event of page) {
					cursor = event.seq;
					yield event;
					if (aborted) return;
				}
				// Re-read even after a short page: a commit that lands mid-yield finds no waker to wake.
			}
		} finally {
			onEnd();
		}
	}
	const iterator = run();
	return {
		[Symbol.asyncIterator]: () => iterator,
		close() {
			aborted = true;
			wake();
		},
		wake,
	};
}
