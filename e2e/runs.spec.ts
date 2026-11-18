import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";
import type { Run } from "../apps/server/src/api.ts";
import { stubGateFile } from "../apps/server/src/modules/runs/stub.ts";
import { git } from "../apps/server/test/git.ts";
import { expect, test } from "./fixtures.ts";

async function created<T>(
	response: ReturnType<APIRequestContext["post"]>,
): Promise<T> {
	const answered = await response;
	expect(answered.status()).toBe(201);
	return (await answered.json()) as T;
}

async function readRun(request: APIRequestContext, id: string): Promise<Run> {
	const response = await request.get(`/api/runs/${id}`);
	expect(response.status()).toBe(200);
	return (await response.json()).run;
}

test("a run started over the API commits on its own branch, and a restart fails a run it cut short", async ({
	request,
	honeypot,
}) => {
	const { project } = await created<{ project: { id: string } }>(
		request.post("/api/projects", {
			data: { name: "Checkout", repos: ["acme/api"] },
		}),
	);
	const { minion } = await created<{ minion: { id: string } }>(
		request.post("/api/minions", {
			data: {
				name: "Scout",
				profile: { systemPrompt: "", skills: [], mcpServers: {} },
			},
		}),
	);
	const start = (brief: string) =>
		created<{ run: Run }>(
			request.post("/api/runs", {
				data: {
					projectId: project.id,
					minionId: minion.id,
					repo: "acme/api",
					brief,
				},
			}),
		);
	const held = (run: Run) => existsSync(stubGateFile(honeypot.gateDir, run.id));

	const { run: first } = await start("add a line to the README");
	await expect.poll(() => held(first)).toBe(true);
	await rm(stubGateFile(honeypot.gateDir, first.id));
	await expect
		.poll(async () => (await readRun(request, first.id)).state.kind)
		.toBe("succeeded");
	const done = await readRun(request, first.id);
	expect(done.state).toMatchObject({
		kind: "succeeded",
		head: await git(done.worktree, "rev-parse", "HEAD"),
	});
	expect(await git(done.worktree, "symbolic-ref", "HEAD")).toBe(
		`refs/heads/honeypot/run-${first.id}`,
	);
	expect(await git(done.worktree, "show", "HEAD:README.md")).toBe(
		"# acme/api\nadd a line to the README",
	);
	expect(await git(done.worktree, "log", "-1", "--format=%an")).toBe("Scout");

	const { run: second } = await start("add the line held");
	await expect.poll(() => held(second)).toBe(true);
	await honeypot.restart();
	expect((await readRun(request, second.id)).state).toMatchObject({
		kind: "failed",
		reason: "interrupted",
	});
	expect(
		(await readRun(request, first.id)).state,
		"a run that ended stays as it ended",
	).toEqual(done.state);
});
