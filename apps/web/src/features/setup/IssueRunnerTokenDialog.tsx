import type { IssueRunnerTokenResult } from "@dodok/shared";
import type { RefObject } from "react";
import { qk } from "@/api/queries";
import { IssueDialog } from "./IssueTokenDialog";
import { llmsHandoffLine } from "./llms";
import { RUNNER_CONFIG_PATH, runnerConfigExample } from "./runnerConfig";
import { CopyBlock } from "./sections";

/** 토큰 파일 안내 — 발급·다시 발급이 함께 쓴다 */
export function RunnerTokenFile({ tokenFile }: { tokenFile: string }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <p className="text-sm font-medium">토큰 파일</p>
      <p className="text-xs text-muted-foreground">
        <code className="font-mono">{tokenFile}</code>
      </p>
      <CopyBlock text={`chmod 600 ${tokenFile}`} label="권한 명령 복사" />
    </div>
  );
}

/** 러너 토큰 발급(러너 스펙 5장·7장) — 브리지 토큰 대화상자를 그대로 쓰고, 원문 아래에 토큰 파일 안내와 설정 파일 예시를 둔다 */
export function IssueRunnerTokenDialog({
  triggerRef,
  onDone,
}: {
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** 「복사했습니다」 뒤 — 발급한 토큰(= 러너) id */
  onDone?: (tokenId: string) => void;
}) {
  return (
    <IssueDialog<IssueRunnerTokenResult>
      triggerRef={triggerRef}
      onDone={(issued) => onDone?.(issued.record.id)}
      triggerLabel="새 러너 토큰 발급"
      title="새 러너 토큰"
      path="/setup/runner-tokens"
      listKey={qk.runnerTokens}
      handoff={(issued) => llmsHandoffLine("runner", issued.runnerConfig.serverUrl, issued.token)}
      config={(issued) => (
        <>
          <RunnerTokenFile tokenFile={issued.runnerConfig.tokenFile} />
          <div className="grid min-w-0 gap-1.5">
            <p className="text-sm font-medium">러너 설정</p>
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">{RUNNER_CONFIG_PATH}</code>
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
