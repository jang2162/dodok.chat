/**
 * 에이전트 → 서버 방향 변환. 응답 전달(`deliver`)과 `message` 툴 send 인자를 브리지 계약의 `OutboundMessage` 로 만든다.
 * `openclaw` 를 import 하지 않는다 — 단위 테스트 대상.
 */
import {
  ComponentsV1,
  dodokSessionKey,
  Id,
  parseDodokSessionKey,
  threadMatchesSessionKey,
  type OutboundMessage,
} from "@dodok/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 스레드 세션의 에이전트가 채널 최상위·다른 채널·다른 스레드로 보내려 할 때 모델에게 돌려주는 고정 사유(스펙 결정 6).
 * 대상을 되읊지 않는다 — 모델이 고칠 것은 「이 스레드로만」 하나다
 */
export const THREAD_ONLY_REASON = "dodok: 이 대화는 스레드라 이 스레드에만 보낼 수 있습니다";

/** message 툴의 `to` 로 쓰는 dodok 대상 문법: `channel:<uuid>` (앞에 `dodok:` 가 붙어도 된다) */
export function formatDodokTarget(conversationId: string): string {
  return `channel:${conversationId}`;
}

export function parseDodokTarget(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^dodok:/i, "")
    .replace(/^channel:/i, "");
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

export function conversationIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  return parseDodokSessionKey(sessionKey ?? undefined)?.conversationId ?? null;
}

/** 인바운드에서 받은 상관관계 — 응답을 우리 런·원 메시지에 묶는다 */
export type OutboundCorrelation = {
  runId?: string;
  replyToInboundId?: string;
  providerRunId?: string;
};

/**
 * `resolveOutboundSessionRoute` 에 넘길 스레드 id. 채널 세션이면 없다 — message 툴이 채널 세션의 `threadId` 인자를
 * 쓰지 않으므로(`messageToolSendToOutbound`) 경로만 스레드로 가면 채널 발언이 스레드 전사에 mirror 된다.
 * 세션 문맥이 없는 코어 전송(sendText 의 런 오류 알림 등)은 코어가 준 threadId 를 그대로 쓴다.
 */
export function outboundRouteThreadId(params: {
  currentSessionKey?: string | null | undefined;
  threadId?: string | number | null | undefined;
}): string | number | undefined {
  const current = parseDodokSessionKey(params.currentSessionKey ?? undefined);
  if (current && !current.threadRootId) return undefined;
  return params.threadId ?? undefined;
}

export type OutboundResult = { ok: true; message: OutboundMessage } | { ok: false; error: string };

/**
 * 툴 인자 오류. 코어 `tools.invoke` 는 `err.name === "ToolInputError"` 면 400 + 원문을 돌려주고, 아니면
 * `tool execution failed` 로 뭉갠다(ADR 0002 6·11.1). 클래스는 plugin-sdk 에서 export 되지 않아 이름으로 맞춘다.
 */
export function toolInputError(message: string): Error {
  const error = new Error(message);
  error.name = "ToolInputError";
  return error;
}

/**
 * 모델은 `artifact://<파일 이름>` 에 이름을 그대로 쓴다. 이름 안의 공백류는 계약 `SafeUrl`(`\S+`)에 막히므로
 * 검증 전에 `url` 속성의 artifact:// 값에서만 공백류를 퍼센트 인코딩한다(웹 해석기가 디코드해 찾는다).
 * https:// 값은 그대로 둔다 — 그쪽 공백은 계약 위반이 맞다. 입력은 바꾸지 않고 사본을 돌려준다
 */
function encodeArtifactWhitespace(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(encodeArtifactWhitespace);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === "url" && typeof value === "string" && value.startsWith("artifact://")
        ? value.replace(/\s/g, (ch) => encodeURIComponent(ch))
        : encodeArtifactWhitespace(value);
  }
  return out;
}

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
  const parsed = ComponentsV1.safeParse(encodeArtifactWhitespace(candidate));
  if (parsed.success) return { ok: true, value: parsed.data };
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
    .join("; ");
  return { ok: false, error: `components: v1 스키마 위반 — ${detail}` };
}

