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
 * 러너 설정 파일 예시 — 러너의 `RunnerConfig`(packages/claude-runner config.ts)와 같은 꼴, 서버 llms.txt 안내서의 예시와 같은 값. 서버가 준
 * 조각(serverUrl·tokenFile)에 루트 하나와 Claude Code 프로그램 하나를 더한다. 에이전트는 이 파일이 아니라 앱에서 만든다(러너 일반화 스펙
 * 2장). 루트 `label` 을 적는 예를 둔다 — 안 적으면 디렉터리 이름(홈이면 계정 이름)이 서버로 간다. 토큰 원문은 싣지 않는다(tokenFile)
 */
export function runnerConfigExample(snippet: RunnerConfigSnippet): string {
  return JSON.stringify(
    {
      serverUrl: snippet.serverUrl,
      tokenFile: snippet.tokenFile,
      maxConcurrentRuns: 3,
      roots: [{ id: "src", path: "~/src", label: "내 저장소들" }],
      browse: true,
      programs: {
        claude: {
          configDir: RUNNER_CLAUDE_DIR,
          maxPermissionMode: "default",
          disallowedTools: [],
          allowedToolsCeiling: null,
        },
      },
    },
    null,
    2,
  );
}

/** 토큰 파일 안내 — 발급·다시 발급이 함께 쓴다 */
export function RunnerTokenFile({ tokenFile }: { tokenFile: string }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <p className="text-sm font-medium">토큰 파일</p>
      <p className="text-xs text-muted-foreground">
        러너 머신에서 토큰을 <code className="font-mono">{tokenFile}</code> 파일에 저장하고 본인만 읽게 권한을
        바꾸세요. 설정 파일에는 토큰을 적지 않습니다.
      </p>
      <CopyBlock text={`chmod 600 ${tokenFile}`} label="권한 명령 복사" />
    </div>
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
          <RunnerTokenFile tokenFile={issued.runnerConfig.tokenFile} />
          <div className="grid min-w-0 gap-1.5">
            <p className="text-sm font-medium">러너 설정</p>
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">{RUNNER_CONFIG_PATH}</code> 로 저장하고{" "}
              <code className="font-mono">roots</code> 를 에이전트가 돌 디렉터리로 좁게 고치세요. 루트의{" "}
              <code className="font-mono">label</code> 을 꼭 적으세요 — 안 적으면 디렉터리 이름이 서버로
              갑니다. 에이전트는 이 파일이 아니라 앱의 「에이전트」 탭에서 만듭니다.
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
