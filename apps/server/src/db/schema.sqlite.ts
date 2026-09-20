import type {
  ApprovalDecision,
  Attachment,
  ComponentState,
  ComponentsV1,
  MentionSet,
  RelayPolicy,
  RunEvent,
  RunUsage,
  SystemMeta,
} from "@dodok/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    authProvider: text("auth_provider").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_ws_handle").on(t.workspaceId, t.handle)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
  },
  (t) => [uniqueIndex("memberships_ws_user").on(t.workspaceId, t.userId)],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").notNull(),
    providerAgentId: text("provider_agent_id").notNull(),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    basePrompt: text("base_prompt"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("agents_ws_handle").on(t.workspaceId, t.handle),
    uniqueIndex("agents_ws_provider_agent").on(t.workspaceId, t.provider, t.providerAgentId),
  ],
);

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  topic: text("topic"),
  prompt: text("prompt"),
  relayPolicy: json<RelayPolicy>("relay_policy_json").notNull(),
  visibility: text("visibility").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  lastSeq: integer("last_seq").notNull().default(0), // 메시지 seq 카운터
  promptRevision: integer("prompt_revision").notNull().default(1), // prompt·promptOverride·relayPolicy 가 바뀔 때마다 +1
  createdAt: ts("created_at").notNull(),
});

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    sessionKey: text("session_key").notNull(), // agent:<providerAgentId>:dodok:channel:<channelId>
    promptRevisionAtStart: integer("prompt_revision_at_start").notNull(), // 세션이 마지막으로 새로 시작됐을 때(첫 턴·리셋 뒤)의 채널 프롬프트 리비전
    sessionStartedAt: ts("session_started_at"), // Gateway sessions.list 의 sessionStartedAt (리셋 판별)
    lifecycleRevision: text("lifecycle_revision"), // 실측값은 uuid 문자열 (sessions.reset 응답 entry)
    providerSessionId: text("provider_session_id"), // sessionId (리셋 뒤에도 유지되므로 식별용으로만)
    historyCursor: text("history_cursor"), // chat.history deltaCursor (오면 저장, 최적화용)
    lastSyncedAt: ts("last_synced_at"),
  },
  (t) => [uniqueIndex("agent_sessions_channel_agent").on(t.channelId, t.agentId)],
);

export const channelMembers = sqliteTable(
  "channel_members",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    memberType: text("member_type").notNull(),
    memberId: text("member_id").notNull(),
    promptOverride: text("prompt_override"),
    autoRespond: integer("auto_respond", { mode: "boolean" }).notNull().default(false),
    aliases: json<string[]>("aliases_json").notNull().default([]),
    joinedAt: ts("joined_at").notNull(),
  },
  (t) => [uniqueIndex("channel_members_unique").on(t.channelId, t.memberType, t.memberId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    authorType: text("author_type").notNull(),
    authorId: text("author_id"),
    bodyMd: text("body_md").notNull(),
    mentions: json<MentionSet>("mentions_json").notNull(),
    attachments: json<Attachment[]>("attachments_json").notNull().default([]),
    components: json<ComponentsV1>("components_json"),
    componentState: json<ComponentState>("component_state_json"),
    systemMeta: json<SystemMeta>("system_meta_json"),
    replyTo: text("reply_to"),
    runId: text("run_id"),
    clientMsgId: text("client_msg_id"),
    externalId: text("external_id"),
    createdAt: ts("created_at").notNull(),
    editedAt: ts("edited_at"),
  },
  (t) => [
    uniqueIndex("messages_channel_seq").on(t.channelId, t.seq),
    uniqueIndex("messages_author_client_msg").on(t.authorId, t.clientMsgId),
    uniqueIndex("messages_external_id").on(t.externalId),
    index("messages_run").on(t.runId),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    triggerKind: text("trigger_kind").notNull(),
    triggerMessageId: text("trigger_message_id"),
    triggerInteractionId: text("trigger_interaction_id"),
    rootMessageId: text("root_message_id").notNull(),
    relayDepth: integer("relay_depth").notNull().default(0),
    parentRunId: text("parent_run_id"),
    sessionKey: text("session_key").notNull(),
    providerRunId: text("provider_run_id"),
    status: text("status").notNull(),
    hasCanonical: integer("has_canonical", { mode: "boolean" }).notNull().default(false),
    finalSource: text("final_source"),
    usage: json<RunUsage>("usage_json"),
    error: json<{ code: string; message: string }>("error_json"),
    relayHash: text("relay_hash"), // hash(from, to, 정규화 본문)
    createdAt: ts("created_at").notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
  },
  (t) => [
    uniqueIndex("runs_provider_run").on(t.providerRunId),
    index("runs_channel_created").on(t.channelId, t.createdAt),
    index("runs_root").on(t.rootMessageId),
    index("runs_session_status").on(t.sessionKey, t.status),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: json<RunEvent>("payload_json").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("run_events_run_seq").on(t.runId, t.seq)],
);

export const componentInteractions = sqliteTable(
  "component_interactions",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    componentId: text("component_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    blockId: text("block_id"),
    itemId: text("item_id").notNull(),
    values: json<Record<string, unknown>>("values_json").notNull(),
    createdAt: ts("created_at").notNull(),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [index("component_interactions_message").on(t.messageId)],
);

/** 승인 계약(shared `Approval`, 설계 3.1)에 맞춘다. `runId` 는 없을 수 있다 — 승인 페이로드에 runId 가 없어 sessionKey 로 상관한다(스파이크 3.2). */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    providerApprovalId: text("provider_approval_id").notNull(),
    kind: text("kind").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: text("run_id").references(() => runs.id), // 열린 런이 없으면 채널 수준 승인
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    pluginId: text("plugin_id"),
    title: text("title").notNull(),
    description: text("description"),
    detail: text("detail"),
    severity: text("severity").notNull(),
    allowedDecisions: json<ApprovalDecision[]>("allowed_decisions_json").notNull(),
    urlPath: text("url_path"),
    status: text("status").notNull(),
    decision: text("decision"),
    reason: text("reason"),
    decidedBy: text("decided_by"), // 우리 사용자가 해결했을 때만 — 다른 디바이스가 해결하면 비운다
    decidedAt: ts("decided_at"),
    expiresAt: ts("expires_at").notNull(), // 카운트다운의 근거
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("approvals_provider").on(t.providerApprovalId),
    index("approvals_channel_status").on(t.channelId, t.status),
    index("approvals_run").on(t.runId),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    endpoint: text("endpoint").notNull(),
    keys: json<{ p256dh: string; auth: string }>("keys_json").notNull(),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint").on(t.endpoint)],
);
