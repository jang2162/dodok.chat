import { resolve } from "node:path";
import type { RunnerApprovalRequested } from "@dodok/shared";
import { type ApprovalOutcome, workdirMasker } from "../../sink";
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
const ARGS_MAX = 16_000;
// 값 전체가 경로 하나인 파일 도구 입력 키 — 요약은 그 경로만
const FILE_TOOL_PATH_KEY: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export type { ApprovalOutcome };

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

/** clip 의 뒤쪽판 — 끝에서부터 max 안으로 */
function clipEnd(text: string, max: number): string {
  const chars = Array.from(text);
  let out = "";
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]!;
    if (out.length + ch.length > max) break;
    out = ch + out;
  }
  return out;
}

const elisionMark = (omitted: number): string => ` …(가운데 ${omitted}자 생략)… `;

/**
 * max 를 넘으면 가운데를 줄이고 표시를 남긴다 — 앞만 남기면 `echo aaa…; curl … | sh` 의 꼬리를 사람이 못 보고 허용한다.
 * 앞 약 2/3, 뒤 약 1/3(400 이면 앞 약 250·뒤 약 125). 생략 수는 코드 포인트
 */
export function elide(text: string, max: number): string {
  if (text.length <= max) return text;
  // 표시 길이는 생략 수의 자릿수에 달렸다 — 글 전체 길이의 자릿수로 넉넉히 잡는다
  const room = max - elisionMark(text.length).length;
  const tail = clipEnd(text, Math.floor(room / 3));
  const head = clip(text, room - tail.length);
  const omitted = Array.from(text).length - Array.from(head).length - Array.from(tail).length;
  return head + elisionMark(omitted) + tail;
}

// 카드에서 글을 숨기거나 뒤집는 글자 — 목록이 아니라 부류로 잡는다. 제어 문자 \p{Cc}(줄바꿈·탭·CR·ESC 등), 서식 문자 \p{Cf}
// (양방향 서식·ZWSP·BOM·소프트 하이픈·태그 — ZWJ 만 빼 ZWJ 이모지를 살린다), 줄·문단 구분자 \p{Zl}·\p{Zp}, U+0020 이 아닌 공백
// \p{Zs}(NBSP·U+3000 등), 폭은 있고 글리프가 빈 한글 채움 문자(U+115F·1160·3164·FFA0)와 점자 빈칸(U+2800).
// 줄바꿈이나 빈 글자 수백 개로 꼬리를 인자 상자 밖으로 밀거나 U+202E 로 꼬리를 뒤집어 보이게 할 수 있다(N1·N1′)
const HIDING_CHARS =
  /(?![\u{20}\u{200D}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu;
const NAMED_ESCAPES: Record<string, string> = { "\n": "⏎", "\r": "\\r", "\t": "\\t" };

/** 숨기는 글자를 보이게 바꾼다 — 줄바꿈은 ⏎ 로 한 줄에 접고, 나머지는 `\r`·`\t`·`\u{202E}` 꼴 */
function revealHidden(text: string): string {
  return text.replace(
    HIDING_CHARS,
    (ch) => NAMED_ESCAPES[ch] ?? `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
}

/**
 * 승인 카드의 요약. Bash 는 명령, 파일 도구는 작업 디렉터리 상대 경로, 그 밖은 입력 JSON 200자 — 호스트 경로는 가리고,
 * 숨기는 글자를 보이게 바꾼 뒤(revealHidden), 길면 가운데를 줄인다
 */
export function summarizeToolInput(toolName: string, input: unknown, workdir: string): string {
  const mask = workdirMasker(workdir);
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pathKey = FILE_TOOL_PATH_KEY[toolName];
  let summary: string;
  if (toolName === "Bash" && typeof record.command === "string") {
    summary = revealHidden(mask(record.command));
  } else if (pathKey !== undefined && typeof record[pathKey] === "string") {
    // 상대 경로는 작업 디렉터리에 붙여 본다 — `../../etc/hosts` 도 밖으로 가려진다
    summary = revealHidden(mask.path(resolve(workdir, record[pathKey])));
  } else {
    // JSON.stringify 는 양방향 서식·U+2028 을 이스케이프하지 않는다
    summary = elide(revealHidden(mask.json(JSON.stringify(input) ?? "null")), JSON_SUMMARY_MAX);
  }
  return elide(summary, SUMMARY_MAX);
}

const argsCutMark = (omitted: number): string => ` …(뒤 ${omitted}자 생략)`;

/**
 * 승인 카드 「전체 보기」의 도구 입력 JSON 전체 — 가림·숨김 글자 드러내기는 요약(summarizeToolInput)과 같은 규칙이다(요약은 가렸는데
 * 전체 보기에서 호스트 경로가 보이면 안 된다). ARGS_MAX(UTF-16)를 넘으면 끝을 자르고 표시를 남긴다 — 앞쪽 요약이 이미 꼬리를 보인다
 */
export function fullToolArgs(input: unknown, workdir: string): string {
  const text = revealHidden(workdirMasker(workdir).json(JSON.stringify(input) ?? "null"));
  if (text.length <= ARGS_MAX) return text;
  const head = clip(text, ARGS_MAX - argsCutMark(text.length).length);
  return head + argsCutMark(Array.from(text).length - Array.from(head).length);
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
      args: fullToolArgs(input, deps.workdir),
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
