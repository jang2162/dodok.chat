import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ComponentState, ComponentsV1 } from "../components";
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

export const SystemKind = z.enum(["relay_limit", "relay_denied", "run_error", "info"]);
export type SystemKind = z.infer<typeof SystemKind>;
export const SystemMeta = z.object({
  kind: SystemKind,
  /** relay_limit/relay_denied: 이어가기 대상 */
  relay: z.object({ fromAgentId: Id, toAgentId: Id, sourceRunId: Id, rootMessageId: Id }).optional(),
  runId: Id.optional(),
});
export type SystemMeta = z.infer<typeof SystemMeta>;

export const Message = z.object({
  id: Id,
  channelId: Id,
  seq: z.int().min(1),
  kind: z.enum(["normal", "system"]),
  authorType: z.enum(["user", "agent", "system"]),
  authorId: Id.optional(), // system이면 없음
  bodyMd: z.string().max(100_000),
  mentions: MentionSet,
  attachments: z.array(Attachment).max(10).default([]),
  components: ComponentsV1.optional(),
  componentState: ComponentState.optional(), // components가 있을 때 서버가 부여 (만료 시각·소비된 아이템)
  systemMeta: SystemMeta.optional(), // kind === "system"일 때
  replyTo: Id.optional(),
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

export const ApprovalKind = z.enum(["exec", "plugin", "generic"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
export const Approval = z.object({
  id: Id,
  runId: Id,
  providerApprovalId: z.string(),
  kind: ApprovalKind,
  summary: z.string().max(4000),
  payload: z.record(z.string(), z.unknown()).optional(),
  status: ApprovalStatus,
  decidedBy: Id.optional(),
  decidedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime.optional(),
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
