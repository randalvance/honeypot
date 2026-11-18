# ADR 0003: Minions run through a runtime adapter, each in its own worktree

- Status: accepted
- Date: 2026-11-18
- Epic: [#4 Agent runtime: run one minion on one task](https://github.com/randalvance/honeypot/issues/4)

## Context

Epic #4 runs a minion on a brief in a project repo. Its first acceptance box asks that an API call run a minion on a sample repo with the brief "add a line to the README", and that the commit appear on the run's own branch. Its fourth box asks that two concurrent runs on one repo each change only their own worktree.

The first agent is Claude, through the Claude Agent SDK. A test cannot call it. It needs an API key, it costs money per run, and it answers differently each time. The browser tests start the server as a child process, so they can configure it only through environment variables.

Nothing in the codebase cloned a repo or ran git before this epic.

## Decision

The runs module calls one interface, `RuntimeAdapter`, and owns everything around the agent: the worktree, the final commit, and the run's state.

| Concern | Choice |
| --- | --- |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.322, pinned exactly. It was the newest release that `minimumReleaseAge` allowed when the epic started. `modules/runs/claude.ts` is the only file that imports it, and it loads the SDK with a dynamic import, so the tests never load it. |
| Adapter | `RuntimeAdapter.run(session, signal)` resolves `finished` or `failed` and never rejects. The runs store builds the `Session`, which holds the worktree, the branch, the minion, the project context, and the brief. An adapter never reads the database. |
| Picking an adapter | `RuntimeConfig` is data, either `{ kind: "claude" }` or `{ kind: "stub", gateDir? }`. `main.ts` builds it from `HONEYPOT_RUNTIME` and `HONEYPOT_STUB_GATE_DIR`, so the browser tests pick the stub the same way they pick the GitHub stub. |
| The stub | It appends the brief to `README.md` in the worktree and never runs git. A brief that starts with `fail:` ends the session as failed. With a gate folder, each session writes `<gateDir>/<runId>.held` after its edit and waits until a test deletes that file, so a test can hold two runs in the middle of their work. |
| Repo layout | One bare clone per repo at `<workspace>/repos/<owner>/<name>.git`, with no checkout, shared by every run. Each run adds its own worktree at `<workspace>/worktrees/run-<id>` on its own branch, `honeypot/run-<id>`, cut from the remote's default branch. `<workspace>/scratch/run-<id>` holds the agent's config folder outside the worktree. Opening a worktree runs one at a time per repo, because two fetches into one bare clone race on its refs. |
| Clone source | `GITHUB_SERVER_URL`, default `https://github.com`, which is the name GitHub Actions already sets. The tests point it at a folder of local bare repos. |
| The final commit | When the adapter finishes, the runtime stages whatever the minion left uncommitted and commits it as one commit on the run's branch. The run records the branch tip as its `head`. A failed session commits nothing, and its worktree keeps the changes. |
| Hermetic git | Every git process the runtime starts, and the agent's own environment, carry the minion's name and the email `<minionId>@minions.honeypot.invalid` in `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, plus `commit.gpgsign=false`. The identity goes in the environment because the dev container exports the developer's identity there, and git prefers the environment over repo config. Git reads no system config and never prompts. It still reads the global config, so the dev container's `gh` credential helper can fetch private repos. |
| Hermetic agent | `settingSources: []` loads no user or project settings and no `CLAUDE.md`. `strictMcpConfig: true` loads only the minion's MCP servers. `CLAUDE_CONFIG_DIR` points into the run's scratch folder. The agent's environment drops `GITHUB_TOKEN` and `GH_TOKEN`. Tool rules allow file edits in the worktree and `git status`, `diff`, `log`, `add`, and `commit`, and they deny `git push`, `checkout`, and `switch`. A tool call that no rule allows is denied, because the run has no `canUseTool` callback. The runtime copies the minion's skills into a per-run plugin, and the `skills` option enables only those. |
| Restarts | Shutdown aborts every live run and writes nothing for it. The next start's `runs.recover()` fails each row that is still `running` with the reason `interrupted`. `recover()` is the only writer of that reason, so a crash and a clean stop end the same way. |

## Consequences

- The tests and the browser tests never start a Claude Code process. `claude.ts` runs only under `pnpm dev`, which needs `ANTHROPIC_API_KEY`. `.devcontainer/devcontainer.json` passes it in from the host.
- `pnpm test` needs `git` on the `PATH`.
- Worktrees, run branches, and bare clones stay on disk after a run ends. Cleanup is a later decision.
- Runs never push. A later epic pushes the run's branch and opens a pull request.
- Each Claude run is one Claude Code process. Nothing caps how many run at once yet.
- The transcript (box 2), outcome lists (box 3), and cancel (box 5) extend `Session` and `RunFailure` without changing what exists. A stored failure reason is never renamed or removed, because run rows keep parsing forever.

## Alternatives considered

- **A full clone per run.** Each run would fetch the whole history, and five runs on one repo would hold five object stores.
- **One shared checkout with a branch switch per run.** Two concurrent runs would edit the same files, which box 4 rules out.
- **Pass the adapter object into `start()`.** The server tests could do that, but the browser tests start `main.ts` as a process and can set only environment variables.
- **Let the minion make every commit.** A minion that edits files and stops without committing would leave its run with no commit, so box 1 would depend on the model remembering a step.
- **`permissionMode: "bypassPermissions"`.** The agent could then run any shell command, `git push` included.
- **Mock the SDK's `query` in the tests.** The test would check our call against our own guess of the SDK's behavior, and it would still need an update on each SDK release.
