CREATE TABLE `message_reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_reactions_message` ON `message_reactions` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_reactions_created` ON `message_reactions` (`created_at`);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `reactions_seen_at` integer;
--> statement-breakpoint
UPDATE `agent_sessions` SET `reactions_seen_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `reactions_seen_at` IS NULL;
