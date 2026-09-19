# 서버 코어 설계 (Phase 1 ①)

작성일: 2026-09-15 · 상태: 승인(2026-09-15), 구현 계획 `docs/superpowers/plans/2026-09-15-server-core.md` · 근거: `docs/plan.md` v0.6(8장 Phase 1, 10장 결정), 계약 스펙 `2026-09-14-shared-contracts-design.md`, ADR 0001~0003

## 0. 목적과 범위

Phase 1 MVP 코어를 ① 서버 코어, ② 웹 두 스펙으로 나눈다. 이 문서는 ①이다 — `apps/server` 를 실제로 뜨는 서버로 만들고 `packages/openclaw-adapter` 를 스파이크 수준에서 프로덕션 수준으로 올린다.
계약(도메인·DB·상태머신·라우터·RunEvent·wire·bridge·components)은 계약 스펙이 정본이며 여기서는 **참조만** 한다. 계약 스펙에 없는 것을 새로 정할 때는 **[신규]** 로 표시한다.

이 스펙이 끝났을 때 되는 것: 사람이 wire 클라이언트로 채널에 글을 쓰면 라우터가 에이전트 런을 만들고, 브리지로 플러그인에 인바운드가 가고, Gateway 이벤트가 델타·툴 이벤트로 스트리밍되고, 플러그인 정본이 메시지로 확정되고, 에이전트 메시지의 @멘션으로 릴레이가 이어지며, 상한에서 시스템 메시지로 멈춘다. 재접속·단절·재시작에서 런이 고아가 되지 않는다.

범위 밖(Phase 2 이후): 업로드·썸네일, 푸시, 승인 카드 미러(`approvals/`)의 UI 경로, 스레드, 이미지 아티팩트, 원격 Gateway 배포 절차(ADR 0002 9절은 사용자 절차).

## 1. 결정(2026-09-15)

| 항목 | 결정 |
| --- | --- |
| 접근 | **A. 모듈형 단일 프로세스 + 인메모리 오케스트레이터(DB 가 정본)** |
| 검증 기준 | 가짜 Gateway·가짜 플러그인 통합 테스트(CI) + 로컬 dev Gateway 실연(워커) |
| 인증 | Better Auth + 단일 owner + 로컬 토큰 로그인, 이메일·비밀번호 로그인 비활성 |
| Gateway 대상 | 개발·검증은 `~/.openclaw-dev`(에이전트 `dev`·`fin`), 원격은 사용자가 플러그인을 호스트에 올린 뒤 별도 검증 |
| 계획서 10장 | #1(프롬프트 주입) #11(Node 24) #13(봇 루프 보호) #14(`admission`) #15(`operator.admin`·`sessions.reset`) #16(재접속 복구) #17(대체 경로 미사용) #18·#19(플러그인 정리) 를 그대로 따른다 |

## 2. 프로세스·부팅·종료

한 프로세스, `apps/server/src/app.ts` 의 `createApp(config)` 가 순서대로 올린다.

1. `config.ts` — `.env` 를 zod 로 검증한 `ServerConfig`(3.1). 실패하면 어떤 변수가 왜 틀렸는지 찍고 종료.
2. `db/client.ts` — `createDb(DB_PATH)` + Drizzle 마이그레이션 적용. 워크스페이스가 없으면 1개 생성(이름 `DODOK_WORKSPACE_NAME`, 기본 `dodok`).
3. `auth/` — Better Auth 인스턴스, owner 부트스트랩(3.3).
4. Fastify — `@fastify/cookie`, Better Auth 핸들러(`/api/auth/*`), REST `/api/v1`(4장), 헬스 `/healthz`.
5. Socket.IO — 기본 네임스페이스 = wire(3.11), `/bridge` = 어댑터 `attachBridge`(6.3). 같은 HTTP 서버에 붙는다.
6. 어댑터 — `OpenClawAdapter.connect()`. Gateway 접속 실패는 **부팅을 막지 않는다**(`adapter.status: down` 으로 시작해 백오프 재시도).
7. **부팅 정리** — `runs` 에서 종료되지 않은 런(queued/streaming/tool/awaiting_approval/finalizing)을 `error({ code: "SERVER_RESTART" })` 로 닫고 `RUN_ERROR`·`STATE_SNAPSHOT` 이벤트를 기록한다. 메모리 타이머는 재시작에서 살아남지 않으므로 복원하지 않는다(접근 A 의 대가).
8. `listen(HOST, PORT)`.

종료(SIGTERM/SIGINT): 새 wire 연결 거부 → 진행 중 런은 그대로 두고(재시작 정리가 닫는다) → 브리지 소켓에 `system.notice { reason: "shutdown" }` → Gateway 연결 종료 → DB 닫기. 10초 안에 끝나지 않으면 강제 종료.

## 3. 모듈

배치는 구성 가이드 2.2 를 따른다. 각 모듈은 `Db` 를 받는 서비스 함수 묶음이며, 프로세스 전역 상태는 오케스트레이터(3.8)와 어댑터 인스턴스뿐이다. 모듈 간 통지는 `realtime/bus.ts` **[신규]** 의 타입드 `EventEmitter`(`ServerBus`)로 한다 — DB 쓰기 → bus emit → realtime 이 wire 팬아웃. 모듈이 Socket.IO 를 직접 만지지 않는다.

