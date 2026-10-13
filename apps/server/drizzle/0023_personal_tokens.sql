CREATE TABLE `personal_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_tokens_hash` ON `personal_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `personal_tokens_user_created` ON `personal_tokens` (`user_id`,`created_at`);