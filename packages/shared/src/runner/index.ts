import { z } from "zod";
import { ErrorCode, Id } from "../common";
import { InboundDeliver, OutboundMessage } from "../bridge";
import { ApprovalDecision } from "../domain";
import { RunEvent } from "../events";
import { isRegistrableAgentId } from "../session-key";

// `/runner` 계약(러너 스펙 3장, 계획 판정 P1) — Socket.IO 네임스페이스, 프레임은 이벤트 이름 + ack. 경계에서 이 Zod 로 파싱한다.
// 하트비트는 Socket.IO 가 한다 — ping/pong 프레임은 두지 않는다

export * from "./prompt";

export const RUNNER_NAMESPACE = "/runner";
/** 첨부 바이트 HTTP(GET·POST, 러너 토큰) — 브리지의 /bridge/attachments 와 같은 모양 */
export const RUNNER_ATTACHMENTS_PATH = "/runner/attachments";
export const RUNNER_PROTOCOL = 1;

export const RunnerCapability = z.enum(["threads", "interrupt", "approvals", "attachments"]);
export type RunnerCapability = z.infer<typeof RunnerCapability>;

/** 러너가 알리는 에이전트 — 작업 디렉터리는 라벨만, 경로 원문은 싣지 않는다. id 는 OpenClaw agentId 규칙 + 소문자(스레드 스펙 R4) */
export const RunnerAgent = z.object({
  id: z.string().refine(isRegistrableAgentId, "agent id must be a lowercase OpenClaw agentId"),
  name: z.string().min(1).max(64),
  model: z.string().min(1).max(64),
  workdirLabel: z.string().min(1).max(64),
});
export type RunnerAgent = z.infer<typeof RunnerAgent>;

export const RunnerHello = z.object({
  runnerProtocol: z.int(),
  runnerVersion: z.string(),
  sdkVersion: z.string(),
  claudeCodeVersion: z.string(),
  bundleSha256: z.string().nullable(),
  // 문자열이면 받는다 — 모르는 값은 서버가 버린다(거절하면 새 러너가 옛 서버에 못 붙는다 — 스레드 스펙 R1)
  capabilities: z.array(z.string()),
  agents: z.array(RunnerAgent).max(32),
});
export type RunnerHello = z.infer<typeof RunnerHello>;

/**
 * 거절이면 러너는 사유를 출력하고 종료한다. hello 거절은 판본 불일치뿐이다 — 토큰 틀림(UNAUTHORIZED)·가드 차단(RATE_LIMITED)은
 * 핸드셰이크 미들웨어가 connect_error 로 거절하고, 러너는 거기서 가른다(RATE_LIMITED 는 끝내지 않는다 — 최종 리뷰 M3)
 */
export const RunnerHelloResult = z.discriminatedUnion("ok", [
  // conflicts — 다른 러너가 먼저 알려 이 러너에 배정하지 않는 에이전트 id
  z.object({ ok: z.literal(true), serverVersion: z.string(), conflicts: z.array(z.string()) }),
  z.object({ ok: z.literal(false), code: z.literal("PROTOCOL_MISMATCH"), message: z.string() }),
]);
export type RunnerHelloResult = z.infer<typeof RunnerHelloResult>;

/**
 * 런 하나. resume 은 싣지 않는다 — 러너가 그 providerSessionId 의 전사가 있으면 이어 가고 없으면 새로 연다(판정 P2).
 * channelRulesAppend·turnFacts 는 서버가 `buildChannelRulesAppend`·`buildTurnFacts` 로 만든다(판정 P3)
 */
export const RunnerRunStart = z.object({
  deliver: InboundDeliver,
  providerSessionId: z.uuid(),
  channelRulesAppend: z.string(),
  turnFacts: z.string(),
  sessionTitle: z.string().max(120),
});
export type RunnerRunStart = z.infer<typeof RunnerRunStart>;

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
  "run.event": (p: RunnerRunEvent) => void;
  "run.final": (p: RunnerRunFinal) => void;
  "run.error": (p: RunnerRunError) => void;
  "outbound.post": (p: RunnerOutboundPost, ack: (r: RunnerOutboundAck) => void) => void;
  "approval.requested": (p: RunnerApprovalRequested) => void;
  "approval.withdrawn": (p: RunnerApprovalWithdrawn) => void;
}

export interface RunnerServerToClientEvents {
  "run.start": (p: RunnerRunStart, ack: (r: RunnerRunAck) => void) => void;
  "run.abort": (p: RunnerRunAbort) => void;
  "approval.resolve": (p: RunnerApprovalResolve) => void;
}
