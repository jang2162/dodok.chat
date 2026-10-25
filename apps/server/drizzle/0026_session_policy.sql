-- 채널 세션 정책과 세션 관리자(채널 세션 스펙 「기존 표」 절·「권한」 장). 두 열 모두 ALTER … ADD 로 붙인다(표 다시 만들기 없음).
-- role 은 사람 행만 갖는다 — 에이전트 행은 null 로 둔다. 기존 사람 행은 "member" 로 채운다
ALTER TABLE `channel_members` ADD `role` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `session_policy_json` text DEFAULT '{"create":"members"}' NOT NULL;--> statement-breakpoint
UPDATE `channel_members` SET `role` = 'member' WHERE `member_type` = 'user';
