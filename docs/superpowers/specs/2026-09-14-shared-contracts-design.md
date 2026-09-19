# @dodok/shared 계약 + DB 스키마 설계

작성일: 2026-09-14 · 상태: 승인된 설계(섹션 A~D 대화 승인) · 선행 문서: `docs/plan.md` v0.4, `docs/project-structure.md`

## 0. 목적과 범위

이 문서는 구성 가이드 5장 1단계("shared 타입·스키마부터")를 바로 구현할 수 있도록 **모든 경계의 계약**을 코드 수준으로 정한다.

포함: 기반 규약(ID·시간·에러·패키지 구조), 멘션 규약, 도메인 Zod 스키마, Drizzle DB 스키마(SQLite), 런 상태머신과 라우터/릴레이 규칙, RunEvent(AG-UI 이름 차용)와 OpenClaw 매핑, wire(클라이언트↔서버)와 bridge(플러그인↔서버) Socket.IO 프로토콜, components v1과 상호작용, 테스트 전략.

제외: UI 화면 설계, 서버 모듈 내부 구조, OpenClaw 어댑터의 Gateway 클라이언트 구현, Phase 0 스파이크 절차(계획서 8장).

확정된 갈림길: 브리지 전송은 **Socket.IO 재사용**, 멘션은 **토큰 문법 `<@a:id>`/`<@u:id>`**.

---

## 1. 기반 규약

### 1.1 패키지 구조

`@dodok/shared` 하나. 런타임 의존은 `zod`(4.x) 하나뿐이며 Node 전용 API를 쓰지 않는다(브라우저·서버·Gateway 플러그인 세 곳에서 로드). AG-UI는 이벤트 **이름만** 차용하고 `@ag-ui/core`에 의존하지 않는다.

```
packages/shared/
├─ package.json          exports: ".", "./domain", "./components", "./events", "./wire", "./bridge", "./mention"
├─ src/
│  ├─ common.ts          Id, IsoDateTime, ErrorCode, ApiError, Result, Ack
│  ├─ mention.ts
│  ├─ domain/index.ts    엔티티 Zod 스키마 + 타입
│  ├─ components/index.ts
│  ├─ events/index.ts    RunEvent 유니온
│  ├─ wire/index.ts      Socket.IO 기본 네임스페이스 이벤트 맵
│  └─ bridge/index.ts    Socket.IO /bridge 네임스페이스 이벤트 맵
└─ fixtures/openclaw/    스파이크 1에서 캡처한 Gateway 이벤트 JSON (계약 테스트용)
```

### 1.2 공통 타입 (`common.ts`)

```ts
import { z } from "zod";

/** UUIDv7 (uuid v14 `v7()`), 모든 엔티티 PK */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** wire/bridge의 시간은 ISO 8601 문자열. DB는 integer ms. */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const ErrorCode = z.enum([
  "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "VALIDATION", "CONFLICT",
  "RATE_LIMITED", "RELAY_LIMIT", "ADAPTER_UNAVAILABLE", "PROTOCOL_MISMATCH",
  "EXPIRED", "CONSUMED", "TIMEOUT", "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };
/** Socket.IO ack 콜백 시그니처 */
export type Ack<T> = (res: Result<T>) => void;

/** 핸드셰이크 협상용. wire와 bridge 각각 독립적으로 올린다. */
export const WIRE_PROTOCOL = 1 as const;
export const BRIDGE_PROTOCOL = 1 as const;
```

### 1.3 규칙

- ID는 UUIDv7. 시간순 정렬이 되고 Postgres `uuid`와 호환된다.
- 시간: wire/bridge는 ISO 8601(오프셋 포함), DB는 SQLite integer ms(`timestamp_ms`). 변환은 서버 경계에서만.
- 모든 외부 입력은 경계에서 `schema.parse` 후 내부로. 실패는 `VALIDATION`.
- 에러 코드는 닫힌 enum. 새 코드 추가는 이 문서 갱신을 동반한다.
- 핸들 네임스페이스는 **워크스페이스 내 사람·에이전트 공용**이다(같은 핸들을 사람과 에이전트가 동시에 가질 수 없음). 테이블이 다르므로 서비스 계층에서 검증한다.

---

## 2. 멘션 규약 (`mention.ts`)

저장 본문(`bodyMd`)에는 토큰 `<@a:<uuid>>`(에이전트), `<@u:<uuid>>`(사람)만 들어간다. 파생 배열 `mentions`를 메시지에 같이 저장한다.

```ts
export const MENTION_TOKEN_RE =
  /<@(a|u):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** 에이전트 출력·사람 입력의 평문 멘션. 앞은 문장 시작/공백/구두점, 뒤는 단어 경계. */
export const PLAIN_MENTION_RE = /(^|[^\w@])@([a-z0-9_-]{2,32})(?![\w-])/g;

export type MentionSet = { agents: Id[]; users: Id[] };

export type Participant = {
  type: "agent" | "user";
  id: Id;
  handle: string;          // 워크스페이스 핸들
  aliases?: string[];      // 채널 한정 별칭 (ChannelMember.aliases)
  displayName: string;
};

/** 토큰 본문 → 파생 멘션 집합 (중복 제거, 등장 순서 유지) */
export function parseMentions(bodyMd: string): MentionSet;

/** 토큰 본문 → 에이전트에게 보낼 평문. 토큰을 `@handle`로 치환, 미해결 토큰은 `@unknown`으로. */
export function renderForAgent(bodyMd: string, participants: Participant[]): string;

/** 토큰 본문 → 화면 표시용 세그먼트 (렌더러가 칩으로 그림) */
export function segment(bodyMd: string): Array<{ kind: "text"; text: string } | { kind: "mention"; type: "agent" | "user"; id: Id }>;

/**
 * 평문(`@handle`) → 토큰 본문. 참여자 핸들·별칭에 매칭되는 것만 치환, 나머지는 그대로.
 * 에이전트 아웃바운드와 작성기 폴백(붙여넣기 등)에 사용. 코드 블록·인라인 코드 안은 건드리지 않는다.
 */
export function tokenize(text: string, participants: Participant[]): { bodyMd: string; mentions: MentionSet };
```

왕복 성질(테스트로 고정): `tokenize(renderForAgent(body, P), P).bodyMd === body` (참여자 집합이 같고 본문에 미해결 토큰이 없을 때).

---

## 3. 도메인 스키마 (`domain/index.ts`)