### 3.1 `config.ts` **[신규]**

```ts
export const ServerConfig = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(3000),
  APP_ORIGIN: z.url(),                              // 쿠키·CORS 기준 (예: http://localhost:5173)
  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().optional(),                   // 기본 <DATA_DIR>/dodok.sqlite
  LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
  DODOK_WORKSPACE_NAME: z.string().default("dodok"),
  OWNER_HANDLE: Handle.default("owner"),
  LOCAL_AUTH_TOKEN: z.string().min(16),             // 로컬 로그인 토큰 (= owner 의 Better Auth 비밀번호)
  BETTER_AUTH_SECRET: z.string().min(32),
  OPENCLAW_TARGET: z.enum(["remote", "dev"]).default("remote"),
  OPENCLAW_GATEWAY_URL: z.url().optional(),         // remote
  OPENCLAW_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_DEV_GATEWAY_URL: z.url().optional(),     // dev (openclaw --dev gateway run)
  OPENCLAW_DEV_GATEWAY_TOKEN: z.string().optional(),
  OPENCLAW_DEVICE_IDENTITY_PATH: z.string().optional(),   // 기본 <DATA_DIR>/openclaw-device(.dev).json
  BRIDGE_TOKEN: z.string().min(16),
  BRIDGE_PUBLIC_URL: z.url().optional(),            // 플러그인 계정 설정에 적을 값(정보용)
}).superRefine(/* OPENCLAW_TARGET 에 맞는 URL·TOKEN 쌍이 있어야 한다 */);
```

`OPENCLAW_TARGET` 이 고르는 쌍이 어댑터로 간다. 디바이스 아이덴티티 파일도 대상별로 나뉜다(`openclaw-device.json` / `openclaw-device-dev.json`) — 원격과 dev 의 페어링이 섞이지 않게.

### 3.2 `db/`

계약 스펙 4장 그대로. **[신규]** 두 가지:

```ts
// channels 에 추가
promptRevision: integer("prompt_revision").notNull().default(1),   // prompt·promptOverride·relayPolicy 가 바뀔 때마다 +1

// 새 테이블
export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  sessionKey: text("session_key").notNull(),               // agent:<providerAgentId>:dodok:channel:<channelId>
  promptRevisionAtStart: integer("prompt_revision_at_start").notNull(),
  sessionStartedAt: ts("session_started_at"),              // Gateway sessions.list 의 sessionStartedAt (리셋 판별)
  lifecycleRevision: text("lifecycle_revision"),             // 실측값은 uuid 문자열 (sessions.reset 응답 entry)
  providerSessionId: text("provider_session_id"),          // sessionId (리셋 뒤에도 유지되므로 식별용으로만)
  historyCursor: text("history_cursor"),                   // chat.history deltaCursor (오면 저장, 최적화용)
  lastSyncedAt: ts("last_synced_at"),
}, (t) => [uniqueIndex("agent_sessions_channel_agent").on(t.channelId, t.agentId)]);
```

`promptRevisionAtStart` 는 「그 세션이 마지막으로 새로 시작됐을 때(첫 턴·리셋 뒤)의 채널 프롬프트 리비전」이다. 마이그레이션은 Drizzle Kit 으로 생성해 커밋한다.

### 3.3 `auth/` — Better Auth + 로컬 토큰

- Better Auth(1.7) + Drizzle SQLite 어댑터. Better Auth 의 자체 테이블(`user`·`session`·`account`·`verification`)은 **우리 `users` 와 별개**로 두고, `users.id` = Better Auth `user.id` 로 맞춘다(같은 값으로 삽입).
- `emailAndPassword` 는 **켜되 회원가입은 막는다**(`disableSignUp: true`). 소셜·OIDC 없음. 세션 만료 30일, 갱신 1일.
- **owner 부트스트랩**(부팅 3단계): Better Auth `user` 에 이메일 `owner@dodok.local` 이 없으면 만들고, `users`·`memberships(role: owner)` 행도 만든다. 비밀번호는 `LOCAL_AUTH_TOKEN`. 토큰이 바뀌면(로그인 실패 뒤 재확인) 비밀번호를 갱신한다 — 즉 **로컬 토큰 = owner 의 비밀번호**이며 Better Auth 의 표준 흐름만 쓴다.
- `POST /api/v1/auth/local { token }` → 서버가 Better Auth 서버 API 로 `owner@dodok.local` + `token` 사인인 → 세션 쿠키 + 응답 본문에 `sessionToken`(wire 접속용). 실패는 `UNAUTHORIZED`, 5회/분 레이트리밋.
- REST 인증: 쿠키 또는 `Authorization: Bearer <sessionToken>`. wire 접속의 `auth.token` 은 `sessionToken` 이며 서버가 Better Auth 로 검증해 `userId` 를 소켓에 붙인다(계약 스펙 7.1).
- MVP 는 사용자가 owner 1명이므로 권한 검사는 「로그인됨」뿐이다. `role` 은 저장만 한다.

