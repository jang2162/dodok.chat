import type {
  ApprovalDecision,
  Attachment,
  AutomationKind,
  AutomationSchedule,
  AutomationStatus,
  ComponentState,
  ComponentsV1,
  MentionSet,
  OpsEvent,
  OpsEventKind,
  OpsSeverity,
  RelayPolicy,
  SessionPolicy,
  RunEvent,
  RunUsage,
  SystemMeta,
} from "@dodok/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { session } from "./auth-schema";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
  /** 운영 설정 { dailyRunLimit?, timeZone? } — 망가진 값도 읽을 수 있게 json 모드가 아니다(modules/ops/settings.ts 가 파싱) */
  opsJson: text("ops_json").notNull().default("{}"),
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
  (t) => [
    uniqueIndex("users_ws_handle").on(t.workspaceId, t.handle),
    // email 이 NULL 인 행은 여럿이어도 된다 — SQLite 는 유일 인덱스에서 NULL 을 서로 다르게 본다
    uniqueIndex("users_ws_email").on(t.workspaceId, t.email),
  ],
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
    /**
     * 비활성화한 시각 — null 이면 활성. 비활성 membership 은 인증 자리(auth/roles.ts roleOf)가 없는 것처럼 본다. 역할·채널 참여는
     * 남아 다시 활성화하면 그대로 돌아온다(채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절)
     */
    deactivatedAt: ts("deactivated_at"),
  },
  (t) => [uniqueIndex("memberships_ws_user").on(t.workspaceId, t.userId)],
);

/**
 * OpenClaw Gateway 연결(멀티 Gateway 스펙 「gateways (새 표)」 절) — id 가 어댑터 계약의 연결 id 다. token 은 Gateway 공유 토큰 평문(결정 4 — 같은 DATA_DIR 의
 * 디바이스 아이덴티티도 평문이다). API 응답·로그·사건·wire 에 싣지 않는다. owner_user_id 는 사람마다 붙이기의 자리 — 지금은 늘 null
 */
export const gateways = sqliteTable(
  "gateways",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    url: text("url").notNull(),
    token: text("token").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ownerUserId: text("owner_user_id").references(() => users.id),
    lastVersion: text("last_version"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("gateways_ws_name").on(t.workspaceId, t.name)],
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
    // Claude 러너 에이전트가 묶인 러너 토큰 — 그 토큰의 러너만 맡는다. null 이면 처음 알린 러너에 묶인다. 폐기돼도 남는다
    runnerTokenId: text("runner_token_id").references((): AnySQLiteColumn => runnerTokens.id),
    // OpenClaw 에이전트를 맡은 Gateway — null 이면 연결이 빈 에이전트(Gateway 를 지웠다 — 옮기기를 기다린다)
    gatewayId: text("gateway_id").references(() => gateways.id, { onDelete: "set null" }),
    // 보관(삭제)한 시각 — null 이면 살아 있다. 보관해도 행·핸들·채널 참여·세션은 남아 되살리면 그대로 돌아온다
    archivedAt: ts("archived_at"),
  },
  (t) => [
    uniqueIndex("agents_ws_handle").on(t.workspaceId, t.handle),
    // 에이전트의 정체는 「연결 + 제공자 쪽 id」다 — 두 Gateway 의 main 은 둘 다 등록된다. 러너는 id 로 에이전트를 가져가므로 워크스페이스에 하나.
    // 대소문자 무시는 등록(createAgent)이 본다
    uniqueIndex("agents_openclaw_gateway_agent")
      .on(t.gatewayId, t.providerAgentId)
      .where(sql`provider = 'openclaw'`),
    uniqueIndex("agents_claude_ws_agent")
      .on(t.workspaceId, t.provider, t.providerAgentId)
      .where(sql`provider = 'claude'`),
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
  // 보관한 시각 — null 이면 살아 있다. 보관해도 메시지·스레드·런·멤버·세션·첨부는 남아 보관 해제하면 그대로 돌아온다
  archivedAt: ts("archived_at"),
  // 누가 새 세션을 만드나(채널 세션 스펙 「권한」 장) — 세션 관리자는 channel_members.role
  sessionPolicy: json<SessionPolicy>("session_policy_json").notNull().default({ create: "members" }),
});

