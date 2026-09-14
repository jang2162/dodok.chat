/**
 * 서버 → 에이전트 방향 변환. 브리지 `inbound.deliver` 를 OpenClaw 인바운드 디스패치에 넣을 사실(facts)로 만든다.
 * `openclaw` 를 import 하지 않는다 — 단위 테스트 대상. SDK 호출은 `channel.ts` 가 한다.
 */
import type { InboundDeliver } from "@dodok/shared";
import { buildInboundText, type ContextFormatOptions } from "./context";
import { formatDodokTarget } from "./outbound";

/**
 * 계획서 5.8 — 채널당 에이전트별 1세션. `generation` ≥ 2 면 `:g<N>` 을 붙여 새 세션으로 회전한다
 * (채널 프롬프트가 바뀌었을 때 기존 claude-cli 세션을 버리는 대안 — 스파이크 3 P6).
 */
export function dodokSessionKey(agentId: string, channelId: string, generation = 1): string {
  if (!Number.isInteger(generation) || generation < 1) throw new Error(`세대는 1 이상의 정수: ${generation}`);
  const base = `agent:${agentId}:dodok:channel:${channelId}`;
  return generation === 1 ? base : `${base}:g${generation}`;
}

const GENERATION_SUFFIX_RE = /^:g([2-9]|[1-9]\d+)$/;

function matchesSessionKey(sessionKey: string, base: string): boolean {
  if (sessionKey === base) return true;
  return sessionKey.startsWith(base) && GENERATION_SUFFIX_RE.test(sessionKey.slice(base.length));
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
  if (!matchesSessionKey(d.sessionKey, expected)) {
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
