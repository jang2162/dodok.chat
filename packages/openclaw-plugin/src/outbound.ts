/**
 * 에이전트 → 서버 방향 변환. 응답 전달(`deliver`)과 `message` 툴 send 인자를 브리지 계약의 `OutboundMessage` 로 만든다.
 * `openclaw` 를 import 하지 않는다 — 단위 테스트 대상.
 */
import { ComponentsV1, Id, type OutboundMessage } from "@dodok/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_CHANNEL_RE =
  /^agent:([^:]+):dodok:channel:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::|$)/i;

/** message 툴의 `to` 로 쓰는 dodok 대상 문법: `channel:<uuid>` (앞에 `dodok:` 가 붙어도 된다) */
export function formatDodokTarget(channelId: string): string {
  return `channel:${channelId}`;
}

export function parseDodokTarget(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^dodok:/i, "")
    .replace(/^channel:/i, "");
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

export function channelIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  const match = sessionKey ? SESSION_CHANNEL_RE.exec(sessionKey) : null;
  return match?.[2]?.toLowerCase() ?? null;
}

function agentIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  const match = sessionKey ? SESSION_CHANNEL_RE.exec(sessionKey) : null;
  return match?.[1] ?? null;
}

/** 인바운드에서 받은 상관관계 — 응답을 우리 런·원 메시지에 묶는다 */
export type OutboundCorrelation = {
  runId?: string;
  replyToInboundId?: string;
  providerRunId?: string;
};

export type OutboundResult = { ok: true; message: OutboundMessage } | { ok: false; error: string };

function coerceComponents(
  raw: unknown,
): { ok: true; value: OutboundMessage["components"] } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  let candidate = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { ok: false, error: "components: JSON 문자열을 파싱할 수 없다" };
    }
  }
  const parsed = ComponentsV1.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
    .join("; ");
  return { ok: false, error: `components: v1 스키마 위반 — ${detail}` };
}

export type BuildOutboundInput = {
  outboundId: string;
  channelId: string;
  agentId: string;
  sessionKey: string;
  text: string;
  components?: unknown;
  correlation?: OutboundCorrelation;
  now: Date;
};

export function buildOutboundMessage(input: BuildOutboundInput): OutboundResult {
  const components = coerceComponents(input.components);
  if (!components.ok) return components;
  const message: OutboundMessage = {
    outboundId: input.outboundId,
    channelId: input.channelId,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    text: input.text,
    attachments: [],
    ts: input.now.toISOString(),
  };
  const { runId, providerRunId, replyToInboundId } = input.correlation ?? {};
  if (runId && Id.safeParse(runId).success) message.runId = runId;
  if (providerRunId) message.providerRunId = providerRunId;
  if (replyToInboundId && Id.safeParse(replyToInboundId).success) message.replyToInboundId = replyToInboundId;
  if (components.value) message.components = components.value;
  // 키 순서를 계약 스키마와 맞춰 두면 관찰 JSON 이 읽기 쉽다
  return {
    ok: true,
    message: {
      outboundId: message.outboundId,
      channelId: message.channelId,
      agentId: message.agentId,
      sessionKey: message.sessionKey,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.providerRunId ? { providerRunId: message.providerRunId } : {}),
      ...(message.replyToInboundId ? { replyToInboundId: message.replyToInboundId } : {}),
      text: message.text,
      ...(message.components ? { components: message.components } : {}),
      attachments: message.attachments,
      ts: message.ts,
    },
  };
}

function firstString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export type MessageToolSendInput = {
  /** `ChannelMessageActionContext.params` — 모델이 채운 message 툴 인자 */
  params: Record<string, unknown>;
  agentId: string | null | undefined;
  sessionKey: string | null | undefined;
  correlation?: OutboundCorrelation;
  outboundId: string;
  now: Date;
};

export function messageToolSendToOutbound(input: MessageToolSendInput): OutboundResult {
  const rawTarget = firstString(input.params, ["to", "target", "channelId"]);
  const channelId = rawTarget ? parseDodokTarget(rawTarget) : channelIdFromSessionKey(input.sessionKey);
  if (!channelId) return { ok: false, error: "to: dodok 채널 id(channel:<uuid>)를 해석할 수 없다" };
  const text = firstString(input.params, ["message", "text", "content"]) ?? "";
  const components = input.params["components"];
  if (!text && (components === undefined || components === null)) {
    return { ok: false, error: "message: 본문이나 components 중 하나는 있어야 한다" };
  }
  const agentId = input.agentId || agentIdFromSessionKey(input.sessionKey);
  if (!agentId) return { ok: false, error: "agentId: 툴 컨텍스트에도 세션 키에도 없다" };
  return buildOutboundMessage({
    outboundId: input.outboundId,
    channelId,
    agentId,
    sessionKey: input.sessionKey ?? `agent:${agentId}:dodok:channel:${channelId}`,
    text,
    components,
    correlation: input.correlation,
    now: input.now,
  });
}
