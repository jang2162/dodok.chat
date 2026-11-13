import { z } from "zod";
import type { Ack } from "../common";
import { BRIDGE_PROTOCOL, Id, IsoDateTime } from "../common";
import { ComponentsV1 } from "../components";
import type { BridgeControlCall, ControlResult } from "../control";
import { ATTACHMENT_LIMITS, Attachment, ConversationTitle, ReactionEmoji } from "../domain";
import { parseDodokSessionKey } from "../session-key";
import { Sha256Hex } from "../setup";

export const BridgeCapability = z.enum([
  "agents.list",
  "config.set",
  "typing",
  "run_id_in_outbound",
  "threads",
  "control", // 제어 도구를 등록하고 control.call 을 보낸다 — 없는 플러그인에는 서버가 아무것도 바꾸지 않는다
]);
export type BridgeCapability = z.infer<typeof BridgeCapability>;

export const BridgeHello = z.object({
  pluginId: z.literal("dodok"),
  version: z.string(), // 플러그인 패키지 버전
  sdkVersion: z.string(), // openclaw 패키지 버전
  gatewayVersion: z.string().optional(),
  bundleSha256: Sha256Hex.optional(), // 플러그인 번들 파일 sha256 — 읽기 실패·옛 플러그인이면 없다(설정 마법사 결정 5)
  // 모르는 capability 는 버리고 받는다 — 거절하면 새 플러그인이 옛 서버에 못 붙어 서버만 되돌리는 롤백이 막힌다(판정 R1)
  capabilities: z
    .array(z.unknown())
    .transform((caps) =>
      caps.filter((cap): cap is BridgeCapability => BridgeCapability.safeParse(cap).success),
    ),
});
export type BridgeHello = z.infer<typeof BridgeHello>;
export const BridgeHelloResult = z.object({
  serverVersion: z.string(),
  protocol: z.literal(BRIDGE_PROTOCOL),
});
export type BridgeHelloResult = z.infer<typeof BridgeHelloResult>;

export const InboundAuthor = z.object({
  type: z.enum(["user", "agent", "system"]),
  handle: z.string(),
  displayName: z.string(),
});
export type InboundAuthor = z.infer<typeof InboundAuthor>;

const InboundContextMessage = z.object({ author: InboundAuthor, text: z.string(), ts: IsoDateTime });

/** 한 런에 싣는 리액션 수의 상한(InboundContext.reactions) — 서버 reactions/service 가 이 값으로 자른다 */
export const INBOUND_REACTIONS_MAX = 20;
/** InboundReaction.excerpt 의 길이 상한 — 서버가 발췌를 이 안으로 채운다 */
export const REACTION_EXCERPT_MAX = 60;

/** 에이전트가 쓴 메시지에 사람이 단 리액션 하나 — 문구는 formatReactionFacts 가 만든다 */
export const InboundReaction = z.object({
  messageId: Id,
  excerpt: z.string().max(REACTION_EXCERPT_MAX), // 그 메시지의 읽는 글 앞쪽
  emoji: ReactionEmoji,
  by: z.string(), // 단 사람의 핸들(비활성 멤버도 그 핸들)
  at: IsoDateTime,
});
export type InboundReaction = z.infer<typeof InboundReaction>;

export const InboundContext = z.object({
  recentMessages: z.array(InboundContextMessage).max(20), // 스레드 런이면 비어 있다 — 채널 대화는 스레드에 싣지 않는다
  /** 스레드 런만. 루트 본문은 서버가 4,000자에서 자른다 */
  thread: z
    .object({
      root: InboundContextMessage.extend({ text: z.string().max(4000) }),
      recentMessages: z.array(InboundContextMessage).max(20),
    })
    .optional(),
  participants: z.array(
    z.object({
      type: z.enum(["user", "agent"]),
      handle: z.string(),
      displayName: z.string(),
      isSelf: z.boolean(),
      /**
       * 그 세션(대화)에만 초대한 에이전트(세션 에이전트 초대 스펙 5.2) — 채널 멤버가 아니다. 헤더 「참여자:」에 `(에이전트, 초대됨)`,
       * 자기 자신이면 세션 초대 줄(formatSessionInviteLine). 선택 필드라 옛 플러그인은 버리고 받는다(표시가 없을 뿐)
       */
      invited: z.boolean().optional(),
    }),
  ),
  relayRules: z.string(), // 사람이 읽는 한 문단
  channelPrompt: z.string().optional(),
  promptOverride: z.string().optional(),
  /** 지난 턴 뒤 이 에이전트의 메시지에 달린 리액션 — 최근 INBOUND_REACTIONS_MAX 개. 없으면 키가 없다 */
  reactions: z.array(InboundReaction).max(INBOUND_REACTIONS_MAX).optional(),
  reactionsOmitted: z.int().min(1).optional(), // 상한 밖으로 밀린 수
});
export type InboundContext = z.infer<typeof InboundContext>;

