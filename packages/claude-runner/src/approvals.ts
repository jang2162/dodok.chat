import { resolve } from "node:path";
import type { RunnerApprovalRequested, RunnerApprovalResolve } from "@dodok/shared";
import { createPathMasker, workdirRoots } from "./mask";
import type { CanUseTool } from "./sdk";

// 도구 승인(러너 스펙 6장). CLI 가 canUseTool 로 묻는 것을 approval.requested 로 사람에게 전하고 결정을 기다린다 —
// 무엇을 묻는가는 러너 설정과 CLI 가 정한다. 기한은 서버(러너 어댑터)가 쥐고 지나면 deny + reason "expired" 를 보낸다

export const APPROVAL_DENIED_MESSAGE = "사람이 거절했습니다";
export const APPROVAL_EXPIRED_MESSAGE = "승인 시간이 지났습니다";
/** 런이 멈춰 카드를 거뒀다 — CLI 는 이미 턴을 끝내는 중이라 모델이 이 글을 볼 일은 드물다 */
export const APPROVAL_WITHDRAWN_MESSAGE = "승인 요청이 철회됐습니다";

// shared RunnerApprovalRequested 의 길이 — 넘으면 어댑터가 프레임을 버려 결정이 영영 안 온다
const SUMMARY_MAX = 400;
const TOOL_NAME_MAX = 128;
const JSON_SUMMARY_MAX = 200;
// 값 전체가 경로 하나인 파일 도구 입력 키 — 요약은 그 경로만
const FILE_TOOL_PATH_KEY: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export type ApprovalOutcome = Pick<RunnerApprovalResolve, "decision" | "reason">;

export type CanUseToolDeps = {
  runId: string;
  sessionKey: string;
  workdir: string;
  emit: (p: RunnerApprovalRequested) => void;
  withdraw: (providerApprovalId: string) => void;
  /** 결정이 오면 풀리고 signal 이 끊기면 거절된다 */
  waitDecision: (providerApprovalId: string, signal: AbortSignal) => Promise<ApprovalOutcome>;
  /** 런의 signal(중지·연결 끊김). SDK 가 콜백 signal 을 끊는 것은 CLI 의 취소 요청이 온 뒤라 따로 본다 */
  signal?: AbortSignal;
};

/** 코드 포인트 경계에서 UTF-16 길이 max 안으로 — 스키마 길이는 UTF-16 이고 서로게이트 쌍을 가르지 않는다 */
function clip(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** 승인 카드의 요약. Bash 는 명령, 파일 도구는 작업 디렉터리 상대 경로, 그 밖은 입력 JSON 앞 200자 — 호스트 경로는 가린다 */
export function summarizeToolInput(toolName: string, input: unknown, workdir: string): string {
  const mask = createPathMasker(workdirRoots(workdir));
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pathKey = FILE_TOOL_PATH_KEY[toolName];
  let summary: string;
  if (toolName === "Bash" && typeof record.command === "string") {
    summary = mask(record.command);
  } else if (pathKey !== undefined && typeof record[pathKey] === "string") {
    // 상대 경로는 작업 디렉터리에 붙여 본다 — `../../etc/hosts` 도 밖으로 가려진다
    summary = mask.path(resolve(workdir, record[pathKey]));
  } else {
    summary = clip(mask.json(JSON.stringify(input) ?? "null"), JSON_SUMMARY_MAX);
  }
  return clip(summary, SUMMARY_MAX);
}

export function createCanUseTool(deps: CanUseToolDeps): CanUseTool {
  return async (toolName, input, options) => {
    const id = options.toolUseID;
    const signal = deps.signal ? AbortSignal.any([options.signal, deps.signal]) : options.signal;
    if (signal.aborted) return { behavior: "deny", message: APPROVAL_WITHDRAWN_MESSAGE };
    const suggestions = options.suggestions ?? [];
    // suppressAlwaysAllowRule — 그 규칙이 이 요청보다 넓은 것을 허용한다고 CLI 가 알린 경우
    const canAllowAlways = suggestions.length > 0 && options.suppressAlwaysAllowRule !== true;
    // 기다림을 먼저 건다 — 결정이 요청 프레임과 같은 틱에 돌아와도 잃지 않게
    const decision = deps.waitDecision(id, signal);
    deps.emit({
      providerApprovalId: id,
      runId: deps.runId,
      sessionKey: deps.sessionKey,
      toolCallId: id,
      toolName: clip(toolName, TOOL_NAME_MAX),
      summary: summarizeToolInput(toolName, input, deps.workdir),
      canAllowAlways,
    });
    let outcome: ApprovalOutcome;
    try {
      outcome = await decision;
    } catch {
      deps.withdraw(id);
      return { behavior: "deny", message: APPROVAL_WITHDRAWN_MESSAGE };
    }
    if (outcome.decision === "deny") {
      return {
        behavior: "deny",
        message: outcome.reason === "expired" ? APPROVAL_EXPIRED_MESSAGE : APPROVAL_DENIED_MESSAGE,
      };
    }
    if (outcome.decision === "allow-always" && canAllowAlways) {
      // 제안은 localSettings 로 온다(ADR 0007 4.2) — 러너 머신의 설정 파일에 쓰지 않고 이 세션에만
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: suggestions.map((s) => ({ ...s, destination: "session" as const })),
      };
    }
    return { behavior: "allow", updatedInput: input };
  };
}
