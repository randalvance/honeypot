import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MinionSummary } from "../agents/model.ts";
import type { RepoRef } from "../projects/model.ts";
import { type RunId, runBranch } from "./model.ts";

export interface Worktree {
	readonly path: string;
	readonly branch: string;
	readonly scratch: string;
	/**
	 * The minion as author and committer, with the email `<minionId>@minions.honeypot.invalid`,
	 * and `commit.gpgsign=false`. Git prefers these variables over the developer identity that the dev container exports.
	 */
	readonly env: Readonly<Record<string, string>>;
	/**
	 * Stages every change and commits it as one commit on the run's branch. A clean tree commits nothing.
	 * Throws when HEAD is not the run's branch. Resolves with the branch tip, which is the base when the tree was clean.
	 */
	commitAll(message: string, signal: AbortSignal): Promise<string>;
}

export interface Worktrees {
	locate(runId: RunId): { readonly path: string; readonly branch: string };
	/**
	 * Fetches the repo's default branch into Honeypot's bare clone, then adds the run's worktree on a new branch cut from it.
	 * Opens on one repo run one at a time, and a failed open does not block the next.
	 */
	open(
		runId: RunId,
		repo: RepoRef,
		minion: MinionSummary,
		signal: AbortSignal,
	): Promise<Worktree>;
}

export function createWorktrees(deps: {
	readonly dir: string;
	readonly serverUrl: URL;
}): Worktrees {
	const serverRoot = deps.serverUrl.href.endsWith("/")
		? deps.serverUrl
		: new URL(`${deps.serverUrl.href}/`);
	// Concurrent `git worktree add` on one clone can read a sibling's half-written
	// admin folder and fail ("failed to read worktrees/<name>/commondir").
	const queues = new Map<string, Promise<void>>();
	const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
		const result = (queues.get(key) ?? Promise.resolve()).then(work);
		const settled = result.then(
			() => {},
			() => {},
		);
		queues.set(key, settled);
		void settled.then(() => {
			if (queues.get(key) === settled) queues.delete(key);
		});
		return result;
	};
	const locate = (runId: RunId) => ({
		path: join(deps.dir, "worktrees", `run-${runId}`),
		branch: runBranch(runId),
	});

	return {
		locate,

		async open(runId, repo, minion, signal) {
			const { path, branch } = locate(runId);
			const scratch = join(deps.dir, "scratch", `run-${runId}`);
			const bare = join(
				deps.dir,
				"repos",
				repo.owner.toLowerCase(),
				`${repo.name.toLowerCase()}.git`,
			);
			const base = `refs/remotes/origin/${repo.defaultBranch}`;
			const url = new URL(`${repo.owner}/${repo.name}.git`, serverRoot).href;
			try {
				await oneAtATime(bare, async () => {
					await mkdir(dirname(bare), { recursive: true });
					await git(deps.dir, ["init", "--quiet", "--bare", bare], { signal });
					await git(bare, ["config", "remote.origin.url", url], { signal });
					await git(bare, ["config", "gc.auto", "0"], { signal });
					await git(bare, ["config", "maintenance.auto", "false"], { signal });
					await git(
						bare,
						[
							"fetch",
							"--quiet",
							"--no-tags",
							"origin",
							`+refs/heads/${repo.defaultBranch}:${base}`,
						],
						{ signal },
					);
					await mkdir(dirname(path), { recursive: true });
					await git(
						bare,
						[
							"worktree",
							"add",
							"--quiet",
							"--no-track",
							"-b",
							branch,
							path,
							base,
						],
						{ signal },
					);
				});
				await mkdir(scratch, { recursive: true });
			} catch (error) {
				throw new Error(
					`could not open a worktree of ${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const env = identity(minion);
			return {
				path,
				branch,
				scratch,
				env,
				async commitAll(message, signal) {
					const head = await git(
						path,
						["rev-parse", "--symbolic-full-name", "HEAD"],
						{ signal },
					);
					if (head !== `refs/heads/${branch}`) {
						throw new Error(`the worktree is on ${head}, not ${branch}`);
					}
					const status = await git(path, ["status", "--porcelain"], { signal });
					if (status !== "") {
						await git(path, ["add", "--all"], { signal, env });
						await git(path, ["commit", "--quiet", "--message", message], {
							signal,
							env,
						});
					}
					return git(path, ["rev-parse", "HEAD"], { signal });
				},
			};
		},
	};
}

function identity(minion: MinionSummary): Record<string, string> {
	const email = `${minion.id}@minions.honeypot.invalid`;
	return {
		GIT_AUTHOR_NAME: minion.name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: minion.name,
		GIT_COMMITTER_EMAIL: email,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "commit.gpgsign",
		GIT_CONFIG_VALUE_0: "false",
	};
}

const pointsGitElsewhere = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
]);

function git(
	cwd: string,
	args: readonly string[],
	options: {
		readonly signal: AbortSignal;
		readonly env?: Readonly<Record<string, string>>;
	},
): Promise<string> {
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !pointsGitElsewhere.has(key),
			),
		),
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		...options.env,
	};
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, env, signal: options.signal },
			(error, stdout, stderr) => {
				if (error === null) return resolve(stdout.trim());
				const detail = stderr.trim().split("\n")[0] || error.message;
				reject(new Error(`git ${args[0]}: ${detail}`));
			},
		);
	});
}
