ALTER TABLE `runner_tokens` ADD `update_queued_at` integer;--> statement-breakpoint
ALTER TABLE `runner_tokens` ADD `update_queued_by` text REFERENCES users(id);