CREATE TABLE `channel_reads` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`last_read_seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `channel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 손으로 덧붙인 시드(읽지 않음 스펙 「channel_reads (새 표·새 마이그레이션)」 절) — 배포 직후 모든 채널이 굵어지지 않게 membership 이 있는
-- 사용자(비활성 포함 — 다시 활성화하면 그대로 돌아온다) × 그 워크스페이스의 모든 채널을 지금 last_seq 까지 읽음으로 채운다. 뒤에 가입한
-- 멤버·뒤에 만든 채널은 행이 없어 0 이다
INSERT INTO `channel_reads` (`user_id`, `channel_id`, `last_read_seq`, `updated_at`)
SELECT m.`user_id`, c.`id`, c.`last_seq`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `memberships` m JOIN `channels` c ON c.`workspace_id` = m.`workspace_id`;
