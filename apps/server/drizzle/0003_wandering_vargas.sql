CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`uploader_type` text NOT NULL,
	`uploader_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_sha256` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE INDEX `attachments_unbound` ON `attachments` (`message_id`,`created_at`);