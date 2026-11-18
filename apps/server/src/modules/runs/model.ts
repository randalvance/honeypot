import { z } from "zod";
import { MinionId, type MinionSummary } from "../agents/model.ts";
import { ProjectId, RepoName, type RepoRef } from "../projects/model.ts";

export const RunId = z.uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

/** Stored run rows keep parsing forever, so a reason is never renamed or removed. */
export const RunFailure = z.enum([
	"workspace_failed",
	"agent_failed",
	"interrupted",
]);
export type RunFailure = z.infer<typeof RunFailure>;

/** A run starts `running` and ends `succeeded` or `failed` once. An ended run never changes. */
export type RunState =
	| { readonly kind: "running" }
	| {
			readonly kind: "succeeded";
			/** The run branch's tip after the runtime's commit. */
			readonly head: string;
			readonly at: string;
	  }
	| {
			readonly kind: "failed";
			readonly reason: RunFailure;
			readonly message: string;
			readonly at: string;
	  };

export interface Run {
	readonly id: RunId;
	readonly projectId: ProjectId;
	/** The repo as it was when the run started. */
	readonly repo: RepoRef;
	/** The minion as it was when the run started. A run outlives a renamed or deleted minion. */
	readonly minion: MinionSummary;
	readonly brief: string;
	/** The run's own branch in Honeypot's clone. Honeypot never pushes it. */
	readonly branch: string;
	/** The run's own worktree on the server's disk. It stays after the run ends. */
	readonly worktree: string;
	readonly state: RunState;
	readonly startedAt: string;
}

export const NewRun = z.strictObject({
	projectId: ProjectId,
	minionId: MinionId,
	repo: RepoName,
	brief: z.string().trim().min(1).max(100_000),
});
export type NewRun = z.infer<typeof NewRun>;

export function runBranch(id: RunId): string {
	return `honeypot/run-${id}`;
}