```ts
import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ComponentState, ComponentsV1 } from "../components";
import { MentionSet } from "../mention";

export const Handle = z.string().regex(/^[a-z0-9_-]{2,32}$/);

export const Workspace = z.object({ id: Id, name: z.string().min(1).max(80), createdAt: IsoDateTime });

export const User = z.object({
  id: Id, workspaceId: Id,
  handle: Handle,
  displayName: z.string().min(1).max(80),
  email: z.email().optional(),
  authProvider: z.enum(["local", "email", "oidc"]),
  avatarUrl: z.url().optional(),
  createdAt: IsoDateTime,
});

export const MembershipRole = z.enum(["owner", "admin", "member", "guest"]);
export const Membership = z.object({ id: Id, workspaceId: Id, userId: Id, role: MembershipRole });

export const AgentProvider = z.enum(["openclaw", "claude", "codex", "hermes"]);
export const Agent = z.object({
  id: Id, workspaceId: Id,
  provider: AgentProvider,
  providerAgentId: z.string().min(1),      // OpenClaw agentId
  handle: Handle,
  name: z.string().min(1).max(80),
  avatarUrl: z.url().optional(),
  basePrompt: z.string().max(20_000).optional(),
  enabled: z.boolean(),
  createdAt: IsoDateTime,
});

export const RelayPair = z.object({ from: Id, to: Id });
export const RelayPolicy = z.object({
  maxRelayTurns: z.int().min(0).max(32).default(4),
  allowPairs: z.union([z.literal("all"), z.array(RelayPair).max(64)]).default("all"),
  dailyRunLimit: z.int().min(1).optional(),
});

export const Channel = z.object({
  id: Id, workspaceId: Id,
  name: z.string().min(1).max(80),
  topic: z.string().max(500).optional(),
  prompt: z.string().max(20_000).optional(),
  relayPolicy: RelayPolicy,
  visibility: z.enum(["public", "private"]),
  createdBy: Id,
  createdAt: IsoDateTime,
});

export const ChannelMember = z.object({
  id: Id, channelId: Id,
  memberType: z.enum(["user", "agent"]),
  memberId: Id,
  promptOverride: z.string().max(20_000).optional(),   // agent만
  autoRespond: z.boolean().default(false),              // agent만, 채널당 최대 1
  aliases: z.array(Handle).max(8).default([]),          // agent만
  joinedAt: IsoDateTime,
});

export const Attachment = z.object({
  id: Id,
  kind: z.enum(["image", "file"]),
  url: z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/),
  name: z.string().max(255),
  mime: z.string().max(127),
  size: z.int().min(0),
  width: z.int().optional(), height: z.int().optional(),
  thumbUrl: z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/).optional(),
});

// MentionSet은 mention.ts가 정의하고 여기서는 import만 한다(루트 export * 충돌 방지)

export const SystemKind = z.enum(["relay_limit", "relay_denied", "run_error", "info"]);
export const SystemMeta = z.object({
  kind: SystemKind,
  /** relay_limit/relay_denied: 이어가기 대상 */
  relay: z.object({ fromAgentId: Id, toAgentId: Id, sourceRunId: Id, rootMessageId: Id }).optional(),
  runId: Id.optional(),
});

export const Message = z.object({
  id: Id, channelId: Id,
  seq: z.int().min(1),
  kind: z.enum(["normal", "system"]),
  authorType: z.enum(["user", "agent", "system"]),
  authorId: Id.optional(),                // system이면 없음
  bodyMd: z.string().max(100_000),
  mentions: MentionSet,
  attachments: z.array(Attachment).max(10).default([]),
  components: ComponentsV1.optional(),
  componentState: ComponentState.optional(), // components가 있을 때 서버가 부여 (만료 시각·소비된 아이템)
  systemMeta: SystemMeta.optional(),      // kind === "system"일 때
  replyTo: Id.optional(),
  runId: Id.optional(),                   // agent 메시지: 만들어 낸 런
  clientMsgId: z.string().max(64).optional(),   // 사용자 전송 멱등 키
  externalId: z.string().max(128).optional(),   // 브리지 outboundId (에이전트 메시지 중복 제거)
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.optional(),
});

export const RunStatus = z.enum([
  "queued", "streaming", "tool", "awaiting_approval", "finalizing", "done", "error", "aborted",
]);
export const RunTriggerKind = z.enum(["mention", "auto_respond", "relay", "interaction", "continue"]);
export const RunUsage = z.object({
  inputTokens: z.int().optional(), outputTokens: z.int().optional(),
  costUsd: z.number().optional(), model: z.string().optional(),
});

export const Run = z.object({
  id: Id, channelId: Id, agentId: Id,
  triggerKind: RunTriggerKind,
  triggerMessageId: Id.optional(),        // interaction이면 없음
  triggerInteractionId: Id.optional(),
  rootMessageId: Id,                      // 릴레이 체인의 루트(사람 메시지 또는 상호작용을 담은 메시지)
  relayDepth: z.int().min(0),
  parentRunId: Id.optional(),             // 서브에이전트 자식 런
  sessionKey: z.string(),
  providerRunId: z.string().optional(),   // OpenClaw runId
  status: RunStatus,
  hasCanonical: z.boolean().default(false),
  finalSource: z.enum(["plugin", "gateway"]).optional(),
  usage: RunUsage.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
});

/** wire의 run.state에 실리는 요약 */
export const RunState = Run.pick({
  id: true, channelId: true, agentId: true, status: true, relayDepth: true,
  parentRunId: true, hasCanonical: true, finalSource: true, error: true, startedAt: true, endedAt: true,
});

export const ComponentInteraction = z.object({
  id: Id, messageId: Id, componentId: z.string(), userId: Id,
  blockId: z.string().optional(),
  itemId: z.string(),                     // 버튼/셀렉트 id 또는 모달 id
  values: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
  deliveredAt: IsoDateTime.optional(),
});

export const ApprovalKind = z.enum(["exec", "plugin", "generic"]);
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export const Approval = z.object({
  id: Id, runId: Id,
  providerApprovalId: z.string(),
  kind: ApprovalKind,
  summary: z.string().max(4000),          // 명령·사유 등 사람이 읽는 요약
  payload: z.record(z.string(), z.unknown()).optional(),
  status: ApprovalStatus,
  decidedBy: Id.optional(),
  decidedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
});

export const PushSubscription = z.object({
  id: Id, userId: Id,
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  userAgent: z.string().max(255).optional(),
  createdAt: IsoDateTime,
});

export type Workspace = z.infer<typeof Workspace>;
// 위의 모든 스키마(User, Membership, Agent, RelayPolicy, Channel, ChannelMember, Attachment, MentionSet,
// SystemMeta, Message, Run, RunState, ComponentInteraction, Approval, PushSubscription)는 같은 이름의 타입을 z.infer로 export한다.
```

주의: `Message.components.id`는 저장 시 서버가 부여하고, 만료 시각과 소비된 아이템은 `Message.componentState`에 담는다(9장).

---

## 4. DB 스키마 (`apps/server/src/db/schema.sqlite.ts`, Drizzle)

원칙: **계약은 3장의 Zod 스키마, 테이블은 구현.** MVP는 SQLite 스키마 하나만 둔다. Postgres 전환 시 `schema.pg.ts`를 추가하며, 그때 깨지지 않도록 컬럼 타입을 text id · integer ms · text JSON으로 제한한다.

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  authProvider: text("auth_provider").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: ts("created_at").notNull(),
}, (t) => [uniqueIndex("users_ws_handle").on(t.workspaceId, t.handle)]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
}, (t) => [uniqueIndex("memberships_ws_user").on(t.workspaceId, t.userId)]);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  provider: text("provider").notNull(),
  providerAgentId: text("provider_agent_id").notNull(),
  handle: text("handle").notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  basePrompt: text("base_prompt"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  uniqueIndex("agents_ws_handle").on(t.workspaceId, t.handle),
  uniqueIndex("agents_ws_provider_agent").on(t.workspaceId, t.provider, t.providerAgentId),
]);

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  topic: text("topic"),
  prompt: text("prompt"),
  relayPolicy: json<RelayPolicy>("relay_policy_json").notNull(),
  visibility: text("visibility").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id),
  lastSeq: integer("last_seq").notNull().default(0),   // 메시지 seq 카운터
  createdAt: ts("created_at").notNull(),
});

