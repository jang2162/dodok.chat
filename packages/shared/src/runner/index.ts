import { z } from "zod";
import { ErrorCode, Id } from "../common";
import { InboundDeliver, OutboundMessage } from "../bridge";
import type { ControlResult, RunnerControlCall } from "../control";
import {
  ApprovalDecision,
  permissionModeRank,
  RUNNER_PERMISSION_MODES,
  RunnerPermissionMode,
  RunnerProgram,
  RunnerToolNames,
} from "../domain";
import { RunEvent } from "../events";

// `/runner` 계약(러너 스펙 3장, 계획 판정 P1) — Socket.IO 네임스페이스, 프레임은 이벤트 이름 + ack. 경계에서 이 Zod 로 파싱한다.
// 하트비트는 Socket.IO 가 한다 — ping/pong 프레임은 두지 않는다

export * from "./prompt";
export { permissionModeRank, RUNNER_PERMISSION_MODES, RunnerPermissionMode, RunnerProgram };

export const RUNNER_NAMESPACE = "/runner";
/** 첨부 바이트 HTTP(GET·POST, 러너 토큰) — 브리지의 /bridge/attachments 와 같은 모양 */
export const RUNNER_ATTACHMENTS_PATH = "/runner/attachments";
/** 2 — 러너는 천장만 쥐고 서버가 run.start 에 에이전트 정의를 싣는다(러너 일반화 스펙 3장). 옛 러너(1)는 PROTOCOL_MISMATCH */
export const RUNNER_PROTOCOL = 2;

export const RunnerCapability = z.enum(["threads", "interrupt", "approvals", "attachments"]);
export type RunnerCapability = z.infer<typeof RunnerCapability>;

/** queuedPosition 이 있으면 러너 동시 상한에 걸려 기다린다 — 어댑터가 RUN_QUEUED 를 낸다 */
export const RunnerRunAck = z.object({
  runId: Id,
  admission: z.enum(["dispatch", "drop"]),
  queuedPosition: z.int().min(1).optional(),
  reason: z.string().optional(),
});
export type RunnerRunAck = z.infer<typeof RunnerRunAck>;

// RunEvent 변형마다 seq·ts 를 뺀다 — 서버가 붙인다. 러너가 실어 보내도 strip 으로 버린다
type OmitSeqTs<T> = T extends z.ZodObject<infer S, infer C> ? z.ZodObject<Omit<S, "seq" | "ts">, C> : never;
type OmitEach<T extends readonly unknown[]> = { -readonly [K in keyof T]: OmitSeqTs<T[K]> };
type RunEventBodyOptions = OmitEach<typeof RunEvent.options>;
// map 은 튜플 모양을 잃는다 — 변형마다 같은 omit 이라 모양은 위 매핑 타입과 같다
const runEventBodyOptions = RunEvent.options.map((o) =>
  (o as z.ZodObject).omit({ seq: true, ts: true }),
) as unknown as RunEventBodyOptions;
export const RunEventBodySchema = z.discriminatedUnion("type", runEventBodyOptions);

export const RunnerRunEvent = z.object({ runId: Id, event: RunEventBodySchema });
export type RunnerRunEvent = z.infer<typeof RunnerRunEvent>;

/**
 * 러너가 꺼지느라(SIGINT·SIGTERM) 멈춘 턴의 run.final stopReason — 어댑터가 사람 중지(`aborted`)와 가르고
 * `ADAPTER_UNAVAILABLE` 로 닫는다(「다시 실행」이 붙게)
 */
export const RUNNER_SHUTDOWN_STOP_REASON = "runner_shutdown";

/** 그 프롬프트 턴의 result. costUsd 는 세션 누적 비용의 런 전후 차이(ADR 0007 5.9) */
export const RunnerRunFinal = z.object({
  runId: Id,
  text: z.string(),
  stopReason: z.string(),
  usage: z.object({ inputTokens: z.int().optional(), outputTokens: z.int().optional() }).optional(),
  costUsd: z.number().min(0).optional(),
  costKind: z.enum(["api", "subscription_estimate"]),
});
export type RunnerRunFinal = z.infer<typeof RunnerRunFinal>;

