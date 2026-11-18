import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hc } from "hono/client";
import { expect, expectTypeOf, onTestFinished, test, vi } from "vitest";
import type { AppType } from "../src/app.ts";
import type { ApiErrorBody } from "../src/http.ts";
import type { RunId, RunState } from "../src/modules/runs/model.ts";
import type { RuntimeConfig } from "../src/modules/runs/runtime.ts";
import { stubGateFile } from "../src/modules/runs/stub.ts";
import { git } from "./git.ts";
import {
	type GitHubStub,
	type StubRepo,
	startGitHubStub,
} from "./github-stub.ts";
import {
	errorOf,
	headSeq,
	readEvents,
	startFresh,
	tempDbPath,
} from "./support.ts";

const repos = {
	"acme/api": { defaultBranch: "main" },
	"acme/web": { defaultBranch: "trunk" },
	"acme/locked": { defaultBranch: "main", unclonable: true },
} satisfies Record<string, StubRepo>;

const timeout = 20_000;

async function gitHub() {
	const github = await startGitHubStub(repos);
	onTestFinished(() => github.close());
	return github;
}

async function serve({
	dbPath = tempDbPath(),
	github,
	gated = false,
}: {
	dbPath?: string;
	github?: GitHubStub;
	gated?: boolean;
} = {}) {
	const stub = github ?? (await gitHub());
	const gateDir = join(dirname(dbPath), "gate");
	mkdirSync(gateDir, { recursive: true });
	const runtime: RuntimeConfig = gated
		? { kind: "stub", gateDir }
		: { kind: "stub" };
	const server = await startFresh(dbPath, { github: stub.config, runtime });
	return {
		dbPath,
		github: stub,
		gateDir,
		server,
		api: hc<AppType>(server.url.href).api,
	};
}

type Api = Awaited<ReturnType<typeof serve>>["api"];

async function setUp(api: Api) {
	const project = await api.projects.$post({
		json: { name: "Checkout", repos: ["acme/api", "acme/locked"] },
	});
	const minion = await api.minions.$post({
		json: {
			name: "Scout",
			profile: { systemPrompt: "", skills: [], mcpServers: {} },
		},
	});
	if (project.status !== 201 || minion.status !== 201) {
		throw new Error(`set up answered ${project.status} and ${minion.status}`);
	}
	return {
		project: (await project.json()).project,
		minion: (await minion.json()).minion,
	};
}

type RunInput = Parameters<Api["runs"]["$post"]>[0]["json"];

async function startRun(api: Api, json: RunInput) {
	const response = await api.runs.$post({ json });
	if (response.status !== 201) {
		throw new Error(`start answered ${response.status}`);
	}
	return (await response.json()).run;
}

async function readRun(api: Api, runId: string) {
	const response = await api.runs[":runId"].$get({ param: { runId } });
	if (response.status !== 200) {
		throw new Error(`get answered ${response.status}`);
	}
	return (await response.json()).run;
}

function settled(api: Api, runId: string) {
	return vi.waitFor(
		async () => {
			const run = await readRun(api, runId);
			if (run.state.kind === "running") throw new Error("still running");
			return run;
		},
		{ timeout: 10_000, interval: 20 },
	);
}

function origin(github: GitHubStub, name: string): string {
	return fileURLToPath(new URL(`${name}.git`, github.config.serverUrl));
}

test(
	"a run commits the minion's edit on its own branch in its own worktree, and leaves the origin alone",
	async () => {
		const { server, api, github } = await serve();
		const { project, minion } = await setUp(api);
		const seed = await git(origin(github, "acme/api"), "rev-parse", "main");
		const before = await headSeq(server.url);

		const started = await startRun(api, {
			projectId: project.id,
			minionId: minion.id,
			repo: "acme/api",
			brief: "add a line to the README",
		});
		expect(started).toMatchObject({
			projectId: project.id,
			repo: { owner: "acme", name: "api", defaultBranch: "main" },
			minion: { id: minion.id, name: "Scout" },
			brief: "add a line to the README",
			branch: `honeypot/run-${started.id}`,
			state: { kind: "running" },
		});

		const run = await settled(api, started.id);
		const { worktree } = run;
		expect(run.state).toEqual({
			kind: "succeeded",
			head: await git(worktree, "rev-parse", "HEAD"),
			at: expect.any(String),
		});
		expect(await git(worktree, "symbolic-ref", "HEAD")).toBe(
			`refs/heads/${run.branch}`,
		);
		expect(
			await git(worktree, "rev-list", "--count", `${seed}..HEAD`),
			"one commit on top of the default branch",
		).toBe("1");
		expect(await git(worktree, "diff", "--name-only", seed, "HEAD")).toBe(
			"README.md",
		);
		expect(await git(worktree, "show", "HEAD:README.md")).toBe(
			"# acme/api\nadd a line to the README",
		);
		expect(
			await git(worktree, "log", "-1", "--format=%an <%ae>%n%cn <%ce>"),
			"the minion authored and committed it",
		).toBe(
			`Scout <${minion.id}@minions.honeypot.invalid>\nScout <${minion.id}@minions.honeypot.invalid>`,
		);
		expect(
			await git(
				worktree,
				"log",
				"-1",
				"--format=%s%n%(trailers:key=Honeypot-Run,valueonly)",
			),
		).toBe(`add a line to the README\n${run.id}`);
		expect(await git(worktree, "status", "--porcelain")).toBe("");

		expect(await git(origin(github, "acme/api"), "rev-parse", "main")).toBe(
			seed,
		);
		expect(
			await git(origin(github, "acme/api"), "branch", "--list", "honeypot/*"),
			"nothing was pushed",
		).toBe("");
		const events = await readEvents(server.url, { after: before, count: 2 });
		expect(events).toEqual([
			expect.objectContaining({ type: "run.changed", runId: run.id }),
			expect.objectContaining({ type: "run.changed", runId: run.id }),
		]);
		expect(await headSeq(server.url), "one event to start, one to end").toBe(
			before + 2,
		);
	},
	timeout,
);