export const channelMembers = sqliteTable("channel_members", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id),
  memberType: text("member_type").notNull(),
  memberId: text("member_id").notNull(),
  promptOverride: text("prompt_override"),
  autoRespond: integer("auto_respond", { mode: "boolean" }).notNull().default(false),
  aliases: json<string[]>("aliases_json").notNull().default([]),
  joinedAt: ts("joined_at").notNull(),
}, (t) => [uniqueIndex("channel_members_unique").on(t.channelId, t.memberType, t.memberId)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  authorType: text("author_type").notNull(),
  authorId: text("author_id"),
  bodyMd: text("body_md").notNull(),
  mentions: json<MentionSet>("mentions_json").notNull(),
  attachments: json<Attachment[]>("attachments_json").notNull().default([]),
  components: json<ComponentsV1>("components_json"),
  componentState: json<ComponentState>("component_state_json"),   // 소비된 아이템, 만료 시각
  systemMeta: json<SystemMeta>("system_meta_json"),
  replyTo: text("reply_to"),
  runId: text("run_id"),
  clientMsgId: text("client_msg_id"),
  externalId: text("external_id"),
  createdAt: ts("created_at").notNull(),
  editedAt: ts("edited_at"),
}, (t) => [
  uniqueIndex("messages_channel_seq").on(t.channelId, t.seq),
  uniqueIndex("messages_author_client_msg").on(t.authorId, t.clientMsgId),
  uniqueIndex("messages_external_id").on(t.externalId),
  index("messages_run").on(t.runId),
]);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
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
  relayHash: text("relay_hash"),          // hash(from, to, 정규화 본문) — 반복 감지
  createdAt: ts("created_at").notNull(),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
}, (t) => [
  uniqueIndex("runs_provider_run").on(t.providerRunId),
  index("runs_channel_created").on(t.channelId, t.createdAt),
  index("runs_root").on(t.rootMessageId),
  index("runs_session_status").on(t.sessionKey, t.status),
]);

export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: json<RunEvent>("payload_json").notNull(),
  createdAt: ts("created_at").notNull(),
}, (t) => [uniqueIndex("run_events_run_seq").on(t.runId, t.seq)]);

export const componentInteractions = sqliteTable("component_interactions", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id),
  componentId: text("component_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  blockId: text("block_id"),
  itemId: text("item_id").notNull(),
  values: json<Record<string, unknown>>("values_json").notNull(),
  createdAt: ts("created_at").notNull(),
  deliveredAt: ts("delivered_at"),
}, (t) => [index("component_interactions_message").on(t.messageId)]);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  providerApprovalId: text("provider_approval_id").notNull(),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  payload: json<Record<string, unknown>>("payload_json"),
  status: text("status").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  expiresAt: ts("expires_at"),
  createdAt: ts("created_at").notNull(),
}, (t) => [uniqueIndex("approvals_provider").on(t.providerApprovalId)]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  endpoint: text("endpoint").notNull(),
  keys: json<{ p256dh: string; auth: string }>("keys_json").notNull(),
  userAgent: text("user_agent"),
  createdAt: ts("created_at").notNull(),
}, (t) => [uniqueIndex("push_subscriptions_endpoint").on(t.endpoint)]);
```

규칙:
- `messages.seq` 발급: 같은 트랜잭션 안에서 `UPDATE channels SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq` 후 INSERT. SQLite는 단일 writer라 경합이 없고, Postgres에서도 행 잠금으로 직렬화된다.
- 소프트 삭제 없음. 메시지 수정은 `edited_at`만.
- `runs.relay_hash`는 릴레이 런에만 채운다(5.2).
- `messages.component_state_json`: `{ expiresAt: ISO, consumed: string[] /* itemId */ }`.
- 마이그레이션은 Drizzle Kit. Postgres 스키마가 생기면 양쪽 모두 통과해야 머지(구성 가이드 6장).

---

## 5. 런 상태머신과 라우터

### 5.1 런 상태머신 (`apps/server/src/modules/runs/machine.ts`, 순수 함수)

```ts
export type RunSignal =
  | { kind: "gateway_started" }                  // chat.send 응답 runStarted 또는 첫 agent 이벤트
  | { kind: "text_delta" }
  | { kind: "tool_start" } | { kind: "tool_end"; openTools: number }
  | { kind: "approval_requested" } | { kind: "approval_resolved" }
  | { kind: "gateway_final" }                    // chat state: final
  | { kind: "canonical_received" }               // 브리지 outbound.message 도착
  | { kind: "final_timeout" }                    // finalizing 상한(기본 10s)
  | { kind: "gateway_error"; code: string; message: string }
  | { kind: "gateway_aborted" } | { kind: "abort_requested" }
  | { kind: "queue_timeout" } | { kind: "run_timeout" };

export type Transition =
  | { next: RunStatus; patch?: Partial<Run> }
  | { next: null; reason: "ignored" | "invalid" };

export function transition(run: Pick<Run, "status" | "hasCanonical">, s: RunSignal): Transition;
```

전이 표(행: 현재 상태, 열: 신호). 표에 없는 조합은 `ignored`(로그만).

| 현재 | gateway_started / text_delta | tool_start | tool_end(openTools=0) | approval_requested | approval_resolved | gateway_final | canonical_received | final_timeout | gateway_error / queue_timeout / run_timeout | gateway_aborted / abort_requested |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| queued | streaming | tool | — | awaiting_approval | — | finalizing 또는 done¹ | finalizing (hasCanonical=true)⁵ | — | error | aborted |
| streaming | streaming | tool | — | awaiting_approval | — | finalizing 또는 done¹ | streaming (hasCanonical=true) | — | error | aborted |
| tool | tool | tool | streaming | awaiting_approval | — | finalizing 또는 done¹ | tool (hasCanonical=true) | — | error | aborted |
| awaiting_approval | — | — | — | — | streaming | finalizing 또는 done¹ | awaiting_approval (hasCanonical=true) | — | error | aborted |
| finalizing | — | — | — | — | — | hasCanonical 이면 done (finalSource=plugin)⁵, 아니면 — | done (finalSource=plugin) | hasCanonical 이면 done (finalSource=plugin)⁵, 아니면 done (finalSource=gateway)² | error | aborted |
| done / error / aborted | ignored | ignored | ignored | ignored | ignored | ignored | ignored³ | ignored | ignored | ignored |

¹ `gateway_final` 시 `hasCanonical`이면 곧바로 `done(finalSource=plugin)`, 아니면 `finalizing`.
² 타임아웃 채택 시 WS 스냅샷 본문이 비어 있지 않으면 에이전트 메시지로 저장하고, 비어 있으면 메시지 없이 `done`.
³ 종료 후 도착한 정본은 런 없는 에이전트 메시지로 저장하지 않고, 해당 `runId`를 달아 저장한다(늦은 도착 허용). 상태는 바뀌지 않는다.
⁴ `queue_timeout`은 `queued`에서만 유효하다(스트리밍 중 늦게 도착한 큐 타이머가 런을 죽이지 않도록). 표의 다른 상태에서는 ignored.
⁵ Gateway 이벤트 없이 정본이 먼저 오는 경우 — Phase 1 실연(구독 누락·WS 단절). `queued`에서 정본을 받으면 `finalizing`으로 가고(Gateway 가 시작한 것으로 보아 `RUN_STARTED`·`startedAt`, queued·런 상한 대신 finalizing 상한), `gateway_final`이 오면 곧바로, 안 오면 finalizing 상한에 `done(finalSource=plugin)`. 스냅샷 메시지는 만들지 않는다(정본이 있다). 전에는 `queued`에 남아 queued 상한에 `error(TIMEOUT)`이 됐다.

타임아웃 기본값(채널 설정으로 조정 가능): queued 120초, 런 전체 600초, finalizing 10초. `abort_requested`는 어댑터 `abort(runId)`(→ `chat.abort`)를 호출한 뒤 상태를 바꾼다.

**정본 상관관계**(브리지 `outbound.message` → 런): `runId`가 있으면 그것, 없으면 같은 `sessionKey`에서 상태가 종료되지 않은 런(세션당 런이 직렬이라 최대 1개), 없으면 `replyToInboundId`로 찾은 인바운드 메시지가 만든 런, 셋 다 없으면 런 없이 저장하고 경고.

하나의 런이 정본 메시지를 여러 개 보낼 수 있다(에이전트가 `message` 툴을 여러 번 호출). 모두 `runId`를 단 에이전트 메시지로 저장하며 첫 도착에서 `hasCanonical=true`.

### 5.2 라우터 (`modules/router/decide.ts`, 순수 함수)

```ts
export type RoutingInput = {
  message: Message;                 // 방금 저장된 메시지 (user | agent)
  channel: Channel;
  members: ChannelMember[];
  agents: Agent[];                  // 채널 소속 에이전트 (enabled 포함)
  sourceRun?: Run;                  // message가 에이전트 메시지일 때 그 런
  chainHashes: Set<string>;         // 같은 rootMessageId 체인의 relayHash 집합
  todayRunCount: number;            // 채널 일일 런 수
  now: Date;
};

