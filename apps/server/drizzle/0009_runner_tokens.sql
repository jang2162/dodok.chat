CREATE TABLE `runner_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_tokens_hash` ON `runner_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `runner_tokens_ws_created` ON `runner_tokens` (`workspace_id`,`created_at`);