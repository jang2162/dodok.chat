ALTER TABLE `channels` ADD `direct_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `channels_direct_key` ON `channels` (`workspace_id`,`direct_key`) WHERE kind = 'direct';