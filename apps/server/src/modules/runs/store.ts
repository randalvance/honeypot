import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database, Reader } from "../../db.ts";
import type { ServerEvent } from "../../events.ts";
import { ApiError, notFound } from "../../http.ts";
import type { Agents } from "../agents/store.ts";
import type { Projects } from "../projects/store.ts";
import {
	type NewRun,
	type Run,
	RunFailure,
	RunId,
	type RunState,
	runBranch,
} from "./model.ts";
import { createRuntime, type RuntimeConfig, type Session } from "./runtime.ts";
import { runs } from "./schema.ts";
import { createWorktrees, type Worktree, type Worktrees } from "./worktrees.ts";

export interface Runs {
	/**
	 * Checks the project, that the project has the repo (ignoring case), and the minion, and throws `not_found` for a missing one.
	 * Commits the run as `running`, starts the minion in the background, and returns at once.
	 */
	start(input: NewRun): Run;
	/** Throws `not_found` for a missing run. */
	get(id: RunId): Run;
	/**
	 * Fails every run that a previous process left `running`, with the reason `interrupted`. Idempotent.
	 * It is the only writer of `interrupted`, and the server calls it once, after it listens.
	 */
	recover(): void;
	/**
	 * Stops every live run and resolves when each has settled. A stopped run writes nothing, so its row stays
	 * `running` until the next start's `recover`. Every call returns the first call's promise.
	 */
	close(): Promise<void>;
}

type Ended = Exclude<RunState, { kind: "running" }>;