구현 계획에서 Better Auth 1.7 의 서버 API 이름(사인인·세션 조회·Fastify 핸들러 마운트)을 문서로 확인한다(11장).

### 3.4 `channels/`

- `createChannel`, `updateChannel`(name/topic/prompt/relayPolicy/visibility), `listChannels`, `getChannel`.
- 멤버: `addMember(user|agent)`, `updateAgentMember(promptOverride/autoRespond/aliases)`, `removeMember`. `autoRespond=true` 가 채널에 둘 이상이면 저장은 하되 경고 로그(라우터가 `joinedAt` 최소 하나만 쓴다).
- **프롬프트 리비전**: `prompt`·`promptOverride`·`relayPolicy` 가 바뀌면 같은 트랜잭션에서 `promptRevision += 1`. 커밋 뒤 bus `channel.updated` → wire, 그리고 어댑터 `syncChannelConfig(channelId, { systemPrompt: prompt })`(6.4) 를 **비동기**로 호출(실패해도 채널 변경은 유효, `system.notice warn`).
- 「새 대화」: `resetAgentSession(channelId, agentId)` → 어댑터 `resetSession(sessionKey)` → 성공하면 `agent_sessions` 의 `promptRevisionAtStart = 현재 리비전`, `sessionStartedAt` 갱신, 채널에 시스템 메시지(`info`: "@<handle> 의 대화를 새로 시작했습니다"). 어댑터가 `sessionReset` capability 없음(admin 미부여)을 알리면 `409 ADAPTER_CAPABILITY_MISSING`.

### 3.5 `agents/`

- `createAgent(provider: "openclaw", providerAgentId, handle, name, basePrompt?)`, `updateAgent`, `listAgents`. `enabled=false` 면 라우터가 대상에서 뺀다.
- `discoverAgents()` → 어댑터 `listAgents()`(Gateway `agents.list`) 를 그대로 돌려줘 등록 화면의 선택지로 쓴다. 자동 동기화는 하지 않는다.
- `basePrompt` 는 MVP 에서 **인바운드에 싣지 않는다**(OpenClaw 에이전트 자체 프롬프트는 건드리지 않는다는 계획서 5.2). 저장만.

### 3.6 `messages/`

- `createUserMessage({ channelId, authorId, bodyMd, clientMsgId, attachments?, replyTo })` — 트랜잭션 안에서 `allocateSeq` → `tokenize`(계약 스펙 2장) 로 `mentions` 파생 → INSERT. `(authorId, clientMsgId)` 중복이면 기존 행을 돌려준다(멱등).
- `createAgentMessage({ channelId, agentId, runId?, externalId, bodyMd, components?, replyTo? })` — `externalId`(브리지 `outboundId`) UNIQUE 로 중복 흡수. `components` 가 있으면 `componentState = { expiresAt: now + ttlMs, consumed: [] }`.
- `createSystemMessage({ channelId, kind, bodyMd, systemMeta, components? })`.
- `listMessages(channelId, { beforeSeq?, afterSeq?, limit ≤ 200 })`.
- 저장 뒤 bus `message.created` → wire `message.created`. 라우팅(3.7)은 **저장과 같은 요청 흐름에서** 호출하되 DB 트랜잭션 밖에서 한다(런 생성이 실패해도 메시지는 남는다).

### 3.7 `router/` (서비스)

`routeMessage(message)`:
1. `decideRuns()` 입력을 조립한다 — 채널·멤버·에이전트, 에이전트 메시지면 `sourceRun`, `chainHashes`(같은 `rootMessageId` 의 `runs.relay_hash` 집합), `todayRunCount`(채널의 오늘 런 수, 서버 로컬 자정 기준).
2. `runs` 각각을 오케스트레이터 `enqueueRun(plan, message)` 에 넘긴다.
3. `blocked` 는 사유별로 시스템 메시지 하나(계약 스펙 5.2 규칙 3). `relay_limit` 에는 `continue_relay` 버튼과 `systemMeta.relay`.
4. `continue_relay` 상호작용과 컴포넌트 상호작용은 3.10 이 `triggerKind: continue | interaction` 으로 직접 `enqueueRun` 한다(라우터를 거치지 않는다).

### 3.8 `runs/` — 오케스트레이터 **[신규]**

프로세스에 하나. 런의 진실은 `runs` 행이고, 메모리에는 **타이머와 스트리밍 버퍼만** 둔다.

```ts
export type Orchestrator = {
  enqueueRun(plan: RunPlan, trigger: { message?: Message; interactionId?: Id }): Promise<Run>;
  signal(runId: Id, s: RunSignal, ctx?: SignalContext): Promise<void>;   // 어댑터·타이머·사용자가 부른다
  abort(runId: Id, by: "user"): Promise<void>;
  onCanonical(msg: OutboundMessage): Promise<void>;                     // 브리지 정본 도착
  recoverOnBoot(): Promise<number>;                                      // 2장 7단계
};
```

