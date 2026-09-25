DROP INDEX `agent_sessions_channel_agent`;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `thread_root_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_channel_agent_thread` ON `agent_sessions` (`channel_id`,`agent_id`,`thread_root_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_channel_session` ON `agent_sessions` (`channel_id`,`agent_id`) WHERE thread_root_id IS NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `thread_root_id` text;--> statement-breakpoint
CREATE INDEX `messages_channel_thread_seq` ON `messages` (`channel_id`,`thread_root_id`,`seq`);--> statement-breakpoint
ALTER TABLE `runs` ADD `thread_root_id` text;