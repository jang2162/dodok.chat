ALTER TABLE `memberships` ADD `deactivated_at` integer;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `left_handle`;