/** result 전에 SDK 예외·CLI 종료가 났을 때만. 로그인 문제는 PROVIDER_AUTH */
export const RunnerRunError = z.object({ runId: Id, code: ErrorCode, message: z.string().max(2000) });
export type RunnerRunError = z.infer<typeof RunnerRunError>;

export const RunnerRunAbort = z.object({ runId: Id });
export type RunnerRunAbort = z.infer<typeof RunnerRunAbort>;

/**
 * 러너 `post` 의 outboundId 접두사. 어댑터가 최종 답을 `runner-final:<runId>` 로 저장하므로 러너가 고른 id 는 이 접두사로 묶는다 —
 * 그 키(와 다른 메시지의 external_id)를 먼저 써서 최종 답을 막거나 남의 메시지 id 를 돌려받지 못하게(최종 리뷰 M4)
 */
export const RUNNER_POST_ID_PREFIX = "runner-post:";

/** dodok 도구 `mcp__dodok__post` — 첨부는 먼저 /runner/attachments 로 올린 artifact id */
export const RunnerOutboundPost = OutboundMessage.extend({
  outboundId: z
    .string()
    .min(RUNNER_POST_ID_PREFIX.length + 1)
    .max(128)
    .startsWith(RUNNER_POST_ID_PREFIX),
});
export type RunnerOutboundPost = z.infer<typeof RunnerOutboundPost>;
export const RunnerOutboundAck = z.union([
  z.object({ ok: z.literal(true), messageId: Id }),
  z.object({ ok: z.literal(false), code: ErrorCode, message: z.string() }),
]);
export type RunnerOutboundAck = z.infer<typeof RunnerOutboundAck>;

/** canUseTool 이 불렸다(러너 스펙 6장). summary 는 작업 디렉터리 상대 경로만 — 밖이면 `<작업 디렉터리 밖>` */
export const RunnerApprovalRequested = z.object({
  providerApprovalId: z.string().min(1).max(128),
  runId: Id,
  sessionKey: z.string(),
  toolCallId: z.string(),
  toolName: z.string().max(128),
  summary: z.string().max(400),
  /**
   * 도구 입력 JSON 전체(가림·숨김 글자 드러내기는 summary 와 같은 규칙, 넘으면 끝을 자르고 표시) — 카드의 「전체 보기」.
   * 선택: 옛 러너는 보내지 않는다(그때 카드는 요약만)
   */
  args: z.string().max(16_000).optional(),
  canAllowAlways: z.boolean(),
});
export type RunnerApprovalRequested = z.infer<typeof RunnerApprovalRequested>;

/** 콜백 signal 이 끊겼다(런 중지 등) — 카드는 철회로 닫힌다 */
export const RunnerApprovalWithdrawn = z.object({ providerApprovalId: z.string() });
export type RunnerApprovalWithdrawn = z.infer<typeof RunnerApprovalWithdrawn>;

/** 기한(판정 P5)이 지나 서버가 보내는 거절은 reason: "expired" */
export const RunnerApprovalResolve = z.object({
  providerApprovalId: z.string(),
  decision: ApprovalDecision,
  reason: z.enum(["expired"]).optional(),
});
export type RunnerApprovalResolve = z.infer<typeof RunnerApprovalResolve>;

export interface RunnerClientToServerEvents {
  hello: (p: RunnerHello, ack: (r: RunnerHelloResult) => void) => void;
  "run.session": (p: RunnerRunSession) => void;
  "run.event": (p: RunnerRunEvent) => void;
  "run.final": (p: RunnerRunFinal) => void;
  "run.error": (p: RunnerRunError) => void;
  "outbound.post": (p: RunnerOutboundPost, ack: (r: RunnerOutboundAck) => void) => void;
  "approval.requested": (p: RunnerApprovalRequested) => void;
  "approval.withdrawn": (p: RunnerApprovalWithdrawn) => void;
  "control.call": (p: RunnerControlCall, ack: (r: ControlResult) => void) => void;
}