/**
 * 채널 아래의 대화(세션 — 채널 세션 스펙 2.1). 채널의 메시지·런·에이전트 세션은 모두 대화 하나에 속한다. 0025 가 기존 채널마다
 * id 가 그 채널 id 와 같은 「이전 대화」를 만들었다 — 저장된 세션 키(`…:channel:<id>`)가 새로 계산한 키와 그대로 맞는다
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    title: text("title").notNull(),
    titleSource: text("title_source").notNull(), // "user" | "auto"
    createdByType: text("created_by_type").notNull(), // "user" | "automation"
    createdById: text("created_by_id").notNull(), // 사용자 id 또는 자동화 id — FK 가 아니다(자동화를 지워도 대화는 남는다)
    createdAt: ts("created_at").notNull(),
    lastMessageAt: ts("last_message_at"), // 목록 정렬(최근 활동순). 메시지가 없으면 null
    lastSeq: integer("last_seq").notNull().default(0), // 이 대화에 마지막으로 저장된 메시지의 seq(채널 seq 를 같이 쓴다)
    closedAt: ts("closed_at"), // null 이면 열림
    closedBy: text("closed_by"),
  },
  (t) => [index("conversations_channel_open_recent").on(t.channelId, t.closedAt, t.lastMessageAt)],
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    sessionKey: text("session_key").notNull(), // agent:<providerAgentId>:dodok:channel:<conversationId>[:thread:<rootId>] — shared dodokSessionKey
    promptRevisionAtStart: integer("prompt_revision_at_start").notNull(), // 세션이 마지막으로 새로 시작됐을 때(첫 턴·리셋 뒤)의 채널 프롬프트 리비전
    sessionStartedAt: ts("session_started_at"), // Gateway sessions.list 의 sessionStartedAt (리셋 판별)
    lifecycleRevision: text("lifecycle_revision"), // 실측값은 uuid 문자열 (sessions.reset 응답 entry)
    providerSessionId: text("provider_session_id"), // sessionId (리셋 뒤에도 유지되므로 식별용으로만)
    historyCursor: text("history_cursor"), // chat.history deltaCursor (오면 저장, 최적화용)
    lastSyncedAt: ts("last_synced_at"),
    threadRootId: text("thread_root_id"), // 스레드 하위 세션이면 그 루트 메시지 id, 채널 세션은 null
    // 이 시각 뒤에 달린 리액션만 다음 런에 싣는다. null 이면 실을 것이 없는 것으로 읽는다 — 옛 리액션을 한꺼번에 싣는 쪽으로 틀리지 않게
    reactionsSeenAt: ts("reactions_seen_at"),
  },
  (t) => [
    uniqueIndex("agent_sessions_conversation_agent_thread").on(t.conversationId, t.agentId, t.threadRootId),
    // SQLite 유일 인덱스는 NULL 끼리를 서로 다르다고 봐서 위 인덱스만으로는 대화 세션 행이 둘 생길 수 있다 — 대화 세션만 따로 막는다.
    // coalesce 표현식 인덱스는 drizzle-kit 이 쉼표에서 SQL 을 깨뜨린다. onConflict 는 targetWhere 로 이 인덱스를 고른다(sessions/service.ts)
    uniqueIndex("agent_sessions_conversation_session")
      .on(t.conversationId, t.agentId)
      .where(sql`thread_root_id IS NULL`),
  ],
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
    // 사람 행만 — "member" | "manager"(그 채널의 세션 관리자, 채널 세션 스펙 「권한」 장). 에이전트 행은 null
    role: text("role"),
    joinedAt: ts("joined_at").notNull(),
  },
  (t) => [uniqueIndex("channel_members_unique").on(t.channelId, t.memberType, t.memberId)],
);

/**
 * 사용자 × 채널의 읽음 위치(읽지 않음 스펙 「channel_reads (새 표·새 마이그레이션)」 절) — last_read_seq 는 커지기만 한다(modules/reads/store.ts markRead).
 * 행이 없으면 0 으로 본다. 비활성화·보관은 행을 건드리지 않는다 — 다시 활성화·보관 해제하면 읽음 위치가 그대로 돌아온다
 */
