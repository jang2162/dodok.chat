/**
 * 서버 → 에이전트 방향 변환. 브리지 `inbound.deliver` 를 OpenClaw 인바운드 디스패치에 넣을 사실(facts)로 만든다.
 * `openclaw` 를 import 하지 않는다 — 단위 테스트 대상. SDK 호출은 `channel.ts` 가 한다.
 */
import type { InboundDeliver, InboundDeliverResult } from "@dodok/shared";
import { buildInboundText, type ContextFormatOptions } from "./context";
import { formatDodokTarget } from "./outbound";

/** 계획서 5.8 — 채널당 에이전트별 1세션. 접미사(세대·스레드)는 두지 않는다(계획서 10장 #19) */
export function dodokSessionKey(agentId: string, channelId: string): string {
  return `agent:${agentId}:dodok:channel:${channelId}`;
}

export type DodokInboundFacts = {
  accountId: string;
  channelId: string;
  agentId: string;
  sessionKey: string;
  /** message 툴 `to` 와 같은 문법 */
  target: string;
  messageId: string;
  timestamp: number;
  /** `user:<handle>` / `agent:<handle>` — 사람·에이전트 핸들이 겹쳐도 봇 쌍 키가 섞이지 않게 */
  sender: { id: string; name: string; isBot: boolean };
  /** 컨텍스트 헤더 + 본문 (에이전트가 보는 텍스트) */
  body: string;
  rawBody: string;
  correlation: { deliveryId: string; runId: string; replyToInboundId: string };
  /** 에이전트 작성 인바운드일 때만. OpenClaw `ChannelBotLoopProtectionFacts` 의 입력 */
  botLoopProtection?: {
    scopeId: string;
    conversationId: string;
    senderId: string;
    receiverId: string;
    eventId: string;
  };
};

export type InboundFactsResult = { ok: true; facts: DodokInboundFacts } | { ok: false; error: string };

export function toInboundFacts(
  d: InboundDeliver,
  opts: { accountId: string; context?: ContextFormatOptions },
): InboundFactsResult {
  const expected = dodokSessionKey(d.agentId, d.channelId);
  if (d.sessionKey !== expected) {
    return { ok: false, error: `sessionKey 불일치: 기대 ${expected}, 받음 ${d.sessionKey}` };
  }
  const author = d.message.author;
  const isBot = author.type === "agent";
  const senderId = `${author.type}:${author.handle}`;
  const self = d.context.participants.find((p) => p.isSelf);
  const facts: DodokInboundFacts = {
    accountId: opts.accountId,
    channelId: d.channelId,
    agentId: d.agentId,
    sessionKey: d.sessionKey,
    target: formatDodokTarget(d.channelId),
    messageId: d.message.id,
    timestamp: Date.parse(d.message.ts),
    sender: { id: senderId, name: author.displayName, isBot },
    body: buildInboundText(d, opts.context),
    rawBody: d.message.text,
    correlation: { deliveryId: d.deliveryId, runId: d.runId, replyToInboundId: d.message.id },
  };
  if (isBot) {
    facts.botLoopProtection = {
      scopeId: opts.accountId,
      conversationId: d.channelId,
      senderId,
      receiverId: `agent:${self?.handle ?? d.agentId}`,
      eventId: d.deliveryId,
    };
  }
  return { ok: true, facts };
}

/**
 * OpenClaw `ChannelTurnAdmission`(`channelRuntime.inbound.dispatch` 결과의 `admission`) 중 ack 에 쓰는 만큼.
 * `openclaw` 를 import 하지 않으려고 모양만 옮겨 둔다 — 코어가 kind 를 늘리면 `channel.ts` 타입 검사가 깨진다.
 */
export type CoreTurnAdmission = {
  kind: "dispatch" | "observeOnly" | "handled" | "drop";
  reason?: string;
};

/**
 * 계획서 10장 #14 — 브리지 `inbound.deliver` ack. 런이 시작되면 `onAgentRunStart` 의 runId 를 실어 `dispatch`,
 * 런 없이 디스패치가 끝나면 코어 admission 을 옮긴다. 코어의 `dispatch` 밖 kind 는 에이전트 런이 없으므로
 * 우리 계약에서는 전부 `drop` 이다. 봇 루프 보호 drop 은 코어가 `reason: "bot-loop-protection"` 을 준다(ADR 0002 7.2).
 */
export function toDeliverResult(admission: CoreTurnAdmission, runId?: string): InboundDeliverResult {
  if (admission.kind === "dispatch")
    return runId ? { admission: "dispatch", providerRunId: runId } : { admission: "dispatch" };
  const reason = admission.reason?.trim();
  if (admission.kind === "drop") return { admission: "drop", reason: reason || "unknown" };
  return { admission: "drop", reason: reason ? `${admission.kind}:${reason}` : admission.kind };
}