export interface RunnerServerToClientEvents {
  "run.start": (p: RunnerRunStart, ack: (r: RunnerRunAck) => void) => void;
  "run.abort": (p: RunnerRunAbort) => void;
  "approval.resolve": (p: RunnerApprovalResolve) => void;
  "fs.list": (p: RunnerProjectRef, ack: (r: RunnerFsListResult) => void) => void;
  "project.check": (p: RunnerProjectRef, ack: (r: RunnerProjectCheckResult) => void) => void;
}

// ── 천장·프로젝트(러너 일반화 스펙 2·3장) — 러너는 천장(루트·프로그램·권한 상한)만 쥐고, 서버가 run.start 에 에이전트 정의를
// 통째로 싣는다

/** 러너 로컬 설정의 루트 id — 바꾸면 그 루트의 프로젝트가 「루트 없음」이 된다 */
export const RunnerRootId = z.string().regex(/^[a-z0-9-]{1,32}$/, "root id must match [a-z0-9-]{1,32}");
export type RunnerRootId = z.infer<typeof RunnerRootId>;

/**
 * 루트 안의 상대 경로 — 서버·러너가 같은 스키마로 거른다. 빈 문자열은 루트 자신. `/` 로만 나누고 `..`·`.`·빈 성분·NUL·`\`·앞 `/`
 * 는 거절한다. 러너는 이 검사를 믿지 않고 realpath 로 루트 안인지 다시 본다(심볼릭 링크는 글자로 못 거른다)
 */
export const RunnerRelPath = z
  .string()
  .max(512)
  .refine(
    (p) =>
      p === "" ||
      (!p.includes("\0") &&
        !p.includes("\\") &&
        p.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
    "relPath must be a relative path inside the root",
  );
export type RunnerRelPath = z.infer<typeof RunnerRelPath>;

/** 루트 하나 안의 디렉터리 — 프로젝트의 자리이자 fs.list·project.check 요청 */
export const RunnerProjectRef = z.object({ rootId: RunnerRootId, relPath: RunnerRelPath });
export type RunnerProjectRef = z.infer<typeof RunnerProjectRef>;

/** 프로그램 드라이버가 할 수 있는 것(계획 판정 PR3) — 서버가 그 러너·그 프로그램의 값으로 런 전에 가른다 */
export const RunnerProgramCapability = z.enum([
  "serverSessionIds",
  "approvals",
  "images",
  "interrupt",
  "mcpTools",
  "costs",
]);
export type RunnerProgramCapability = z.infer<typeof RunnerProgramCapability>;

export const RunnerProgramStatus = z.object({
  program: RunnerProgram,
  /** 이 러너가 그 프로그램을 돌릴 수 있나 — 드라이버가 있고 설치돼 있다 */
  available: z.boolean(),
  version: z.string().max(64).optional(),
  auth: z.enum(["ok", "missing", "unknown"]),
  /** 못 쓰는 까닭·로그인 안내 — 경로 원문은 싣지 않는다 */
  reason: z.string().max(200).optional(),
  // 문자열이면 받는다 — 모르는 값은 서버가 버린다(hello capabilities 와 같은 까닭)
  capabilities: z.array(z.string()),
  ceiling: z.object({
    maxPermissionMode: RunnerPermissionMode,
    /** 배열이면 에이전트의 allowedTools 는 그 부분집합이어야 한다. null 이면 상한 없음 */
    allowedToolsCeiling: RunnerToolNames.nullable(),
  }),
});
export type RunnerProgramStatus = z.infer<typeof RunnerProgramStatus>;

/**
 * 러너 → 서버 hello. 루트는 id·라벨뿐이다 — 호스트 경로는 서버로 가지 않는다(스펙 결정 3). strict 라 옛 hello 의 agents·
 * claudeCodeVersion(과 루트의 path)이 실리면 거절한다
 */
export const RunnerHello = z.strictObject({
  runnerProtocol: z.int(),
  runnerVersion: z.string(),
  sdkVersion: z.string(),
  bundleSha256: z.string().nullable(),
  capabilities: z.array(z.string()),
  roots: z.array(z.strictObject({ id: RunnerRootId, label: z.string().min(1).max(64) })).max(16),
  browse: z.boolean(),
  programs: z.array(RunnerProgramStatus).max(8),
});
export type RunnerHello = z.infer<typeof RunnerHello>;

/**
 * 거절이면 러너는 사유를 출력하고 종료한다. hello 거절은 판본 불일치뿐이다 — 토큰 틀림(UNAUTHORIZED)·가드 차단(RATE_LIMITED)은
 * 핸드셰이크 미들웨어가 connect_error 로 거절하고, 러너는 거기서 가른다(RATE_LIMITED 는 끝내지 않는다 — 최종 리뷰 M3)
 */
export const RunnerHelloResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), serverVersion: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal("PROTOCOL_MISMATCH"), message: z.string() }),
]);
export type RunnerHelloResult = z.infer<typeof RunnerHelloResult>;

