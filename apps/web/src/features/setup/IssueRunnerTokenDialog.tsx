import type { IssueRunnerTokenResult } from "@dodok/shared";
import type { RefObject } from "react";
import { qk } from "@/api/queries";
import { IssueDialog } from "./IssueTokenDialog";
import { llmsHandoffLine } from "./llms";
import { RunnerQuickStart } from "./RunnerSection";

/** 러너 토큰 발급(러너 스펙 5장·7장) — 브리지 토큰 대화상자를 그대로 쓰고, 원문 아래에 설치·실행·서버 주소를 둔다(실행하면 러너가 서버 주소와 토큰을 묻는다) */
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
      config={(issued) => <RunnerQuickStart serverUrl={issued.runnerConfig.serverUrl} />}
    />
  );
}