export const InboundDeliver = z.object({
  deliveryId: Id,
  kind: z.enum(["message", "interaction", "continue"]),
  channelId: Id, // 채널 설정(ConfigSet)·프롬프트 조회 — 채널 단위
  conversationId: Id, // OpenClaw 피어 id(`channel:<id>`)·세션 키의 대화
  conversationTitle: ConversationTitle, // 헤더 `세션:` 줄 — formatSessionLine 으로만 싣는다(사람이 쓴 글이다)
  /** DM 런만 — 헤더 `다이렉트 메시지:` 줄(formatDmLine). 선택 필드라 옛 플러그인도 받는다(DM 줄이 없을 뿐) */
  dm: z.object({ ownerHandle: z.string() }).optional(),
  /** 그룹 DM(direct) 런만 — 헤더 `그룹 DM:` 줄(formatGroupDmLine). 선택 필드라 옛 플러그인은 버리고 받는다(그 줄이 없을 뿐) */
  groupDm: z.literal(true).optional(),
  agentId: z.string(), // providerAgentId (OpenClaw agentId)
  sessionKey: z.string(), // dodokSessionKey(agentId, conversationId, threadId)
  threadId: Id.optional(), // 스레드 루트 id — threadMatchesSessionKey 로 키와 대조한다
  runId: Id, // 우리 런 id
  message: z.object({
    id: Id,
    author: InboundAuthor,
    text: z.string(), // renderForAgent 결과 (@handle 평문)
    attachments: z.array(Attachment).max(ATTACHMENT_LIMITS.perMessage),
    ts: IsoDateTime,
  }),
  context: InboundContext,
  options: z
    .object({ queueMode: z.enum(["steer", "followup", "collect", "interrupt"]).optional() })
    .default({}),
});
export type InboundDeliver = z.infer<typeof InboundDeliver>;
export const InboundDeliverResult = z.object({
  admission: z.enum(["dispatch", "drop"]), // 계획서 10장 #14 — drop 은 런 없이 끝났다는 뜻(봇 루프 보호 등)
  reason: z.string().optional(), // drop 사유 (예: "bot-loop-protection")
  providerRunId: z.string().optional(), // ADR 0002 4.3: 값은 우리 runId 와 같다(replyOptions.runId)
});
export type InboundDeliverResult = z.infer<typeof InboundDeliverResult>;

export const ConfigSet = z.object({
  channelId: Id,
  config: z.object({ requireMention: z.boolean().optional(), systemPrompt: z.string().optional() }),
});
export type ConfigSet = z.infer<typeof ConfigSet>;
export const ConfigSetResult = z.object({ applied: z.enum(["live", "restart_required"]) });
export type ConfigSetResult = z.infer<typeof ConfigSetResult>;

export const OutboundMessage = z.object({
  outboundId: z.string().min(1).max(128), // 중복 제거 키 (messages.external_id)
  conversationId: Id, // 채널은 서버가 대화에서 찾는다
  agentId: z.string(), // providerAgentId
  sessionKey: z.string(),
  threadId: Id.optional(), // 스레드 세션에서 보낸 것이면 그 루트 id
  runId: Id.optional(), // 인바운드에서 받은 우리 런 id
  providerRunId: z.string().optional(),
  replyToInboundId: Id.optional(), // InboundDeliver.message.id
  text: z.string().max(100_000), // 평문 (@handle) — 서버가 tokenize
  components: ComponentsV1.optional(),
  /** 브리지 HTTP 로 먼저 올린 첨부 id(스펙 3장 2). 이름·크기·MIME 은 서버 기록이 정본이다 */
  attachmentIds: z.array(Id).max(ATTACHMENT_LIMITS.perMessage).default([]),
  ts: IsoDateTime,
});
export type OutboundMessage = z.infer<typeof OutboundMessage>;

/** 세션 키의 스레드 접미사와 threadId 가 같은가(둘 다 없으면 참). 서버·플러그인이 같이 쓴다 */
export function threadMatchesSessionKey(sessionKey: string, threadId: string | undefined): boolean {
  const parsed = parseDodokSessionKey(sessionKey);
  // 우리 모양이 아닌 키는 스레드인지 알 수 없으므로 맞다고 하지 않는다
  if (!parsed) return false;
  return parsed.threadRootId === threadId?.toLowerCase();
}

