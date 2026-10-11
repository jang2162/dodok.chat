CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`platform` text NOT NULL,
	`token` text NOT NULL,
	`app_id` text NOT NULL,
	`environment` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_token` ON `push_devices` (`token`);--> statement-breakpoint
CREATE INDEX `push_devices_user` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `push_devices_session` ON `push_devices` (`session_id`);