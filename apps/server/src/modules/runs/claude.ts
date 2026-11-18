import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Options,
	query,
	type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeAdapter, Session, SessionEnd } from "./runtime.ts";

const pluginName = "honeypot";

const allowedTools = [
	"Read",
	"Glob",
	"Grep",
	"Edit",
	"Write",
	"Bash(git status *)",
	"Bash(git diff *)",
	"Bash(git log *)",
	"Bash(git add *)",
	"Bash(git commit *)",
];

const disallowedTools = [
	"Bash(git push *)",
	"Bash(git checkout *)",
	"Bash(git switch *)",
	"WebFetch",
	"WebSearch",
];

/** Runs the minion as one Claude Code process through the Claude Agent SDK. */
export function createClaudeRuntime(deps: {
	readonly skillsDir: string;
}): RuntimeAdapter {
	return {
		async run(session, signal) {
			const abortController = new AbortController();
			const abort = () => abortController.abort(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			try {
				signal.throwIfAborted();
				const plugin = await copySkillsIntoRunPlugin(session, deps.skillsDir);
				const messages = query({
					prompt: session.brief,
					options: options(session, plugin, abortController),
				});
				for await (const message of messages) {
					if (message.type === "result") return toEnd(message);
				}
				return {
					kind: "failed",
					message: "the agent stopped without a result",
				};
			} catch (error) {
				return {
					kind: "failed",
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
	};
}

function options(
	session: Session,
	plugin: string | undefined,
	abortController: AbortController,
): Options {
	const { profile } = session.minion;
	return {
		cwd: session.cwd,
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: briefing(session),
		},
		settingSources: [],
		strictMcpConfig: true,
		mcpServers: profile.mcpServers,
		plugins: plugin === undefined ? [] : [{ type: "local", path: plugin }],
		skills: profile.skills.map((ref) => `${pluginName}:${ref}`),
		permissionMode: "acceptEdits",
		allowedTools: [
			...allowedTools,
			...Object.keys(profile.mcpServers).map((name) => `mcp__${name}`),
		],
		disallowedTools,
		maxTurns: 100,
		env: agentEnv(session),
		abortController,
	};
}

function agentEnv(session: Session): Record<string, string | undefined> {
	const { GITHUB_TOKEN: _github, GH_TOKEN: _gh, ...inherited } = process.env;
	return {
		...inherited,
		...session.gitEnv,
		CLAUDE_CONFIG_DIR: join(session.scratch, "claude"),
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	};
}

async function copySkillsIntoRunPlugin(
	session: Session,
	skillsDir: string,
): Promise<string | undefined> {
	const { skills } = session.minion.profile;
	if (skills.length === 0) return undefined;
	const root = join(session.scratch, "plugin");
	await mkdir(join(root, ".claude-plugin"), { recursive: true });
	await writeFile(
		join(root, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: pluginName }),
	);
	await Promise.all(
		skills.map((ref) =>
			cp(join(skillsDir, ref), join(root, "skills", ref), {
				recursive: true,
				dereference: true,
			}),
		),
	);
	return root;
}

function briefing(session: Session): string {
	const { minion, project, cwd, branch } = session;
	const sections = [minion.profile.systemPrompt];
	if (project.context.length > 0) {
		sections.push(
			`# Context for the project ${project.name}`,
			...project.context.map((entry) => `## ${entry.title}\n\n${entry.body}`),
		);
	}
	if (minion.memory.length > 0) {
		sections.push(
			"# Your memory notes",
			...minion.memory.map((note) => `## ${note.name}\n\n${note.body}`),
		);
	}
	sections.push(
		`# This run\n\nWork only in ${cwd}, on the branch ${branch}. You may commit as you go. When you finish, Honeypot commits whatever you leave uncommitted. Do not push, and do not switch branches.`,
	);
	return sections.filter((section) => section !== "").join("\n\n");
}

function toEnd(result: SDKResultMessage): SessionEnd {
	if (result.subtype === "success") {
		return result.is_error
			? { kind: "failed", message: result.result }
			: { kind: "finished" };
	}
	return {
		kind: "failed",
		message: [result.subtype, ...result.errors].join(": "),
	};
}