export type RunPlan = { agentId: Id; triggerKind: RunTriggerKind; rootMessageId: Id; relayDepth: number; relayHash?: string };
export type Blocked = { agentId: Id; reason: "pair_not_allowed" | "max_turns" | "repeat" | "daily_limit" | "disabled" };

export function decideRuns(input: RoutingInput): { runs: RunPlan[]; blocked: Blocked[] };
```

규칙:
1. **사람 메시지**: 대상 = `mentions.agents ∩ 채널 소속 활성 에이전트`. 멘션 자체가 없을 때만 `autoRespond=true`인 멤버 1개(멘션이 있었으나 전부 비활성이면 런 없음)(여럿이면 `joinedAt`이 가장 이른 것 하나, 나머지는 설정 오류로 경고). 각 대상에 `triggerKind: mention | auto_respond`, `rootMessageId = message.id`, `relayDepth = 0`.
2. **에이전트 메시지**(`sourceRun` 필수, 런 없이 저장된 에이전트 메시지는 릴레이하지 않는다): 대상 = `mentions.agents − {sourceRun.agentId}` ∩ 활성 에이전트. autoRespond는 **적용하지 않는다**. 각 대상에 대해 순서대로 검사하고 첫 실패 사유로 `blocked`:
   - `allowPairs === "all"` 또는 `{from: sourceRun.agentId, to}` 포함 → 아니면 `pair_not_allowed`
   - `depth = sourceRun.relayDepth + 1`, `depth <= maxRelayTurns` → 아니면 `max_turns`
   - `relayHash = sha256(from + "\n" + to + "\n" + normalize(bodyMd))`, `normalize` = 토큰 제거·공백 축약·소문자·앞 300자만 사용. `chainHashes`에 없어야 함 → 아니면 `repeat`
   - `dailyRunLimit` 미설정이거나 `todayRunCount < dailyRunLimit` → 아니면 `daily_limit`
   통과하면 `triggerKind: relay`, `rootMessageId = sourceRun.rootMessageId`, `relayDepth = depth`.
3. `blocked`가 있으면 서버는 사유별 시스템 메시지를 하나 만든다(`max_turns`/`repeat` → `relay_limit`, 나머지 → `relay_denied`). `relay_limit`에는 components `{ blocks: [{ type: "actions", items: [{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }] }] }`와 `systemMeta.relay`를 붙인다.
4. **이어가기·상호작용**: `continue_relay` 클릭은 서버가 가로채 `triggerKind: continue`, `relayDepth 0`, `rootMessageId = 시스템 메시지 id`로 대상 에이전트 런을 만든다. 컴포넌트 상호작용은 `triggerKind: interaction`, `relayDepth 0`, `rootMessageId = 상호작용을 담은 메시지 id`. 둘 다 사람이 개입한 것이므로 새 체인이다.
5. 같은 에이전트가 같은 메시지에서 두 번 대상이 될 수 없다(중복 제거).

---

## 6. RunEvent (`events/index.ts`)

AG-UI 이름을 차용한 자체 Zod 유니온. 모든 이벤트는 `base = { runId, seq, ts }`를 포함하며 `seq`는 런 안에서 1부터 단조 증가(서버가 부여).

```ts
const base = { runId: Id, seq: z.int().min(1), ts: IsoDateTime };
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...base, ...shape });

