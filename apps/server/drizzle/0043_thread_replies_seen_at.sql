ALTER TABLE `agent_sessions` ADD `thread_replies_seen_at` integer;
--> statement-breakpoint
UPDATE `agent_sessions` SET `thread_replies_seen_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `thread_replies_seen_at` IS NULL;
