import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadGitHubToken } from "./modules/projects/github.ts";
import { RuntimeConfig } from "./modules/runs/runtime.ts";
import { start } from "./server.ts";

const Env = z.object({
	// Not 0, because the Vite proxy reads this port and cannot follow an ephemeral one.
	HONEYPOT_PORT: z.coerce.number().int().min(1).max(65535),
	HONEYPOT_DB_PATH: z
		.string()
		.min(1)
		.default(fileURLToPath(new URL("../.data/honeypot.db", import.meta.url))),
	HONEYPOT_SKILLS_DIR: z.string().min(1).optional(),
	HONEYPOT_WORKSPACE_DIR: z.string().min(1).optional(),
	HONEYPOT_RUNTIME: z.string().default("claude"),
	HONEYPOT_STUB_GATE_DIR: z.string().min(1).optional(),
	GITHUB_API_URL: z.url().default("https://api.github.com"),
	GITHUB_SERVER_URL: z.url().default("https://github.com"),
});

const env = Env.safeParse(process.env);
if (!env.success) throw new Error(z.prettifyError(env.error));
const gateDir = env.data.HONEYPOT_STUB_GATE_DIR;
const runtime = RuntimeConfig.safeParse({
	kind: env.data.HONEYPOT_RUNTIME,
	...(gateDir === undefined ? {} : { gateDir }),
});
if (!runtime.success) {
	throw new Error(
		`HONEYPOT_RUNTIME and HONEYPOT_STUB_GATE_DIR: ${z.prettifyError(runtime.error)}`,
	);
}
if (runtime.data.kind === "claude" && !process.env.ANTHROPIC_API_KEY) {
	console.warn(
		"no ANTHROPIC_API_KEY: runs will fail. Set it, or set HONEYPOT_RUNTIME=stub.",
	);
}

const token = await loadGitHubToken(process.env);
if (token === undefined) {
	console.warn(
		"no GitHub token: set GITHUB_TOKEN or run gh auth login. Repo checks will fail.",
	);
}
const server = await start({
	port: env.data.HONEYPOT_PORT,
	dbPath: env.data.HONEYPOT_DB_PATH,
	skillsDir:
		env.data.HONEYPOT_SKILLS_DIR ??
		join(dirname(env.data.HONEYPOT_DB_PATH), "skills"),
	workspaceDir:
		env.data.HONEYPOT_WORKSPACE_DIR ??
		join(dirname(env.data.HONEYPOT_DB_PATH), "workspace"),
	github: {
		apiUrl: new URL(env.data.GITHUB_API_URL),
		serverUrl: new URL(env.data.GITHUB_SERVER_URL),
		token,
	},
	runtime: runtime.data,
});
console.log(`honeypot server listening on ${server.url.href}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void server.stop().then(() => process.exit(0)));
}
