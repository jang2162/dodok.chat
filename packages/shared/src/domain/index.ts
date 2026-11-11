import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { StoredComponentState, StoredComponentsV1, StoredItemId } from "../components";
import { MentionSet } from "../mention"; // MentionSet은 mention.ts가 소유. 루트 index가 export하므로 여기서 재export하지 않는다(export * 충돌 방지).
import { AvatarUrl } from "../profile";

export const Handle = z.string().regex(/^[a-z0-9_-]{2,32}$/);
export type Handle = z.infer<typeof Handle>;

export const Workspace = z.object({ id: Id, name: z.string().min(1).max(80), createdAt: IsoDateTime });
export type Workspace = z.infer<typeof Workspace>;

export const User = z.object({
  id: Id,
  workspaceId: Id,
  handle: Handle,
  displayName: z.string().min(1).max(80),
  email: z.email().optional(),
  authProvider: z.enum(["local", "email", "oidc"]),
  avatarUrl: AvatarUrl.optional(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const MembershipRole = z.enum(["owner", "admin", "member", "guest"]);
export type MembershipRole = z.infer<typeof MembershipRole>;
export const Membership = z.object({ id: Id, workspaceId: Id, userId: Id, role: MembershipRole });
export type Membership = z.infer<typeof Membership>;

/** 연결 방식 — Gateway(OpenClaw) 또는 사람 머신의 러너. 러너 안에서 무엇을 돌리는지는 `Agent.program`(러너 일반화 스펙 결정 6) */
export const AgentProvider = z.enum(["openclaw", "runner"]);
/** 누가 이 에이전트와 DM 을 여나(에이전트 DM 스펙 결정 4) — off 아무도, admins admin 이상, everyone 모든 활성 멤버 */
export const DmAccess = z.enum(["off", "admins", "everyone"]);
export type DmAccess = z.infer<typeof DmAccess>;
export type AgentProvider = z.infer<typeof AgentProvider>;
/** 러너가 돌리는 프로그램 — 드라이버가 있는 것은 claude 뿐이다 */
export const RunnerProgram = z.enum(["claude", "codex", "opencode"]);
export type RunnerProgram = z.infer<typeof RunnerProgram>;
/**
 * 권한 모드 — 배열 순서가 「묻지 않고 돌 수 있는 것이 많은 순」의 정본이다(러너 일반화 스펙 2장). bypassPermissions 는 승인 카드가
 * 아예 뜨지 않아 「쓰기 도구는 승인 카드」 원칙이 깨지므로 어느 스키마도 받지 않는다. 러너 계약(runner/index.ts)이 다시 내보낸다 —
 * 여기 두는 까닭은 Agent 응답의 runnerAgent 가 쓰기 때문이다(runner 가 domain 을 값으로 import 한다)
 */
export const RUNNER_PERMISSION_MODES = ["plan", "dontAsk", "default", "acceptEdits"] as const;
export const RunnerPermissionMode = z.enum(RUNNER_PERMISSION_MODES);
export type RunnerPermissionMode = z.infer<typeof RunnerPermissionMode>;
export const permissionModeRank = (mode: RunnerPermissionMode): number =>
  RUNNER_PERMISSION_MODES.indexOf(mode);
/** 러너 실행의 노력치(effort) — SDK query() 의 effort 옵션. null 이면 프로그램 기본 */
export const RUNNER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const RunnerEffort = z.enum(RUNNER_EFFORTS);
export type RunnerEffort = z.infer<typeof RunnerEffort>;
/**
 * 러너 에이전트의 「새 세션 시작값」(세션 설정 스펙 S10) — 설정 행이 없는 대화가 이 값으로 돈다. null 은 「기본」: 모델·effort 는
 * 프로그램 기본, 권한은 실행 때 min(default, 그 러너의 상한). 대화마다의 설정(conversations ConversationAgentSettings)도 같은 값 규칙이다
 */
export const SessionDefaults = z.object({
  model: z.string().min(1).max(128).nullable(),
  effort: RunnerEffort.nullable(),
  permissionMode: RunnerPermissionMode.nullable(),
});
export type SessionDefaults = z.infer<typeof SessionDefaults>;
/** 러너 에이전트의 허용·금지 도구 이름 목록 — run.start.agent 와 REST 본문이 같은 상한을 쓴다 */
export const RunnerToolNames = z.array(z.string().min(1).max(200)).max(100);
/** 프로그램 이름표 — 서버 카드 문구(PROVIDER_AUTH 등)·러너 오류 문구·웹이 같은 글을 쓴다 */
export const RUNNER_PROGRAM_NAME: Record<RunnerProgram, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};
export const Agent = z.object({
  id: Id,
  workspaceId: Id,
  provider: AgentProvider,
  providerAgentId: z.string().min(1), // OpenClaw agentId
  handle: Handle,
  name: z.string().min(1).max(80),
  avatarUrl: AvatarUrl.optional(),
  basePrompt: z.string().max(20_000).optional(),
  enabled: z.boolean(),
  createdAt: IsoDateTime,
  /**
   * 보관(삭제)한 시각 — null 이면 살아 있다. 보관한 에이전트도 행·핸들·채널 참여·세션이 남고 목록에 실린다(채팅 기록의 작성자·멘션
   * 칩을 그리려면 웹이 알아야 한다). 고르는 자리는 이 값으로 거른다
   */
  archivedAt: IsoDateTime.nullable(),
  /**
   * 러너 에이전트가 묶인 러너 토큰 — 그 토큰의 러너만 이 에이전트를 맡는다. REST 에이전트 응답에만 싣는다. 없으면 아직 묶이지
   * 않았다(처음 알리는 러너에 묶인다). revoked 면 맡을 러너가 없다 — 연결 페이지에서 다른 러너에 다시 묶는다
   */
  runner: z.object({ tokenId: Id, label: z.string(), revoked: z.boolean() }).optional(),
  /**
   * OpenClaw 에이전트의 Gateway — REST 에이전트 응답에만, OpenClaw 에이전트에만 키가 있다. null 이면 Gateway 가 지워져 연결이 비었다
   * (owner 가 다른 Gateway 로 옮기기를 기다린다 — 멀티 Gateway 스펙 「에이전트 API」 절)
   */
  gateway: z.object({ id: Id, name: z.string() }).nullable().optional(),
  dmAccess: DmAccess.default("admins"),
  /** 러너 에이전트의 프로그램 — 러너면 값, OpenClaw 면 null */
  program: RunnerProgram.nullable().default(null),
  /** 만든 사람(소유자) — 기록 전에 만든 에이전트는 null. 소유자에게 따로 권한은 없다(프로필 스펙 결정 2) */
  createdBy: Id.nullable().default(null),
  /**
   * 러너 에이전트의 「새 세션 시작값」 — 러너 에이전트에만 키가 있고 모두에게 싣는다(새 세션 창의 상태 줄이 이 값에서 출발한다 — S11).
   * 모델·권한 모드는 에이전트 정의가 아니라 대화마다다(세션 설정 스펙)
   */
  sessionDefaults: SessionDefaults.optional(),
  /**
   * 러너 에이전트의 정의(러너 일반화 스펙 5장) — REST 에이전트 응답에만, 러너 에이전트에만 키가 있다. projectId 가 null 이면 프로젝트가
   * 없는 옛 러너 에이전트(보관됨 — 되살릴 수 없다). 금지 도구는 화면에서 고르지 않지만 이미 값이 있으면 런에 실린다
   */
  runnerAgent: z
    .object({
      projectId: Id.nullable(),
      disallowedTools: RunnerToolNames,
    })
    .optional(),
});
export type Agent = z.infer<typeof Agent>;

export const RelayPair = z.object({ from: Id, to: Id });
export type RelayPair = z.infer<typeof RelayPair>;
export const RelayPolicy = z.object({
  maxRelayTurns: z.int().min(0).max(32).default(4),
  allowPairs: z.union([z.literal("all"), z.array(RelayPair).max(64)]).default("all"),
  dailyRunLimit: z.int().min(1).optional(),
});
export type RelayPolicy = z.infer<typeof RelayPolicy>;

/** 채널마다 누가 새 세션을 만드나(채널 세션 스펙 「권한」 장) — managers 면 그 채널의 세션 관리자와 admin 이상만 */
export const SessionPolicy = z.object({ create: z.enum(["members", "managers"]) });
export type SessionPolicy = z.infer<typeof SessionPolicy>;

/** direct 는 사람 DM·그룹 DM(사람 간 DM 스펙 3장) — 참여자는 channel_members 행이고 그 사람들만 읽는다 */
export const ChannelKind = z.enum(["channel", "dm", "direct"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const Channel = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(80),
  topic: z.string().max(500).optional(),
  prompt: z.string().max(20_000).optional(),
  relayPolicy: RelayPolicy,
  visibility: z.enum(["public", "private"]),
  createdBy: Id,
  createdAt: IsoDateTime,
  /** 보관한 시각 — null 이면 살아 있다. 보관한 채널은 누구나 읽고 아무도 쓰지 못한다(보관 해제만 받는다) */
  archivedAt: IsoDateTime.nullable(),
  sessionPolicy: SessionPolicy.default({ create: "members" }),
  /**
   * dm 이면 주인 사람 하나 + 에이전트 하나의 1:1(에이전트 DM 스펙 2장) — 주인 말고는 owner·admin 도 읽지 못한다(서버 auth/channel-access.ts).
   * dmOwnerId·dmAgentId 는 dm 일 때만 값이 있다
   */
  kind: ChannelKind.default("channel"),
  dmOwnerId: Id.nullable().default(null),
  dmAgentId: Id.nullable().default(null),
});
export type Channel = z.infer<typeof Channel>;

/**
 * 읽기 전용 DM 의 사유 — 에이전트 DM 은 보관 → 꺼짐 → 허용 범위 순으로 하나(에이전트 DM 스펙 3.3), 사람 1:1 DM 은 상대 비활성
 * peer_deactivated 하나(사람 간 DM 스펙 4.3)
 */
export const DmReadOnlyReason = z.enum([
  "agent_archived",
  "agent_disabled",
  "dm_not_allowed",
  "peer_deactivated",
]);
export type DmReadOnlyReason = z.infer<typeof DmReadOnlyReason>;

/** 세션 제목(채널 세션 스펙 2.1) — 1~80자 */
export const ConversationTitle = z.string().trim().min(1).max(80);
/**
 * 채널 아래의 대화(세션). 채널의 메시지·런·에이전트 세션은 모두 대화 하나에 속한다(채널 세션 스펙 결정 1).
 * 기존 채널마다 마이그레이션이 만든 「이전 대화」는 id 가 그 채널 id 와 같다 — 저장된 세션 키가 그대로 맞는다
 */
export const Conversation = z.object({
  id: Id,
  channelId: Id,
  title: ConversationTitle,
  titleSource: z.enum(["user", "auto"]),
  createdBy: z.object({ type: z.enum(["user", "automation"]), id: Id }),
  createdAt: IsoDateTime,
  lastMessageAt: IsoDateTime.optional(),
  lastSeq: z.int().min(0),
  closedAt: IsoDateTime.optional(),
  closedBy: Id.optional(),
});
export type Conversation = z.infer<typeof Conversation>;

/** message.send 가 새 세션을 열 때(채널 세션 스펙 「세션 만들기·닫기」 절) — 제목이 없으면 첫 메시지 본문으로 짓는다 */
export const NewConversation = z.object({ title: ConversationTitle.optional() });
export type NewConversation = z.infer<typeof NewConversation>;

/** PATCH /conversations/:id — 제목 바꾸기·닫기·다시 열기. 둘 다 있으면 제목부터 */
export const ConversationPatch = z
  .object({ title: ConversationTitle.optional(), closed: z.boolean().optional() })
  .refine((p) => p.title !== undefined || p.closed !== undefined, {
    message: "title 이나 closed 가운데 하나는 있어야 한다",
  });
export type ConversationPatch = z.infer<typeof ConversationPatch>;

/** GET /channels/:id/conversations 한 쪽 — 최근 활동순, nextCursor 가 없으면 끝 */
export const ConversationList = z.object({
  conversations: z.array(Conversation),
  nextCursor: z.string().optional(),
});
export type ConversationList = z.infer<typeof ConversationList>;

export const ChannelMember = z.object({
  id: Id,
  channelId: Id,
  memberType: z.enum(["user", "agent"]),
  memberId: Id,
  promptOverride: z.string().max(20_000).optional(), // agent만
  autoRespond: z.boolean().default(false), // agent만, 채널당 최대 1
  aliases: z.array(Handle).max(8).default([]), // agent만
  role: z.enum(["member", "manager"]).optional(), // user만 — manager 는 그 채널의 세션 관리자(채널 세션 스펙 「권한」 장)
  joinedAt: IsoDateTime,
});
export type ChannelMember = z.infer<typeof ChannelMember>;

const AttachmentUrl = z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/);
export const Attachment = z.object({
  id: Id,
  kind: z.enum(["image", "file"]),
  url: AttachmentUrl,
  name: z.string().max(255),
  mime: z.string().max(127),
  size: z.int().min(0),
  width: z.int().optional(),
  height: z.int().optional(),
  thumbUrl: AttachmentUrl.optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** 첨부 상한(스펙 3장 4). 웹·서버·플러그인이 같은 값을 읽는다 */
export const ATTACHMENT_LIMITS = {
  userImageMaxBytes: 5 * 1024 * 1024,
  /** 사람이 올리는 이미지가 아닌 파일 — 이미지는 모델에게 내용으로 가므로 userImageMaxBytes 로 따로 묶는다(파일함 스펙 4.2) */
  userFileMaxBytes: 20 * 1024 * 1024,
  agentFileMaxBytes: 20 * 1024 * 1024,
  perMessage: 10,
  imageMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
} as const;

/** 그려도 되는 이미지 MIME 인가 — SVG 는 스크립트 면이라 아니다(스펙 결정 8). 대소문자를 맞춰 주지 않는다 */
export function isImageMime(mime: string): boolean {
  return (ATTACHMENT_LIMITS.imageMimes as readonly string[]).includes(mime);
}

/**
 * 양방향 제어(U+202A–202E 내장·덮어쓰기, U+2066–2069 격리, U+200E·200F·061C 방향 표시) — \p{Cc} 가 아니라 따로 적는다. 남기면
 * `invoice<U+202E>fdp.exe` 가 화면에 `invoiceexe.pdf` 로 보여 확장자를 속인다. ZWJ(U+200D) 같은 이음 문자는 이모지 열이 깨지므로 넣지 않는다
 */
const BIDI_CONTROLS_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

/**
 * 화면에 그릴 첨부 이름 — 양방향 제어 문자만 뺀다. 서버가 저장 때 다듬기 전에 들어온 옛 이름도 위장 없이 보이게 한다.
 * 비면 "file"(`sanitizeAttachmentName` 과 같은 값)
 */
export function displayAttachmentName(name: string): string {
  return name.replace(BIDI_CONTROLS_RE, "") || "file";
}

/**
 * 표시·`artifact://` 해석용 이름. 경로 구분자·제어 문자·양방향 제어 문자(`BIDI_CONTROLS_RE`)를 빼고 앞뒤 공백과 앞쪽 점을 걷는다.
 * 비면 "file", 최대 255자
 */
export function sanitizeAttachmentName(raw: string): string {
  const cleaned = Array.from(
    raw
      .replace(BIDI_CONTROLS_RE, "")
      .replace(/[\p{Cc}/\\]/gu, "")
      .trim()
      .replace(/^\.+/, "")
      .trim(),
  )
    .slice(0, 255)
    .join("");
  return cleaned || "file";
}

const ARTIFACT_ID_RE = /^artifact:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const artifactUrl = (id: string): string => `artifact://${id}`;
/** 서버 첨부 id 를 가리키는 `artifact://<uuid>` 면 id, 아니면 null */
export function parseArtifactUrl(url: string): string | null {
  return ARTIFACT_ID_RE.exec(url)?.[1]?.toLowerCase() ?? null;
}

export const SystemKind = z.enum(["relay_limit", "relay_denied", "run_error", "run_limit", "info"]);
export type SystemKind = z.infer<typeof SystemKind>;
export const SystemMeta = z.object({
  kind: SystemKind,
  /** relay_limit/relay_denied: 이어가기 대상 */
  relay: z.object({ fromAgentId: Id, toAgentId: Id, sourceRunId: Id, rootMessageId: Id }).optional(),
  runId: Id.optional(),
  /** run_limit: 막은 범위와 그 한도 */
  limit: z.object({ scope: z.enum(["channel", "workspace"]), limit: z.int().min(1) }).optional(),
});
export type SystemMeta = z.infer<typeof SystemMeta>;

/** 이 메시지의 components 에 일어난 상호작용 하나. 정본은 서버의 component_interactions 테이블이다. */
export const MessageInteraction = z.object({
  id: Id,
  componentId: z.string().max(100),
  userId: Id,
  itemId: StoredItemId,
  values: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type MessageInteraction = z.infer<typeof MessageInteraction>;

/** 메시지에 싣는 상호작용 개수 상한. 넘으면 최신 쪽을 남긴다(설계 3장). */
export const INTERACTIONS_MAX = 20;

/** 사람이 달 수 있는 이모지 — 목록은 여기 한 곳이다(웹 피커·서버 검증·에이전트 문구가 모두 이것을 읽는다) */
export const REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🎉", "👀", "✅", "❓"] as const;
export const ReactionEmoji = z.enum(REACTION_EMOJIS);
export type ReactionEmoji = z.infer<typeof ReactionEmoji>;

/** 메시지 하나의 이모지 하나 — 서버가 REACTION_EMOJIS 순서로 모아 싣는다. userIds 는 단 순서 */
export const MessageReaction = z.object({
  emoji: ReactionEmoji,
  count: z.int().min(1),
  userIds: z.array(Id),
});
export type MessageReaction = z.infer<typeof MessageReaction>;

/** 루트 메시지의 스레드 요약 — 답글이 있을 때만 싣는다(스레드·검색 스펙 4.1) */
export const ThreadSummary = z.object({
  count: z.int().min(1),
  lastAt: IsoDateTime,
  agentIds: z.array(Id).max(10),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const Message = z.object({
  id: Id,
  channelId: Id,
  conversationId: Id,
  seq: z.int().min(1),
  kind: z.enum(["normal", "system"]),
  authorType: z.enum(["user", "agent", "system", "automation"]),
  authorId: Id.optional(), // system이면 없음. automation 이면 자동화 id(자동화를 지워도 메시지는 남는다 — FK 가 아니다)
  /**
   * 자동화 글이고 그 자동화가 아직 있을 때만 — 서버 하이드레이션(withAutomationNames)이 붙인다. 자동화 목록 API 는 admin 전용이라
   * member 는 이것으로 이름을 본다. 지운 자동화면 없다
   */
  automationName: z.string().max(40).optional(),
  bodyMd: z.string().max(100_000),
  mentions: MentionSet,
  attachments: z.array(Attachment).max(ATTACHMENT_LIMITS.perMessage).default([]),
  // 읽기 스키마 — 저장된 행·서버가 내보내는 메시지. 새 카드는 쓰는 자리가 ComponentsV1 로 막는다(StoredItemId)
  components: StoredComponentsV1.optional(),
  componentState: StoredComponentState.optional(), // components가 있을 때 서버가 부여 (만료 시각·소비된 아이템)
  /**
   * 이 메시지 카드에 일어난 상호작용(설계 3장). **기본값이 있어 경계를 넘는 Message 에는 항상 있다** —
   * 없는 채로 message.updated 가 오면 웹 캐시가 기존 결과 줄을 지워 버린다.
   */
  interactions: z.array(MessageInteraction).max(INTERACTIONS_MAX).default([]),
  /** 기본값이 있어 경계를 넘는 Message 에는 항상 있다 — interactions 와 같은 까닭(없는 채로 message.updated 가 오면 웹 캐시가 칩을 지운다) */
  reactions: z.array(MessageReaction).max(REACTION_EMOJIS.length).default([]),
  systemMeta: SystemMeta.optional(), // kind === "system"일 때
  replyTo: Id.optional(),
  threadRootId: Id.optional(), // 스레드 답글이면 그 루트. 스레드 안의 스레드는 없다 — 루트만 가리킨다
  threadSummary: ThreadSummary.optional(),
  runId: Id.optional(), // agent 메시지: 만들어 낸 런
  clientMsgId: z.string().max(64).optional(), // 사용자 전송 멱등 키
  externalId: z.string().max(128).optional(), // 브리지 outboundId
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.optional(),
});
export type Message = z.infer<typeof Message>;

export const RunStatus = z.enum([
  "queued",
  "streaming",
  "tool",
  "awaiting_approval",
  "finalizing",
  "done",
  "error",
  "aborted",
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const RunTriggerKind = z.enum(["mention", "auto_respond", "relay", "interaction", "continue"]);
export type RunTriggerKind = z.infer<typeof RunTriggerKind>;
export const RunUsage = z.object({
  inputTokens: z.int().optional(),
  outputTokens: z.int().optional(),
  costUsd: z.number().optional(),
  // 구독 로그인의 달러 값은 청구액이 아니라 공시 단가 환산이다(ADR 0007 4.8)
  costKind: z.enum(["api", "subscription_estimate"]).optional(),
  model: z.string().optional(),
  // 러너 실행 끝의 컨텍스트 사용량(세션 설정 스펙 5.1) — 상태 줄의 컨텍스트 % 가 마지막 실행의 이 둘로 그린다
  contextTokens: z.int().min(0).optional(),
  contextWindow: z.int().min(1).optional(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z.object({
  id: Id,
  channelId: Id,
  conversationId: Id,
  agentId: Id,
  triggerKind: RunTriggerKind,
  triggerMessageId: Id.optional(), // interaction이면 없음
  triggerInteractionId: Id.optional(),
  rootMessageId: Id, // 릴레이 체인의 루트
  threadRootId: Id.optional(), // 스레드 런이면 그 루트 — 채널 런은 없다
  relayDepth: z.int().min(0),
  parentRunId: Id.optional(), // 서브에이전트 자식 런
  sessionKey: z.string(),
  providerRunId: z.string().optional(), // OpenClaw runId
  status: RunStatus,
  hasCanonical: z.boolean().default(false),
  finalSource: z.enum(["plugin", "gateway"]).optional(),
  usage: RunUsage.optional(),
  // connectionClosed — 어댑터가 연결을 닫으며 닫은 런(RunSignal gateway_error 의 같은 표지). 늦게 온 정본을 가른다
  error: z
    .object({ code: z.string(), message: z.string(), connectionClosed: z.literal(true).optional() })
    .optional(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
});
export type Run = z.infer<typeof Run>;

/** wire의 run.state에 실리는 요약 */
export const RunState = Run.pick({
  id: true,
  channelId: true,
  conversationId: true,
  threadRootId: true,
  agentId: true,
  status: true,
  relayDepth: true,
  parentRunId: true,
  hasCanonical: true,
  finalSource: true,
  error: true,
  startedAt: true,
  endedAt: true,
});
export type RunState = z.infer<typeof RunState>;

export const ComponentInteraction = z.object({
  id: Id,
  messageId: Id,
  componentId: z.string(),
  userId: Id,
  blockId: z.string().optional(),
  itemId: z.string(), // 버튼/셀렉트 id 또는 모달 id
  values: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
  deliveredAt: IsoDateTime.optional(),
});
export type ComponentInteraction = z.infer<typeof ComponentInteraction>;

// 승인 계약은 Gateway 실물에 맞춘다(승인 스파이크 3·4·5장, 설계 3.1). 값을 바꾸면 Gateway 가 조용히 거절로 확정한다.
// tool — Claude 러너의 도구 승인(러너 스펙 6장)
// dodok_control — 채널 안 에이전트의 제어 도구 쓰기 확인 카드(제어 MCP 스펙 「확인 카드」 장). 우리 서버가 낸 승인이라 어댑터로 가지
// 않고, 결정은 그 런을 시킨 사람 본인만 allow-once·deny 로 한다
export const ApprovalKind = z.enum(["exec", "plugin", "system-agent", "tool", "dodok_control"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;
/** `cancelled` 는 런 중단·Gateway 재기동. 만료는 `expired`(+ `reason: "timeout"`). */
export const ApprovalStatus = z.enum(["pending", "allowed", "denied", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
/** `approval.resolve` 가 받는 값 셋. 그 승인의 `allowedDecisions` 밖 값은 Gateway 가 `malformed-verdict` 거절로 확정한다(스파이크 4.4). */
export const ApprovalDecision = z.enum(["allow-once", "allow-always", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export const ApprovalReason = z.enum([
  "user",
  "timeout",
  "malformed-verdict",
  "no-route",
  "run-aborted",
  "gateway-restart",
  "storage-corrupt",
]);
export type ApprovalReason = z.infer<typeof ApprovalReason>;
export const ApprovalSeverity = z.enum(["info", "warning", "critical"]);
export type ApprovalSeverity = z.infer<typeof ApprovalSeverity>;

export const Approval = z.object({
  id: Id,
  providerApprovalId: z.string().min(1).max(200), // "plugin:<uuid>" — 유일 인덱스
  kind: ApprovalKind,
  channelId: Id, // 대화의 채널
  conversationId: Id, // sessionKey 에서 푼다
  agentId: Id,
  runId: Id.optional(), // 승인 페이로드에 runId 가 없다 — sessionKey + toolCallId 로 런에 붙인다(스파이크 3.2)
  toolCallId: z.string().max(200).optional(),
  toolName: z.string().max(100).optional(),
  pluginId: z.string().max(100).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(512).optional(), // 툴 인자 JSON 원문 — Gateway 가 380자 초과분을 잘라 준다
  detail: z.string().max(16_384).optional(),
  severity: ApprovalSeverity,
  allowedDecisions: z.array(ApprovalDecision).min(1).max(3), // 이 목록대로만 버튼을 낸다
  urlPath: z.string().max(500).optional(),
  status: ApprovalStatus,
  decision: ApprovalDecision.optional(),
  reason: ApprovalReason.optional(),
  decidedBy: Id.optional(), // 우리 사용자 — 우리가 해결했을 때만
  // dodok_control 만 — 결정할 수 있는 사람(그 런을 시킨 사람). 다른 kind 는 비운다(지금처럼 admin 이상이 결정)
  requestedBy: Id.optional(),
  decidedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime, // 카운트다운의 근거. plugin 기본 TTL 120초, 우리가 늘릴 수단이 없다
  createdAt: IsoDateTime,
});
export type Approval = z.infer<typeof Approval>;

export const PushSubscription = z.object({
  id: Id,
  userId: Id,
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  userAgent: z.string().max(255).optional(),
  createdAt: IsoDateTime,
});
export type PushSubscription = z.infer<typeof PushSubscription>;