- **생성**: `runs` 행(queued) + `RUN_QUEUED` 이벤트 + `run.state` 팬아웃. 세션 키는 어댑터 `sessionKeyFor(providerAgentId, channelId)`.
- **직렬화 [신규]**: 같은 `sessionKey` 에 진행 중(dispatched 이후 종료 전) 런이 있으면 새 런은 `queued` 로 **대기**하고 앞 런이 끝날 때 다음 것을 보낸다(FIFO). 대기 중에는 queued 타이머를 걸지 않는다 — 앞 런의 run 타이머(600s)가 상한이다. OpenClaw 의 `queueMode: followup` 큐잉에 기대지 않는다(ADR 0002 11절 7 미측정).
- **디스패치**: 인바운드 컨텍스트 조립(7장) → 어댑터 `send()` → `queued` 타이머 120s 시작. 어댑터가 `admission: "drop"` 을 돌려주면 `gateway_error { code: "DROPPED", message: reason }` 로 닫고 시스템 메시지(`run_error`: "에이전트가 메시지를 받지 않았습니다(<reason>)").
- **신호 적용**: `transition()` → `runs` UPDATE(같은 트랜잭션에 `STATE_SNAPSHOT` 이벤트) → bus `run.state`. `ignored` 는 debug 로그. 타이머는 상태에 따라 갈아 끼운다(queued 120s → gateway_started 에 run 600s → gateway_final 에 finalizing 10s).
- **스트리밍 버퍼**: 런별 `{ messageId, pending: string, timer }`. `TEXT_MESSAGE_CONTENT` 는 50ms 코얼레싱해 `run_events` 에 1건으로 저장하고 `run.event` 1건으로 보낸다. `TEXT_MESSAGE_REPLACE` 는 버퍼를 비우고 즉시. `TOOL_CALL_ARGS` 도 같은 규칙.
- **정본**: `onCanonical` 은 계약 스펙 5.1 상관관계(runId → sessionKey 의 진행 중 런 → replyToInboundId)로 런을 찾고, `createAgentMessage` → `canonical_received` 신호 → 종료 시 `RUN_FINISHED { messageIds }`. 종료된 런에 늦게 온 정본은 `runId` 를 달아 저장만(주3). 런을 못 찾으면 런 없이 저장 + warn.
- **종료 처리**: `done` 이면 `finalSource=plugin` 일 때 아무것도 더 하지 않고, `finalSource=gateway`(finalizing 타임아웃)면 WS 스냅샷 본문이 비어 있지 않을 때만 에이전트 메시지로 저장. 종료된 에이전트 메시지는 라우터(3.7)로 넘겨 릴레이를 판단한다 — **정본 메시지가 저장되는 순간** 라우팅한다(런 종료를 기다리지 않는다. 한 런이 정본을 여러 개 보내면 각각 라우팅된다).
- **중단**: `abort(runId)` → 어댑터 `abort(runId)`(`chat.abort`) → `abort_requested` 신호.
- **용량**: 채널당 진행 중 런 상한 없음(에이전트마다 세션이 달라 병렬). 프로세스 전체 진행 중 런 상한 32 **[신규]** — 넘으면 새 런은 `queued` 대기.

### 3.9 `sessions/` **[신규]**

`agent_sessions` 유지·조회. 디스패치 직전 `ensureSession(channelId, agentId)`:
- 행이 없으면 만든다(`promptRevisionAtStart = channels.promptRevision` — 첫 턴은 (a) 설정 경로가 이미 프롬프트를 담으므로 동봉하지 않는다).
- `needsPromptContext = promptRevisionAtStart !== channels.promptRevision` — 참이면 인바운드 `context.channelPrompt` 를 채운다(7장). 세션은 리셋·재시작 전까지 옛 시스템 프롬프트를 갖고 있으므로 매 턴 동봉한다.
- 외부(Control UI 등)에서 일어난 리셋은 MVP 에서 감지하지 않는다 — `sessions.list` 항목과 `chat.history.sessionInfo` 에는 `sessionStartedAt`·`lifecycleRevision` 이 없고 `sessions.reset` 응답 `entry` 에만 있다(스파이크 3 관찰 파일 실측). 우리 `resetSession` 의 응답으로만 갱신한다.

### 3.10 `components/`

계약 스펙 9.3 순서대로: `component.interact` → 메시지·`componentState` 검사(만료·소비·`allowedUsers`) → `validateInteraction` → `component_interactions` 저장 → `componentState.consumed` 갱신(reusable 아니면) → `message.updated` → `formatInteractionText` → `continue_relay` 면 `enqueueRun(continue)`, 아니면 `enqueueRun(interaction)` 대상은 그 메시지의 `runId` 의 에이전트. 승인 카드(9.5)는 Phase 2.

### 3.11 `realtime/`

- `socket.ts`: 접속 시 `auth.token`·`protocol` 검증(실패 코드는 계약 스펙 7.1), `user:<id>` 룸. `channel.subscribe` 는 룸 참가 + `lastSeq` 이후 메시지(≤200, `hasMore`) + 진행 중 런 + `pendingApprovals: []`. 나머지 이벤트는 모듈 서비스로 위임하고 ack 는 `Ack<T>` 모양.
- `events.ts`: bus → 룸 팬아웃 매핑 표(메시지·런·채널·타이핑·adapter.status). 소켓별 미전송 큐(Socket.IO `sendBuffer` 길이 또는 우리 카운터) 가 500 이벤트를 넘으면 `run.event` 는 버리고 `run.state { resync: true }`.
- `typing` 은 사람 것만 중계(에이전트 타이핑은 Phase 2).