test(
	"two runs on one repo at the same time each change only their own worktree and branch",
	async () => {
		const { api, github, gateDir } = await serve({ gated: true });
		const { project, minion } = await setUp(api);
		const seed = await git(origin(github, "acme/api"), "rev-parse", "main");
		const run = (brief: string) =>
			startRun(api, {
				projectId: project.id,
				minionId: minion.id,
				repo: "acme/api",
				brief,
			});

		const [alpha, beta] = await Promise.all([
			run("add the line alpha"),
			run("add the line beta"),
		]);
		await vi.waitFor(
			async () => {
				for (const held of [alpha, beta]) {
					expect(
						(await readRun(api, held.id)).state,
						`"${held.brief}" is still running`,
					).toEqual({ kind: "running" });
					expect(
						existsSync(stubGateFile(gateDir, held.id)),
						`"${held.brief}" is held after its edit`,
					).toBe(true);
				}
			},
			{ timeout: 10_000, interval: 20 },
		);
		for (const [held, line] of [
			[alpha, "add the line alpha"],
			[beta, "add the line beta"],
		] as const) {
			expect(await readFile(join(held.worktree, "README.md"), "utf8")).toBe(
				`# acme/api\n${line}\n`,
			);
			expect(await git(held.worktree, "status", "--porcelain")).toBe(
				" M README.md",
			);
		}

		await rm(stubGateFile(gateDir, alpha.id));
		const alphaDone = await settled(api, alpha.id);
		expect((await readRun(api, beta.id)).state.kind, "beta is still held").toBe(
			"running",
		);
		await rm(stubGateFile(gateDir, beta.id));
		const betaDone = await settled(api, beta.id);

		const heads = [];
		for (const [done, line] of [
			[alphaDone, "add the line alpha"],
			[betaDone, "add the line beta"],
		] as const) {
			if (done.state.kind !== "succeeded") {
				throw new Error(`run ${done.id} ended ${done.state.kind}`);
			}
			const { head } = done.state;
			heads.push(head);
			expect(await git(done.worktree, "rev-parse", `${head}^`)).toBe(seed);
			expect(await git(done.worktree, "diff", "--name-only", seed, head)).toBe(
				"README.md",
			);
			expect(await git(done.worktree, "show", `${head}:README.md`)).toBe(
				`# acme/api\n${line}`,
			);
			expect(await git(done.worktree, "status", "--porcelain")).toBe("");
		}
		expect(heads[0]).not.toBe(heads[1]);
		expect(await git(origin(github, "acme/api"), "rev-parse", "main")).toBe(
			seed,
		);
		expect(
			await git(origin(github, "acme/api"), "branch", "--list", "honeypot/*"),
		).toBe("");
	},
	timeout,
);

test(
	"a run the server stopped reads as interrupted after a restart, with its edit kept uncommitted",
	async () => {
		const dbPath = tempDbPath();
		const github = await gitHub();
		const first = await serve({ dbPath, github, gated: true });
		const { project, minion } = await setUp(first.api);
		const seed = await git(origin(github, "acme/api"), "rev-parse", "main");
		const run = await startRun(first.api, {
			projectId: project.id,
			minionId: minion.id,
			repo: "acme/api",
			brief: "add the line gamma",
		});
		await vi.waitFor(
			() => expect(existsSync(stubGateFile(first.gateDir, run.id))).toBe(true),
			{ timeout: 10_000, interval: 20 },
		);
		const before = await headSeq(first.server.url);

		await first.server.stop();
		const second = await serve({ dbPath, github, gated: true });

		expect((await readRun(second.api, run.id)).state).toEqual({
			kind: "failed",
			reason: "interrupted",
			message: "the server stopped during the run",
			at: expect.any(String),
		});
		expect(
			await readEvents(second.server.url, { after: before, count: 2 }),
		).toEqual([
			expect.objectContaining({ type: "server.started" }),
			expect.objectContaining({ type: "run.changed", runId: run.id }),
		]);
		expect(await headSeq(second.server.url)).toBe(before + 2);
		expect(await readFile(join(run.worktree, "README.md"), "utf8")).toBe(
			"# acme/api\nadd the line gamma\n",
		);
		expect(await git(run.worktree, "status", "--porcelain")).toBe(
			" M README.md",
		);
		expect(
			await git(run.worktree, "rev-list", "--count", `${seed}..HEAD`),
		).toBe("0");
	},
	timeout,
);

