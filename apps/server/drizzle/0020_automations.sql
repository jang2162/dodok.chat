CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`body_md` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`schedule_json` text,
	`next_run_at` integer,
	`token_hash` text,
	`token_prefix` text,
	`last_run_at` integer,
	`last_status` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_ws_name` ON `automations` (`workspace_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `automations_token_hash` ON `automations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `automations_due` ON `automations` (`enabled`,`kind`,`next_run_at`);