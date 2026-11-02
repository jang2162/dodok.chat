ALTER TABLE `agents` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `users` ADD `status_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `status_mode_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status_emoji` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status_text` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status_text_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `dnd_allow_approvals` integer DEFAULT true NOT NULL;