export type BuildOutboundInput = {
  outboundId: string;
  /** OpenClaw 피어 id 와 같은 대화 id */
  conversationId: string;
  agentId: string;
  sessionKey: string;
  /** 스레드 세션이면 그 루트 id — 세션 키의 스레드 접미사와 같아야 한다 */
  threadId?: string;
  text: string;
  components?: unknown;
  /** 브리지 HTTP 로 먼저 올린 첨부 id(순서대로). 메타데이터는 서버 기록에서 채운다 */
  attachmentIds?: string[];
  correlation?: OutboundCorrelation;
  now: Date;
};

export function buildOutboundMessage(input: BuildOutboundInput): OutboundResult {
  // 서버도 대조하지만(스펙 3.2) 여기서 먼저 막는다 — 어긋난 채로 가면 스레드 발언이 채널에 저장되거나 ack 오류로만 보인다
  const ours = parseDodokSessionKey(input.sessionKey) !== undefined;
  if (ours ? !threadMatchesSessionKey(input.sessionKey, input.threadId) : input.threadId !== undefined) {
    return {
      ok: false,
      error: `threadId 불일치: 세션 키 ${input.sessionKey}, threadId ${input.threadId ?? "(없음)"}`,
    };
  }
  const components = coerceComponents(input.components);
  if (!components.ok) return components;
  const message: OutboundMessage = {
    outboundId: input.outboundId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    ...(input.threadId ? { threadId: input.threadId.toLowerCase() } : {}),
    text: input.text,
    attachmentIds: input.attachmentIds ?? [],
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
      conversationId: message.conversationId,
      agentId: message.agentId,
      sessionKey: message.sessionKey,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.providerRunId ? { providerRunId: message.providerRunId } : {}),
      ...(message.replyToInboundId ? { replyToInboundId: message.replyToInboundId } : {}),
      text: message.text,
      ...(message.components ? { components: message.components } : {}),
      attachmentIds: message.attachmentIds,
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
  /** 툴 인자에 `media`/`mediaUrls` 가 있다 — 본문 없이 첨부만 보내도 된다 */
  hasMedia?: boolean;
};

/**
 * 스레드 세션(ADR 0006 「아웃바운드와 delivery-mirror 누수」 절)은 세션 키가 정본이다 — `to` 가 없거나 같은 채널이면
 * 그 스레드로 보내고, 다른 채널이나 다른 `threadId` 인자(최상위를 뜻하려는 값 포함)는 고정 사유로 거절한다.
 * 채널 세션은 `threadId` 인자를 쓰지 않는다 — 서버는 런의 스레드와 다른 전송을 받지 않는다(스펙 3.5).
 */
export function messageToolSendToOutbound(input: MessageToolSendInput): OutboundResult {
  const session = parseDodokSessionKey(input.sessionKey ?? undefined);
  const rawTarget = firstString(input.params, ["to", "target", "channelId"]);
  const conversationId = rawTarget ? parseDodokTarget(rawTarget) : (session?.conversationId ?? null);
  if (!conversationId) return { ok: false, error: "to: dodok 채널 id(channel:<uuid>)를 해석할 수 없다" };
  const threadId = session?.threadRootId;
  if (threadId) {
    const requested = input.params["threadId"];
    const requestedThread =
      requested === undefined || requested === null || requested === "" ? undefined : String(requested);
    if (conversationId !== session.conversationId) return { ok: false, error: THREAD_ONLY_REASON };
    if (requestedThread !== undefined && requestedThread.toLowerCase() !== threadId) {
      return { ok: false, error: THREAD_ONLY_REASON };
    }
  }
  const text = firstString(input.params, ["message", "text", "content"]) ?? "";
  const components = input.params["components"];
  if (!text && (components === undefined || components === null) && !input.hasMedia) {
    return { ok: false, error: "message: 본문·components·media 중 하나는 있어야 한다" };
  }
  const agentId = input.agentId || session?.providerAgentId;
  if (!agentId) return { ok: false, error: "agentId: 툴 컨텍스트에도 세션 키에도 없다" };
  let sessionKey = input.sessionKey;
  if (!sessionKey) {
    try {
      sessionKey = dodokSessionKey(agentId, conversationId);
    } catch (error) {
      return { ok: false, error: `agentId: ${String(error)}` };
    }
  }
  return buildOutboundMessage({
    outboundId: input.outboundId,
    conversationId,
    agentId,
    sessionKey,
    ...(threadId ? { threadId } : {}),
    text,
    components,
    correlation: input.correlation,
    now: input.now,
  });
}
