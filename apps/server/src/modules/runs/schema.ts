import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { MinionId } from "../agents/model.ts";
import type { ProjectId } from "../projects/model.ts";
import { projects } from "../projects/schema.ts";
import type { RunId, RunState } from "./model.ts";

/** No foreign key to minions or project repos, because one would stop the delete of a minion or a repo that a run used. A run keeps its own copy of both. */
export const runs = sqliteTable(
	"runs",
	{
		id: text("id").$type<RunId>().primaryKey(),
		projectId: text("project_id")
			.$type<ProjectId>()
			.notNull()
			.references(() => projects.id),
		repoOwner: text("repo_owner").notNull(),
		repoName: text("repo_name").notNull(),
		repoDefaultBranch: text("repo_default_branch").notNull(),
		minionId: text("minion_id").$type<MinionId>().notNull(),
		minionName: text("minion_name").notNull(),
		brief: text("brief").notNull(),
		state: text("state").$type<RunState["kind"]>().notNull(),
		head: text("head"),
		reason: text("reason"),
		message: text("message"),
		startedAt: text("started_at").notNull(),
		endedAt: text("ended_at"),
	},
	(t) => [
		check(
			"run_state_columns",
			sql`(state = 'running' and ended_at is null and head is null and reason is null and message is null)
			or (state = 'succeeded' and ended_at is not null and head is not null and reason is null and message is null)
			or (state = 'failed' and ended_at is not null and head is null and reason is not null and message is not null)`,
		),
		index("runs_running").on(t.state).where(sql`state = 'running'`),
	],
);
