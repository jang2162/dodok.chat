import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ComponentState, ComponentsV1, ItemId } from "../components";
import { MentionSet } from "../mention"; // MentionSet은 mention.ts가 소유. 루트 index가 export하므로 여기서 재export하지 않는다(export * 충돌 방지).

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
  avatarUrl: z.url().optional(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const MembershipRole = z.enum(["owner", "admin", "member", "guest"]);
export type MembershipRole = z.infer<typeof MembershipRole>;
export const Membership = z.object({ id: Id, workspaceId: Id, userId: Id, role: MembershipRole });
export type Membership = z.infer<typeof Membership>;

export const AgentProvider = z.enum(["openclaw", "claude", "codex", "hermes"]);
export type AgentProvider = z.infer<typeof AgentProvider>;
export const Agent = z.object({
  id: Id,
  workspaceId: Id,
  provider: AgentProvider,
  providerAgentId: z.string().min(1), // OpenClaw agentId
  handle: Handle,
  name: z.string().min(1).max(80),
  avatarUrl: z.url().optional(),
  basePrompt: z.string().max(20_000).optional(),
  enabled: z.boolean(),
  createdAt: IsoDateTime,
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
});
export type Channel = z.infer<typeof Channel>;

export const ChannelMember = z.object({
  id: Id,
  channelId: Id,
  memberType: z.enum(["user", "agent"]),
  memberId: Id,
  promptOverride: z.string().max(20_000).optional(), // agent만
  autoRespond: z.boolean().default(false), // agent만, 채널당 최대 1
  aliases: z.array(Handle).max(8).default([]), // agent만
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
  agentFileMaxBytes: 20 * 1024 * 1024,
  perMessage: 10,
  imageMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
} as const;

/** 그려도 되는 이미지 MIME 인가 — SVG 는 스크립트 면이라 아니다(스펙 결정 8). 대소문자를 맞춰 주지 않는다 */
export function isImageMime(mime: string): boolean {
  return (ATTACHMENT_LIMITS.imageMimes as readonly string[]).includes(mime);
}

/** 표시·`artifact://` 해석용 이름. 경로 구분자·제어 문자를 빼고 앞뒤 공백과 앞쪽 점을 걷는다. 비면 "file", 최대 255자 */
export function sanitizeAttachmentName(raw: string): string {
  const cleaned = Array.from(
    raw
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
  itemId: ItemId,
  values: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type MessageInteraction = z.infer<typeof MessageInteraction>;

/** 메시지에 싣는 상호작용 개수 상한. 넘으면 최신 쪽을 남긴다(설계 3장). */
export const INTERACTIONS_MAX = 20;

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
  seq: z.int().min(1),
  kind: z.enum(["normal", "system"]),
  authorType: z.enum(["user", "agent", "system"]),
  authorId: Id.optional(), // system이면 없음
  bodyMd: z.string().max(100_000),
  mentions: MentionSet,
  attachments: z.array(Attachment).max(ATTACHMENT_LIMITS.perMessage).default([]),
  components: ComponentsV1.optional(),
  componentState: ComponentState.optional(), // components가 있을 때 서버가 부여 (만료 시각·소비된 아이템)
  /**
   * 이 메시지 카드에 일어난 상호작용(설계 3장). **기본값이 있어 경계를 넘는 Message 에는 항상 있다** —
   * 없는 채로 message.updated 가 오면 웹 캐시가 기존 결과 줄을 지워 버린다.
   */
  interactions: z.array(MessageInteraction).max(INTERACTIONS_MAX).default([]),
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
  model: z.string().optional(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z.object({
  id: Id,
  channelId: Id,
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
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
});
export type Run = z.infer<typeof Run>;

/** wire의 run.state에 실리는 요약 */
export const RunState = Run.pick({
  id: true,
  channelId: true,
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
export const ApprovalKind = z.enum(["exec", "plugin", "system-agent"]);
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
  channelId: Id, // sessionKey 에서 푼다
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