/**
 * 에이전트 헤더의 `세션: <제목>` 줄 — 플러그인 헤더(`packages/openclaw-plugin/src/context.ts`)와 러너 턴 사실(`runner/prompt.ts`)이 같이 쓴다.
 * 제목은 사람이 쓴 글이라 헤더 안에서 줄을 바꾸지 못하게 한 줄로 접는다 — 줄바꿈이 남으면 제목에 쓴 `---`·`참여자:` 가 헤더의 끝이나
 * 서버가 붙인 사실처럼 읽힌다. 줄 경계(제어 문자·U+2028/2029 포함)는 공백 하나로, 보이지 않는 서식 글자는 지운다
 */
export function formatSessionLine(title: string): string {
  const line = foldHeaderText(title);
  return `세션: ${line === "" ? "새 세션" : line}`;
}

/**
 * 에이전트 헤더의 DM 줄(에이전트 DM 계획 PD8) — 플러그인 헤더와 러너 턴 사실이 `[dodok context]` 줄 바로 다음, 세션 줄 앞에 싣는다.
 * 조사를 「님과」로 고정해 핸들의 받침을 가리지 않는다. 핸들은 세션 제목과 같은 규칙으로 한 줄로 접는다(`formatSessionLine` 주석)
 */
export function formatDmLine(ownerHandle: string): string {
  return `다이렉트 메시지: @${foldHeaderText(ownerHandle)} 님과 1:1`;
}

/**
 * 에이전트 헤더의 그룹 DM 줄(사람 간 DM 계획 PH12) — DM 줄과 같은 자리(`[dodok context]` 줄 바로 다음, 세션 줄 앞)에 싣는다. 채널처럼 보이는
 * 자리가 참여자만 보는 대화임을 밝힌다 — 참여자는 그 아래 `참여자:` 줄이 말한다
 */
export function formatGroupDmLine(): string {
  return "그룹 DM: 참여자만 보는 대화";
}

/**
 * 에이전트 헤더 「참여자:」 줄의 한 사람 — 플러그인 헤더와 러너 턴 사실이 같이 쓴다. 그 세션에만 초대한 에이전트는 `초대됨` 을 붙인다
 * (세션 에이전트 초대 스펙 5.2)
 */
export function formatParticipantLabel(p: InboundContext["participants"][number]): string {
  const marks = [
    p.type === "user" ? "사람" : "에이전트",
    ...(p.isSelf ? ["나"] : []),
    ...(p.invited ? ["초대됨"] : []),
  ];
  return `@${p.handle}(${marks.join(", ")})`;
}

/**
 * 초대받은 에이전트 자신의 헤더에 세션 줄 바로 다음 싣는 줄(세션 에이전트 초대 스펙 5.2) — 그 에이전트는 채널 멤버가 아니라 그 세션에만
 * 불렸다. 참여자 가운데 자기 자신(isSelf)이 invited 일 때만 — 아니면 null
 */
export function formatSessionInviteLine(participants: InboundContext["participants"]): string | null {
  return participants.some((p) => p.isSelf && p.invited)
    ? "세션 초대: 이 세션에만 초대됐습니다 — 이 채널의 다른 세션은 보이지 않습니다."
    : null;
}

function foldHeaderText(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .trim();
}

export const BridgeStatus = z.object({
  gateway: z.enum(["connected", "reconnecting", "down"]),
  queueDepth: z.int().min(0),
});
export type BridgeStatus = z.infer<typeof BridgeStatus>;

export interface BridgeClientToServerEvents {
  // 플러그인 → 서버
  hello: (p: BridgeHello, ack: Ack<BridgeHelloResult>) => void;
  "outbound.message": (p: OutboundMessage, ack: Ack<{ messageId: Id }>) => void;
  "outbound.typing": (p: { channelId: Id; agentId: string }) => void;
  status: (p: BridgeStatus) => void;
  "control.call": (p: BridgeControlCall, ack: (r: ControlResult) => void) => void;
}
export interface BridgeServerToClientEvents {
  // 서버 → 플러그인
  "inbound.deliver": (p: InboundDeliver, ack: Ack<InboundDeliverResult>) => void;
  "config.set": (p: ConfigSet, ack: Ack<ConfigSetResult>) => void;
  "agents.list": (
    p: Record<string, never>,
    ack: Ack<{ agents: Array<{ agentId: string; name?: string }> }>,
  ) => void;
  "system.notice": (p: { reason: "replaced" | "shutdown"; message: string }) => void;
}

/** 브리지 HTTP 첨부 경로와 헤더(스펙 3장 5). 인증은 `Authorization: Bearer <브리지 토큰>` */
export const BRIDGE_ATTACHMENTS_PATH = "/bridge/attachments";
export const BRIDGE_ATTACHMENT_HEADERS = {
  fileName: "x-dodok-file-name",
  conversationId: "x-dodok-conversation-id", // 서버가 그 대화의 채널로 묶는다
} as const;