export function createRuns(deps: {
	readonly db: Database;
	readonly projects: Projects;
	readonly agents: Agents;
	readonly workspaceDir: string;
	readonly serverUrl: URL;
	readonly skillsDir: string;
	readonly runtime: RuntimeConfig;
}): Runs {
	const { db, projects, agents } = deps;
	const worktrees = createWorktrees({
		dir: deps.workspaceDir,
		serverUrl: deps.serverUrl,
	});
	const runtime = createRuntime(deps.runtime, { skillsDir: deps.skillsDir });
	const live = new Map<
		RunId,
		{ readonly controller: AbortController; readonly settled: Promise<void> }
	>();
	let closing: Promise<void> | undefined;

	const changed = (runId: RunId): ServerEvent[] => [
		{ type: "run.changed", runId },
	];

	const get = (id: RunId): Run => toRun(requireRun(db.read, id), worktrees);

	const finish = (id: RunId, state: Ended) => {
		db.commit((tx) => {
			const { changes } = tx
				.update(runs)
				.set(endColumns(state))
				.where(and(eq(runs.id, id), eq(runs.state, "running")))
				.run();
			return { value: undefined, events: changes > 0 ? changed(id) : [] };
		});
	};

	const drive = async (
		run: Run,
		session: Omit<Session, "cwd" | "branch" | "scratch" | "gitEnv">,
		signal: AbortSignal,
	): Promise<Ended | undefined> => {
		const failed = (reason: RunFailure, message: string): Ended => ({
			kind: "failed",
			reason,
			message,
			at: new Date().toISOString(),
		});
		let worktree: Worktree;
		try {
			worktree = await worktrees.open(run.id, run.repo, run.minion, signal);
		} catch (error) {
			return signal.aborted
				? undefined
				: failed("workspace_failed", describe(error));
		}
		const end = await runtime.run(
			{
				...session,
				cwd: worktree.path,
				branch: worktree.branch,
				scratch: worktree.scratch,
				gitEnv: worktree.env,
			},
			signal,
		);
		if (signal.aborted) return undefined;
		if (end.kind === "failed") return failed("agent_failed", end.message);
		try {
			const head = await worktree.commitAll(commitMessage(run));
			return { kind: "succeeded", head, at: new Date().toISOString() };
		} catch (error) {
			// Sealing is not abortable, so a throw here is a real failure even mid-shutdown.
			return failed("workspace_failed", describe(error));
		}
	};

	return {
		start(input) {
			if (closing !== undefined) throw new Error("the runs store is closed");
			const project = projects.get(input.projectId);
			const repo = project.repos.find(
				(r) =>
					`${r.owner}/${r.name}`.toLowerCase() === input.repo.toLowerCase(),
			);
			if (!repo) {
				throw new ApiError({
					code: "not_found",
					message: `the project has no repo ${input.repo}`,
				});
			}
			const minion = agents.getMinion(input.minionId);
			const id = RunId.parse(randomUUID());
			db.commit((tx) => {
				tx.insert(runs)
					.values({
						id,
						projectId: project.id,
						repoOwner: repo.owner,
						repoName: repo.name,
						repoDefaultBranch: repo.defaultBranch,
						minionId: minion.id,
						minionName: minion.name,
						brief: input.brief,
						state: "running",
						startedAt: new Date().toISOString(),
					})
					.run();
				return { value: undefined, events: changed(id) };
			});
			const run = get(id);
			const controller = new AbortController();
			const settled = drive(
				run,
				{
					runId: id,
					minion,
					project: { name: project.name, context: project.context },
					repo,
					brief: input.brief,
				},
				controller.signal,
			)
				.then((state) => {
					if (state) finish(id, state);
				})
				.catch((error: unknown) => {
					console.error(`run ${id} ended without a state`, error);
				})
				.finally(() => live.delete(id));
			live.set(id, { controller, settled });
			return run;
		},

		get,

		recover() {
			db.commit((tx) => {
				const ended = tx
					.update(runs)
					.set(
						endColumns({
							kind: "failed",
							reason: "interrupted",
							message: "the server stopped during the run",
							at: new Date().toISOString(),
						}),
					)
					.where(eq(runs.state, "running"))
					.returning({ id: runs.id })
					.all();
				return {
					value: undefined,
					events: ended.flatMap(({ id }) => changed(id)),
				};
			});
		},

		close() {
			closing ??= (async () => {
				const drivers = [...live.values()];
				for (const { controller } of drivers) controller.abort();
				await Promise.all(drivers.map(({ settled }) => settled));
			})();
			return closing;
		},
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requireRun(read: Reader, id: RunId) {
	const row = read.select().from(runs).where(eq(runs.id, id)).get();
	if (!row) throw new ApiError(notFound("run").error);
	return row;
}

function endColumns(state: Ended) {
	switch (state.kind) {
		case "succeeded":
			return { state: state.kind, head: state.head, endedAt: state.at };
		case "failed":
			return {
				state: state.kind,
				reason: state.reason,
				message: state.message,
				endedAt: state.at,
			};
	}
}

function commitMessage(run: Run): string {
	const [title = ""] = run.brief.split("\n");
	return `${[...title].slice(0, 72).join("")}\n\nHoneypot-Run: ${run.id}`;
}

function toRun(row: typeof runs.$inferSelect, worktrees: Worktrees): Run {
	return {
		id: row.id,
		projectId: row.projectId,
		repo: {
			owner: row.repoOwner,
			name: row.repoName,
			defaultBranch: row.repoDefaultBranch,
		},
		minion: { id: row.minionId, name: row.minionName },
		brief: row.brief,
		branch: runBranch(row.id),
		worktree: worktrees.locate(row.id).path,
		state: toState(row),
		startedAt: row.startedAt,
	};
}

function toState(row: typeof runs.$inferSelect): RunState {
	const { state, head, reason, message, endedAt } = row;
	switch (state) {
		case "running":
			return { kind: state };
		case "succeeded":
			if (head !== null && endedAt !== null) {
				return { kind: state, head, at: endedAt };
			}
			break;
		case "failed":
			if (reason !== null && message !== null && endedAt !== null) {
				return {
					kind: state,
					reason: RunFailure.parse(reason),
					message,
					at: endedAt,
				};
			}
			break;
	}
	throw new Error(`run ${row.id} breaks the ${state} column check`);
}