export const RunEvent = z.discriminatedUnion("type", [
  // 런 수명
  ev("RUN_QUEUED",   { position: z.int().optional() }),                              // dodok 확장
  ev("RUN_STARTED",  { threadId: Id /* channelId */, agentId: Id, sessionKey: z.string(), providerRunId: z.string().optional() }),
  ev("RUN_FINISHED", { messageIds: z.array(Id), usage: RunUsage.optional(), stopReason: z.string().optional() }),
  ev("RUN_ERROR",    { message: z.string(), code: z.string().optional(), detail: z.record(z.string(), z.unknown()).optional() }),
  ev("RUN_ABORTED",  { by: z.enum(["user", "gateway"]) }),                          // dodok 확장 (타임아웃은 RUN_ERROR code TIMEOUT)
  ev("STATE_SNAPSHOT", { snapshot: RunState }),                                      // 상태 전이마다
  // 텍스트
  ev("TEXT_MESSAGE_START",   { messageId: z.string(), role: z.literal("assistant") }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: z.string(), delta: z.string().min(1) }),
  ev("TEXT_MESSAGE_REPLACE", { messageId: z.string(), text: z.string() }),         // dodok 확장 (OpenClaw replace)
  ev("TEXT_MESSAGE_END",     { messageId: z.string() }),
  // 툴
  ev("TOOL_CALL_START",  { toolCallId: z.string(), toolCallName: z.string(), parentMessageId: z.string().optional() }),
  ev("TOOL_CALL_ARGS",   { toolCallId: z.string(), delta: z.string() }),
  ev("TOOL_CALL_END",    { toolCallId: z.string() }),
  ev("TOOL_CALL_RESULT", { toolCallId: z.string(), content: z.string(), ok: z.boolean().optional(), durationMs: z.int().optional() }),
  // 단계·서브에이전트
  ev("STEP_STARTED",  { stepName: z.string() }),
  ev("STEP_FINISHED", { stepName: z.string() }),
  ev("SUBAGENT_STARTED",  { subagentRunId: Id, providerRunId: z.string().optional(), label: z.string().optional() }),
  ev("SUBAGENT_FINISHED", { subagentRunId: Id }),
  ev("SUBAGENT_ERROR",    { subagentRunId: Id, message: z.string() }),
  // 승인 (dodok 확장)
  ev("APPROVAL_REQUESTED", { approvalId: Id, kind: ApprovalKind, summary: z.string(), expiresAt: IsoDateTime.optional() }),
  ev("APPROVAL_RESOLVED",  { approvalId: Id, decision: z.enum(["approved", "denied", "expired"]), decidedBy: Id.optional() }),
  // 미분류
  ev("CUSTOM", { name: z.string(), value: z.unknown().optional() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
```

`messageId`(TEXT_*)는 Gateway 쪽 메시지 식별자이며 우리 `Message.id`가 아니다. 정본 저장 시 `RUN_FINISHED.messageIds`에 우리 id를 싣는다.

### 6.1 OpenClaw → RunEvent 매핑 (어댑터 `gateway/events.ts`)

| OpenClaw | RunEvent | 상태 신호(5.1) |
| --- | --- | --- |
| 첫 `agent lifecycle start` 또는 첫 `chat` 이벤트(런당 1회) | `RUN_STARTED` — **어댑터 매퍼가 아니라 오케스트레이터가** `gateway_started` 전이 때 런 행(channelId·agentId·sessionKey·providerRunId)으로 만든다(매퍼는 Gateway `agentId` 가 providerAgentId 라 우리 uuid 를 모른다; 2026-09-15 판정) | gateway_started |
| `chat` `state: status` (`phase`, `retry`) | `STEP_STARTED`/`STEP_FINISHED` (stepName=phase) | — |
| `chat` `state: delta` `deltaText` | `TEXT_MESSAGE_START`(첫 델타) + `TEXT_MESSAGE_CONTENT` | text_delta |
| `chat` `state: delta` `replace: true` | `TEXT_MESSAGE_REPLACE` (`message` 스냅샷) | text_delta |
| `chat` `state: final` | `TEXT_MESSAGE_END` (+ usage는 런에 기록) | gateway_final |
| `chat` `state: error` | `RUN_ERROR` (`errorKind`, `errorDetail`) | gateway_error |
| `chat` `state: aborted` | `RUN_ABORTED { by: "gateway" }` | gateway_aborted |
| `agent` `stream:"tool"` phase `start`/`result` (계획서가 말한 `session.tool`은 `tool-events`를 선언한 연결에 오지 않는다 — ADR 0001) | `TOOL_CALL_START/ARGS/END/RESULT` | tool_start / tool_end |
| `session.operation` (`compact`) | `STEP_STARTED/FINISHED` (stepName=`compact`) | — |
| `session.approval`, `exec.approval.request` | `APPROVAL_REQUESTED` (+ `approvals` 행) | approval_requested |
| `approval.resolve` 결과 / 승인 만료 | `APPROVAL_RESOLVED` | approval_resolved |
| `spawnedBy`가 우리 런을 가리키는 자식 런 | 부모에 `SUBAGENT_STARTED/FINISHED/ERROR`, 자식은 `parentRunId`를 단 Run 행 | — |
| `agent` 이벤트 (`stream`별) | 스파이크 1 전까지 `CUSTOM { name: "openclaw.agent.<stream>", value: data }` | — |
| 브리지 `outbound.message` 도착 | `RUN_FINISHED`(done 전이 시) | canonical_received |
| 우리 상태 전이 | `STATE_SNAPSHOT` | — |

50ms 코얼레싱: 같은 `messageId`의 연속 `TEXT_MESSAGE_CONTENT`는 병합해 하나로 저장·전송. `TOOL_CALL_ARGS`도 동일. 병합 후 이벤트만 `run_events`에 기록한다.

---

## 7. wire 프로토콜 (`wire/index.ts`, Socket.IO 기본 네임스페이스)

### 7.1 접속

`io(APP_ORIGIN, { auth: { token, protocol: WIRE_PROTOCOL } })`. 서버는 토큰 검증 실패 시 `UNAUTHORIZED`, `protocol !== WIRE_PROTOCOL`이면 `PROTOCOL_MISMATCH`로 연결을 거부한다(`connect_error`의 `data`에 `ApiError`). 접속 직후 서버가 소켓을 `user:<userId>` 룸에 넣는다.

REST(`/api/v1`)와의 경계: CRUD(채널·에이전트·멤버·설정·업로드·히스토리 페이징·런 목록)는 REST, 팬아웃·저지연(전송·구독·델타·상호작용·승인·중단·타이핑)은 Socket.IO. REST 계약은 이 문서 범위 밖이지만 같은 도메인 스키마를 쓴다.

### 7.2 이벤트 맵

```ts
// 클라이언트 → 서버 (ack 있음)
export const ChannelSubscribe = z.object({ channelId: Id, lastSeq: z.int().min(0).optional() });
export const ChannelSubscribeResult = z.object({
  messages: z.array(Message),         // lastSeq 이후, 최대 200개 (더 있으면 hasMore)
  hasMore: z.boolean(),
  activeRuns: z.array(RunState),      // 종료되지 않은 런
  pendingApprovals: z.array(Approval),
});
export const MessageSend = z.object({
  channelId: Id, clientMsgId: z.string().min(1).max(64),
  bodyMd: z.string().min(1).max(100_000),   // 토큰 본문 (작성기가 토큰화해서 보냄)
  attachments: z.array(Id).max(10).optional(),   // 업로드 API로 먼저 올린 첨부 id
  replyTo: Id.optional(),
});
export const RunAbort = z.object({ runId: Id });
export const RunEventsReplay = z.object({ runId: Id, afterSeq: z.int().min(0).default(0) });
export const RunEventsReplayResult = z.object({ events: z.array(RunEvent), run: RunState });
export const ComponentInteract = z.object({
  messageId: Id, componentId: z.string(), blockId: z.string().optional(), itemId: z.string(),
  values: z.record(z.string(), z.unknown()),
});
export const ApprovalResolve = z.object({ approvalId: Id, decision: z.enum(["approve", "deny"]), note: z.string().max(500).optional() });
export const Typing = z.object({ channelId: Id });

export interface ClientToServerEvents {
  "channel.subscribe":   (p: ChannelSubscribe, ack: Ack<ChannelSubscribeResult>) => void;
  "channel.unsubscribe": (p: { channelId: Id }, ack: Ack<null>) => void;
  "message.send":        (p: MessageSend, ack: Ack<{ message: Message }>) => void;
  "run.abort":           (p: RunAbort, ack: Ack<null>) => void;
  "run.events.replay":   (p: RunEventsReplay, ack: Ack<RunEventsReplayResult>) => void;
  "component.interact":  (p: ComponentInteract, ack: Ack<{ interactionId: Id }>) => void;
  "approval.resolve":    (p: ApprovalResolve, ack: Ack<null>) => void;
  "typing":              (p: Typing) => void;                       // ack 없음, 클라이언트가 3초 스로틀
}

// 서버 → 클라이언트 (룸 channel:<id> 또는 user:<id>)
export const AdapterStatus = z.object({
  provider: AgentProvider,
  gateway: z.enum(["connected", "reconnecting", "down"]),
  bridge: z.enum(["connected", "down"]),
});
export interface ServerToClientEvents {
  "message.created": (p: { message: Message }) => void;
  "message.updated": (p: { message: Message }) => void;              // 수정, 컴포넌트 소비/만료
  "run.state":       (p: { run: RunState; resync?: boolean }) => void;
  "run.event":       (p: { event: RunEvent }) => void;
  "approval.requested": (p: { approval: Approval }) => void;
  "approval.resolved":  (p: { approval: Approval }) => void;
  "channel.updated": (p: { channel: Channel }) => void;
  "channel.member.changed": (p: { channelId: Id; members: ChannelMember[] }) => void;
  "typing":          (p: { channelId: Id; actorType: "user" | "agent"; actorId: Id }) => void;
  "adapter.status":  (p: AdapterStatus) => void;                     // user 룸
  "system.notice":   (p: { level: "info" | "warn" | "error"; message: string }) => void;
}
```

### 7.3 규칙

- `message.send`는 `(authorId, clientMsgId)`로 멱등. 같은 키가 오면 저장된 메시지를 그대로 ack.
- 클라이언트는 채널별 `lastSeq`, 런별 `lastEventSeq`를 보관한다. 재접속 시 `channel.subscribe { lastSeq }`로 메시지 빈틈을, `run.events.replay { afterSeq }`로 런 이벤트 빈틈을 메운다.
- 서버는 소켓별 미전송 큐가 상한(기본 1MB 또는 500 이벤트)을 넘으면 `run.event` 델타를 버리고 `run.state { resync: true }`를 보낸다. 클라이언트는 이를 받으면 해당 런을 replay한다.
- 스트리밍 버블은 `runId`를 키로 클라이언트가 만들고, `message.created`가 같은 `runId`를 달고 오면 버블을 그 메시지로 교체한다. 런이 `done`인데 메시지가 없으면(빈 응답) 버블을 제거한다.
- `run.event`는 채널 룸 구독자에게만 보낸다. 활동 패널을 열지 않은 클라이언트도 상태 표시를 위해 `run.state`는 항상 받는다.

---

## 8. bridge 프로토콜 (`bridge/index.ts`, Socket.IO `/bridge` 네임스페이스)

### 8.1 접속

플러그인이 `io(BRIDGE_PUBLIC_URL, { auth: { token: BRIDGE_TOKEN, protocol: BRIDGE_PROTOCOL, pluginVersion } })`로 접속한다. 토큰은 상수 시간 비교(스파이크 2 구현은 `auth: { token }` 만 보내고 버전·프로토콜은 `hello`/`BridgeHelloResult` 로 오간다 — ADR 0002 10절; 아래 hello 10초 타임아웃은 스파이크 브리지 서버에 미구현, Phase 1 서버 과제). 계정당 활성 연결은 1개이며 **새 연결이 이긴다**: 서버는 기존 소켓에 `system.notice { reason: "replaced" }`를 보내고 끊는다. 접속 직후 플러그인은 `hello`를 보내야 하며, 10초 안에 오지 않으면 끊는다.

### 8.2 이벤트 맵

```ts
export const BridgeHello = z.object({
  pluginId: z.literal("dodok"),
  version: z.string(),                 // 플러그인 패키지 버전
  sdkVersion: z.string(),              // openclaw 패키지 버전
  gatewayVersion: z.string().optional(),
  capabilities: z.array(z.enum(["agents.list", "config.set", "typing", "run_id_in_outbound"])),
});
export const BridgeHelloResult = z.object({ serverVersion: z.string(), protocol: z.literal(BRIDGE_PROTOCOL) });

export const InboundAuthor = z.object({ type: z.enum(["user", "agent", "system"]), handle: z.string(), displayName: z.string() });
export const InboundContext = z.object({
  recentMessages: z.array(z.object({ author: InboundAuthor, text: z.string(), ts: IsoDateTime })).max(20),
  participants: z.array(z.object({ type: z.enum(["user", "agent"]), handle: z.string(), displayName: z.string(), isSelf: z.boolean() })),
  relayRules: z.string(),              // 사람이 읽는 한 문단 (maxRelayTurns, 허용 쌍 요약)
  channelPrompt: z.string().optional(),
  promptOverride: z.string().optional(),
});
export const InboundDeliver = z.object({
  deliveryId: Id,
  kind: z.enum(["message", "interaction", "continue"]),
  channelId: Id,
  agentId: z.string(),                 // providerAgentId (OpenClaw agentId)
  sessionKey: z.string(),              // agent:<agentId>:dodok:channel:<channelId>
  runId: Id,                           // 우리 런 id (아웃바운드에 되돌려 받기 위함)
  message: z.object({
    id: Id, author: InboundAuthor,
    text: z.string(),                  // renderForAgent 결과 (@handle 평문)
    attachments: z.array(Attachment).max(10),
    ts: IsoDateTime,
  }),
  context: InboundContext,
  options: z.object({ queueMode: z.enum(["steer", "followup", "collect", "interrupt"]).optional() }).default({}),
});
export const InboundDeliverResult = z.object({
  admission: z.enum(["dispatch", "drop"]),   // 계획서 10장 #14 — drop 은 런 없이 끝났다는 뜻(봇 루프 보호 등)
  reason: z.string().optional(),            // drop 사유: 코어가 준 값 그대로("bot-loop-protection", "outbound-echo"), 런 없이 끝난 다른 kind 는 "<kind>:<reason>", 비면 "unknown". 플러그인 자체 거절(검증 실패 등)은 drop 이 아니라 Result 의 ok:false
  providerRunId: z.string().optional(),     // ADR 0002 4.3: 값은 우리 runId 와 같다(replyOptions.runId)
});

export const ConfigSet = z.object({
  channelId: Id,
  config: z.object({ requireMention: z.boolean().optional(), systemPrompt: z.string().optional() }),
});
export const ConfigSetResult = z.object({ applied: z.enum(["live", "restart_required"]) });

export const OutboundMessage = z.object({
  outboundId: z.string().min(1).max(128),   // 플러그인이 생성, 중복 제거 키 (messages.external_id)
  channelId: Id,
  agentId: z.string(),                 // providerAgentId
  sessionKey: z.string(),
  runId: Id.optional(),                // 인바운드에서 받은 우리 런 id (capability run_id_in_outbound)
  providerRunId: z.string().optional(),
  replyToInboundId: Id.optional(),     // InboundDeliver.message.id
  text: z.string().max(100_000),       // 평문 (@handle) — 서버가 tokenize
  components: ComponentsV1.optional(),
  attachments: z.array(Attachment).max(10).default([]),
  ts: IsoDateTime,
});

export interface BridgeClientToServerEvents {   // 플러그인 → 서버
  "hello":            (p: BridgeHello, ack: Ack<BridgeHelloResult>) => void;
  "outbound.message": (p: OutboundMessage, ack: Ack<{ messageId: Id }>) => void;
  "outbound.typing":  (p: { channelId: Id; agentId: string }) => void;
  "status":           (p: { gateway: "connected" | "reconnecting" | "down"; queueDepth: number }) => void;
}
export interface BridgeServerToClientEvents {   // 서버 → 플러그인
  "inbound.deliver": (p: InboundDeliver, ack: Ack<InboundDeliverResult>) => void;
  "config.set":      (p: ConfigSet, ack: Ack<ConfigSetResult>) => void;
  "agents.list":     (p: Record<string, never>, ack: Ack<{ agents: Array<{ agentId: string; name?: string }> }>) => void;
  "system.notice":   (p: { reason: "replaced" | "shutdown"; message: string }) => void;
}
```

### 8.3 규칙

- 인바운드 본문은 서버가 `renderForAgent`로 평문화해서 보낸다. 컨텍스트 창을 텍스트로 조립하는 것은 플러그인(`context.ts`)이다. 형식(플러그인이 인바운드 앞에 붙임):
  ```
  [dodok context] channel=<channelId> you=@<handle>
  참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)
  릴레이 규칙: 다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.
  최근 대화:
  [09:12] @jang: ...
  [09:13] @planner: ...
  ---
  ```
  `promptOverride`와 `channelPrompt`는 헤더 줄이 아니라 OpenClaw `MsgContext.ChannelPromptContext`로 싣는다(표시 전사를 오염시키지 않는다 — 계획서 10장 #1·#18). `channelPrompt`는 `config.set`으로 Gateway 설정에 들어가 있어도 **claude-cli 기존 세션에는 반영되지 않으므로**(ADR 0003 3절) **서버가** 「세션 시작 시점의 채널 프롬프트 리비전 ≠ 현재 리비전」일 때만 채운다. 리비전은 서버 내부 상태라 `InboundContext`에 필드를 두지 않는다. 플러그인은 값이 있으면 항상 싣는다(스파이크용 `inboundChannelPrompt` 설정 키는 제거).
- 전달 보장: 서버는 `inbound.deliver` ack가 10초 안에 없으면 최대 3회(1s·4s·16s) 재시도한다. 플러그인이 끊겨 있으면 런의 queued 상한(120초) 동안 서버 큐에 보관하고, 넘기면 런을 `error(ADAPTER_UNAVAILABLE)`로 끝낸다. 플러그인은 아웃바운드 큐(메모리, 최대 1000건)를 갖고 재접속 후 재전송한다.
- 중복 제거: 서버는 `outboundId`(`messages.external_id` UNIQUE), 플러그인은 `deliveryId`(메모리 LRU 24시간)로 중복을 버리고 **같은 ack를 다시 돌려준다**.
- 정본 상관관계는 5.1 규칙을 따른다. `runId`는 인바운드에 실어 보내므로 플러그인이 아웃바운드에 되돌려 주는 것이 기본이고(`run_id_in_outbound` capability), 되돌려 줄 수 없는 SDK 경로면 `sessionKey` 폴백을 쓴다.
- `outbound.message.text`는 서버가 `tokenize`해 `bodyMd`로 저장하고 `mentions`를 파생한 뒤 라우터(5.2)에 넘긴다.

---

## 9. components v1과 상호작용 (`components/index.ts`)

### 9.1 스키마

```ts
export const ItemId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const SafeUrl = z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/);
const AllowedUsers = z.array(Id).max(50).optional();

export const Button = z.object({
  type: z.literal("button"), id: ItemId,
  label: z.string().min(1).max(80),
  style: z.enum(["primary", "secondary", "success", "danger"]).default("secondary"),
  emoji: z.string().max(8).optional(),
  url: SafeUrl.optional(),             // 링크 버튼: 상호작용 없음
  allowedUsers: AllowedUsers,
});
export const SelectOption = z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(100), description: z.string().max(100).optional(), emoji: z.string().max(8).optional() });
export const Select = z.object({
  type: z.literal("select"), id: ItemId,
  placeholder: z.string().max(150).optional(),
  multi: z.boolean().default(false),
  minValues: z.int().min(0).max(25).optional(), maxValues: z.int().min(1).max(25).optional(),
  options: z.array(SelectOption).min(1).max(25),
  allowedUsers: AllowedUsers,
});

