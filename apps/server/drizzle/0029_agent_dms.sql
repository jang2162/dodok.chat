ALTER TABLE `agents` ADD `dm_access` text DEFAULT 'admins' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `kind` text DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `dm_owner_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `channels` ADD `dm_agent_id` text REFERENCES agents(id);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_dm_pair` ON `channels` (`dm_owner_id`,`dm_agent_id`) WHERE kind = 'dm';