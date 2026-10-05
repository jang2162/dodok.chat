import type { IssueRunnerTokenResult, RunnerConfigSnippet } from "@dodok/shared";
import type { RefObject } from "react";
import { qk } from "@/api/queries";
import { IssueDialog } from "./IssueTokenDialog";
import { llmsHandoffLine } from "./llms";
import { CopyBlock } from "./sections";

/** 러너 설정 파일의 기본 자리(러너 스펙 4.1 `dodok-runner --config` 기본값) */
export const RUNNER_CONFIG_PATH = "~/.dodok-runner/config.json";
/** 러너 전용 Claude 로그인 디렉터리 — 사람의 `~/.claude` 와 섞지 않는다(러너 스펙 4.1 `claudeConfigDir`) */
export const RUNNER_CLAUDE_DIR = "~/.dodok-runner/claude";

/**
 * 러너 설정 파일 예시(러너 스펙 4.1) — 서버가 준 조각(serverUrl·tokenFile)에 로그인 디렉터리와 고쳐 쓸 에이전트 하나를 더한다.
 * 토큰 원문은 싣지 않는다 — 원문은 tokenFile 에 둔다
 */
export function runnerConfigExample(snippet: RunnerConfigSnippet): string {
  return JSON.stringify(
    {
      serverUrl: snippet.serverUrl,
      tokenFile: snippet.tokenFile,
      claudeConfigDir: RUNNER_CLAUDE_DIR,
      maxConcurrentRuns: 3,
      agents: [
        {
          id: "coder",
          name: "코더",
          workdir: "~/src/my-repo",
          workdirLabel: "my-repo",
          model: "sonnet",
          permissionMode: "default",
          allowedTools: ["Read", "Grep", "Glob"],
          disallowedTools: [],
        },
      ],
    },
    null,
    2,
  );
}

/** 러너 토큰 발급(러너 스펙 5장·7장) — 브리지 토큰 대화상자를 그대로 쓰고, 원문 아래에 토큰 파일 안내와 설정 파일 예시를 둔다 */
export function IssueRunnerTokenDialog({ triggerRef }: { triggerRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <IssueDialog<IssueRunnerTokenResult>
      triggerRef={triggerRef}
      triggerLabel="새 러너 토큰 발급"
      title="새 러너 토큰"
      description="알아볼 라벨을 붙입니다(예: 러너를 돌릴 머신 이름). 원문은 발급 직후 한 번만 보입니다."
      path="/setup/runner-tokens"
      listKey={qk.runnerTokens}
      handoff={(issued) => llmsHandoffLine("runner", issued.runnerConfig.serverUrl, issued.token)}
      config={(issued) => (
        <>
          <div className="grid min-w-0 gap-1.5">
            <p className="text-sm font-medium">토큰 파일</p>
            <p className="text-xs text-muted-foreground">
              러너 머신에서 토큰을 <code className="font-mono">{issued.runnerConfig.tokenFile}</code> 파일에
              저장하고 본인만 읽게 권한을 바꾸세요. 설정 파일에는 토큰을 적지 않습니다.
            </p>
            <CopyBlock text={`chmod 600 ${issued.runnerConfig.tokenFile}`} label="권한 명령 복사" />
          </div>
          <div className="grid min-w-0 gap-1.5">
            <p className="text-sm font-medium">러너 설정</p>
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">{RUNNER_CONFIG_PATH}</code> 로 저장하고{" "}
              <code className="font-mono">agents</code> 를 러너에서 돌릴 에이전트로 고치세요.
            </p>
            <CopyBlock
              text={runnerConfigExample(issued.runnerConfig)}
              label="설정 복사"
              testId="runner-config"
            />
          </div>
        </>
      )}
    />
  );
}