export const channelReads = sqliteTable(
  "channel_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastReadSeq: integer("last_read_seq").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
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
    threadRootId: text("thread_root_id"), // 스레드 답글이면 같은 대화의 루트(thread_root_id 가 null 인 메시지) id
    createdAt: ts("created_at").notNull(),
    editedAt: ts("edited_at"),
  },
  (t) => [
    uniqueIndex("messages_channel_seq").on(t.channelId, t.seq),
    uniqueIndex("messages_author_client_msg").on(t.authorId, t.clientMsgId),
    uniqueIndex("messages_external_id").on(t.externalId),
    index("messages_run").on(t.runId),
    index("messages_channel_thread_seq").on(t.channelId, t.threadRootId, t.seq),
    index("messages_conversation_thread_seq").on(t.conversationId, t.threadRootId, t.seq),
  ],
);

/** 첨부(스펙 4.1). message_id 가 null 이면 아직 묶이지 않은 업로드다. 블롭은 sha256 이름으로 디스크에 한 번만 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    uploaderType: text("uploader_type").notNull(), // "user" | "bridge"
    uploaderId: text("uploader_id"), // 사용자 id, 러너가 올렸으면 러너 토큰 id, 플러그인(브리지)이면 null
    // 플러그인이 올렸으면 그 브리지 토큰의 Gateway — 그 Gateway 만 읽고 정본에 묶는다(멀티 Gateway 스펙 「브리지 첨부 범위」 절). Gateway 를 지우면 비어
    // 아무도 묶지 못한다(러너 정본은 uploader_id 가 자기 토큰인 것만 묶는다)
    gatewayId: text("gateway_id").references(() => gateways.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // "image" | "file"
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    messageId: text("message_id").references(() => messages.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("attachments_message").on(t.messageId),
    index("attachments_sha256").on(t.sha256),
    index("attachments_unbound").on(t.messageId, t.createdAt),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
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
    // connectionClosed — 어댑터가 연결을 닫으며 닫은 런(재시작 뒤에도 늦은 정본을 가른다, runs/orchestrator.ts onCanonical)
    error: json<{ code: string; message: string; connectionClosed?: true }>("error_json"),
    relayHash: text("relay_hash"), // hash(from, to, 정규화 본문)
    threadRootId: text("thread_root_id"), // 스레드 런이면 그 루트 메시지 id
    // 그 런을 맡은 연결(OpenClaw Gateway id·러너 토큰 id) — 만들 때 에이전트 행의 연결, send 가 돌려준 값으로 덮는다. 에이전트를
    // 옮겨도 옛 런의 대조가 흔들리지 않게 런에 남긴다. 세션 키가 같은 두 Gateway 의 런을 이것으로 가른다
    connectionId: text("connection_id"),
    // 그 런을 시킨 사람(제어 MCP 스펙 「그 런을 시킨 사람」 절) — 채널 안 에이전트의 제어 도구가 이 사람의 지금 역할을 빌린다.
    // null 이면 시킨 사람이 없다(자동화 글로 시작한 사슬·이 열 전의 런) — 읽기 도구만. 정하는 곳은 runs/orchestrator.ts requesterOf
    requestedBy: text("requested_by"),
    createdAt: ts("created_at").notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
  },
  (t) => [
    // 제공자 런 id 는 연결 안에서만 유일하다 — 두 Gateway 가 같은 id 를 낼 수 있다
    uniqueIndex("runs_connection_provider_run").on(t.connectionId, t.providerRunId),
    index("runs_channel_created").on(t.channelId, t.createdAt),
    index("runs_conversation_created").on(t.conversationId, t.createdAt),
    index("runs_root").on(t.rootMessageId),
    index("runs_session_status").on(t.sessionKey, t.status),
    index("runs_connection_session_status").on(t.connectionId, t.sessionKey, t.status),
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

/**
 * 사람이 메시지에 단 리액션 — 한 사람이 같은 이모지는 한 번뿐. created_at 은 에이전트에게 안 알린 것을 가르는 커서 비교에 쓴다.
 * 사용자 행은 지워지지 않으므로(비활성화) 사용자 cascade 는 정합성용이다
 */
