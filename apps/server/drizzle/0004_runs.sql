CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`repo_default_branch` text NOT NULL,
	`minion_id` text NOT NULL,
	`minion_name` text NOT NULL,
	`brief` text NOT NULL,
	`state` text NOT NULL,
	`head` text,
	`reason` text,
	`message` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_state_columns" CHECK((state = 'running' and ended_at is null and head is null and reason is null and message is null)
			or (state = 'succeeded' and ended_at is not null and head is not null and reason is null and message is null)
			or (state = 'failed' and ended_at is not null and head is null and reason is not null and message is not null))
);
--> statement-breakpoint
CREATE INDEX `runs_running` ON `runs` (`state`) WHERE state = 'running';