/** 서버가 정한 에이전트 정의 — 러너는 런마다 천장(로컬 설정)과 견주고 넘으면 RUNNER_CEILING 으로 거절한다 */
export const RunnerRunAgent = z.object({
  program: RunnerProgram,
  project: RunnerProjectRef,
  /** null 이면 프로그램 기본 모델 */
  model: z.string().min(1).max(128).nullable(),
  permissionMode: RunnerPermissionMode,
  /** 묻지 않고 허용하는 도구. null 이면 미리 허용한 도구가 없다(상한 안에서 프로그램 기본) */
  allowedTools: RunnerToolNames.nullable(),
  disallowedTools: RunnerToolNames,
});
export type RunnerRunAgent = z.infer<typeof RunnerRunAgent>;

/**
 * 런 하나. resume 은 싣지 않는다 — 러너가 그 providerSessionId 의 전사가 있으면 이어 가고 없으면 새로 연다(판정 P2).
 * channelRulesAppend·turnFacts 는 서버가 `buildChannelRulesAppend`·`buildTurnFacts` 로 만든다(판정 P3 — 에이전트 지시도 그 틀 안,
 * 러너 일반화 계획 판정 PR1). providerSessionId 는 서버가 세션 id 를 정할 수 있는 프로그램(serverSessionIds)이면 늘, 아니면 그
 * 프로그램이 run.session 으로 알린 값이 있을 때만 싣는다
 */
export const RunnerRunStart = z.object({
  deliver: InboundDeliver,
  providerSessionId: z.string().min(1).max(128).optional(),
  channelRulesAppend: z.string(),
  turnFacts: z.string(),
  sessionTitle: z.string().max(120),
  agent: RunnerRunAgent,
});
export type RunnerRunStart = z.infer<typeof RunnerRunStart>;

/** 프로그램이 스스로 지은 세션 id — 서버가 세션 행에 저장해 다음 런에 싣는다 */
export const RunnerRunSession = z.object({ runId: Id, providerSessionId: z.string().min(1).max(128) });
export type RunnerRunSession = z.infer<typeof RunnerRunSession>;

/** fs.list — 디렉터리만, 숨김(`.` 시작) 빼고, 루트 밖을 가리키는 링크 빼고, 이름순 500개 */
export const RUNNER_FS_LIST_MAX = 500;
export const RunnerFsEntry = z.object({ name: z.string().min(1).max(255), isGitRepo: z.boolean() });
export type RunnerFsEntry = z.infer<typeof RunnerFsEntry>;
export const RunnerFsListResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    entries: z.array(RunnerFsEntry).max(RUNNER_FS_LIST_MAX),
    truncated: z.boolean(),
  }),
  // FORBIDDEN — 러너가 둘러보기를 껐다(browse: false). NOT_FOUND — 루트·디렉터리가 없거나 루트 밖
  z.object({ ok: z.literal(false), code: z.enum(["FORBIDDEN", "NOT_FOUND"]) }),
]);
export type RunnerFsListResult = z.infer<typeof RunnerFsListResult>;

export const RunnerProjectCheckResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), isGitRepo: z.boolean() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["root_missing", "not_found", "not_directory", "outside_root"]),
  }),
]);
export type RunnerProjectCheckResult = z.infer<typeof RunnerProjectCheckResult>;

/** 천장 검사가 걸린 항목 — run.error RUNNER_CEILING 의 message 가 이 이름 하나다 */
export const RunnerCeilingItem = z.enum(["root", "path", "program", "permissionMode", "allowedTools"]);
export type RunnerCeilingItem = z.infer<typeof RunnerCeilingItem>;