export const messageReactions = sqliteTable(
  "message_reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index("message_reactions_message").on(t.messageId),
    index("message_reactions_created").on(t.createdAt),
  ],
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
    conversationId: text("conversation_id") // 세션 키에서 푼 대화
      .notNull()
      .references(() => conversations.id),
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
    connectionId: text("connection_id"), // 승인이 온 연결 — 해결도 그 연결로 보낸다
    // dodok_control 확인 카드만 — 결정할 수 있는 사람(그 런의 runs.requested_by). 다른 kind 는 비운다
    requestedBy: text("requested_by"),
  },
  (t) => [
    // 제공자 승인 id 는 연결 안에서만 유일하다(runs 와 같은 까닭)
    uniqueIndex("approvals_connection_provider").on(t.connectionId, t.providerApprovalId),
    index("approvals_channel_status").on(t.channelId, t.status),
    index("approvals_run").on(t.runId),
  ],
);

/**
 * 웹 푸시 구독. session_id 는 구독을 등록한 Better Auth 세션 — 그 세션 행이 지워지면(로그아웃·비밀번호 변경·재설정·비활성화·
 * 만료 청소, 모두 session 행 DELETE) 구독도 함께 지워진다(ON DELETE CASCADE, createDb 가 foreign_keys 를 켠다).
 * 청소 전의 만료 세션은 listSubscriptions 가 거른다
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    keys: json<{ p256dh: string; auth: string }>("keys_json").notNull(),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint").on(t.endpoint),
    index("push_subscriptions_session").on(t.sessionId),
  ],
);

/**
 * 네이티브 푸시 기기(APNs·FCM). token 은 전역 유일 — 같은 폰에 다른 계정이 로그인하면 행이 그 사용자·세션으로 옮겨 간다.
 * 세션이 지워지면 함께 지워진다(웹 구독과 같은 규칙)
 */
export const pushDevices = sqliteTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: ["ios", "android"] }).notNull(),
    token: text("token").notNull(),
    appId: text("app_id").notNull(),
    /** iOS 만 — APNs 호스트(production·sandbox)를 가른다 */
    environment: text("environment", { enum: ["sandbox", "production"] }),
    createdAt: ts("created_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
  },
  (t) => [
    uniqueIndex("push_devices_token").on(t.token),
    index("push_devices_user").on(t.userId),
    index("push_devices_session").on(t.sessionId),
  ],
);

/**
 * 브리지 토큰(설정 마법사 스펙 2.2) — 원문은 두지 않는다. hash 는 sha256(원문) hex, prefix 는 알아보기용 6자.
 * 폐기는 지우지 않고 revoked_at 을 채운다(목록에 남는다)
 */
export const bridgeTokens = sqliteTable(
  "bridge_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    label: text("label").notNull(),
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    // 토큰이 붙이는 Gateway — 플러그인은 토큰만 보내고 서버가 이것으로 Gateway 를 안다. Gateway 를 지우면 함께 지운다
    gatewayId: text("gateway_id")
      .notNull()
      .references(() => gateways.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("bridge_tokens_hash").on(t.hash),
    index("bridge_tokens_ws_created").on(t.workspaceId, t.createdAt),
  ],
);

/** 러너 토큰(러너 스펙 5장) — bridge_tokens 와 같은 열. 원문 drn_… 은 발급 응답에만, 여기는 sha256 hex 와 원문 앞 6자 */
export const runnerTokens = sqliteTable(
  "runner_tokens",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    label: text("label").notNull(),
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("runner_tokens_hash").on(t.hash),
    index("runner_tokens_ws_created").on(t.workspaceId, t.createdAt),
  ],
);

/**
 * 개인 토큰(PAT, 제어 MCP 스펙 「개인 토큰(PAT)」 절) — 바깥 MCP 클라이언트가 `/mcp` 에 그 사람으로 붙는다. 원문 dpt_… 은 발급
 * 응답에만 있고 여기에는 sha256 hex 만 둔다. 비활성화가 그 사람의 행을 모두 폐기하고, 다시 활성화해도 되살리지 않는다
 */
