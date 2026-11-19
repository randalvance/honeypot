import { access, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunId } from "./model.ts";
import type { RuntimeAdapter, SessionEnd } from "./runtime.ts";

export function stubGateFile(gateDir: string, runId: RunId): string {
	return join(gateDir, `${runId}.held`);
}

/** Appends the brief to `README.md` and never runs git. A brief `fail: <message>` ends the session failed after its edit. */
export function createStubRuntime(config: {
	readonly gateDir?: string;
}): RuntimeAdapter {
	return {
		async run(session, signal): Promise<SessionEnd> {
			try {
				await appendFile(join(session.cwd, "README.md"), `${session.brief}\n`);
				if (config.gateDir !== undefined) {
					const gate = stubGateFile(config.gateDir, session.runId);
					await writeFile(gate, "");
					while (await exists(gate)) await delay(20, undefined, { signal });
				}
			} catch (error) {
				return {
					kind: "failed",
					message: error instanceof Error ? error.message : String(error),
				};
			}
			const failure = /^fail:\s*(.+)/.exec(session.brief);
			return failure?.[1] === undefined
				? { kind: "finished" }
				: { kind: "failed", message: failure[1] };
		},
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
