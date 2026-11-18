import { z } from "zod";
import type { Minion } from "../agents/model.ts";
import type { Project, RepoRef } from "../projects/model.ts";
import type { RunId } from "./model.ts";
import { createStubRuntime } from "./stub.ts";

/** Which adapter runs minions. It is data, so `main.ts` builds it from the environment and the browser tests pick the stub. */
export const RuntimeConfig = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("claude") }),
	/** With `gateDir`, each session writes `<gateDir>/<runId>.held` after its edit and holds until that file is gone or the signal aborts. */
	z.strictObject({
		kind: z.literal("stub"),
		gateDir: z.string().min(1).optional(),
	}),
]);
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;

/** Everything one minion needs to work one brief. The runs store builds it, so an adapter never reads the database. */
export interface Session {
	readonly runId: RunId;
	/** The run's worktree. The agent works only here. */
	readonly cwd: string;
	readonly branch: string;
	/** The run's own folder outside the worktree, for agent config. It stays with the run. */
	readonly scratch: string;
	/** The identity and no-signing variables for any git the agent runs. */
	readonly gitEnv: Readonly<Record<string, string>>;
	readonly minion: Minion;
	readonly project: Pick<Project, "name" | "context">;
	readonly repo: RepoRef;
	readonly brief: string;
}

export type SessionEnd =
	| { readonly kind: "finished" }
	| { readonly kind: "failed"; readonly message: string };

export interface RuntimeAdapter {
	/**
	 * Runs the minion until its agent stops. An agent failure resolves `failed` and never rejects.
	 * After `signal` aborts, it ends the agent and settles promptly. The caller checks the signal.
	 */
	run(session: Session, signal: AbortSignal): Promise<SessionEnd>;
}

export function createRuntime(
	config: RuntimeConfig,
	deps: { readonly skillsDir: string },
): RuntimeAdapter {
	switch (config.kind) {
		case "claude":
			return {
				async run(session, signal) {
					// Imported on first use, so a process on the stub never loads the SDK.
					const { createClaudeRuntime } = await import("./claude.ts");
					return createClaudeRuntime(deps).run(session, signal);
				},
			};
		case "stub":
			return createStubRuntime(config);
	}
}