export const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("section"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("separator") }),
  z.object({ type: z.literal("actions"), id: ItemId.optional(), items: z.array(z.union([Button, Select])).min(1).max(5) })
    .refine((b) => b.items.every((i) => i.type === "button") || (b.items.length === 1 && b.items[0].type === "select"),
            { message: "actions: 버튼 1~5개 또는 셀렉트 정확히 1개" }),
  z.object({ type: z.literal("media"), items: z.array(z.object({ url: SafeUrl, alt: z.string().max(200).optional() })).min(1).max(10) }),
  z.object({ type: z.literal("file"), url: SafeUrl, name: z.string().min(1).max(255), size: z.int().optional() }),
]);

const FieldBase = { id: ItemId, label: z.string().min(1).max(45), required: z.boolean().default(false) };
export const Field = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), ...FieldBase, placeholder: z.string().max(100).optional(), minLength: z.int().optional(), maxLength: z.int().max(4000).optional(), default: z.string().optional() }),
  z.object({ type: z.literal("textarea"), ...FieldBase, placeholder: z.string().max(100).optional(), maxLength: z.int().max(4000).optional(), default: z.string().optional() }),
  z.object({ type: z.literal("number"), ...FieldBase, min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), default: z.number().optional() }),
  z.object({ type: z.literal("date"), ...FieldBase, default: z.iso.date().optional() }),
  z.object({ type: z.literal("select"), ...FieldBase, multi: z.boolean().default(false), options: z.array(SelectOption).min(1).max(25), default: z.array(z.string()).optional() }),
  z.object({ type: z.literal("checkbox"), ...FieldBase, default: z.boolean().optional() }),
  z.object({ type: z.literal("radio"), ...FieldBase, options: z.array(SelectOption).min(2).max(10), default: z.string().optional() }),
]);
export const Modal = z.object({
  id: ItemId, title: z.string().min(1).max(45), triggerLabel: z.string().min(1).max(80),
  fields: z.array(Field).min(1).max(5), allowedUsers: AllowedUsers,
});