test(
	"a repo that will not clone fails the run as workspace_failed and adds no worktree",
	async () => {
		const { api } = await serve();
		const { project, minion } = await setUp(api);

		const started = await startRun(api, {
			projectId: project.id,
			minionId: minion.id,
			repo: "acme/locked",
			brief: "add a line to the README",
		});
		const run = await settled(api, started.id);

		expect(run.state).toEqual({
			kind: "failed",
			reason: "workspace_failed",
			message: expect.stringContaining("acme/locked"),
			at: expect.any(String),
		});
		expect(existsSync(run.worktree)).toBe(false);
	},
	timeout,
);

test(
	"a minion that fails fails the run as agent_failed, commits nothing, and keeps its edit in the worktree",
	async () => {
		const { api, github } = await serve();
		const { project, minion } = await setUp(api);
		const seed = await git(origin(github, "acme/api"), "rev-parse", "main");

		const started = await startRun(api, {
			projectId: project.id,
			minionId: minion.id,
			repo: "acme/api",
			brief: "fail: the README is read-only",
		});
		const run = await settled(api, started.id);

		expect(run.state).toEqual({
			kind: "failed",
			reason: "agent_failed",
			message: "the README is read-only",
			at: expect.any(String),
		});
		expect(
			await git(run.worktree, "rev-list", "--count", `${seed}..HEAD`),
		).toBe("0");
		expect(await git(run.worktree, "status", "--porcelain")).toBe(
			" M README.md",
		);
		expect(await readFile(join(run.worktree, "README.md"), "utf8")).toBe(
			"# acme/api\nfail: the README is read-only\n",
		);
	},
	timeout,
);

type Ids = { projectId: string; minionId: string };

test.each<[string, (ids: Ids) => unknown, number, string | undefined]>([
	[
		"an unknown project",
		(ids) => ({ ...valid(ids), projectId: randomUUID() }),
		404,
		undefined,
	],
	[
		"an unknown minion",
		(ids) => ({ ...valid(ids), minionId: randomUUID() }),
		404,
		undefined,
	],
	[
		"a repo the project does not have",
		(ids) => ({ ...valid(ids), repo: "acme/web" }),
		404,
		undefined,
	],
	["a blank brief", (ids) => ({ ...valid(ids), brief: "  \n " }), 400, "brief"],
	[
		"a field runs do not take",
		(ids) => ({ ...valid(ids), branch: "main" }),
		400,
		"",
	],
])(
	"the API rejects a run with %s and starts nothing",
	async (_, body, status, issuePath) => {
		const { dbPath, server, api } = await serve();
		const { project, minion } = await setUp(api);
		const before = await headSeq(server.url);

		const rejected = await fetch(new URL("/api/runs", server.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(
				body({ projectId: project.id, minionId: minion.id }),
			),
		});

		expect(rejected.status).toBe(status);
		const error = await errorOf(rejected);
		if (issuePath === undefined) {
			expect(error.code).toBe("not_found");
		} else {
			expect(error).toMatchObject({
				code: "invalid_request",
				issues: [expect.objectContaining({ path: issuePath })],
			});
		}
		expect(await headSeq(server.url), "nothing was written").toBe(before);
		expect(existsSync(join(dirname(dbPath), "workspace", "worktrees"))).toBe(
			false,
		);
	},
	timeout,
);

function valid(ids: Ids) {
	return { ...ids, repo: "acme/api", brief: "add a line to the README" };
}

test("reading a run that does not exist is not_found", async () => {
	const { api } = await serve();
	const response = await api.runs[":runId"].$get({
		param: { runId: randomUUID() },
	});
	expect(response.status).toBe(404);
	expect((await errorOf(response)).code).toBe("not_found");
});

test("the web client sees branded run ids and the run state union", () => {
	type Start = Awaited<ReturnType<Api["runs"]["$post"]>>;
	type StartAt<S extends number> = Awaited<
		ReturnType<Extract<Start, { status: S }>["json"]>
	>;
	type Read = Awaited<ReturnType<Api["runs"][":runId"]["$get"]>>;
	type ReadAt<S extends number> = Awaited<
		ReturnType<Extract<Read, { status: S }>["json"]>
	>;
	expectTypeOf<StartAt<201>["run"]["id"]>().toEqualTypeOf<RunId>();
	expectTypeOf<StartAt<201>["run"]["state"]>().toEqualTypeOf<RunState>();
	expectTypeOf<ReadAt<200>["run"]["state"]>().toEqualTypeOf<RunState>();
	expectTypeOf<StartAt<400>>().toEqualTypeOf<ApiErrorBody>();
	expectTypeOf<ReadAt<404>>().toEqualTypeOf<ApiErrorBody>();
});
