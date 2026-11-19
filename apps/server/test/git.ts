import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";

const fixture = "Fixture <fixture@example.invalid>";

function run(
	cwd: string,
	args: readonly string[],
	input?: string,
): Promise<string> {
	const {
		GIT_DIR: _dir,
		GIT_WORK_TREE: _workTree,
		GIT_INDEX_FILE: _index,
		GIT_OBJECT_DIRECTORY: _objects,
		...inherited
	} = process.env;
	const env = {
		...inherited,
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_TERMINAL_PROMPT: "0",
	};
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{ cwd, env },
			(error, stdout, stderr) => {
				if (error === null) return resolve(stdout.trimEnd());
				reject(
					new Error(
						`git ${args.join(" ")} in ${cwd}: ${stderr.trim() || error.message}`,
					),
				);
			},
		);
		if (input === undefined) child.stdin?.end();
		else child.stdin?.end(input);
	});
}

/** Runs git as the fixture identity and resolves with its output, trailing whitespace removed. */
export function git(cwd: string, ...args: string[]): Promise<string> {
	return run(cwd, args);
}

/** A bare repo at `dir` whose `branch` holds one commit adding `README.md` as `# <name>\n`. Fixed dates keep the commit's SHA the same on every run. */
export async function seedRepo(
	dir: string,
	name: string,
	branch: string,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await run(dir, ["init", "--quiet", "--bare"]);
	const message = `Seed ${name}\n`;
	const readme = `# ${name}\n`;
	const when = "1767225600 +0000";
	const stream = [
		`commit refs/heads/${branch}`,
		`author ${fixture} ${when}`,
		`committer ${fixture} ${when}`,
		`data ${Buffer.byteLength(message)}`,
		message,
		"M 100644 inline README.md",
		`data ${Buffer.byteLength(readme)}`,
		readme,
		"",
	].join("\n");
	await run(dir, ["fast-import", "--quiet"], stream);
}
