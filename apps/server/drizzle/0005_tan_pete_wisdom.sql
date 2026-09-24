CREATE TABLE `ops_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`key` text NOT NULL,
	`detail_json` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`resolved_at` integer,
	`acked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ops_events_ws_last` ON `ops_events` (`workspace_id`,`last_at`);--> statement-breakpoint
CREATE INDEX `ops_events_open` ON `ops_events` (`workspace_id`,`kind`,`key`,`acked_at`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `ops_json` text DEFAULT '{}' NOT NULL;