export const ComponentsV1 = z.object({
  id: z.string().optional(),           // 서버가 저장 시 부여 (cmp_<uuid>)
  reusable: z.boolean().default(false),
  ttlMs: z.int().min(1_000).max(86_400_000).default(1_800_000),
  text: z.string().max(2000).optional(),   // 컴포넌트를 못 그리는 곳의 대체 텍스트
  blocks: z.array(Block).max(10).default([]),
  modal: Modal.optional(),
}).refine(uniqueIds, { message: "components: 모든 id는 유일해야 함" });
// uniqueIds: blocks[].id, items[].id, modal.id, modal.fields[].id를 모아 중복 검사

export const ComponentState = z.object({ expiresAt: IsoDateTime, consumed: z.array(ItemId) });
export type ComponentsV1 = z.infer<typeof ComponentsV1>;
```

에이전트에게 노출하는 message 툴 스키마 조각(플러그인 `components-schema.ts`)은 이 스키마에서 `id`를 제외한 형태를 그대로 JSON Schema로 변환해 쓴다(`z.toJSONSchema`).

### 9.2 상호작용 값

| 아이템 | `values` |
| --- | --- |
| button | `{}` |
| select | `{ values: string[] }` (multi가 아니면 길이 1) |
| modal | `{ fields: Record<fieldId, string \| number \| boolean \| string[]> }` |

### 9.3 서버 처리 순서 (`modules/components/interact.ts`)

1. 메시지·`components.id` 일치 확인 → `NOT_FOUND`
2. `componentState.expiresAt` 경과 → `EXPIRED`
3. `allowedUsers` (아이템 → 모달 순, 비어 있으면 모두 허용) → `FORBIDDEN`
4. `reusable=false`이고 `consumed`에 있음 → `CONSUMED`
5. 값 검증(셀렉트 옵션 집합·min/maxValues, 필드 제약) → `VALIDATION`
6. `component_interactions` 저장, `consumed`에 추가, `message.updated` 브로드캐스트
7. 시스템 메시지의 `continue_relay`면 라우터의 `continue` 경로로. 아니면 아래 텍스트를 만들어 `inbound.deliver { kind: "interaction" }`으로 **컴포넌트를 쓴 에이전트**의 채널 세션에 전달하고 `triggerKind: interaction` 런을 만든다.

### 9.4 에이전트 전달 텍스트

기계가 읽는 한 줄 + 사람이 읽는 본문. 언어 중립을 위해 헤더는 고정 형식이다.

```
[dodok interaction] user=@jang kind=button component=cmp_9f… item=go_fast
@jang 님이 "빠르게" 버튼을 눌렀습니다.