### 3.12 `adapters/`

`types.ts` 는 계획서 5.7 을 구체화한다(6.1). `registry.ts` 는 provider → 인스턴스(MVP 는 `openclaw` 하나).

## 4. REST `/api/v1` **[신규]**

전부 JSON, 인증 필요(3.3의 `/auth/local` 제외). 오류는 계약 스펙 1.2 `ApiError { code, message, details? }`. 요청·응답은 계약 스펙 3장 도메인 스키마를 그대로 쓴다.

| 메서드·경로 | 동작 |
| --- | --- |
| `POST /auth/local` · `POST /auth/logout` · `GET /auth/me` | 로컬 토큰 로그인 / 로그아웃 / 현재 사용자·워크스페이스 |
| `GET /channels` · `POST /channels` · `GET /channels/:id` · `PATCH /channels/:id` | 채널 CRUD(삭제 없음) |
| `GET /channels/:id/members` · `POST` · `PATCH /channels/:id/members/:memberId` · `DELETE` | 멤버 관리(에이전트 멤버의 `promptOverride`·`autoRespond`·`aliases`) |
| `POST /channels/:id/agents/:agentId/reset` | 「새 대화」(3.4) |
| `GET /channels/:id/messages?beforeSeq&afterSeq&limit` | 히스토리 페이징 |
| `GET /channels/:id/runs?limit` · `GET /runs/:id` · `GET /runs/:id/events?afterSeq` | 런 목록·상세·이벤트(활동 패널) |
| `GET /agents` · `POST /agents` · `PATCH /agents/:id` · `GET /agents/discover` | 에이전트 등록(`discover` 는 Gateway `agents.list`) |
| `GET /adapter/status` | `AdapterStatus` + Gateway `hello-ok` 요약(버전·capabilities·`sessionReset` 가능 여부) |
| `GET /healthz` | 인증 없음. DB·어댑터 상태 |

## 5. 런 한 턴의 흐름

1. `message.send` → 3.6 저장·브로드캐스트 → 3.7 `decideRuns` → 3.8 `enqueueRun`(queued, `RUN_QUEUED`).
2. 세션 직렬화 통과 → 3.9 `ensureSession` → 7장 컨텍스트 조립 → 어댑터 `send()` → 브리지 `inbound.deliver`(재시도 규칙은 계약 스펙 8.3) → ack `admission`.
3. Gateway `agent`/`chat` 이벤트 → 어댑터 `events.ts` 가 `RunEvent` + `RunSignal` 로 정규화 → `signal()` → 상태 전이·`run_events`·`run.event`/`run.state` 팬아웃. 델타는 50ms 코얼레싱.
4. 플러그인 `outbound.message` → `onCanonical` → 에이전트 메시지 저장(`message.created`, `runId`) → `canonical_received` → 클라이언트는 버블을 메시지로 교체.
5. Gateway `final` → `gateway_final` → 정본이 있으면 `done(plugin)`, 없으면 `finalizing` 10s 뒤 `done(gateway)`.
6. 저장된 에이전트 메시지는 3.7 로 다시 들어가 릴레이를 판단한다. 대상이 있으면 2단계부터(`relayDepth+1`), 상한이면 `relay_limit` 시스템 메시지.

## 6. OpenClaw 어댑터 (`packages/openclaw-adapter`)

### 6.1 인터페이스 (`apps/server/src/adapters/types.ts`)

```ts
// 정본: packages/openclaw-adapter/src/adapter-types.ts (서버는 apps/server/src/adapters/types.ts 에서 re-export)
export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunEventBody = DistributiveOmit<RunEvent, "seq" | "ts">;   // 판별 유니온을 유지한 채 seq·ts 만 뺀다 (단순 Omit 은 공통 키만 남긴다)
export type AdapterEvent =
  | { kind: "run_event"; runId: Id; event: RunEventBody }                        // seq·ts 는 오케스트레이터가 부여
  | { kind: "run_signal"; runId: Id; signal: RunSignal }                          // RunSignal 은 @dodok/shared 로 이동
  | { kind: "canonical"; message: OutboundMessage }                                // 브리지 정본(알림용 — 저장 결과는 onCanonical 훅이 돌려준다)
  | { kind: "status"; status: AdapterStatus; capabilities: AdapterCapabilities };

export interface AgentAdapter {
  readonly provider: "openclaw";
  connect(): Promise<void>;                       // 실패해도 throw 하지 않고 status 로 알린다
  close(): Promise<void>;
  status(): AdapterStatus;
  capabilities(): AdapterCapabilities;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>>;
  sessionKeyFor(providerAgentId: string, channelId: Id): string;
  send(input: InboundDeliver): Promise<InboundDeliverResult>;   // 브리지 inbound.deliver (재시도 포함). 실패는 AdapterError(code) throw
  abort(runId: Id, sessionKey: string): Promise<void>;          // chat.abort
  resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }>;   // sessions.reset (admin 필요)
  syncChannelConfig(channelId: Id, config: ConfigSet["config"]): Promise<ConfigSetResult>;   // 브리지 config.set
  onEvent(handler: (e: AdapterEvent) => void): () => void;
}
export class AdapterError extends Error { readonly code: ErrorCode }
```

