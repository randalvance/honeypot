import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, resolve } from "node:path";
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
	 * Shutdown does not abort it: it is local and fast, and a seal that cannot be cut short keeps the recorded
	 * state consistent with the branch.
	 */
	commitAll(message: string): Promise<string>;
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
	// Git resolves a relative path against each subprocess's own directory, so one absolute base keeps
	// every path meaning one place.
	const dir = resolve(deps.dir);
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
		path: join(dir, "worktrees", `run-${runId}`),
		branch: runBranch(runId),
	});

	return {
		locate,

		async open(runId, repo, minion, signal) {
			const { path, branch } = locate(runId);
			const scratch = join(dir, "scratch", `run-${runId}`);
			const bare = join(
				dir,
				"repos",
				repo.owner.toLowerCase(),
				`${repo.name.toLowerCase()}.git`,
			);
			const base = `refs/remotes/origin/${repo.defaultBranch}`;
			const url = new URL(`${repo.owner}/${repo.name}.git`, serverRoot).href;
			try {
				await oneAtATime(bare, async () => {
					await mkdir(dirname(bare), { recursive: true });
					await git(dir, ["init", "--quiet", "--bare", bare], { signal });
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
						// A transfer below 1 KB/s for a minute counts as stalled, so a dead
						// connection cannot hold the repo's queue open.
						{
							signal,
							config: {
								"http.lowSpeedLimit": "1000",
								"http.lowSpeedTime": "60",
							},
						},
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
				async commitAll(message) {
					const head = await git(path, [
						"rev-parse",
						"--symbolic-full-name",
						"HEAD",
					]);
					if (head !== `refs/heads/${branch}`) {
						throw new Error(`the worktree is on ${head}, not ${branch}`);
					}
					// Stage first: an edit the agent staged and then reverted in the tree
					// still shows in status, and committing it would fail as empty.
					await git(path, ["add", "--all"], { env });
					const status = await git(path, [
						"status",
						"--porcelain",
						"--untracked-files=all",
					]);
					if (status !== "") {
						await git(
							path,
							["commit", "--quiet", "--no-verify", "--message", message],
							{ env },
						);
					}
					return git(path, ["rev-parse", "HEAD"]);
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
		...gitConfig({ "commit.gpgsign": "false", "core.hooksPath": devNull }),
	};
}

/**
 * `GIT_CONFIG_COUNT`-indexed variables, the one way env can carry config without a file.
 * Pairs the server inherited (an operator's URL-scoped http.extraHeader, say) come first,
 * so `pairs` wins where both name one key: in git, the later value does.
 */
function gitConfig(
	pairs: Readonly<Record<string, string>>,
): Record<string, string> {
	const entries = [...inheritedConfig(), ...Object.entries(pairs)];
	return {
		GIT_CONFIG_COUNT: String(entries.length),
		...Object.fromEntries(
			entries.flatMap(([key, value], index) => [
				[`GIT_CONFIG_KEY_${index}`, key],
				[`GIT_CONFIG_VALUE_${index}`, value],
			]),
		),
	};
}

function inheritedConfig(): [string, string][] {
	const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
	const pairs: [string, string][] = [];
	for (let index = 0; index < (Number.isFinite(count) ? count : 0); index++) {
		const key = process.env[`GIT_CONFIG_KEY_${index}`];
		const value = process.env[`GIT_CONFIG_VALUE_${index}`];
		if (key !== undefined && value !== undefined) pairs.push([key, value]);
	}
	return pairs;
}

const pointsGitElsewhere = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_COMMON_DIR",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
]);

function git(
	cwd: string,
	args: readonly string[],
	options: {
		readonly signal?: AbortSignal;
		readonly env?: Readonly<Record<string, string>>;
		readonly config?: Readonly<Record<string, string>>;
	} = {},
): Promise<string> {
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !pointsGitElsewhere.has(key),
			),
		),
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		// No hooks on the runtime's own git. The developer's global hooksPath must not run here.
		...gitConfig({ "core.hooksPath": devNull, ...options.config }),
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
