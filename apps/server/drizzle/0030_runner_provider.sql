DROP INDEX `agents_claude_ws_agent`;--> statement-breakpoint
ALTER TABLE `agents` ADD `program` text;--> statement-breakpoint
-- 손으로 덧붙인 옮기기(러너 일반화 계획 판정 PR6) — 제공자는 연결 방식(openclaw·runner)이고 러너 안에서 돌리는 것은 program 이다.
-- 옛 claude 에이전트는 러너 에이전트 + 프로그램 claude 로 옮긴다. 새 부분 유일 색인(provider = 'runner')보다 먼저 둔다
UPDATE `agents` SET `provider` = 'runner', `program` = 'claude' WHERE `provider` = 'claude';
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_runner_ws_agent` ON `agents` (`workspace_id`,`provider`,`provider_agent_id`) WHERE provider = 'runner';