`packages/openclaw-adapter/src/index.ts` 의 `createOpenClawAdapter()` 가 구현한다. 생성 인자: Gateway URL·토큰·디바이스 아이덴티티 경로·브리지 토큰·Socket.IO `Server`(`/bridge` 부착용)·로거·`onCanonical`(서버가 정본을 저장하고 `{ messageId }` 를 돌려주는 훅)·`sessionKeysToRecover`(재접속 복구 대상). 테스트 대역 `FakeAdapter` 도 같은 패키지에 있다(태스크 6 에서 위치 결정 — 어댑터 패키지는 서버를 import 할 수 없다).

### 6.2 Gateway 클라이언트(`gateway/client.ts` 프로덕션화)

- 스코프 `["operator.read", "operator.write", "operator.approvals", "operator.admin"]` 로 접속(계획서 #15). `hello-ok` 뒤 `sessions.list` 를 한 번 호출해 `operator.admin` 부여 여부를 판정할 수 없으므로(없는 메서드와 스코프 부족이 같은 오류 — ADR 0001) **`sessions.reset` 을 실제 세션에 처음 호출할 때** `MISSING_SCOPE` 면 `capabilities.sessionReset=false` 로 내리고 `status` 로 알린다. 원격이 admin 을 주는지 확인하는 것은 구현 계획의 첫 작업(dev 루프백은 준다 — ADR 0003 2절).
- 재접속: 지수 백오프(1s→30s 상한) + 페어링 `PAIRING_REQUIRED` 재시도(ADR 0001). 접속마다 `status`.
- **재접속 복구**(계획서 #16): 접속 뒤 `agent_sessions` 의 세션 각각에 `sessions.subscribe` → `chat.history({ sessionKey, limit: 50 })` 전체 응답(커서가 저장돼 있으면 `cursor` 로 먼저, `kind:"reset"` 이면 전체) . 히스토리 본문으로 **메시지를 만들지 않는다**(정본은 플러그인 경로·서버 DB). `inFlightRun` 이 있고 우리 `runs` 에 진행 중 런이 있으면 그 런에 다시 붙이고, 없으면 무시.
- `events.ts` **[신규]**: 계약 스펙 6.1 표를 그대로 구현. `runId` 로 우리 런을 찾을 수 없는 이벤트(Gateway 안에서 사람이 직접 띄운 세션 등)는 `CUSTOM` 으로도 저장하지 않고 debug 로그만.
- `agents.list`, `chat.abort`, `sessions.reset` 래퍼. 모든 호출은 `FORBIDDEN`/`MISSING_SCOPE` 를 「기능 없음」으로 바꾸고 연결은 유지한다.

### 6.3 브리지(`bridge/server.ts` + `session.ts`)

스파이크 2 구현을 그대로 쓰되 콜백을 어댑터 이벤트로 연결하고, **플러그인 ack 를 `InboundDeliverResult` 로 Zod 파싱**한다(지금은 타입만 통과시킨다 — phase1-prep 보고 걱정 4). 그 다음: `onOutboundMessage` → `canonical`, `onHello` → `status.bridge = connected`, 끊김 → `down`. `send()` 는 계약 스펙 8.3 의 재시도(10s ack 없으면 1·4·16s 3회) 뒤 `ADAPTER_UNAVAILABLE` 로 거부한다 — 오케스트레이터는 queued 120s 안에서 이 거부를 받아 `gateway_error` 로 닫는다. 플러그인이 붙어 있지 않으면 즉시 거부하지 않고 120s 동안 대기했다가 붙으면 보낸다(오케스트레이터 큐).

### 6.4 `config-sync.ts`

`syncChannelConfig` → 브리지 `config.set { channelId, config: { systemPrompt, requireMention } }` → `applied` 를 로그. 실패는 예외로 돌려주고 채널 모듈이 `system.notice warn` 으로 알린다. `restart_required` 는 MVP 에서 무시(로그만).

### 6.5 `sessions.ts`

`sessionKeyFor` = `agent:<providerAgentId>:dodok:channel:<channelId>` 원형(계획서 #19). 접미사 없음.

## 7. 인바운드 컨텍스트 조립 (서버, `runs/context.ts` **[신규]**)

`InboundDeliver.context` 는 서버가 채운다. 플러그인은 그것을 헤더·`ChannelPromptContext` 로 렌더할 뿐이다(계획서 #18).

- `recentMessages`: 트리거 메시지 이전 채널 메시지 최근 20개(시스템 메시지 제외, 트리거 메시지 자체는 `message` 필드로 따로 간다). `text` 는 `renderForAgent`(@handle 평문).
- `participants`: 채널 멤버 전부(사람 `handle`·`displayName`, 에이전트 `handle`·`name`, `isSelf`).
- `relayRules`: 한 문단 — "다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 N턴). 언급만 할 때는 @ 없이 이름만 쓰세요." + `allowPairs` 가 제한이면 이 에이전트가 부를 수 있는 핸들 목록. 라우터는 멘션 = 호출이라 서술 속 @핸들도 릴레이가 된다(live-smoke 5.4-5) — 그래서 부를 때만 @ 를 쓰게 한다.
- `channelPrompt`: 3.9 `needsPromptContext` 일 때만 채널 `prompt`. 아니면 생략.
- `promptOverride`: 에이전트 멤버의 `promptOverride` 가 있으면 항상.
- `message.text`: 트리거 메시지 `renderForAgent`. `interaction`/`continue` 런은 `formatInteractionText` 결과. 첨부는 Phase 2.
- `options.queueMode`: 보내지 않는다(서버가 직렬화).

## 8. 오류·복구

| 상황 | 동작 |
| --- | --- |
| Gateway 단절 | `adapter.status gateway: reconnecting`. 진행 중 런은 이벤트가 끊기므로 타이머(run 600s)로 종료. 재접속 뒤 6.2 복구 |
| 브리지 단절 | `bridge: down`. 대기 런은 120s 안에 플러그인이 돌아오면 전송, 아니면 `error(ADAPTER_UNAVAILABLE)` + `run_error` 시스템 메시지 |
| `inbound.deliver` ack 없음 | 계약 스펙 8.3 재시도 뒤 위와 같음 |
| ack `admission: drop` | `error(DROPPED:<reason>)` + `run_error` 시스템 메시지. `reason` 이 `bot-loop-protection` 이면 "봇 루프 보호로 거절됨", 그 밖(`outbound-echo`, `handled:*`, `observeOnly:*`, `unknown`)은 사유 문자열을 그대로 표시 — 정확 일치 분기는 `bot-loop-protection` 하나뿐 |
| ack `ok:false`(플러그인 예외·검증 실패) | 재시도하지 않고 `error(ADAPTER_ERROR:<code>)` + `run_error`. 재시도는 「ack 없음」에만(계약 스펙 8.3) |
| ack 가 `InboundDeliverResult` 로 파싱되지 않음(옛 플러그인 번들의 `{}` 등) | 어댑터가 경계에서 Zod 파싱해 `error(ADAPTER_PROTOCOL)`. dev·원격 플러그인은 `admission` 을 싣는 번들(커밋 phase1-prep 이후)로 재설치한다 |
| 정본 없이 `final` | `finalizing` 10s → WS 스냅샷으로 확정(`finalSource=gateway`), 비어 있으면 메시지 없이 `done` |
| Gateway 이벤트 없이 정본(구독 누락·WS 단절 — Phase 1 실연) | `queued` → `finalizing`(`hasCanonical`) → `final` 이 오면 곧바로, 안 오면 10s 뒤 `done(finalSource=plugin)`. `run_error` 없음(계약 스펙 5.1 ⁵) |
| 종료된 런에 늦은 정본 | `runId` 달아 저장, 라우팅은 한다(늦어도 릴레이는 유효) |
| 서버 재시작 | 2장 7단계. 클라이언트는 `channel.subscribe { lastSeq }` 로 빈틈을 메운다 |
| `sessions.reset` 스코프 부족 | `capabilities.sessionReset=false`, REST `409`. 폴백(키 회전)은 계획서 #15 의 후속 결정 |
| Socket.IO 미전송 큐 초과 | `run.state { resync: true }` (계약 스펙 7.3) |
| 오케스트레이터 신호 처리 중 예외 | 런을 `error(INTERNAL)` 로 닫고 로그. 다른 런에 전파하지 않는다 |

로깅은 pino. 런마다 `runId`·`channelId`·`agentId` 를 바인딩한 자식 로거를 쓴다. 토큰은 절대 로그에 찍지 않는다(설정 로더가 `***` 로 가린다).
진단 줄(Phase 1 실연 뒤): 어댑터 `inbound delivered`(info), 오케스트레이터 `run ended`(info, 종료 전이마다)·`run closed by timeout`(warn, `final_timeout` 만 info) — 메시지 본문·토큰은 싣지 않는다(필드는 live-smoke 5.4-3).

## 9. 검증

### 9.1 단위(vitest, 각 패키지)

- 모듈 서비스: 인메모리 SQLite(`:memory:` + 마이그레이션)로 CRUD·멱등·리비전 증가·페이징.
- 오케스트레이터: **가짜 어댑터**(`send` 가 즉시 `dispatch` 를 돌려주고 테스트가 이벤트를 주입)와 **가짜 시계**(vitest fake timers)로 전이·타이머·직렬화·코얼레싱·정본 상관·부팅 정리.
- 어댑터 `events.ts`: ADR 0001·0002 관찰 파일(`data/spike-*-observations*.json` 의 마스킹된 이벤트)에서 발췌한 픽스처로 매핑을 잰다.
- 라우터·상태머신·상호작용은 이미 순수 함수 테스트가 있다(계약 스펙 10장).

### 9.2 통합 **[신규 하네스]** (`apps/server/test/integration/`, `test/fakes/`)

- `fake-gateway.ts`: `ws` 서버. 실제 `@openclaw/gateway-client` 가 붙을 수 있는 프로토콜 v4 부분집합 — `connect.challenge` → `connect` → `hello-ok`(features·snapshot), `chat.send`(응답 `runId = idempotencyKey`, 시나리오 스크립트에 따라 `agent`/`chat` 이벤트 방출), `sessions.subscribe`, `sessions.list`, `chat.history`, `chat.abort`, `sessions.reset`(admin 부여 여부를 스위치로), `agents.list`. 디바이스 서명은 검증하지 않는다. 프레임 모양은 ADR 0001 관찰 파일을 따른다.
- `fake-plugin.ts`: `socket.io-client` 로 `/bridge` 에 붙는 가짜 플러그인 — `hello`, `inbound.deliver` 를 받으면 시나리오에 따라 ack(`dispatch`/`drop`)하고 가짜 Gateway 에 「이 세션에 런을 돌려라」고 지시, 지연 뒤 `outbound.message`(본문에 다른 에이전트 @멘션 가능) 전송.
- 시나리오 객체 하나가 두 가짜를 조율한다: `{ agents: { dev: replies[], fin: replies[] } }` 처럼 에이전트별 답변 대본.
- **시나리오 테스트**(완료 기준): 서버를 실제로 띄우고 wire 클라이언트(`socket.io-client`)로 —
  1. 로그인 → 채널 생성 → 에이전트 `dev`·`fin` 등록·멤버 추가.
  2. 사람이 `@dev` 멘션 → `run.state`(queued→streaming→done) · `run.event` 델타 · `message.created`(runId) 순서 확인.
  3. `dev` 답변이 `@fin` 을 멘션 → 릴레이 런 · `relayDepth 1` → `fin` 답변이 `@dev` → `relayDepth 2` … `maxRelayTurns=2` 에서 `relay_limit` 시스템 메시지 + `continue_relay` 버튼.
  4. `continue_relay` 클릭 → `continue` 런.
  5. 반복 본문 → `repeat` 차단, `allowPairs` 제한 → `relay_denied`.
  6. 플러그인 ack `drop` → `run_error`. 브리지 끊고 메시지 → 120s(가짜 시계) 뒤 `ADAPTER_UNAVAILABLE`.
  7. 재접속: 클라이언트가 `lastSeq` 로 빈틈 메움. 서버 재시작(앱 재생성) → 진행 중 런이 `SERVER_RESTART` 로 닫힘.
  8. 채널 프롬프트 변경 → 다음 인바운드 `context.channelPrompt` 동봉, 리셋 뒤에는 동봉 없음.
- CI(로컬 `pnpm test`)에서 돈다. 모델 런 없음.

### 9.3 실연(워커, 로컬 dev Gateway)

`scripts/wire-cli.ts` **[신규]**(`tsx`; 로그인·채널 생성·구독·전송·이벤트 출력)로 실제 서버 + 실제 플러그인(dev Gateway 에 설치된 최신 번들) + `dev`·`fin` 에이전트로 9.2 의 2~4 를 손으로 한 번 돌리고 로그를 `data/phase1-live-*.log` 에 남긴다. 모델 런 상한은 브리프에서 정한다(예: 8회). 원격 Gateway 실연은 사용자가 플러그인을 올린 뒤 같은 스크립트로.

### 9.4 완료 기준

9.2 시나리오 1~8 통과, 9.3 실연 로그, `pnpm test/typecheck/lint/fmt:check` 통과, `.env.example` 갱신, 구성 가이드 2.2·4장 갱신.

## 10. 열린 질문·후속

1. 원격 Gateway 공유 토큰이 `operator.admin` 을 주는가 — 구현 계획 첫 작업에서 실측. 안 주면 계획서 #15 폴백(키 회전) 결정.
2. `chat.history` 의 `inFlightRun` 실물(ADR 0003 9절 6) — 재접속 복구에서 「다시 붙이기」가 실제로 되는지는 실연에서 본다.
3. 서버 직렬화 vs OpenClaw `followup` 큐 — 직렬화가 응답 지연을 늘리면 Phase 2 에서 `queueMode` 재검토. 직렬화 덕에 플러그인 ack 는 `onAgentRunStart` 직후(수백 ms)에 오지만, 코어가 런을 띄우지 않고 `dispatch()` 만 오래 끄는 경우 ack 가 서버 타임아웃(10s)과 부딪힐 수 있다(phase1-prep 보고 걱정 2) — 실연에서 ack 지연을 잰다.
4. Better Auth 1.7 의 정확한 서버 API·Fastify 마운트 방식·세션 토큰을 wire 에 쓰는 방법 — 구현 계획에서 문서로 확인하고 태스크에 적는다.
5. `basePrompt` 를 어디에 쓸지(OpenClaw 에이전트 프롬프트는 건드리지 않기로 해 MVP 미사용).

## 11. 참고

- 계약 스펙: `docs/superpowers/specs/2026-09-14-shared-contracts-design.md`
- 구성 가이드 2.2·2.3·4장: `docs/project-structure.md`
- ADR 0001(Gateway 프로토콜 실물), 0002(플러그인·브리지), 0003(채널 프롬프트·재접속 복구·대체 경로)
- Better Auth: https://www.better-auth.com/docs · Fastify: https://fastify.dev · Socket.IO: https://socket.io/docs/v4/