[dodok interaction] user=@jang kind=select component=cmp_9f… item=target values=["web"]
@jang 님이 "대상 선택"에서 웹을 골랐습니다.

[dodok interaction] user=@jang kind=modal component=cmp_9f… item=details
@jang 님이 "세부 정보" 양식을 제출했습니다.
- 제목: 로그인 버그
- 설명: ...
- 우선순위: 높음
- 완료 시 알림: 예
```

### 9.5 승인 카드

승인은 components가 아니다. `approvals` 엔티티를 클라이언트가 고정 UI(승인/거부 버튼)로 그리고 `approval.resolve`로 응답한다. 서버는 어댑터 `resolveApproval`(→ `approval.resolve`)을 호출하고 결과를 `approval.resolved`와 `APPROVAL_RESOLVED`로 알린다. 승인자는 MVP에서 owner 전원.

---

## 10. 테스트 전략

| 대상 | 방법 |
| --- | --- |
| `shared` Zod 스키마 | Vitest 단위 테스트. 경계값: 버튼 6개·셀렉트+버튼 혼합·옵션 26개·모달 필드 6개·TTL 범위 밖·id 중복 → 거부. 기본값 채움 확인 |
| `mention.ts` | 왕복 성질(2장), 코드 블록 안 `@` 무시, 미해결 토큰 `@unknown`, 별칭 매칭 |
| RunEvent | `fixtures/openclaw/*.json`(스파이크 1에서 캡처) → 어댑터 매핑 함수 → `RunEvent.parse` 통과. 새 Gateway 버전으로 올릴 때 픽스처를 다시 캡처 |
| `chat.send` 파라미터 | `@openclaw/gateway-protocol`의 `protocol.schema.json`으로 우리가 만드는 요청을 검증 |
| 런 상태머신 | `transition`을 표 기반 테스트(5.1 표의 모든 칸). 종료 상태 불변 |
| 라우터 | `decideRuns`를 표 기반 테스트: 멘션 없음·autoRespond·에이전트가 자기 멘션·쌍 불허·턴 초과·반복·일일 상한·이어가기 |
| wire | `expectTypeOf`로 이벤트 맵 페이로드와 Zod 타입 일치. in-memory Fastify+Socket.IO에 `socket.io-client`로 접속해 subscribe(lastSeq 빈틈)·send 멱등·replay·resync 시나리오 |
| bridge | 가짜 플러그인(`socket.io-client`)으로 hello 필수·새 연결 우선·inbound ack 재시도·outbound 중복 제거·재접속 후 재전송·정본 상관관계 3단계 |
| DB | Drizzle 마이그레이션 스냅샷, `seq` 발급 동시성(병렬 INSERT 100건 → 1..100 연속), UNIQUE 제약 |
| components 상호작용 | 9.3 순서의 각 실패 코드, 재사용/1회용, 전달 텍스트 스냅샷 |

---

## 11. 스파이크에서 확정할 항목 (기본값 포함)

| # | 항목 | 이 문서의 기본값 | 확정 시점 |
| --- | --- | --- | --- |
| 1 | 플러그인 아웃바운드에 우리 `runId`/Gateway `runId`가 실리는가 | 인바운드 `runId`를 되돌려 받는다고 가정, 불가하면 `sessionKey` 폴백 | **확정(ADR 0002 4.3)**: `replyOptions.runId` 로 Gateway runId = 우리 runId. 아웃바운드에 `runId` 실림 |
| 2 | 인바운드 ingress가 Gateway `runId`를 돌려주는가 | `InboundDeliverResult.providerRunId` optional | **확정(ADR 0002 4.3, 계획서 10장 #14)**: 돌려주며 값은 우리 `runId` 와 같다. 필드는 존치하되 의미는 「같다」. drop(봇 루프 보호) 시에는 `admission: "drop"` + `reason` 을 돌려준다(8.2) |
| 3 | `agent` 이벤트 `stream` 값과 툴 이벤트의 실제 모양 | `CUSTOM`으로 보존 | **확정(ADR 0001 5.3·6.5)**: 툴 진행은 `agent` `stream:"tool"` phase `start`/`result`(`toolCallId`·`name`·`args`·`isError`·`result`). `session.tool` 은 tool-events 선언 연결에 오지 않음 |
| 4 | capability 이름(`tool-events` 등) | 문서 이름 그대로 선언 | **확정(ADR 0001 5.3)**: 정본은 `GATEWAY_CLIENT_CAPS`, 세 이름 모두 존재. `features.capabilities` 는 서버 플래그라 에코되지 않음 |
| 5 | `config.set`이 재시작 없이 반영되는가 | `applied: "restart_required"`도 허용 | **확정(ADR 0003 3절)**: `applied: "live"`는 설정 스냅샷 기준. claude-cli 기존 세션은 드리프트·Gateway 재시작으로도 미반영, `sessions.reset`·새 키에서만 반영. 인바운드 경로(프리픽스·`ChannelPromptContext`)는 매 턴 반영 |
| 6 | 채널 봇 루프 보호가 릴레이를 막는가 | 막으면 채널 설정으로 끄고 우리 `relayPolicy`만 사용 | **확정(ADR 0002 7절, 계획서 10장 #13)**: 플러그인이 사실을 넘길 때만 동작(기본 20회/60초·쿨다운 60초, 초과 시 `admission: drop`). 사실을 넘기되 코어 예산은 `maxRelayTurns` 보다 느슨하게 두어 안전망으로만 쓴다 |
| 7 | `chat.send` + `originatingChannel: "dodok"` 대체 경로 | 미사용 | **확정(ADR 0003 6절)**: `deliver:true`면 배달되지만 `sendText`(agentId·runId 없음)이고 `originating*`는 admin 필요 — 기본값 「미사용」 유지 |

확정되면 이 문서의 해당 절과 `docs/plan.md` 10장을 갱신하고 `docs/adr/`에 기록한다.

---

## 12. 참고

- `docs/plan.md` 3.1(프로토콜 사실), 5.2~5.8(설계 결정), 7(스택)
- `docs/project-structure.md` 2.1~2.4(패키지 파일 배치), 6(컨벤션)
- 라이브러리 기준 버전(2026-09-14): zod 4.6, drizzle-orm 0.45, socket.io 4.8, fastify 5.12, better-sqlite3 13.0, uuid 14
- AG-UI 이벤트 이름: `@ag-ui/core` 0.0.59의 `EventType`
