CREATE TABLE `conversation_reads` (
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`last_read_seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `conversation_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 손으로 덧붙인 옮기기(채널 세션 계획 태스크 7) — 읽음 위치를 채널 단위(channel_reads)에서 대화 단위로 옮긴다. channel_reads 를 지우기 전에 둔다.
-- ① 옛 채널 읽음은 그 채널의 「이전 대화」(id = 채널 id, 0025 가 만든 것)로 옮긴다. 그 대화의 last_seq 로 깎는다 — markRead 와 같은 불변식
--    (같은 채널의 다른 세션이 뒤에 쓴 글의 seq 까지 채널 읽음에 들어 있을 수 있다). 행이 없던 사람(뒤에 가입·처음 여는 채널)은 그대로 0 이다
INSERT INTO `conversation_reads` (`user_id`, `conversation_id`, `last_read_seq`, `updated_at`)
SELECT r.`user_id`, v.`id`, MIN(r.`last_read_seq`, v.`last_seq`), r.`updated_at`
FROM `channel_reads` r JOIN `conversations` v ON v.`id` = r.`channel_id`;
--> statement-breakpoint
-- ② 그 밖의 대화(0025 뒤에 만든 세션)는 membership 이 있는 사용자(비활성 포함 — 다시 활성화하면 그대로 돌아온다) × 그 워크스페이스의 대화를
--    그 대화의 last_seq 까지 읽음으로 채운다 — 0018 시드와 같은 까닭(배포 직후 모든 세션이 굵어지지 않게). 뒤에 만든 세션은 행이 없어 0 이다
INSERT INTO `conversation_reads` (`user_id`, `conversation_id`, `last_read_seq`, `updated_at`)
SELECT m.`user_id`, v.`id`, v.`last_seq`, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `memberships` m
JOIN `channels` c ON c.`workspace_id` = m.`workspace_id`
JOIN `conversations` v ON v.`channel_id` = c.`id`
WHERE v.`id` <> c.`id`;
--> statement-breakpoint
DROP TABLE `channel_reads`;