export const personalTokens = sqliteTable(
  "personal_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("personal_tokens_hash").on(t.hash),
    index("personal_tokens_user_created").on(t.userId, t.createdAt),
  ],
);

/**
 * 운영 사건(운영 보강 스펙 3.1) — 같은 kind·key 는 한 줄로 묶여 count·last_at 만 오른다.
 * detail_json 에는 id·코드·수치만(메시지 본문·토큰·호스트 경로·IP 전체 금지). last_at 이 30일 지나면 지운다
 */
export const opsEvents = sqliteTable(
  "ops_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").$type<OpsEventKind>().notNull(),
    severity: text("severity").$type<OpsSeverity>().notNull(),
    key: text("key").notNull(),
    detail: json<OpsEvent["detail"]>("detail_json").notNull(),
    count: integer("count").notNull().default(1),
    firstAt: ts("first_at").notNull(),
    lastAt: ts("last_at").notNull(),
    resolvedAt: ts("resolved_at"),
    ackedAt: ts("acked_at"),
  },
  (t) => [
    index("ops_events_ws_last").on(t.workspaceId, t.lastAt),
    index("ops_events_open").on(t.workspaceId, t.kind, t.key, t.ackedAt),
  ],
);

/**
 * 초대·재설정 링크(팀 스펙 3.1) — 원문(dit_…·drt_…)은 두지 않는다. token_hash 는 sha256(원문) hex, prefix 는 원문 앞 8자.
 * 유효 = used_at·revoked_at 이 NULL 이고 expires_at 이 지나지 않음. 폐기·사용은 지우지 않고 그 칸을 채운다
 */
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").$type<"invite" | "reset">().notNull(),
    role: text("role").$type<"admin" | "member">(), // kind = 'invite' 일 때만
    targetUserId: text("target_user_id").references(() => users.id), // kind = 'reset' 일 때만
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    usedBy: text("used_by"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("invites_token_hash").on(t.tokenHash)],
);

/**
 * 자동화(자동화 스펙 「데이터 모델」 절) — 예약·웹훅 트리거가 channel_id 의 최상위에 body_md 를 게시한다. 게시한 메시지의
 * author_id 가 이 id 다(FK 가 아니라 행을 지워도 메시지는 남는다).
 * 종류마다 쓰는 칸이 갈린다 — schedule_json·next_run_at 은 예약만(next_run_at 은 켜져 있을 때만), token_hash·token_prefix 는 웹훅만.
 * 토큰 원문(whk_…)은 두지 않는다 — token_hash 는 sha256(원문) hex, token_prefix 는 whk_ 뒤 6자
 */
export const automations = sqliteTable(
  "automations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    // 자동화가 게시하는 자기 세션(채널 세션 스펙 「자동화」 절) — 첫 게시가 만든다. 닫혔거나 다른 채널의 것이면 게시가 새 세션으로 바꿔 단다(automations/post.ts)
    conversationId: text("conversation_id").references(() => conversations.id),
    kind: text("kind").$type<AutomationKind>().notNull(),
    // 평문 `@핸들` — 게시할 때 토큰화한다(계획 판정 PA1)
    bodyMd: text("body_md").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    scheduleJson: json<AutomationSchedule>("schedule_json"),
    nextRunAt: ts("next_run_at"),
    tokenHash: text("token_hash"),
    tokenPrefix: text("token_prefix"),
    lastRunAt: ts("last_run_at"),
    lastStatus: text("last_status").$type<AutomationStatus>(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("automations_ws_name").on(t.workspaceId, t.name),
    // 예약 종류는 NULL — SQLite 는 유일 인덱스에서 NULL 을 서로 다르게 본다
    uniqueIndex("automations_token_hash").on(t.tokenHash),
    // 스케줄러 틱의 dueSchedules(enabled AND kind = 'schedule' AND next_run_at <= now)
    index("automations_due").on(t.enabled, t.kind, t.nextRunAt),
  ],
);
