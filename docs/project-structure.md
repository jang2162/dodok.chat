# 프로젝트 구성 가이드 (Claude Code 인계용)

작성일: 2026-09-14 · 계획서 v0.17 기준(2026-09-25 갱신: Phase 3 ④ 문서화) · 이 문서는 "어떻게 구성할지"만 다룬다. 배경·결정 근거는 `docs/plan.md` 참고.

---

## 1. 저장소 구조 (pnpm workspaces + Turborepo)

```
dodok.chat/
├─ apps/
│  ├─ web/                    # @dodok/web — React 19 + Vite PWA(서비스 워커 src/sw.ts — Phase 2 ④)
│  └─ server/                 # @dodok/server — Node 24 + Fastify + Socket.IO (+ 플러그인 브리지 엔드포인트)
├─ packages/
│  ├─ shared/                 # @dodok/shared — 도메인 타입·Zod 스키마·components v1 규약·RunEvent(AG-UI 매핑)·wire 계약
│  ├─ openclaw-plugin/        # @dodok/openclaw-plugin — OpenClaw 채널 플러그인 (원격 Gateway 안에서 실행)
│  ├─ openclaw-adapter/       # @dodok/openclaw-adapter — 서버 측 OpenClaw 어댑터 (브리지 서버 + Gateway WS 클라이언트)
│  ├─ runner-adapter/         # @dodok/runner-adapter — 서버 측 Claude 러너 어댑터 (/runner 네임스페이스·러너 연결·승인 기한·AgentAdapter 구현)
│  └─ claude-runner/          # @dodok/claude-runner — 사람의 머신에서 도는 러너 CLI dodok-runner (Claude Agent SDK, 설정·재접속·런·post 도구·승인·첨부)
├─ infra/                    # 배포(Docker Compose) — 절차 docs/guides/deploy.md, 각 파일의 까닭은 그 파일 머리 주석
│  ├─ compose.yml             # 운영: 서비스 app(서버, 포트 안 엶)·caddy(80·443), 볼륨 dodok-data·caddy-data·caddy-config. app 의 HOST·PORT·DATA_DIR·DODOK_MIGRATIONS_DIR·DODOK_PLUGIN_DIR(/app/plugin)·DODOK_RUNNER_DIR(/app/runner) 고정
│  ├─ compose.local.yml       # 이 Mac 의 로컬 검증 겹침: 127.0.0.1:8443·Caddy 내부 CA·devfake 프로필(dev:fake 를 Caddy 뒤에)
│  ├─ Dockerfile.server       # 단계 build(번들) → deploy(런타임 의존성 닫힘) · plugin(pack:plugin — 플러그인 tgz, openclaw devDependency 는 이 단계에만)
│  │                          # → runtime(운영, node:24.21.0-bookworm-slim, 비루트 — 번들·닫힘·마이그레이션·/app/plugin/*.tgz·/app/runner/*.tgz) · devfake(로컬 검증 전용)
│  ├─ Dockerfile.web          # 웹 빌드(ARG VITE_BUILD_ID) → caddy:2.11.4 에 dist 와 Caddyfile
│  ├─ Caddyfile               # 자동 HTTPS·/api·/socket.io·/bridge/*·/runner/*·/healthz 프록시, /assets immutable·나머지 no-cache·SPA 폴백, 보안 헤더·CSP(강제), 본문 32MB
│  ├─ check-caddy.sh          # Caddy 앞단 검사(curl — 라우팅·폴백·캐시·보안 헤더), `bash infra/check-caddy.sh https://localhost:8443`
│  ├─ local.env.example       # 로컬 검증 설정의 틀 — 사본 infra/local.env 는 git 제외
│  └─ .env → ../.env          # 배포 호스트에서 손으로 만드는 링크(git 제외) — compose 변수 치환이 infra/ 의 .env 만 읽는다
├─ docs/
│  ├─ plan.md                 # 계획서
│  ├─ project-structure.md    # 이 문서
│  ├─ guides/                 # 작업 지침 (worktree-workflow.md, browser-verification.md, live-smoke.md, deploy.md — 배포·백업·복원·업데이트,
│  │                          #   agent-guide.md — 에이전트가 채널에서 받는 것·릴레이·components·파일·승인과 AGENTS.md·채널 프롬프트에 붙여 넣을 블록)
│  ├─ superpowers/            # 스펙·구현계획 (specs/, plans/)
│  └─ adr/                    # 결정 기록 (스파이크 결과마다 한 장; 0001 = Gateway 클라이언트 스파이크)
├─ scripts/
│  ├─ orca-worker.sh          # Orca 워커 수명주기 (spawn/attach/wait/status/reap/stop/keep/sync-config)
│  └─ test/                   # 위 스크립트의 테스트 하네스 + Orca CLI 스텁
├─ .claude/
│  ├─ settings.json           # SessionStart·UserPromptSubmit 훅 등록
│  ├─ hooks/node-env.sh       # SessionStart: mise 가 핀한 Node·pnpm 을 Bash 도구 PATH 앞에 (비대화형 셸은 mise activate 훅이 안 돈다)
│  └─ hooks/orca-worker-check.sh   # 미정리 워커·워크트리 현황을 세션에 알림
├─ .worktrees/dodok.chat/     # Orca 워크트리 자리 — git 제외 (docs/guides/worktree-workflow.md)
├─ data/                      # 런타임 데이터 (SQLite, 첨부 블롭 attachments/, 디바이스 아이덴티티, VAPID 키 vapid.json) — git 제외
├─ README.md                  # 저장소 첫 화면 — 소개·구성 그림·빠른 시작(dev:fake / deploy.md 로)·문서 지도. 설치 단계는 옮겨 적지 않는다
├─ CLAUDE.md                  # 에이전트 지침 (정본)
├─ .mcp.json                  # 프로젝트 MCP — playwright-neo (BrowserOS neo 의 CDP 에 붙는 Playwright)
├─ .oxlintrc.json / .oxfmtrc.json
├─ .dockerignore             # 이미지 빌드 컨텍스트에서 빼는 것 — .env*·data·node_modules·dist·.worktrees·.superpowers·infra/*.env (패턴이 루트 기준이라 **/ 로 하위까지)
├─ mise.toml / .npmrc         # Node 24.21.0 · pnpm 11.16.0 핀(openclaw engines >=24.16 <25) · engine-strict
├─ package.json / pnpm-workspace.yaml / turbo.json
└─ .env.example
```

패키지 의존 방향: `web → shared`, `server → shared, openclaw-adapter, runner-adapter`, `openclaw-adapter → shared`, `runner-adapter → shared`, `openclaw-plugin → shared`, `claude-runner → shared`(번들에 넣는다 — devDependency) + `@anthropic-ai/claude-agent-sdk`(정확 핀, 번들에 넣지 않는다). `shared`는 아무것도 의존하지 않는다(브라우저·Node·Gateway 세 곳에서 다 로드되므로 Node 전용 API 금지).

OpenClaw 패키지 버전은 세 곳(`openclaw-adapter`의 `@openclaw/gateway-client`·`@openclaw/gateway-protocol`, `openclaw-plugin`의 `openclaw` devDependency) 모두 **배포 Gateway와 같은 버전으로 정확 핀**한다. 시작 버전 2026.9.4.

---

## 2. 패키지별 책임과 핵심 파일

### 2.1 `packages/shared`

```
src/
├─ common.ts      Id(UUIDv7)·IsoDateTime·ErrorCode·ApiError·Result/Ack·WIRE_PROTOCOL/BRIDGE_PROTOCOL — 아래 전부가 쓰는 바닥
├─ domain/        workspace, user, agent, channel, message, run, approval 타입 + Zod.
│                 `Message.interactions`(그 메시지 components 의 상호작용 기록, `MessageInteraction[]`, 최신 `INTERACTIONS_MAX`=20건,
│                 `.default([])` — 경계를 넘는 Message 에 늘 있다).
│                 Phase 4 ① 스레드: `Message.threadRootId?`(답글이면 그 루트 — 루트만 가리킨다)·루트의 `threadSummary?`(`ThreadSummary` { count, lastAt, agentIds ≤10 } — 답글이 있을 때만),
│                 `Run.threadRootId?`·`RunState` 의 `threadRootId`(스레드 런이면 그 루트 — queued 동안에도 소속을 안다, 채널 런은 없다)
├─ components/    components v1 스키마 (blocks/actions/button/select/modal/media/file) + 제약 검증 — Phase 2 ② 는 이 파일을 안 바꿨다
├─ events/        RunEvent 유니온 (AG-UI 이벤트명 채택: TEXT_MESSAGE_START/CONTENT/END,
│                 TOOL_CALL_START/ARGS/END, RUN_STARTED/FINISHED/ERROR, STATE_SNAPSHOT, CUSTOM)
├─ wire/          클라이언트↔서버 Socket.IO 이벤트 계약 (server→client, client→server 타입 맵).
│                 승인: client→server `approval.resolve`, server→client `approval.requested`·`approval.resolved`,
│                 구독 ack 의 `pendingApprovals`(그 채널의 **미해결**만). 스레드: `MessageSend.threadRootId?`, 구독 ack 의 `threadRoots?`
│                 (lastSeq 재동기화 때만 — 페이지의 답글이 가리키는데 페이지에 없는 옛 루트, 최신 요약)
├─ bridge/        플러그인↔서버 브리지 메시지 계약 (인바운드 전달, 아웃바운드 수신, 컴포넌트 결과, 설정 변경, 헬스).
│                 `BridgeHello.bundleSha256`(선택, sha256 hex) — 플러그인이 자기 번들 파일을 해시해 싣는다(없으면 서버는 「빌드를 알 수 없습니다」).
│                 `BridgeHello.capabilities` 는 아는 값만 남기고 모르는 값은 버린다(닫힌 enum 이면 옛 서버가 새 플러그인 hello 를 통째로 거절한다).
│                 스레드: `BridgeCapability "threads"`, `InboundDeliver.threadId?`·`context.thread?`({ root, recentMessages }), `OutboundMessage.threadId?`,
│                 `threadMatchesSessionKey`(threadId 와 세션 키의 스레드 접미사 대조 — 우리 모양이 아닌 키면 false)
├─ setup/         Phase 3 ②. 설정 마법사 계약 — Sha256Hex·SetupStatus(server·bridge{publicUrl}·pluginFile·gateways: GatewaySetup[]·runners)·
│                 GatewaySetup(id·name·url·enabled·gateway{state(+disabled),host,version,pinned,drift,pairing}·bridge{state,plugin}·pluginMatches — 공유 토큰 없음)·
│                 BridgeTokenRecord(원문·해시 없음, prefix 6자, connected)·IssueBridgeTokenInput(라벨 trim 1~60)·
│                 IssueBridgeTokenResult(token `dbt_` + 43자 — 원문은 여기에만, record, pluginConfig). wire server→client `setup.status`({ status })는 `wire/` 에
├─ gateways/      멀티 Gateway. Gateway API 계약 — CreateGatewayBody(name trim 1~32·url `ws://`·`wss://` 만·token)·UpdateGatewayBody(모두 선택, 빈 token 은 「바꾸지 않음」)·
│                 GatewaySummary(공유 토큰 대신 `tokenSet: true`, ownerUserId — v1 은 null)·DeleteGatewayResult{unboundAgents,deletedTokens}
├─ ops/           Phase 3 ③. 운영 계약 — OpsEventKind(14종 — 팀의 invite_accept_failed·member_remove_failed 포함)·OpsSeverity(info·warn·error)·OpsEvent(detail 은 평평한 원시값만 — id·코드·수치, key 1~200자)·OpsUnacked{warn,error}·
│                 OpsEventsPage·OpsSettingsPatch(dailyRunLimit 1~10000 또는 null)·`OPS_DEFAULT_DAILY_RUN_LIMIT`=300·OpsAckResult·OpsStatus(서버·DB·디스크·Gateway{pinned,drift}·
│                 플러그인·adapter·오늘 런 수·상한·blockedToday·unacked·workspaceId)·OpsRunsRow·OpsRunsSummary(usageTrusted 가 false 면 행에 tokens·costUsd 가 없다).
│                 wire server→client `ops.event`({ event, unacked } — owner·admin 만)는 `wire/` 에, SystemKind `run_limit`·SystemMeta.limit{scope,limit} 은 `domain/` 에,
│                 ErrorCode `RATE_LIMITED`·`RUN_LIMIT`·`INSUFFICIENT_STORAGE` 는 `common.ts` 에
├─ push/          Phase 2 ④. PushSubscriptionInput(https endpoint ≤2048·base64url 키)·PushUnsubscribeInput·PushPayload
│                 ({ kind: mention|approval|relay_limit, channelId, title ≤80, body ≤200, url(`/c/<uuid>`·`/c/<uuid>/activity`·`/c/<uuid>/t/<uuid>`), tag ≤80 } — 서비스 워커가 경계에서 파싱한다).
│                 wire 쪽 `presence.update`(`PresenceUpdate` { visible, channelId? }, ack 없음)는 `wire/` 의 Typing 옆에 있다
├─ search/        Phase 4 ①. `GET /api/v1/search` 계약 — SearchQuery(q 2~200 코드 포인트·채널·작성자·기간·커서)·SearchHit(messageId·channelId·**seq**(결과로 가기가
│                 `?around=` 로 받는다)·threadRootId?·작성자·createdAt·snippet ≤400)·SearchResult(hits·nextCursor?·limited — 2글자 경로)·
│                 스니펫 표시 문자 `SEARCH_SNIPPET_OPEN`/`CLOSE`(STX·ETX — 서버는 HTML 을 만들지 않는다)
├─ members/       Phase 4 ② 팀. TeamRole(owner·admin·member — guest 는 없다)·roleAtLeast(owner > admin > member, 모르는 값은 false)·Password(12~256자)·DisplayName(trim 1~64)·
│                 InviteKind(invite·reset)·Invite(원문·해시 없음, prefix)·IssueInviteBody·IssuedInvite({ invite, token, url } — 원문은 여기에만)·TokenBody·InviteLookup·
│                 AcceptInviteBody·ResetPasswordBody·LocalLoginBody(`{ token }` 또는 `{ email, password }`)·Person(사람 목록 한 줄 — 나간 멤버는 role 없음·leftHandle)·
│                 MemberRow(+ email·role)·UpdateMemberRoleBody(admin·member)·UpdateMeBody·ChangePasswordBody. wire server→client `people.changed`({ people })는 `wire/` 에,
│                 `User.leftHandle?`(나간 멤버의 옛 핸들)은 `domain/` 에
├─ session-key.ts Phase 4 ①. 세션 키를 만들고 푸는 **유일한** 자리(서버·어댑터·플러그인이 따로 조립·정규식을 두지 않는다 — 두면 모양이 조용히 갈라진다).
│                 `dodokSessionKey(agentId, channelId, rootId?)` → `agent:<agentId>:dodok:channel:<channelId>[:thread:<rootId>]`(channelId·rootId 소문자 —
│                 코어가 dodok 키를 통째로 소문자로 접는다, agentId 가 규칙 밖이거나 rootId 가 빈 문자열이면 던진다) · `parseDodokSessionKey`(우리 모양이 아니면 undefined) ·
│                 `isOpenClawAgentId`(OpenClaw 규칙 `[a-z0-9][a-z0-9_-]{0,63}`, 대소문자 무시 — 빌더가 쓰는 규칙) ·
│                 `isRegistrableAgentId`(그 규칙 ∧ 소문자 — 에이전트 등록 경계. 이미 저장된 대문자 행은 빌더가 그대로 받는다)
└─ mention.ts     @멘션 파싱 (사람/에이전트 별칭 → id), 릴레이 감지에 공용
test/agent-guide-examples.test.ts   docs/guides/agent-guide.md 의 `json dodok-components`·`-invalid`·`json dodok-message` 코드 블록을 뽑아 ComponentsV1 로 파싱
                 (유효는 통과·틀린 예는 실패·종류마다 최소 개수). shared 에 Node 타입이 없어 문서는 Vite `?raw` 동적 import 로 읽는다
```

규칙: 여기의 Zod 스키마가 단일 진실. 서버 입력 검증·클라이언트 폼·플러그인 아웃바운드 검증·브리지 양단 검증이 전부 같은 스키마를 import한다. 브리지 계약이 `shared`에 있는 이유는 플러그인과 서버가 서로 다른 프로세스·호스트에서 같은 메시지를 파싱하기 때문이다.

- `src/adapter/` — 어댑터 계약 `AgentAdapter`·`AdapterEvent`·`AdapterError`·`AdapterStatus`(provider 판별 유니온)·`ProviderApproval`, 인증 실패 가드 `BridgeAuthGuard`(`guard.ts` — 브리지·러너 핸드셰이크와 두 첨부 HTTP 가 한 카운터). 두 어댑터 패키지와 서버가 여기서 가져간다.
- `src/runner/` — `/runner` 프레임 Zod(`index.ts` — `RunnerHello`·`RunnerRunStart`·`RunnerRunFinal`·`RunnerOutboundPost`·승인 프레임, `RUNNER_PROTOCOL`·`RUNNER_ATTACHMENTS_PATH`)와 러너 프롬프트 문장(`prompt.ts` — 채널 규칙 틀 `buildChannelRulesAppend`, 턴 사실 `buildTurnFacts`, 사용자 메시지 `renderRunnerPrompt`).

### 2.2 `apps/server`

Phase 1 ① 서버 코어 실물(스펙 `docs/superpowers/specs/2026-09-15-server-core-design.md`, 계획 `docs/superpowers/plans/2026-09-15-server-core.md`)에
Phase 2 ① 승인(스펙 `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`)과 Phase 2 ② 상호작용 기록 하이드레이션
(스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md` 4장), Phase 2 ③ 첨부(스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md`, 구현과 달라진 것은 11장),
Phase 2 ④ 웹 푸시(스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`, 구현과 달라진 것은 11장)가 얹혔고,
Phase 3 ① 배포 패키징(스펙 `docs/superpowers/specs/2026-09-24-deploy-packaging-design.md`, 구현과 달라진 것은 12장)이 운영 번들·백업을,
Phase 3 ② 설정 마법사(스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`, 구현과 달라진 것은 스펙 「구현과 맞춘 것」 장)가 연결 점검·브리지 토큰(DB)·플러그인 파일 내려받기를,
Phase 3 ③ 운영 보강(스펙 `docs/superpowers/specs/2026-09-25-ops-hardening-design.md`, 구현과 달라진 것은 스펙 「구현과 맞춘 것」 장)이 런 수 상한·레이트리밋·운영 사건·운영 API 를,
Phase 4 ① 스레드·검색(스펙 `docs/superpowers/specs/2026-09-25-threads-search-design.md`, 구현과 달라진 것은 스펙 「구현과 맞춘 것」 장)이 스레드 하위 세션·스코프 조회·around·전문 검색을 더했다.
한 프로세스 안에 REST·wire·브리지·어댑터가 같이 뜬다. 첨부 바이트는 브리지와 같은 오리진의 HTTP(`/bridge/attachments`)로 오간다.

```
src/
├─ main.ts                프로세스 진입점: 소스 실행이면 cwd 를 저장소 루트로 옮기고 루트 .env 로드(이미 있는 env 는 덮지 않음 — 운영 번들은 둘 다 안 한다) →
│                         DATA_DIR 쓰기 검사(못 쓰면 한 줄 설정 오류로 exit 1) → createApp → 종료 표지 startRunState(`<DATA_DIR>/run-state.json`) → app.setPreviousClean →
│                         installProcessHandlers → listen
├─ process-handlers.ts    installProcessHandlers: SIGINT/SIGTERM → close → 표지 clean → exit 0(close 가 PROCESS_EXIT_TIMEOUT_MS 10s 를 넘으면 exit 1, 두 번째 신호는 다시 안 닫음) ·
│                         unhandledRejection → error 로그 + 사건 crash_rejection, 계속 돈다 · uncaughtException → 사건 crash_exception 을 close **전에** 동기로 → close → exit 1(표지는 clean:false 그대로).
│                         listen 실패(포트 충돌)도 Node 24 ESM 에서는 uncaughtException 으로 와 같은 길이다
├─ runtime.ts             실행 모드: isBundled(esbuild define __DODOK_BUNDLED__)·migrationsFolder(DODOK_MIGRATIONS_DIR, 없으면 apps/server/drizzle)·
│                         unwritableDataPath·dataDirErrorMessage(비루트 컨테이너 + 다른 UID 볼륨 → chown 명령이 든 한 줄)
├─ backup.ts              runBackup: 온라인 백업을 한 번에 전부 복사(읽기 트랜잭션 스냅숏) → <DATA_DIR>/backups/.partial-* 에서 만들고 rename,
│                         vapid.json·디바이스 아이덴티티 사본(0600), 보관 개수(기본 7, 백업 이름 형식만 센다), 1시간 넘은 .partial-* 정리
├─ backup-main.ts         백업 CLI(번들 dist/backup.js — `docker compose -f infra/compose.yml exec app node dist/backup.js [--keep N]`), 한 줄 출력·실패 exit 1, SIGINT·SIGTERM 에 자기 .partial-* 삭제(복사 도중의 신호는 복사가 끝난 뒤 완료·exit 0)
├─ app.ts                 createApp: 부팅 순서(DB → 워크스페이스 → 인증·owner → Fastify → Socket.IO → 어댑터 → 서비스 → 라우트 → wire → 부팅 정리 → adapter.connect),
│                         종료 순서(새 wire 거부 → 푸시 트리거 떼기 → 오케스트레이터 stop → adapter.close → io.close → Fastify → 진행 중 푸시 발송 최대 2s(PUSH_DRAIN_TIMEOUT_MS) → DB, 10s 상한),
│                         /healthz(`{ok, db}` 뿐 — 워크스페이스 id·어댑터 상세는 ops/status), Gateway 재접속 60s 알림.
│                         운영(Phase 3 ③): ops 서비스·부팅 sweep + 24시간마다(OPS_SWEEP_INTERVAL_MS), 레이트리밋(`AppDeps.limits`·`limitClock` — 기본 LIMITS·단조 시계)과 REST 상한 데코레이션
│                         `restLimits`, 브리지 실패 카운터 BridgeAuthGuard 하나(브리지·러너 핸드셰이크·`/bridge/attachments`·`/runner/attachments` — 사건 bridge_auth_blocked 의 detail.path 로 가른다), 감시 다섯(watchConnections·watchRunners·watchGatewayVersion·watchRunFailures·
│                         createDiskMonitor — `await disk.ready` 로 부팅이 끝나면 첫 측정이 있다, `App.disk()`·`checkDisk()`)는 종료 때 `"ops"` 단계 **전에** 닫는다.
│                         테스트·dev:fake 입력: `AppDeps.statfs`·`disconnectEventMs`·`gatewayBackoff`. VAPID 키를 읽고(주체가 로컬 자리값이면 warn 한 줄) 발송기(`AppDeps.pushSend`, 없으면 webPushSender)를 배선한다.
│                         브리지 검증 함수(verifyBridgeTokenDb — 토큰 id 와 그 토큰의 Gateway, 어댑터 핸드셰이크와 `/bridge/attachments` 가 같이 쓴다),
│                         부팅 때 DB 의 Gateway 를 모두 어댑터에 넣음(bootGateways — 꺼진 것도 `enabled: false`, 0개여도 뜬다), 부팅 때 한 번 readPluginFile,
│                         setup 상태 조립(Gateway 행 + 어댑터 gatewaySetupDetails)·`setup.status` 발행
├─ config.ts              env 를 zod 로 검증한 ServerConfig. OpenClaw Gateway 는 env 가 아니라 DB(`modules/gateways/`)
├─ logger.ts              pino, 토큰·비밀 키 redact(VAPID_PRIVATE_KEY·privateKey 포함, 깊이 0~3 의 token·`set-cookie` — 새 토큰 헤더를 만들면 이름을 이 파일에 적는다:
│                         redact 는 헤더 이름 와일드카드를 받지 못한다). 사건 줄은 `event: "ops.<kind>"`(modules/ops/service.ts).
│                         requestLogSerializer — Fastify 요청 로그의 req(원격 주소만 ipPrefix 로 가림, app.ts 가 Fastify 에 준 자식 로거의 serializers.req — Fastify 기본을 이긴다).
│                         브리지·러너 거절 로그도 app.ts 가 어댑터 옵션 logAddress 로 ipPrefix 를 준다(가드·스로틀 키는 전체 주소)
├─ wiring.ts              createServices(라우터 ⇄ 오케스트레이터 상호 참조, RunsFacade), sessionRecoverTargets(재접속 복구 대상 — 연결 id 별 Map, OpenClaw 에이전트 세션만)
├─ db/
│  ├─ schema.sqlite.ts    Drizzle 스키마 (계획서 6장 테이블 + agent_sessions + approvals + attachments + bridge_tokens + ops_events + invites + runner_tokens + gateways — 마이그레이션 0000~0014,
│  │                      FK ON DELETE 는 push_subscriptions.session_id·bridge_tokens.gateway_id(cascade)와 agents.gateway_id·attachments.gateway_id(set null)뿐).
│  │                      ⚠ drizzle-kit 은 기존 표에 FK 열을 더하는 `ALTER TABLE … ADD … REFERENCES` 에서 스냅숏의 ON DELETE 를 빠뜨린다 — SQLite 가 받아도 조용히 다르게 동작하므로,
│  │                      FK 열을 더하면 생성 SQL 의 ON DELETE 를 스냅숏과 대조하고 다르면 그 줄만 손으로 고친 뒤(SQLite 가 ALTER 를 받지 않으면 표를 다시 만든다) 머리 주석에
│  │                      까닭을 적는다. 스냅숏은 생성기 출력 그대로 두고 다음 generate 가 「No schema changes」인지 본다(0010·0012·0014).
│  │                      스레드(0006): messages.thread_root_id(인덱스 messages_channel_thread_seq (channel_id, thread_root_id, seq))·agent_sessions.thread_root_id·runs.thread_root_id —
│  │                      세 열 모두 FK 없음(저장 경로 검증이 지킨다). agent_sessions 의 유일 제약은 **부분 유일 인덱스 둘** — 스레드 행 agent_sessions_channel_agent_thread
│  │                      (channel_id, agent_id, thread_root_id), 채널 행 agent_sessions_channel_session (channel_id, agent_id) WHERE thread_root_id IS NULL(coalesce 표현식 인덱스는
│  │                      drizzle-kit 이 SQL 을 깨뜨려 생성한다). 그래서 채널 세션 upsert 는 `targetWhere: thread_root_id IS NULL` 이 있어야 그 인덱스를 고른다.
│  │                      검색(0007, 커스텀): FTS5 `messages_fts(body, attachment_names)` contentless(`contentless_delete=1`), `trigram case_sensitive 0`, rowid = messages 의 암묵 rowid,
│  │                      kind normal 만 — 트리거 셋(`_ai`·`_ad`·`_au` — 수정은 `UPDATE OF body_md, attachments_json, kind`)과 백필.
│  │                      ⚠ **`messages` 를 다시 만드는 마이그레이션(drizzle 의 `__new_messages` 복사 → DROP → RENAME)을 내면 트리거가 사라지고 rowid 가 새로 매겨진다** —
│  │                      오류 없이 검색만 낡는다(지운 말로 다른 메시지가 찾힌다). 그 뒤에 `0007_search_fts.sql` 의 트리거 셋과 백필을 새 커스텀 마이그레이션으로 다시 넣는다.
│  │                      가드: `test/search.service.test.ts` 의 백필 테스트(모든 마이그레이션 뒤 트리거 셋 존재·남은 행마다 제 id 로만 찾힘)가 빨갛게 된다.
│  │                      `VACUUM` 도 text PK 테이블의 rowid 를 바꿀 수 있다(SQLite 문서 — 번들 SQLite 에서는 보존됐다) — 운영자가 돌렸다면 `0007_search_fts.sql` 의 백필(`DELETE FROM messages_fts` 뒤 `INSERT … SELECT`)을 다시 한다.
│  │                      bridge_tokens: id·workspace_id·label·hash(sha256 hex, 유일)·prefix·created_at·last_used_at·revoked_at·gateway_id — 원문 없음.
│  │                      멀티 Gateway(0012): gateways — id(= 어댑터 계약의 연결 id)·workspace_id·name(유일 gateways_ws_name)·url·token(Gateway 공유 토큰 평문 — API·로그·wire 에 싣지 않는다)·
│  │                      enabled·owner_user_id·last_version·created_at·updated_at. agents.gateway_id(OpenClaw 에이전트의 Gateway, null 이면 연결이 빈 에이전트)·
│  │                      runs.connection_id·approvals.connection_id(그 런·승인의 연결 — 공유 Run·Approval 에 싣지 않고 store 의 getRunConnectionId·getApprovalConnectionId 로 읽는다).
│  │                      유일: OpenClaw 에이전트 agents_openclaw_gateway_agent (gateway_id, provider_agent_id) · 러너 에이전트 agents_claude_ws_agent (workspace_id, provider, provider_agent_id) ·
│  │                      runs_connection_provider_run (connection_id, provider_run_id) · approvals_connection_provider (connection_id, provider_approval_id) — 제공자 id 는 연결 안에서만 유일하다.
│  │                      attachments.gateway_id(0014 — 플러그인이 올린 첨부의 Gateway. 그 Gateway 만 읽고 정본에 묶는다, Gateway 를 지우면 비어 아무도 묶지 못한다 — 러너 정본은 uploader_id 가 자기 러너 토큰인 것만 묶는다).
│  │                      `drizzle/0012_multi_gateway.sql`·`0014_attachment_gateway.sql` 의 `ADD gateway_id … REFERENCES` 줄은 ON DELETE 를 손으로 붙였다(생성기가 빠뜨린다 — 그 파일 머리 주석).
│  │                      팀(0008): invites — id·workspace_id·kind(invite·reset)·role(invite 만)·target_user_id(reset 만)·token_hash(sha256 hex, 유일 invites_token_hash)·prefix·
│  │                      created_by·created_at·expires_at·used_at·used_by(FK 없음)·revoked_at — 원문 없음, 유효 = used_at·revoked_at 이 비고 만료 전. users.left_handle(나간 멤버의 옛 핸들 —
│  │                      그 행의 handle 은 `left-<id 뒤 27자>`, email 은 NULL), 유일 인덱스 users_ws_email (workspace_id, email)(NULL 여럿 허용 — 이메일은 넣기 전에 소문자로).
│  │                      직전 마이그레이션까지 적용된 DB 를 만드는 테스트는 행을 **SQL 로** 넣는다 — drizzle 스키마 객체는 뒤 마이그레이션의 열(`left_handle` 등)까지 INSERT 에 싣는다.
│  │                      ops_events(0005): id·workspace_id·kind·severity·key·detail_json·count·first_at·last_at·resolved_at(끊김 사건)·acked_at, 인덱스 ops_events_ws_last(workspace_id, last_at)·
│  │                      ops_events_open(workspace_id, kind, key, acked_at). workspaces.ops_json(0005, text 기본 `'{}'`) — { dailyRunLimit?: number | null }(Gateway 버전 기억은 gateways.last_version),
│  │                      키가 없으면 상한 300, null 이면 무제한(json 모드가 아닌 까닭: 망가진 값을 {} 로 읽고 warn 하려고)
│  │                      push_subscriptions(0010): session_id(구독을 등록한 Better Auth 세션, NOT NULL, FK ON DELETE CASCADE, 인덱스 push_subscriptions_session) —
│  │                      세션 행을 지우는 모든 자리(로그아웃·비밀번호 변경·재설정·내보내기·owner 토큰 교체·만료 청소)가 구독도 지운다. 0010 은 표를 다시 만들고 옛 행(세션 모름)을 버린다 —
│  │                      웹이 앱을 열 때 다시 등록한다(`drizzle/0010_push_session.sql` 은 손으로 쓴 SQL — 생성기의 ALTER 는 SQLite 가 받지 않는다. 까닭은 그 파일 머리 주석).
│  ├─ auth-schema.ts      Better Auth 테이블
│  ├─ client.ts           createDb: better-sqlite3 연결(WAL) → assertTrigramSupport → 마이그레이션(runtime.migrationsFolder — 운영 번들은 DODOK_MIGRATIONS_DIR 가 없으면 설정 오류)
│  └─ fts.ts              assertTrigramSupport(sqlite) — temp 탐침 테이블로 FTS5 trigram 을 확인, 없으면 한 줄 오류(cause 보존). 마이그레이션 **전**이어야 한다 —
│                         뒤면 0007 이 여러 줄 drizzle 오류로 먼저 죽는다
├─ auth/
│  ├─ index.ts            Better Auth(이메일 로그인·가입·비밀번호 변경·세션 폐기·로그아웃 HTTP 경로 비활성 — disabledPaths, routes.ts 허용 목록 밑의 겹 방어), 세션 토큰 검증(userId·sessionId)
│  ├─ owner.ts            부팅 때 owner 보장 — LOCAL_AUTH_TOKEN 이 owner 비밀번호, 바뀌면 기존 세션을 끊는다
│  ├─ roles.ts            Phase 4 ② 팀. 역할 검사의 유일한 자리(매트릭스의 정본은 팀 스펙 「역할과 권한」 절 표) — requireSession(세션 + membership, 없거나 모르는 역할이면 401,
│  │                      `request.user` = { id, workspaceId, role, sessionId })·requireRole(ctx, min — 요청마다 membership 을 읽는다, 모자라면 403 FORBIDDEN)·assertRole(핸들러 안에서 다시 읽기)·
│  │                      roleOf·sessionUser·sessionTokenOf · 본문 필드로 가르는 목록 둘 MEMBER_EDITABLE_CHANNEL_FIELDS(name·topic — `POST`·`PATCH /channels`)·
│  │                      MEMBER_EDITABLE_AGENT_MEMBER_FIELDS(memberType·memberId·aliases — 채널 멤버 `POST`·`PATCH`)과 hasFieldOutside(원문 본문 키 — 목록 밖이 하나라도 있으면 admin, 새 필드의 기본은 admin).
│  │                      requireSession 이 여기 있는 까닭: routes.ts 와 나누면 서로를 import 한다
│  └─ routes.ts           POST /api/v1/auth/local(`{ token }` = owner, `{ email, password }` = 멤버 — 이메일은 소문자로, `OWNER_EMAIL` 이메일 로그인·membership 없는 사용자는 같은 401 한 문구, IP 당 분당 LIMITS.localLoginPerMin)·GET me(role 포함)·POST logout(세션 행을 지우고 disconnectSessions 로 그 세션 소켓을 끊는다),
│                         `/api/auth/*`(Better Auth, LIMITS.betterAuthPerMin) — 넘으면 429 + 사건 ratelimit, 허용 목록 BETTER_AUTH_HTTP_PATHS(`/ok`)만 통과하고 나머지는 404,
│                         requireOwner(= roles.ts 의 requireRole(ctx, "owner")) · requireSession·sessionUser 는 roles.ts 에서 다시 내보낸다(Bearer 또는 dodok.session 쿠키 — 사용자를 확인한 뒤 REST 상한 `request.server.restLimits` 를 센다),
│                         createIpLimit — 로그인(`/auth/local`·`me/password`)·초대 경로(lookup·accept·reset)가 하나씩
├─ http/
│  ├─ errors.ts           HttpError·apiError — ApiError { code, message, details? } ↔ HTTP 상태
│  └─ validate.ts         경계 Zod 파싱(body·query·params·wire payload·저장값)
├─ modules/
│  ├─ attachments/        Phase 2 ③. 첨부의 정본 — 디스크 블롭(`<ATTACHMENTS_DIR>/<sha 앞 2자>/<sha256>`, 같은 내용은 한 번) + attachments 행, 경계를 넘는 꼴은 `artifact://<id>`.
│  │                      sniff.ts(순수: 매직 바이트 → kind·mime, 이미지면 image-size 로 가로·세로 — EXIF 회전 5~8 은 바꿔서, 못 읽으면 file. SVG 는 늘 file) ·
│  │                      store.ts(sha256·블롭 쓰기(임시 파일 → rename)·지우기, sha 별 잠금 BlobLocks — 업로드와 정리가 같은 잠금을 지난다) ·
│  │                      service.ts(올리기(사람 이미지 5 MB·브리지 파일 20 MiB)·잡기 claimUser/claimBridge·묶기·읽기 권한 findReadable·정리 sweepAttachments —
│  │                      24시간 넘은 미묶음 행, 행 없는 블롭, 1시간 넘은 .tmp) ·
│  │                      routes.ts(`POST`·`GET /api/v1/attachments`(세션), `POST`·`GET /bridge/attachments`(브리지 토큰) — 원시 바이트 본문, 인증은 onRequest,
│  │                      GET 은 블롭을 먼저 열어 없으면 404, nosniff·CSP sandbox·immutable, Content-Disposition 은 RFC 5987).
│  │                      브리지 범위(멀티 Gateway 스펙 6.4): 브리지 토큰의 Gateway 가 올린 것과 그 Gateway 에서 열린 런(runs.connection_id)의 트리거 첨부만 읽고(범위 밖은 404),
│  │                      정본에 묶는 것(claimBridgeAttachments)도 그 Gateway 가 올린 것만 — 러너 정본은 자기 러너 토큰이 올린 것만 묶는다.
│  │                      꺼진 Gateway 의 브리지 토큰은 핸드셰이크와 같게 401(acceptBridgeGateway — 실패 카운터에 세지 않는다)
│  │                      정리 타이머 startAttachmentSweeper 는 app.ts 에 있다(부팅 때 한 번, 그 뒤 1시간마다, 닫을 때 진행 중인 정리를 기다린다)
│  ├─ approvals/          store.ts(approvals 테이블 — (연결, providerApprovalId) 유일 upsert, 중복은 병합 후 재발행, 채널 미해결 목록),
│  │                      service.ts(상관 — 승인이 온 연결의 에이전트·findOpenRunBySession(연결, 세션 키) → 저장 → APPROVAL_REQUESTED/RESOLVED 런 이벤트 → 버스,
│  │                      resolve 는 승인 설계 4.4 의 문지기 검사 뒤 승인이 온 연결로 어댑터 RPC).
│  │                      REST 라우트는 없다 — 요구·확정은 wire 로만 오간다
│  ├─ channels/           CRUD·멤버(에이전트 promptOverride·autoRespond·aliases, 사람은 membership 이 있는 사람만 — 나간 사람 404)·프롬프트 리비전(역할: 만들기·`PATCH` 는 name·topic 밖 필드면 admin, 채널 멤버는 aliases 밖 필드면 admin, 「새 대화」는 admin — auth/roles.ts),
│  │                      사람의 자동 참여 joinChannelIfAbsent·사람 메시지의 멘션 후보 userMessageParticipants(채널 밖의 워크스페이스 사람 + 채널 참가자)·에이전트 헤더의 channelParticipants,
│  │                      채널 프롬프트 동기화 prompt-sync.ts(OpenClaw config.set — 바꿀 때 그 채널 에이전트의 켜진 Gateway 마다, 에이전트를 넣거나 옮겨 Gateway 가 채널에 처음 들어올 때 그 Gateway 에,
│  │                      플러그인 hello 때 그 Gateway 의 채널들을 다시 — watchPluginHellos, app.ts 가 건다), 「새 대화」(resetAgentSession —
│  │                      `POST …/agents/:agentId/reset?threadRootId=` 면 그 스레드 세션만 reset·그 스레드 런만 abort, info 도 스레드에. 루트가 아니면 404, UUID 가 아니면 400)
│  ├─ agents/             에이전트 등록·수정(admin 이상, 핸들은 members/handles.ts 의 assertHandleFree), GET /agents/discover(Gateway agents.list, admin 이상). 등록은 providerAgentId 를 shared `isRegistrableAgentId`(소문자)로 400 VALIDATION,
│  │                      OpenClaw 는 등록·찾기 모두 gatewayId 필수(워크스페이스의 Gateway 가 아니면 400, 찾기는 꺼진 Gateway 면 ADAPTER_UNAVAILABLE), 같은 Gateway 에 같은 id 면 409.
│  │                      `PUT /agents/:id/gateway`(owner) — 다른 Gateway 로 옮기기(대상에 같은 id 409, 러너 에이전트 400). 응답 Agent 에 OpenClaw 면 gateway({id,name} 또는 null),
│  │                      조회는 `providerAgentIdIs`(lower() 비교 — 승인 findAgentId·런 없는 정본 agentIdFor 가 같이 쓴다: 코어가 세션 키를 소문자로 접는다)
│  ├─ messages/           seq 발급(seq.ts)·사람/에이전트/시스템 메시지 저장·bus 통지·히스토리 페이징. 저장과 같은 트랜잭션에서 첨부를 묶는다
│  │                      (사람 메시지는 같은 트랜잭션에서 쓴 사람·멘션된 사람을 채널에 참여시키고 커밋 뒤 `channel.member.changed` 한 번 — 에이전트 메시지는 아무도 참여시키지 않는다)
│  │                      (사람: 틀린 id 가 하나라도 있으면 VALIDATION, clientMsgId 재전송은 잡기보다 먼저 확인 / 에이전트: 틀린 id 만 빼고 경고).
│  │                      withInteractions(db, msgs): components 가 있는 메시지에만 component_interactions 를 한 번에 읽어
│  │                      `interactions`(createdAt·id 오름차순, 최신 20건)를 싣는다 — 그런 메시지가 없으면 질의하지 않는다.
│  │                      클라이언트가 볼 Message 만 거친다: listMessages(REST `GET /channels/:id/messages`·구독 ack)와 wire 팬아웃(realtime/events.ts).
│  │                      내부 getMessage·bus 페이로드는 거치지 않는다(components v1 스펙 11장 Ruling 1).
│  │                      스레드(Phase 4 ①): 저장 때 threadRootId 는 같은 채널의 루트만(답글·다른 채널·없음이면 VALIDATION — 답글을 루트로 바꾸지 않는다), 시스템 메시지도 가진다.
│  │                      답글이 저장되면 루트를 요약과 함께 `message.updated`. hydrateForClient = withInteractions + withThreadSummaries(요약은 한 번에 — 루트마다 질의하지 않는다).
│  │                      listMessages 의 `MessageScope` — 채널 경로는 루트만(`roots`), 스레드 경로 `GET /channels/:id/threads/:rootId/messages` 는 루트+답글
│  │                      ({ root, messages, hasMore[, hasMoreAfter] } — root 는 늘, 다른 워크스페이스·없는 id·답글·다른 채널 루트면 404). 두 경로 모두 `beforeSeq`·`afterSeq`·`limit` 과
│  │                      `?around=<seq>`(그 seq 이하에서 절반 올림·초과에서 나머지, hasMoreAfter — beforeSeq·afterSeq 와 함께면 400). 채널 경로의 around 가 답글 seq 면 그 루트를 가운데로.
│  │                      threadRootsOf — lastSeq 재동기화 때 페이지 밖 옛 루트를 질의 한 번으로(구독 ack `threadRoots`)
│  ├─ search/             Phase 4 ①. service.ts(searchMessages — 3글자 이상은 `messages_fts MATCH` 에 사용자 입력을 따옴표 구절 하나로, bm25 다음 최신순, 페이지 20·커서.
│  │                      2글자(코드 포인트)는 `body_md LIKE … ESCAPE '\'` 최근 90일·최대 50개, 커서 없이 `limited: true`. NUL 이 든 검색어는 400.
│  │                      워크스페이스의 모든 채널(`channels.visibility` 는 아직 거르지 않는다 — 비공개 채널이 생기면 `readableChannels` 와 별칭 표 `mentionDirectory` 가 함께 거른다), kind normal 만.
│  │                      검색어 안 `@핸들`(shared PLAIN_MENTION_RE)은 아는 에이전트·사람(나갔으면 옛 핸들)·범위 채널 별칭이면 멘션 토큰으로 바꾼 대체 검색어로도 찾는다 —
│  │                      색인은 원문 그대로, 원래 검색어(글자로 남은 `@핸들`)와 대체 검색어를 OR(합쳐 최대 8, 원래 검색어 몫은 늘 남긴다). 스니펫은 readable.ts 의 읽는 글(멘션 → @핸들,
│  │                      모르면 「@알 수 없음」, 마크다운 표시 걷음, 글자마다 원문 범위)에서 앞뒤 64 글자 — 일치는 원문에서 찾고 강조는 그 범위를 낳은 글자에, 보이지 않는 자리(링크 주소 등)의
│  │                      일치는 건너뛰어 강조를 그릴 수 있는 첫 일치를, 강조가 길면 문맥을 줄여 400 안. 변환은 일치 주변 창만(readableWindow — 앞뒤 2048, 강조·링크 짝 찾기가 한 줄 안에서
│  │                      길이의 제곱이라). 본문에 없으면 첨부 이름, 그래도 없으면 본문 머리 128자, 본문의 STX·ETX 는 먼저 걷는다) ·
│  │                      routes.ts(`GET /api/v1/search` — requireSession 뒤 REST 상한 위에 검색 전용 사용자당 분당 LIMITS.searchPerMin(60), 넘으면 429 + 사건 ratelimit)
│  ├─ router/             decide.ts(순수: 멘션·릴레이 판정, maxRelayTurns·allowPairs·반복 해시 — 일일 상한은 ops 관문, isPairAllowed 는 다시 실행도 쓴다.
│  │                      스레드 답글(사람): 멘션된 에이전트마다 스레드 런, 멘션이 없으면 루트를 쓴 에이전트(활성·멤버) → 채널 자동 응답. 스레드 답글(에이전트)의 멘션은 같은 스레드 릴레이) +
│  │                      service.ts(관문 `RunGate.enqueue` 로 런, relay_limit·relay_denied 시스템 메시지와 continue_relay 버튼 — 스레드면 그 스레드에, RETRY_RUN_ITEM = "retry_run")
│  ├─ runs/               orchestrator.ts(세션 직렬화·타이머·신호 → 상태 전이·run_events·정본 상관·부팅 정리. run_error 시스템 메시지(TIMEOUT·ADAPTER_UNAVAILABLE·ADAPTER_PROTOCOL·
│  │                      DROPPED:*·ADAPTER_ERROR:*)에 트리거 메시지가 있으면 1회용 「다시 실행」 버튼(retry_run, 24시간) — bot-loop-protection 으로 떨어진 런은 빼고), machine.ts(순수 상태머신),
│  │                      세션 큐·열린 런 찾기·정본의 에이전트 찾기는 「연결 id + 세션 키」 단위(두 Gateway 의 같은 id 에이전트는 서로 기다리지 않는다), runs.connection_id 는 만들 때
│  │                      에이전트의 연결 → send 결과의 connectionId 로 덮는다. 어댑터 이벤트·정본이 다른 연결의 런 id 를 실으면 그 런에 반영하지 않는다(warn).
│  │                      스레드 런(Phase 4 ①): 세션 큐는 (연결, 세션 키) 단위라 채널과 병렬·같은 스레드는 직렬. 붙은 플러그인이 있고 그 hello 에 threads 가 없으면 곧바로 error PLUGIN_OUTDATED
│  │                      (붙은 플러그인이 없으면 채널 런처럼 기다린다), 저장된 providerAgentId 가 규칙 밖이면 INVALID_AGENT_ID(다시 실행 버튼 없음). 정본은 세션 키의 스레드·threadId·런의 스레드가
│  │                      같아야 저장하고(다르면 VALIDATION — 어댑터가 ack 에 INTERNAL 로 싣는다), 에이전트·스냅샷·run_error 메시지의 threadRootId 는 런에서 온다.
│  │                      store.ts(runs·run_events — runs.thread_root_id ↔ Run.threadRootId), context.ts(인바운드 InboundDeliver 조립 — 트리거 첨부를 싣고, 이전 메시지 줄의 첨부는 `[이미지 N장]`·`[파일: 이름]` 자리표시로만.
│  │                      채널 런 recentMessages 는 thread_root_id IS NULL 만, 스레드 런은 recentMessages 가 비고 context.thread = 루트(THREAD_ROOT_TEXT_MAX 4000자)·그 스레드 normal 답글 최근 20(트리거 앞 — 상호작용이면 카드까지)),
│  │                      media-lines.ts(순수: Gateway 폴백 스냅샷의 단독 `MEDIA:` 줄 걷기 — 줄이 있으면 finalizing 을 줄당 30s, 최대 120s 늘린다), timers.ts, routes.ts(런 목록·상세·이벤트 REST)
│  ├─ sessions/           agent_sessions — 채널×에이전트(스레드면 ×루트) 세션 키 보장(키는 어댑터 sessionKeyFor → shared dodokSessionKey), 리셋 뒤 프롬프트 리비전 갱신, 서버가 정하는 러너 세션 id(ensureProviderSessionId — 채널 규칙 리비전이 바뀌면 renewSessionOnPromptChange 가 비우고 오케스트레이터가 info 한 번).
│  │                      세션 시작 리비전은 행마다(스레드 세션 행도 따로). providerAgentId 가 규칙 밖이면 키를 만들기 전에 VALIDATION(INVALID_AGENT_ID_REASON — run_error 카드와 같은 문장)
│  ├─ components/         interact.ts(순수: 검사 순서·값 스키마·인바운드 텍스트) + service.ts(저장·소비·continue/interaction/retry 런.
│  │                      상호작용마다 message.updated — reusable 카드도 결과 줄이 실시간으로 는다. 소비(consumed)는 1회용만.
│  │                      검사(트랜잭션 밖) → 관문 check(막히면 RUN_LIMIT, 소비 안 함) → 트랜잭션 안 재검사·저장·소비 → 관문 enqueue.
│  │                      retry_run: 원래 런이 error 이고 트리거 메시지가 있을 때만, 같은 트리거·rootMessageId·relayDepth 로 parentRunId 를 단 새 런 — relay 런이면 쌍(트리거를 쓴 에이전트 → 대상)을
│  │                      지금 allowPairs 로 다시 본다(턴 상한·반복은 안 본다))
│  ├─ push/               Phase 2 ④. vapid.ts(키: VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY 둘 다 있으면 그것, 아니면 `<DATA_DIR>/vapid.json`(없으면 만들고 0600,
│  │                      망가졌으면 덮어쓰지 않고 던진다)) · presence.ts(소켓별 「보이는가·보는 채널」, 메모리뿐 — isWatching) ·
│  │                      triggers.ts(순수: message.created·approval.requested → 받을 사람·알림 내용 — 멘션(자기 멘션은 작성자가 사람일 때만 뺀다)·승인 요청(워크스페이스의 owner·admin 전원 — `TriggerLookups.admins`)·relay_limit,
│  │                      제목 늘 `dodok`, 본문은 누가·어디·무엇만. 스레드 멘션은 「@dev가 #채널 스레드에서 불렀습니다」·url `/c/<id>/t/<rootId>`·tag `mention:t:<rootId>`
│  │                      (`mention:<channelId>:<rootId>` 는 81자로 상한 80 을 넘는다), 스레드 안 relay_limit 은 tag 는 채널 그대로·문구와 링크만 스레드) ·
│  │                      service.ts(구독 upsert(endpoint 유일 — 다른 사용자·세션 것이면 지금 사용자·세션으로 옮긴다)·해지·목록(등록한 세션이 만료 전인 것만), createTriggerLookups(DB 조회), attachPushTriggers(버스 배선 —
│  │                      같은 승인 id 는 한 번만, 최근 1000개), createPushDispatcher(보고 있으면 거름 → 구독마다 병렬 발송, TTL 3600·approval 만 urgency high·topic=tag 의 sha256 앞 32자,
│  │                      404·410 삭제 / 400·403·413 error / 그 밖 warn, 로그에 keys·endpoint·본문 없음, drain), webPushSender(web-push, 요청 timeout 10s)) ·
│  │                      routes.ts(`GET /api/v1/push/vapid-public-key` · `POST`·`DELETE /api/v1/push/subscriptions` — 세션, user-agent 512자)
│  ├─ gateways/           멀티 Gateway. OpenClaw Gateway 저장소·API — 전부 owner 세션(`requireOwner`, 아니면 403). 공유 토큰은 DB 평문, 응답·로그에 없다.
│  │                      service.ts(listGatewayRows(더한 차례) · createGateway·updateGateway(이름은 워크스페이스 안 유일 — CONFLICT details.field name,
│  │                      빈 토큰은 그대로, 바뀐 것이 없으면 쓰지 않음) · deleteGateway(한 트랜잭션 — 에이전트 gateway_id 비움, 행 삭제, 브리지 토큰은 FK cascade) ·
│  │                      gatewayConfig(어댑터에 넘기는 설정 — 공유 토큰이 나가는 유일한 자리) · bootGateways) ·
│  │                      routes.ts(`GET`·`POST /api/v1/gateways` · `PATCH`·`DELETE /api/v1/gateways/:id` — 저장 뒤 어댑터 upsertGateway·removeGateway ·
│  │                      `GET`·`POST /api/v1/gateways/:id/bridge-tokens`(발급 201, `Cache-Control: no-store` — 원문은 이 응답에만) ·
│  │                      `DELETE /api/v1/gateways/:id/bridge-tokens/:tokenId`(204, 폐기 뒤 revokeTokenSessions — 끊기 실패는 warn))
│  ├─ setup/              Phase 3 ②. 설정 마법사 — 전부 owner 세션(`requireOwner`, 아니면 403).
│  │                      tokens.ts(bridge_tokens 저장소 — 토큰은 Gateway 하나에 묶인다: 원문 `dbt_` + randomBytes(32) base64url, DB 는 sha256 hex·prefix(원문 `dbt_` 뒤 6자)만 ·
│  │                      issueBridgeToken(그 Gateway 에, 라벨 trim 1~60) · verifyBridgeTokenDb(해시로 활성 행 → timingSafeEqual → { tokenId, gatewayId }, lastUsedAt 1분에 한 번) ·
│  │                      listBridgeTokens(그 Gateway 의 것, 폐기 포함, 새것부터) · revokeBridgeToken(그 Gateway 의 행만)) ·
│  │                      status.ts(순수: bridgePublicUrl(BRIDGE_PUBLIC_URL, 없으면 APP_ORIGIN 의 wss:/ws: + /bridge)·buildSetupStatus — Gateway 행(목록·차례·켜짐의 정본) +
│  │                      어댑터 Gateway 별 상세(id 로 짝 — 모르는 행은 down, 꺼졌으면 disabled) + 품은 파일 + 서버 버전,
│  │                      pluginMatches 는 Gateway 마다 접속 플러그인의 bundleSha256 과 품은 tgz **안의 번들** sha256 비교, 모르면 null) ·
│  │                      plugin-file.ts(pluginDirCandidates — DODOK_PLUGIN_DIR(이미지 /app/plugin), 소스 실행이면 저장소 packages/openclaw-plugin/dist ·
│  │                      readPluginFile — 가장 최근 tgz 의 sha256·크기·`package/dist/index.js` sha256, tar 는 의존성 없이 읽는다) ·
│  │                      routes.ts(`GET /api/v1/setup/status` · `GET /api/v1/setup/plugin.tgz`
│  │                      (`dodok-openclaw-plugin-<sha 앞 12자>.tgz`, 없으면 404 `PLUGIN_FILE_MISSING`, 부팅 뒤 파일이 바뀌었으면 409 `PLUGIN_FILE_CHANGED`))
│  ├─ runners/            Phase 4 ③. 연결 페이지 러너 블록 — 전부 owner 세션.
│  │                      tokens.ts(runner_tokens 저장소 — bridge_tokens 와 같은 규칙, 원문 `drn_`, `.env` 이어받기 없음 · verifyRunnerTokenDb 는 id·라벨 ·
│  │                      activeRunnerTokenCount(어댑터 상태 runners.tokens) · isActiveRunnerTokenId(runner_down 이 폐기된 토큰에 사건을 남기지 않게)) ·
│  │                      runner-file.ts(runnerDirCandidates — DODOK_RUNNER_DIR(이미지 /app/runner), 소스 실행이면 packages/claude-runner/dist ·
│  │                      readRunnerFile — tgz 안 `package/dist/main.js` sha256, 몸통은 plugin-file.ts readBundledTgz) ·
│  │                      routes.ts(`GET`·`POST /api/v1/setup/runner-tokens`(201 no-store, runnerConfig{serverUrl — 브리지 공개 주소의 오리진을 http(s) 로, tokenFile}) ·
│  │                      `DELETE /api/v1/setup/runner-tokens/:id`(폐기 → 러너 어댑터 revokeTokenSessions — 묶임은 남는다) ·
│  │                      `PUT /api/v1/setup/runner-tokens/:id/agents/:agentId`(다시 묶기 — 활성 토큰만, 폐기면 409) · `GET /api/v1/setup/runner.tgz`(없으면 404 `RUNNER_FILE_MISSING`)) ·
│  │                      bindings.ts(agents.runner_token_id — boundRunnerToken·claimRunnerToken(묶임 없는 등록 claude 행만, 조건부 UPDATE)·bindRunnerToken.
│  │                      러너 어댑터의 bindings 옵션이 앞의 둘을 부르고, 에이전트 등록은 그 id 를 맡는 러너의 토큰(servingTokenId)을 INSERT 에 싣는다).
│  │                      러너 어댑터(@dodok/runner-adapter)는 app.ts 가 만든다(deps.adapters 를 안 주면 늘 — 테스트는 runnerAdapter: true). 러너 첨부 HTTP
│  │                      (`/runner/attachments`)는 attachments/routes.ts 가 브리지와 같은 가드·같은 제한으로 연다(업로더는 bridge — 에이전트 쪽)
│  ├─ ops/                Phase 3 ③. 운영 사건·런 수 상한·레이트리밋·안정성 — API 는 전부 admin 이상(`requireRole(ctx, "admin")`, 아니면 403).
│  │                      store.ts(ops_events: 묶기 — 같은 kind·key·미확인·last_at 1시간 안이면 count+1, severity 는 높은 쪽 · 끊김 사건은 resolved_at 전까지 한 줄 ·
│  │                      resolveEvent(downMs = 닫은 때 − first_at + detail.thresholdMs) · ack(upTo 까지) · 목록(커서 `<last_at ms>:<id>`, 50) · sumCountsSince · 30일 sweep ·
│  │                      저장 전 모양 검사 OpsShapeError) ·
│  │                      service.ts(createOpsService — 다른 모듈의 유일한 입구 record·resolve·ack·list·countsSince·unacked·sweep·close. 실패는 logger.error 뒤 null(원래 동작을 막지 않는다),
│  │                      ops_events 는 이 서비스로만 쓴다(unacked 메모리 캐시). 기록마다 로그 `event: "ops.<kind>"` 와 owner·admin 소켓 `ops.event` — 같은 줄은 OPS_EMIT_COALESCE_MS(1s) 창으로 모은다) ·
│  │                      settings.ts(workspaces.ops_json 읽기·패치 — 모르는 키는 보존) · ip.ts(ipPrefix — IPv4 /24·IPv6 /48) ·
│  │                      budget.ts(createRunGate — 런을 만드는 모든 경로가 지나는 관문 check·enqueue: 워크스페이스 상한 먼저, 그다음 채널 dailyRunLimit. 막히면 그 채널에 오늘 같은 scope 의
│  │                      run_limit 시스템 메시지가 없을 때만 하나 + 사건 run_limit. 스레드 런이면 그 알림을 스레드에 — 「오늘 이미 남겼나」는 채널 단위) ·
│  │                      limits.ts(LIMITS — 레이트리밋 숫자의 유일한 자리) · ratelimit.ts(TokenBucket·KeyedLimiter, 기본 시계 monotonicNow) ·
│  │                      http-limits.ts(createRestLimits — REST·업로드 상한, recordRateLimit — 사건 key 는 라우트 패턴) ·
│  │                      health.ts(watchConnections — 켜진 Gateway 마다 Gateway·브리지가 DISCONNECT_EVENT_MS(60s) 넘게 끊기면 gateway_down·plugin_down(key gateway:<id>)을 열고 붙거나 끄거나 지우면 닫는다 ·
│  │                      watchRunners — 이 프로세스에서 붙은 적 있는 러너 토큰이 60s 넘게 끊기면 runner_down(key 토큰 id), 붙으면 닫는다, 폐기된 토큰은 남기지 않는다 ·
│  │                      gatewayPin·observeGatewayVersion·watchGatewayVersion — 기억은 Gateway 마다 gateways.last_version, 핀과 다르면 gateway_version_untested(key gateway:<id>:<버전>, detail.version), 기억한 값과 다르면 gateway_version_changed(key gateway:<id>) — detail 에 Gateway 이름 ·
│  │                      diskLevel·createDiskMonitor — 부팅 때와 10분마다 statfs, error 면 첨부 업로드 507, check() 로 곧바로 다시 잰다 ·
│  │                      startRunState — run-state.json 종료 표지, 직전이 clean:false 면 unclean_shutdown · watchRunFailures — error 로 끝난 런마다 run_failed agent:<id>) ·
│  │                      summary.ts(runsSummary — 오늘·7일 채널별·에이전트별 런·실패·중지·차단, 토큰·금액은 붙은 어댑터 가운데 USAGE_TRUSTED_PROVIDERS 의 런만 — 없으면 키가 없고 화면은 「측정 불가」, ADR 0005) ·
│  │                      routes.ts(`GET /api/v1/ops/status` · `GET /api/v1/ops/runs?days=1|7` · `GET /api/v1/ops/events?cursor&severity` · `POST /api/v1/ops/events/ack` ·
│  │                      `PATCH /api/v1/ops/settings` {dailyRunLimit} — 응답은 전부 shared 스키마로 한 번 더 파싱)
│  ├─ members/            Phase 4 ② 팀. 초대·재설정 링크·가입·멤버 관리·「내 계정」·사람 목록 — 원문 토큰은 발급 응답 한 번뿐(`Cache-Control: no-store`), 로그·사건·목록·wire 에 없다.
│  │                      tokens.ts(원문 `dit_`(초대)·`drt_`(재설정) + randomBytes(32) base64url, DB 는 sha256 hex·prefix 만 · sameHash — 해시로 찾은 행을 상수 시간으로 한 번 더 대조) ·
│  │                      invites.ts(invites 저장소: issueInvite(7일)·issueResetLink(24시간 — 대상의 앞선 재설정 링크를 같은 트랜잭션에서 폐기)·canIssueResetLink(발급 규칙 — 발급·조회·수락이 같이 쓴다)·
│  │                      resetLinkUsable(조회·수락 때 발급자·대상의 지금 역할로 canIssueResetLink)·listPendingInvites(kind invite 만)·getPendingInvite·
│  │                      revokeInvite·findValidInvite(무효 까닭은 가르지 않는다)·claimInvite(`used_at IS NULL AND revoked_at IS NULL AND expires_at > now` 원자적 잡기)·unclaimInvite(`used_at` 만 되돌린다)) ·
│  │                      accept.ts(acceptInvite — 초대 확인 → 같은 이메일의 수락이 이 프로세스에서 진행 중이면 409(DB 연결별 표시, 첫 await 전) → Better Auth 쪽 이메일(우리 users 행이 없고 owner 이메일이 아닌 고아 Better Auth 사용자는 세션·계정과 함께 지우고 warn — 수락이 Better Auth 생성 뒤·우리 행 앞에서 죽은 자리)·비밀번호 해시(await) → await 없이 핸들·이메일 검사와 claim → Better Auth 내부 어댑터로 사용자·credential →
│  │                      users·memberships 한 트랜잭션 → 세션 발급 { userId, sessionToken }. 실패하면 Better Auth 사용자 삭제·claim 되돌림, 되돌리기도 실패하면 운영 사건 invite_accept_failed ·
│  │                      resetPassword — resetLinkUsable 을 못 지나면 404(링크 미소비), 비밀번호 교체 → 대상 세션 삭제 → 곧바로 disconnectUser → 새 세션 · normalizeEmail(소문자 — 이메일을 넣거나 찾는 경로는 모두 지난다)) ·
│  │                      account.ts(updateDisplayName · changePassword — 현재 비밀번호 확인(틀리면 400 VALIDATION field current), 이 세션을 뺀 세션 삭제 → 지운 세션만 disconnectSessions) ·
│  │                      handles.ts(assertHandleFree — 핸들 검사의 유일한 자리: `left-`(LEFT_HANDLE_PREFIX, 나간 사람 몫 예약)는 400 VALIDATION, 사람(users)·에이전트(agents) 어느 쪽과 겹쳐도 409,
│  │                      둘 다 field handle. 가입·에이전트 등록·수정이 부른다) ·
│  │                      service.ts(listMembers · changeRole(owner — admin → member 면 그 사람이 발급한 쓰이지 않은(`used_by IS NULL`) 링크 폐기) ·
│  │                      removeMember — Better Auth 삭제(세션·계정·사용자) → 트랜잭션(역할 재확인·membership·채널 참여·푸시 구독 삭제, 겨눈 재설정·발급한 링크 폐기, handle → leftHandleOf·left_handle·email NULL)
│  │                      → disconnectUser, 트랜잭션이 실패하면 소켓을 끊고 운영 사건 member_remove_failed 뒤 500 · leftHandleOf(`left-` + id 뒤 27자)) ·
│  │                      people.ts(listPeople — 나간 멤버 포함, 그 줄은 role 없음·leftHandle, 이메일은 싣지 않는다 · broadcastPeople — 버스 `people.changed` → 워크스페이스 방) ·
│  │                      routes.ts(registerMemberRoutes — `POST`·`GET /api/v1/invites`·`DELETE /api/v1/invites/:id`(admin 이상, admin 초대의 발급·폐기는 owner)·
│  │                      `POST /api/v1/members/:userId/reset-link`(admin 은 member 에게만, owner 는 owner 를 뺀 모두 — 발급 둘은 사용자당 LIMITS.inviteIssuePerMin) ·
│  │                      `POST /api/v1/invites/lookup`·`accept`·`reset`(로그인 없이, 토큰은 본문으로, 셋이 초대 경로 IP 버킷 LIMITS.invitePublicPerMin — 수락·재설정은 200 { sessionToken, user } + 쿠키) ·
│  │                      `PATCH /api/v1/me` · `POST /api/v1/me/password`(로그인 IP 버킷, owner 는 403)) ·
│  │                      manage.routes.ts(registerMemberManageRoutes — `GET /api/v1/people`(세션) · `GET /api/v1/members`(admin 이상) · `PATCH /api/v1/members/:userId`(owner) ·
│  │                      `DELETE /api/v1/members/:userId`(admin 은 member 만, owner 는 owner 를 뺀 모두)). 가입·역할·표시 이름·내보내기 뒤 broadcastPeople
│  └─ adapter/            GET /api/v1/adapter/status
├─ adapters/
│  ├─ connection.ts       connectionIdOf(에이전트 → 연결 id — OpenClaw 는 gateway_id, 러너는 runner_token_id) · agentConnectionId · agentOnConnection(어댑터 이벤트의 연결로
│  │                      에이전트를 찾는 SQL 조건). 서버는 런·세션·승인을 「연결 id + 세션 키」로 찾는다 — 두 Gateway 의 같은 id 에이전트는 세션 키가 같다
│  ├─ registry.ts         AdapterRegistry(제공자당 어댑터 하나 — all·forProvider·forAgent·onEvent)
│  └─ types.ts            AgentAdapter 계열 타입 재수출(계약은 packages/shared/src/adapter)
├─ util/
│  └─ josa.ts             받침에 따른 조사(시스템 메시지 병기형). 웹 `lib/josa.ts` 와 두 벌 — 한쪽만 고치면 어긋난다
└─ realtime/
   ├─ bus.ts              ServerBus — 모듈 → realtime 타입드 이벤트
   ├─ socket.ts           wire 인증(세션 토큰·프로토콜)·사용자당 동시 소켓 상한(LIMITS.socketsPerUser)·룸(channel:<id>, user:<id>, workspace:<id>, session:<Better Auth session id> — 토큰 원문은 소켓에 두지 않는다)·connection 에서 membership·세션(행과 만료 시각 — sessionAlive)을 다시 본다·
   │                      disconnectUser(내보내기·재설정 수락)·disconnectSessions(me/password — 지운 세션만, 로그아웃 — 이 세션. 빈 목록이면 아무것도 안 한다: `io.in([])` 는 모든 소켓이다)·
   │                      sweepExpiredSessions(만료된 세션 행을 지우고 그 세션 소켓을 끊는다 — app.ts 가 부팅 때 한 번, 그 뒤 SESSION_SWEEP_INTERVAL_MS(1분)마다. 소켓은 핸드셰이크·connection 에서만 세션을 보므로 REST 없이 wire 만 쓰는 탭은 이것이 끊는다)·
   │                      소켓마다 토큰 버킷 넷(WIRE_BUCKET — heavy·replay·approval·chatter, 넘으면 ack RATE_LIMITED·ack 없는 이벤트는 버림·사건 ratelimit `wire:<이벤트>`)·
   │                      클라이언트 → 서버 핸들러(subscribe 는 lastSeq 가 없으면 루트만, 있으면 lastSeq 이후 루트·답글 ≤200 + 옛 루트 요약 threadRoots · message.send 는 threadRootId 를 넘긴다,
   │                      ack 에 그 채널의 **미해결** 승인 pendingApprovals · approval.resolve 는 승인 서비스로 넘긴다 ·
   │                      presence.update 는 PresenceUpdate 로 파싱해 push presence 에 — 실패는 버린다, 끊기면 지운다)
   ├─ cookie-auth.ts      wire 핸드셰이크의 dodok.session 쿠키 파싱(웹은 토큰을 다루지 않는다)
   ├─ events.ts           bus → 룸 팬아웃(`setup.status` 는 owner, `ops.event` 는 owner·admin 사용자 룸에만 — roleRooms 가 보낼 때마다 membership 을 다시 읽어 역할 변경을 따른다, `people.changed` 는 워크스페이스 룸), 소켓별 미전송 500 초과 시 run.event 버림 + run.state { resync }.
   │                      message.created 는 withInteractions, message.updated 는 hydrateForClient(+ 루트 스레드 요약)로 하이드레이션한다 — 그 두 버스 이벤트의 유일한 소비자라
   │                      emit 자리가 늘어도 저절로 덮인다(components v1 스펙 11장 Ruling 1).
   │                      approval.requested·resolved 는 channel.created 와 함께 **워크스페이스 룸**으로 — 지금 구독 중이 아닌 채널의 승인도 닿아야 한다(설계 5.4·Ruling 7)
   └─ types.ts            WireServer·RunsFacade 타입
```

업로드는 `modules/attachments/`, 웹 푸시는 `modules/push/` 가 맡는다.

테스트(`apps/server/test/`): 모듈 단위(인메모리 SQLite), `fakes/`(가짜 Gateway·가짜 플러그인·시나리오 대본 — 대본의 `components` 는 실물 플러그인
`buildOutboundMessage` 를 지나 스키마를 어기면 거절된다), `integration/`(시나리오 1~8 `relay`·`prompt`·`recovery`, 시나리오 9a~9g `approvals`(9c′ 포함 8건),
시나리오 10a~10g `components`(셀렉트·모달 → 다음 런, 결과 줄 세 경로, reusable, 상한 20, 동시 두 번, 스키마 위반 거절), 시나리오 11a~11i `attachments`(올리기·권한·판별·에이전트 첨부·미디어만·폴백 `MEDIA:`·정리·문맥 자리표시),
시나리오 12a~12h `push`(멘션·보고 있으면 거름·승인·릴레이 한도·410 정리·자기 멘션·페이로드에 본문 없음·소켓 둘 + 종료 drain),
`ops-events`·`ops-limits`·`ops-ratelimit`·`ops-health`(운영 보강 — `ops.event` 는 owner·admin 소켓에만, 워크스페이스·채널 한도와 하루 한 번 메시지·다시 실행, REST·wire·브리지 실패 카운터·XFF,
끊김 사건 열고 닫기·버전·디스크 507·run_failed — 60초는 가짜 타이머 단위 테스트가 재고 통합은 줄인 임계 `disconnectEventMs`),
`setup`(설정 마법사 — 토큰 겹침 교체·폐기 뒤 핸드셰이크·첨부 HTTP 거절·접속 중 폐기의 즉시 끊김, `setup.status` 는 owner 소켓에만(admin 소켓은 못 받는다), 원문이 로그·목록·wire 에 없음,
Gateway 0개 부팅, 검증 함수가 던지면 거절, 거절 로그 주소(TRUST_PROXY)), `gateways`(Gateway API — 0개 부팅·추가·수정·삭제·Gateway 아래 브리지 토큰·부팅 때 넣기),
`late-canonical`(연결을 닫으며 끝낸 런의 늦은 정본 — 저장만, 릴레이·푸시 없음, 「다시 실행」 카드 소비, 재시작 뒤도),
`threads`(스레드 11건 — 스레드 키·문맥(채널 대화 없음)·정본·루트 요약·activeRuns 의 threadRootId, 멘션 없는 답글, 채널·스레드 병렬과 같은 스레드 직렬, 스레드 릴레이·relay_limit,
한도, 스레드 「새 대화」, PLUGIN_OUTDATED → 재설치 → 다시 실행, threadId 불일치 거절, 카드 버튼, 스레드 멘션 푸시), 실제 어댑터 + 가짜 둘),
검색은 단위(`search.service`·`search.routes`·`db.fts` — 트리거 셋·rowid 재사용·백필 가드·주입·2글자·NUL·레이트리밋),
팀은 단위(`roles.matrix` — 팀 스펙 「역할과 권한」 표의 경로 × 역할 허용·거부 전부·필드별·`approval.resolve`·승인 푸시 수신자·membership 없는 세션 · `members.invites`·`members.accept`·`members.manage`·`people`·`auth.login`·`auth` —
두 번 제출·핸들 충돌 양쪽·재가입·링크 폐기·세션 소켓 끊기와 지우기 → 끊기 순서·핸드셰이크 틈·버킷 분리·Better Auth 폐기 경로 404),
`helpers/`(`bootLiveApp`·wire 클라이언트·시나리오 단계·`png.ts`(테스트 PNG 생성기 `makePng`·`PDF_BYTES`) — `bootTestApp` 은 앱마다 임시 `ATTACHMENTS_DIR` 을 만들고 닫으면 지운다.
`bootLiveApp` 의 `extraGateways`(이름·`agents`)는 가짜 Gateway·플러그인 짝을 더 붙인다 — `live.gateways` 가 더한 차례의 짝 목록이고(첫 줄이 `live.gateway`·`live.plugin`), 가짜 Gateway `agents.list` 는 `agents` 옵션(기본 `dev`·`fin`)이다. 멀티 Gateway 통합은 `test/multi-gateway.integration.test.ts`.
`bootTestApp`·`bootLiveApp` 은 `deps.pushSend` 가 없으면 가짜 발송기 `noExternalPush` 를 넣고, `env.ts` 의 `testEnv` 는 프로세스마다 만든 VAPID 키를 환경변수로 준다 — 테스트가 밖으로 푸시를 보내거나 `data/vapid.json` 을 만들지 않는다).
가짜 플러그인은 브리지 HTTP 로 첨부를 받고 올리며(`uploadAttachment`·`downloadAttachment`), 대본 `ScenarioScript` 에 `attachments`·`attachmentIds`·`withholdCanonical` 이 있다.
가짜 플러그인 hello(`FAKE_PLUGIN_HELLO`)는 `threads` 를 싣고, `hello` 옵션·`reconnect({ hello })` 로 옛 플러그인·재설치를 흉내 낸다. 대본은 정본에 `delivery.threadId` 를 싣는다.
손으로 두드리는 실연 도구는 루트 `scripts/wire-cli.ts`(`pnpm wire-cli`, `docs/guides/live-smoke.md`).

개발 모드 `apps/server/scripts/dev-fake.ts`(`pnpm -F @dodok/server dev:fake`, 웹 MVP 스펙 9.2): 위 `test/fakes/` 를 그대로 가져다 가짜 Gateway·가짜 플러그인·대본과 함께 서버를 띄운다 —
실제 `OpenClawAdapter` 가 가짜 Gateway 에 붙으므로 모델 런·실제 Gateway 없이 웹 전체를 돌릴 수 있다.
가짜 Gateway 는 둘이다(`DEV_FAKE_GATEWAYS`) — 「사무실」(고정 id `DEV_FAKE_OFFICE_GATEWAY_ID`, 에이전트 `dev`·`fin`, 고정 브리지 토큰 `dev-fake-bridge-token-office`)·
「집」(`DEV_FAKE_HOME_GATEWAY_ID`, `main`·`dev`, `dev-fake-bridge-token-home`). `dev` 가 두 Gateway 에 일부러 겹친다. 시작 때 둘을 DB 에 넣고(`--keep` 이면 주소·토큰만 이번 가짜로 — 지운 고정 Gateway 는 다시 만들되 그 이름을 사람이 다른 Gateway 에 썼으면 「<이름> (dev:fake)」)
Gateway 마다 토큰 행·가짜 플러그인·대본을 하나씩 둔다. 시작은 가짜 플러그인이 붙은 고정 짝만 기다린다 — 사람이 더한 Gateway 는 닿지 않아도 되고, 사람이 끈 고정 Gateway·폐기한 고정 토큰이면 그 짝의 플러그인은 warn 만 남기고 붙지 않는다. 그 밖의 원인(사람 손이 닿지 않은 새 DB 등)으로 고정 짝이 못 붙으면 시작이 실패한다. OpenClaw 에이전트도 시작 때 등록한다 — 핸들 `dev`·`fin`(사무실)·`main`·`dev-home`(집), 그 핸들이나 그 Gateway 의 같은 id 가 이미 있으면 그대로 둔다.
대본의 이름표는 핸들이라(`**dev-home**: …`) 답만 보고 어느 Gateway 가 답했는지 안다. DB 에 넣지 않은 셋째 가짜 Gateway 도 하나 연다 — 시작 로그 `spareGateway` 의 주소·토큰(가짜는 토큰을 검사하지 않는다)을 연결 페이지 「Gateway 추가」에 넣어 붙여 본다(플러그인 없이 Gateway 줄만 붙는다). `.env` 를 읽지 않고 개발 전용 고정값을 쓴다(로그인 토큰 `dev-fake-local-token` — 시크릿이 아니라 로그에 찍는다),
DB 는 `data/dev-fake.sqlite`(시작마다 새로, `--keep` 이면 유지), 기본 포트 3000(Vite 프록시 대상). 운영 코드(`src/`)는 건드리지 않는다.
부팅 때 고정 member 계정(이메일 `member@dodok.local`, 비밀번호 `dev-fake-member-password`, 핸들 `mia`, 표시 이름 「미아」)도 owner 와 같은 자리에서 보장한다 —
사람을 만드는 서버 경로(`members/accept.ts` 의 `acceptInvite`)를 그대로 써 초대를 내부에서 하나 내 곧바로 수락한다, `--keep` 이면 이미 있을 때 그대로, 운영 `createApp` 에는 없다.
받은 글의 키워드로 대본을 고른다 — 드롭·실패·느리게·오래(답 길이와 무관하게 약 15초 스트리밍 — 채널과 스레드에 연달아 부르면 두 버블이 함께 흐른다)·도구·승인(승인 둘·승인 항상), components 는 「폼」(모달 필드 5종)·「폼 둘」(checkbox·radio + 필수 text — 둘이 합쳐 필드 7종)·
「고르기」(단일 셀렉트 + 옵션 12개 다중 셀렉트 — 스크롤 상자가 실제로 넘친다)·「카드」(블록 5종, media·file·링크 버튼에 `artifact://` 하나씩)·「재사용」(reusable 버튼 + 모달)·
「짧게」(TTL 20초, 다른 키워드와 오면 그 카드의 TTL 만 줄인다), 첨부(Phase 2 ③)는 「이미지 보여줘」(chart.png 480×320)·「보고서 줘」(report.pdf)·「카드에 이미지」(media·file·링크 버튼이 `artifact://<이름>` 으로 첨부를 가리키고 하나는 없는 이름)·「미디어만」(글 없는 응답).
푸시(Phase 2 ④)는 「나 불러」(답 `@<부른 사람> 확인해 주세요` — 멘션 푸시, 「느리게」와 함께면 채널을 옮길 시간이 난다). 사람이 첨부를 붙여 부르면 답 앞에 `받은 첨부 N개, 첫 이미지 W×H` 줄을 붙인다. 대본이 내는 글·라벨·파일 이름에 키워드가 없음을 `DEV_FAKE_KEYWORDS` 전수 테스트가 본다.
스레드(Phase 4 ①)는 따로 키워드가 없다 — 스레드에서 멘션하면 대본이 그 스레드로 답하고(정본에 `threadId`, 델타 포함), 스레드 안 답의 「@핸들 이어서 부탁해요」는 같은 스레드에서 릴레이한다. 가짜 플러그인 hello 는 `threads` 를 싣는다.
웹을 다른 포트로 띄우면 `PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake` + `DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web dev --port 5180`(`APP_ORIGIN` 기본은 `http://localhost:5173`).
가짜 플러그인은 `.env` 가 아니라 그 Gateway 의 고정 브리지 토큰(라벨 `dev-fake`)으로 붙는다 — 연결 페이지의 각 Gateway 카드 토큰 목록에 그 줄이 있다.
Gateway 를 고르는 훅(`plugin-token`·`plugin-capabilities`·`gateway`)은 본문에 `gatewayId`(사무실·집의 고정 id)가 있어야 한다 — 없거나 그 둘이 아니면 400 `VALIDATION`(문구에 고를 수 있는 id 가 실린다).
**개발 전용 훅 `POST /__devfake/plugin-token { "gatewayId": "<id>", "token": "<원문>" }`**(`DEV_FAKE_PLUGIN_TOKEN_PATH`): 그 Gateway 의 가짜 플러그인을 끊고 그 토큰으로 다시 붙인다 — 연결 페이지의 토큰 교체(발급 → 「지금 접속 중」 이동 → 옛 토큰 폐기 → 옛 토큰 재접속 거절)를 브라우저로 잴 때. 다른 Gateway 의 플러그인은 그대로다. 다른 Gateway 에 묶인 토큰이면 400 `VALIDATION`(받으면 이 플러그인이 그 Gateway 자리를 차지해 그 Gateway 의 런에 이 짝의 대본이 답한다). DB 에 없는 토큰은 받아 `{ ok: false, reason: "UNAUTHORIZED" }` 를 돌려준다.
응답은 200 `{ ok: true }` 또는 `{ ok: false, reason }`(예 `UNAUTHORIZED` — 모르는 토큰을 주면 가짜 플러그인이 끊긴 채 남아 임계 뒤 `plugin_down` 이 열린다).
**개발 전용 훅 `POST /__devfake/plugin-capabilities { "gatewayId": "<id>", "threads": boolean }`**(`DEV_FAKE_PLUGIN_CAPABILITIES_PATH`): 옛 플러그인 흉내 — false 면 그 Gateway 의 가짜 플러그인을 끊고 hello capabilities 에서 `threads` 를 뺀 채 다시 붙는다(스레드 멘션은 곧바로 `PLUGIN_OUTDATED` run_error 카드, 채널 멘션은 그대로), true 면 되돌린다(재설치 — 그 카드의 「다시 실행」이 스레드에서 답한다). 토큰은 그대로. 응답은 200 `{ ok: true, capabilities }` 또는 `{ ok: false, reason }`. 값은 메모리에만 있어 다시 띄우면 `threads` 가 있다.
**운영 훅**(Phase 3 ③) — 운영 화면의 배지·끊김·디스크를 브라우저로 잴 때:
- `POST /__devfake/ops/event { kind, key, severity, detail? }`(`DEV_FAKE_OPS_EVENT_PATH`) — `app.ops.record` 만 부른다(ops_events 를 직접 쓰지 않아 unacked 캐시·`ops.event`·로그가 함께 돈다). 200 `{ ok: true, event }`.
- `POST /__devfake/gateway { gatewayId, state: "down" | "connected" }`(`DEV_FAKE_GATEWAY_PATH`) — down 이면 그 가짜 Gateway 가 연결을 끊고 그 뒤 `connect` 를 `UNAVAILABLE` 로 거절한다(끊기만 하면 `@openclaw/gateway-client` 가 자기 백오프로 속에서 재시도해 어댑터가 모른다). dev:fake 만 어댑터 재접속 백오프 상한을 1초로 준다(`AppDeps.gatewayBackoff`). 플러그인(브리지)과 다른 Gateway 는 그대로. 200 `{ ok: true, status }`(`status` 는 그 Gateway 한 줄), 10초 안에 안 바뀌면 `{ ok: false, reason: "timeout", status }`.
- `POST /__devfake/disk { freeBytes, totalBytes } | { reset: true }`(`DEV_FAKE_DISK_PATH`) — 디스크 감시의 statfs 를 그 값으로 바꾸고 곧바로 다시 잰다(error 면 응답 전에 `disk_low`·첨부 507 이 반영된다). reset 이면 실제 statfs. 값은 메모리에만 있어 다시 띄우면 실제로 돌아간다.
- `POST /__devfake/runner { connected: boolean, token?: string }`(`DEV_FAKE_RUNNER_PATH`) — false 면 가짜 Claude 러너를 끊고 어댑터의 붙은 러너 수가 줄 때까지(5초) 기다린다, true 면 다시 붙는다(`token` 을 주면 그 러너 토큰으로 — 연결 페이지에서 발급한 토큰). 가짜 러너는 스스로 다시 붙지 않는다(토큰 폐기 뒤 포함). 200 `{ ok: true, status }` 또는 `{ ok: false, reason }`. 고정 러너 토큰 `dev-fake-runner-token`(라벨 dev-fake)·에이전트 `coder`(provider claude)는 시작 때 넣어 둔다.

여섯 훅 공통: owner 세션(쿠키 또는 Bearer) — 판정은 같은 헤더로 앱의 `GET /api/v1/setup/status` 를 inject 해 그 401·403 을 그대로 돌려준다, 본문은 판정 뒤에 읽는다, `content-type` 이 `application/json` 이 아니면 415(단순 요청으로 못 부르게), 경로는 쿼리 앞까지 정확히 일치(아니면 원래 리스너 → 앱 404), 본문 16 KB 상한, 모양이 틀리면 400 `VALIDATION`.
서버 오리진으로 직접 부른다 — 웹 페이지 안 `fetch` 는 CORS 와 415 에 걸린다. Playwright 면 `context.cookies()` 의 `dodok.session` 을 `request.post(…, { headers: { cookie }, data })` 로 싣는다.
⚠ 쿠키는 **웹 오리진**(APP_ORIGIN, 예 `http://localhost:5180`) 기준으로 읽는다 — Vite 가 `/api` 를 프록시해 브라우저는 API 오리진(`127.0.0.1:3100`)에 직접 요청하지 않으므로 세션 쿠키는 웹 오리진에 저장된다.
API 오리진으로 `context.cookies(…)` 를 거르면 공유 프로필에 이전 dev:fake 실행에서 남은 낡은 `dodok.session`(같은 127.0.0.1:포트 조합을 다시 쓴 적이 있으면)을 집어 훅 호출이 조용히 401 `UNAUTHORIZED` 로 실패한다.
```bash
O=http://127.0.0.1:3100; J=<스크래치>/jar     # dev:fake 를 PORT=3100 으로 띄웠을 때
curl -s -c $J -o /dev/null -X POST $O/api/v1/auth/local -H 'content-type: application/json' -d '{"token":"dev-fake-local-token"}'
curl -s -b $J -X POST $O/__devfake/ops/event -H 'content-type: application/json' -d '{"kind":"ratelimit","key":"wire:message.send","severity":"warn"}'
curl -s -b $J -X POST $O/__devfake/gateway   -H 'content-type: application/json' -d '{"gatewayId":"00000000-0000-4000-8000-00000000def2","state":"down"}'
curl -s -b $J -X POST $O/__devfake/disk      -H 'content-type: application/json' -d '{"freeBytes":104857600,"totalBytes":10737418240}'
curl -s -b $J -X POST $O/__devfake/plugin-capabilities -H 'content-type: application/json' -d '{"gatewayId":"00000000-0000-4000-8000-00000000def1","threads":false}'
curl -s -b $J -X POST $O/__devfake/runner -H 'content-type: application/json' -d '{"connected":false}'
```
`createApp` 은 ready 뒤라 경로를 더할 수 없어 HTTP 서버의 request 리스너를 감싼다(이 경로들만 받고 나머지는 engine.io → Fastify). 운영 `createApp`·번들에는 이 경로가 없다(404).
**`DODOK_DEVFAKE_DISCONNECT_MS`**(dev:fake 전용, 양의 정수 ms — 없거나 비면 운영과 같은 60000, 그 밖이면 시작하지 않는다) — 끊김 사건 임계(`AppDeps.disconnectEventMs`). 사건 `detail.thresholdMs` 에 실린다.
종료 표지는 `<dataDir>/dev-fake-run/run-state.json` — `pnpm -F @dodok/server dev` 의 표지와 섞이지 않는다. 처음 띄우면 운영 화면 「직전 종료」가 알 수 없음, Ctrl-C·SIGTERM 뒤면 깨끗, `kill -9` 뒤면 비정상 + `unclean_shutdown`.
run_error 「다시 실행」 카드는 대본 「실패」 키워드(코드 `unknown` — 알리지 않는 코드)나 Gateway down(런이 기다렸다 돈다)으로는 생기지 않는다 — `plugin-token {"gatewayId":"<id>","token":"nope"}` 로 그 Gateway 의 가짜 플러그인을 끊고 그 Gateway 의 에이전트를 멘션하면 120초(`queuedMs`) 뒤 `ADAPTER_UNAVAILABLE` 로 생긴다. 스레드 안이면 `plugin-capabilities {"gatewayId":"<id>","threads":false}` 뒤 스레드 멘션으로 곧바로(`PLUGIN_OUTDATED`) 생긴다. 되붙이기는 `{"gatewayId":"<id>","token":"dev-fake-bridge-token-office"}`(집이면 `…-home`, 그 행을 폐기하지 않았다면). 같은 채널·에이전트에 여럿 걸면 세션 큐 때문에 120초씩 이어지니 채널을 나눈다.
⚠ `dev:fake` 는 **실제 `web-push` 발송기**를 쓴다 — 브라우저에서 푸시를 켜고 트리거를 일으키면 실제 푸시 서비스(FCM 등)로 나간다(`startDevFake` 의 `pushSend` 옵션으로만 바꾼다). `<dataDir>/vapid.json` 은 시작마다 지우지 않는다 — 새 키면 브라우저 구독이 매번 무효가 된다.

### 2.3 `packages/openclaw-adapter` (서버 프로세스 안에서 실행)

```
src/
├─ index.ts               배럴: adapter-types · createOpenClawAdapter(+ GatewayConnectionConfig·GatewayStatusEntry·GatewaySetupEntry) · FakeAdapter · ProviderApproval·parseSessionKey(서버 승인 상관이 쓴다) · BridgeAuthGuard · OPENCLAW_PINNED_VERSION
├─ version.ts             OPENCLAW_PINNED_VERSION — 저장소가 검증한 OpenClaw 버전. package.json 의 OpenClaw 패키지 정확 핀과 같아야 한다(test/version.test.ts).
│                         서버가 접속한 Gateway 버전과 비교해 gateway_version_untested·운영 화면·연결 페이지의 드리프트 문구를 낸다
├─ adapter-types.ts       AgentAdapter 인터페이스(스펙 6.1), AdapterEvent(+ kind:"approval")·RunEventBody, AdapterCapabilities(sessionReset·agentsList·configSet),
│                         resolveApproval(providerApprovalId, kind, decision), AdapterError
├─ openclaw-adapter.ts    createOpenClawAdapter: 브리지 + Gateway 연결 목록(connection/manager) 조립 — 어댑터 하나가 Gateway 연결 여럿을 품는다(멀티 Gateway 스펙 5장).
│                         upsertGateway({ id, name, url, token, enabled })·removeGateway(id) 로 연결을 넣고 빼고(서버가 부른다 — 재시작 없음), 메서드는 연결 id 로
│                         그 연결에 보낸다(null·모르는 id·꺼진 연결이면 ADAPTER_UNAVAILABLE). 정본 outbound.message → onCanonical(message, 연결 id).
│                         gatewayStatuses()·gatewaySetupDetails() 가 Gateway 별 상태·상세(더한 차례, 상세에 공유 토큰 없음). 계약의 status()·setupDetail() 은
│                         단수 모양 — status 는 켜진 Gateway 가운데 가장 나쁜 gateway(down > reconnecting > connected)와 「켜진 Gateway 모두에 플러그인」이면 connected 인
│                         bridge(켜진 Gateway 가 없으면 down/down), setupDetail 은 첫 켜진 Gateway 의 것(없으면 host 가 빈 down/null). setup 이벤트는 Gateway 별
│                         상세 목록이 바뀔 때(같으면 안 냄). 능력(sessionReset·agentsList)은 어댑터에 하나 — 어느 Gateway 든 FORBIDDEN 이면 내린다.
│                         revokeTokenSessions(tokenId) — 그 토큰으로 붙은 세션만 끊고 수를 돌려준다
├─ connection/
│  ├─ manager.ts          Gateway 연결 목록 — 만들기·바꾸기·지우기·연결 id 로 찾기. 연결 id 는 디렉터리 이름이 되므로 영숫자로 시작하고 영숫자·`.`·`_`·`-` 만.
│                         같은 id 를 지우는 중에 온 upsert 는 지우기(디렉터리 삭제까지)가 끝난 뒤에 적용한다
│  └─ gateway-connection.ts  Gateway 연결 하나: WS 루프(gateway/connection-manager)·디바이스 디렉터리 `<DATA_DIR>/gateways/<id>/`(device.json·device-tokens.json)·
│                         이벤트 매퍼·승인 병합(기억은 연결마다 — 두 Gateway 가 같은 승인 id 를 내도 따로)·프레임 덤프(`<path>.<id>`)·브리지 자리.
│                         send = 런 id 등록 → 세션 구독 → inbound.deliver(플러그인 미접속 120s 대기, ack 타임아웃 10s + 트리거 이미지 첨부당 30s·재시도 1s·4s·16s) → admission.
│                         abort(chat.abort)·resetSession(sessions.reset, FORBIDDEN 이면 capability 내림)·listAgents(그 Gateway 의 agents.list)·syncChannelConfig·forgetRun.
│                         이름만 바뀌면 다시 붙지 않는다. 끄기·주소/토큰 바꾸기·삭제는 그 연결의 열린 런만 닫는다 — ack 를 기다리던 send 는 ADAPTER_UNAVAILABLE 로
│                         던지고(브리지 ack 대기도 끝냄), 디스패치된 런은 러너가 끊길 때와 같은 RUN_ERROR + gateway_error(ADAPTER_UNAVAILABLE,
│                         connectionClosed: true)(서버가 「다시 실행」 카드를 단다). 신호 전에 옛 링크가 붙어 있으면 두 쪽 런 모두에 chat.abort 를 보내고(런마다 2s 상한,
│                         실패는 warn) 그 뒤 옛 링크를 멈춘다 — 새 링크는 기다리지 않고 곧바로 만든다. 디바이스 파일을 못 지우면 warn 만 남기고 이어 간다.
│                         끄면 그 Gateway 의 플러그인 소켓도 끊고, 주소가 바뀌면 device-tokens.json 을 지워 다시 페어링하고(디바이스 키는 그대로), 지우면 디렉터리를 지운다.
│                         Gateway WS 가 끊기기만 한 것(재접속 루프)은 런을 닫지 않는다 — 정본은 플러그인 경로다.
│                         스레드: supports("threads") — 그 연결에 **지금 붙은** 플러그인 hello 의 capabilities(붙은 플러그인이 없으면 false). send 전 구독은 키를 가리지 않아
│                         스레드 키도 인바운드보다 먼저 sessions.messages.subscribe 된다. 재접속 복구 대상은 서버가 연결 id 별로 준다(sessionRecoverTargets — 스레드 행 포함)
├─ fake-adapter.ts        FakeAdapter — 서버 단위 테스트용(`@dodok/openclaw-adapter/fake` 서브패스), calls 기록(upsertGateway·removeGateway 포함 — 기록만)·이벤트 주입,
│                         setPluginCapabilities(옛 플러그인 흉내 — 기본은 threads 있음)
├─ config-sync.ts         채널 설정 → 그 Gateway 의 브리지 config.set(10s). 플러그인이 없으면 기다리지 않고 ADAPTER_UNAVAILABLE
├─ gateway/
│  ├─ approvals.ts        Gateway 승인 프레임 → ProviderApproval 정규화(순수). 정본 전역 plugin|exec|openclaw.approval.requested/resolved(request 블록·toolCallId 있음)와
│  │                      보조 session.approval(presentation 블록·toolCallId 없음)·재접속 approvalReplay 를 한 모양으로 모으고, 만료의 비대칭
│  │                      (plugin 은 deny+resolvedBy:null, session 은 expired)도 여기서 흡수한다. **우리 세션만** 거른다(전역 프레임이라 다른 채널·TUI 승인도 온다).
│  │                      계약 상한 초과는 승인을 버리지 않는다(fail-open) — 승인을 버리면 카드도 못 보고 TTL 만료만 보게 된다.
│  │                      보여 주는 값(title·description·detail·toolName·pluginId·urlPath)은 잘라서 끝에 … 를 붙이고,
│  │                      상관 키 toolCallId 는 자르지 않고 통째로 버린다(자른 id 는 어느 툴 호출과도 안 맞는다 — 채널 수준 승인이 된다)
│  ├─ client.ts           @openclaw/gateway-client 래퍼: connect.challenge → connect(디바이스 서명·공유 토큰, scopes 에 operator.admin 포함,
│  │                      caps DEFAULT_GATEWAY_CAPS) → hello-ok. 실패(PAIRING_REQUIRED 포함)는 그대로 올리고 재시도는 연결 관리자 몫
│  ├─ connection-manager.ts  접속 루프·지수 백오프·상태(down/reconnecting/connected)·요청 타임아웃, 페어링 대기(requestId·since — 다음 성공 접속에서 지움, 재시도 5s), 접속마다 복구(sessions.subscribe →
│  │                      대상 세션별 sessions.messages.subscribe → chat.history, 커서 reset 이면 꼬리 페이지 다시).
│  │                      subscribeSession: 접속 뒤 새로 생긴 세션은 send 전에 연결당 한 번 구독 — 실물 Gateway 는 구독한 세션의 이벤트만 보낸다(실연에서 발견, live-smoke 5.4).
│  │                      세션 구독에 includeApprovals: true — 켜야 session.approval 과 응답의 approvalReplay(재접속 되감기)가 온다
│  ├─ device-identity.ts  Ed25519 아이덴티티 생성·저장(0600)·서명 (스파이크 1에서 확정)
│  ├─ events.ts           chat(delta/final/error/aborted)·agent(lifecycle·stream:"tool")·session.message(usage) → RunEvent + RunSignal.
│  │                      우리 런(runId = 우리 런 uuid, ADR 0002 4.3)만. deltaText → TEXT_MESSAGE_CONTENT(replace 면 TEXT_MESSAGE_REPLACE), final 스냅샷은 정본 대체용
│  ├─ frame-dump.ts       OPENCLAW_FRAME_DUMP_PATH — 받은 chat·agent·session.message·session.approval·plugin|exec.approval.requested/resolved 프레임 JSONL append(연결마다 `<path>.<id>`)
│  │                      (스트림, 쓰기 오류면 warn 뒤 끔, close 에서 닫음)
│  └─ sessions.ts         sessionKeyFor(providerAgentId, channelId, threadRootId?) = shared dodokSessionKey(`agent:<agentId>:dodok:channel:<channelId>[:thread:<rootId>]` —
│                         「새 대화」는 sessions.reset, 세대 접미사 없음: 계획서 10장 #15·#19), parseSessionKey = shared parseDodokSessionKey(승인 상관 — 스레드 키면
│                         ProviderApproval.threadRootId), sessions.reset·chat.history 응답 파싱
├─ bridge/
│  ├─ guard.ts            BridgeAuthGuard(Phase 3 ③) — 브리지 인증 **실패만** 세는 주소별 카운터(isBlocked·fail). 창 안에 maxFailures 번 틀리면 blockMs 동안 막고,
│  │                      성공은 카운터를 건드리지 않는다(그런 메서드가 없다 — 막힌 주소의 정상 토큰도 막힌 동안 거절되고 저절로 풀린다), 주소 maxAddresses 개까지.
│  │                      서버가 인스턴스 하나를 만들어 핸드셰이크(옵션 `bridge.authGuard`·`onBlocked`)와 `/bridge/attachments` 에 같이 준다. 숫자는 서버 LIMITS.bridgeFail
│  ├─ server.ts           attachBridge: Socket.IO 네임스페이스 /bridge 하나(HTTP 경로는 /socket.io/). 막힌 주소(authGuard)는 토큰을 보지 않고 거절(`blocked after repeated failures`) →
│  │                      verifyToken 인증(통과면 { tokenId, gatewayId } — 던지면 거절, 실패 카운터에는 세지 않는다) → acceptGateway(켜진 Gateway 인가 — 아니면 같은
│  │                      `token mismatch` 로 거절하되 실패로 세지 않는다: 꺼진 Gateway 의 플러그인은 백오프로 계속 다시 붙는다) → 세션이 tokenId·gatewayId 를 기억 → hello →
│  │                      inbound.deliver·config.set·agents.list 요청, outbound.message·status 수신, close 때 system.notice { reason: "shutdown" }.
│  │                      Gateway 마다 자리(forGateway(id) — 같은 id 에 같은 객체): 활성 플러그인 하나(새 hello 는 같은 Gateway 의 앞 연결만 replaced)·ready 대기·outboundId 중복 흡수.
│  │                      disconnectGateway(id, { forget? }) 는 그 Gateway 의 소켓만 끊고 ready 대기를 끝낸다(끄기·삭제).
│  │                      거절 로그 `token mismatch from <주소>` 는 주소별 1분에 한 줄(넘친 수는 `(N more suppressed)`), revokeSessions(tokenId) 는 사유 revoked 로 그 토큰의 소켓만 끊는다
│  └─ session.ts          RejectLogThrottle·클라이언트 이벤트 Zod 파싱·연결 단계(tokenId·gatewayId 포함)·outboundId 중복 제거, verifyBridgeToken(상수 시간 비교 — 스파이크 러너용)
└─ spike/                 Phase 0 스파이크 러너(gateway-spike·bridge-spike·prompt-spike·admin-scope-probe·bridge-serve) — 서버는 쓰지 않는다
```

테스트(`test/`): 모듈별 단위 + `fixtures/gateway-events.ts`(ADR 0001·0002 관찰에서 뽑은 Gateway 이벤트 팩토리). `./testing` 서브패스는 없다 — 서버 통합 하네스
(`apps/server/test/fakes/`)가 픽스처·`connectGateway`·`attachBridge`·`createGatewayEventMapper` 를 상대 경로로 가져간다(어댑터 파일을 옮기면 서버 typecheck 가 잡는다).

### 2.4 `packages/openclaw-plugin` (원격 OpenClaw Gateway 프로세스 안에서 실행)

```
src/
├─ index.ts               defineChannelPluginEntry({ plugin, setRuntime }) — id "dodok". 매니페스트 channels·channelConfigs, package.json openclaw.channel,
│                         런타임 dependencies 없는 단일 번들(esbuild) (ADR 0002 3.1·3.2)
├─ channel.ts             채널 정의: 인바운드 ingress, 아웃바운드 액션 어댑터(describeMessageTool),
│                         채널별 설정 스키마(requireMention, systemPrompt, botLoopProtection, inboundChannelPrompt 는 제거[계획서 10장 #18]). 코어 봇 루프 보호는
│                         플러그인이 에이전트 작성 인바운드에 사실을 넘길 때만 동작한다 (ADR 0002 7절). 봇 루프 예산의 conversationId 는 스레드에서도 channelId.
│                         스레드(Phase 4 ①, ADR 0006): resolveOutboundSessionRoute 는 SDK buildThreadAwareOutboundSessionRoute(precedence threadId → currentSession — 없으면
│                         delivery-mirror 가 새다), 채널 세션은 threadId 인자를 쓰지 않는다(outboundRouteThreadId). handleAction 은 세션 키에서 스레드를 풀어 OutboundMessage.threadId —
│                         스레드 세션에서 다른 채널이나 그 스레드가 아닌 threadId 면 THREAD_ONLY_REASON(outbound.ts)으로 ToolInputError. sendText 는 ctx.threadId 로 스레드에, 최종 답(deliver)도 threadId 를 싣는다.
│                         hello capabilities = DODOK_BRIDGE_CAPABILITIES(`run_id_in_outbound`·`config.set`·`threads`). SDK 를 그대로 불러 `test/channel.test.ts` 가 시험한다
├─ bundle-hash.ts         Phase 3 ②. computeBundleSha256(import.meta.url) — 자기 번들 파일의 sha256(읽기 실패·file: 아님이면 undefined → hello 에서 필드를 뺀다).
│                         channel.ts 가 모듈 스코프에서 한 번 재서 hello 의 bundleSha256 에 싣는다. 세대마다 다른 임시 경로에서 평가돼도 내용이 같아 값이 같다(ADR 0004).
│                         `scripts/build.mjs` 가 산출물 글자로 두 자리(`computeBundleSha256(import.meta.url)`·`bundleSha256: BUNDLE_SHA256`)를 확인하고 없으면 빌드를 멈춘다
├─ inbound.ts             toInboundFacts(순수): 브리지 inbound.deliver → 디스패치 사실. 세션 키가 dodokSessionKey(agentId, channelId, threadId) 와 같고 threadMatchesSessionKey 여야 받는다.
│                         스레드면 conversation.threadId·reply.messageThreadId, route.parentSessionKey 는 비운다(포크 없음 — 스레드·검색 스펙 결정 5)
├─ components-schema.ts   message 툴에 끼울 components 스키마 조각 (shared/components를 그대로 노출). url 설명에 `artifact://<파일 이름>` 관례
├─ config.ts              계정 설정 스키마 — bridgeUrl·token, 첨부 상한 mediaMaxMb(선택, 1~20 → min(값 MiB, 20 MiB))
├─ media-http.ts          Phase 2 ③. 브리지 URL → HTTP 오리진(wss→https, 경로 제거), 첨부 받기·올리기(fetch 주입, 30s, 네트워크 오류만 1회 재시도). 상태 없음
├─ inbound-media.ts       Phase 2 ③(순수). 인바운드 이미지 첨부를 병렬로 받아 saveMediaBuffer(maxBytes 20 MiB) → media fact(url 없음).
│                         이미지가 아닌 첨부는 본문 끝 `[첨부 파일: 이름]`, 실패는 `[이미지를 불러오지 못했습니다: 이름]` — 런은 막지 않는다
├─ outbound-media.ts      Phase 2 ③(순수). 원천 모으기(툴 media/mediaUrls·deliver mediaUrls)·이름 정리·겹치면 ` (2)`·loadWebMediaRaw 옵션·올리기,
│                         실패 사유는 오류 코드별 고정 문구(원문은 가려서 로그에만 — 스펙 11장 Ruling 3), 미디어만 있는 final 도 보낸다(shouldDeliverFinal)
├─ bridge-client.ts       서버 브리지 WSS 아웃바운드 접속(BRIDGE_URL·토큰)·지수 백오프 재연결·아웃바운드 큐
├─ bridge-registry.ts     계정별 브리지·세션별 상관관계를 globalThis Symbol.for 키에 둔다 — 9.5 는 번들을 두 번 평가해 모델 런의 message 툴이
│                         startAccount 를 돌지 않은 인스턴스로 간다. 삭제는 같은 객체일 때만(releaseBridge) (ADR 0004)
├─ outbound.ts            buildOutboundMessage·coerceComponents — components 의 `artifact://` 값 안 공백류를 검증 전에 퍼센트 인코딩(Ruling 4).
│                         세션 키와 threadId 를 대조한다(우리 키면 threadMatchesSessionKey, 우리 키가 아닌데 threadId 가 있으면 거절 — 조용히 채널로 가지 않고 오류). THREAD_ONLY_REASON
│                         = 「dodok: 이 대화는 스레드라 이 스레드에만 보낼 수 있습니다」
├─ config-writer.ts       브리지에서 받은 채널 설정 변경을 runtime.config.mutateConfigFile 로 Gateway 설정에 반영(channel-config-writes 는 권한 판정).
│                         반영은 설정 스냅샷 기준 live. claude-cli 기존 세션은 리셋·새 키에서만 반영, 드리프트·재시작으로는 미반영 (ADR 0003 3절)
└─ context.ts             인바운드에 동봉할 최근 채널 메시지 N개 + 참여자 목록 + 릴레이 규칙 요약 + 채널 프롬프트 배치(헤더 줄 또는 ChannelPromptContext, ADR 0003).
                          스레드면 첫 줄에 `thread=<rootId>`, 「최근 대화」 대신 `스레드 루트:`·`스레드 최근:`(서버가 채널 대화를 보내도 싣지 않는다)
```

SDK import 경로: `openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/channel-message`, `openclaw/plugin-sdk/channel-config-schema` 등 서브패스만 사용한다. `openclaw`는 devDependency이며 번들 시 external로 두어 Gateway가 제공하는 런타임을 쓴다.

배포: Gateway 호스트에서 `openclaw plugins install <tarball> --force --accept-capabilities`(초기; tarball 은 `pnpm pack` — 배포 서버 이미지가 같은 커밋의 tgz 를 `/app/plugin/` 에 품고 웹 연결 페이지가 내려준다(`docs/guides/deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」 절), `openclaw plugins pack` 은 채널 플러그인 거부, RPC `plugins.install` 은 clawhub/official 만 — ADR 0002 9절), 안정화 후 npm `@dodok/openclaw-plugin` 퍼블리시. Gateway 설정에 우리 채널 계정(브리지 URL·토큰 — 토큰은 연결 페이지에서 발급한 `dbt_…`, 발급 대화상자가 설정 조각을 준다)을 넣는다. 플러그인이 **아웃바운드**로 접속하므로 Gateway 호스트에 인바운드 포트를 열 필요는 없다.

### 2.4a `packages/runner-adapter` (서버 프로세스 안에서 실행)

서버 측 Claude 러너 어댑터 — `AgentAdapter` 의 `provider: "claude"` 구현. 설계는 `docs/superpowers/specs/2026-09-27-claude-runner-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장).
- `src/runner-adapter.ts` — `/runner` 네임스페이스(러너 토큰 핸드셰이크·hello·같은 토큰 교체는 옛 자리를 잇는다), `send`→`run.start`(채널 규칙 틀·턴 사실은 여기서 만든다), `run.event` 허용 목록·runId 대조, `run.final`→정본·usage(`dodok.usage`), 중지(`run.final aborted` → 메시지 없는 `RUN_ABORTED`, 러너 종료 `run.final runner_shutdown` → `ADAPTER_UNAVAILABLE`), `outbound.post` 를 열린 런에 묶기, `mayReadAttachment`(러너 토큰 첨부 읽기 범위 — 열린 런의 트리거 첨부만), `supports`(러너가 없으면 true), 서버 종료·hello 타임아웃은 전송만 닫고 교체·폐기만 `disconnect(true)`.
- `src/connections.ts` — 붙은 러너와 에이전트 배정(러너 토큰에 묶인 등록 에이전트는 그 토큰의 러너만, 묶임이 없으면 먼저 알린 러너가 맡고 뒤 러너의 같은 id 는 「충돌」, 교체는 자리 잇기). 묶임 없는 등록 에이전트는 hello·러너가 빠진 뒤 지금 맡는 러너 토큰에 묶는다(`claimUnbound`).
- 러너 프레임 속도 제한 — 소켓마다 버킷 둘(`run.event` 와 나머지, 숫자는 서버 `LIMITS.runner`, 옵션 `frameLimit` 로 받는다). 넘친 프레임은 버리고 warn·`onLimited`(운영 사건)는 주소별 1분에 한 번. 열린 런·기다리는 승인을 가리키는 종결·승인 프레임 가운데 처리기가 받아들일 것은 버킷을 거치지 않는다(승인 요청은 런마다 누계 32개까지 — `namesOpenWork`, 까닭과 상한은 그 머리 주석).
- `src/approvals.ts` — 러너 승인 정규화(서버 쪽 id `runner:<토큰 id>:<러너 id>`)와 10분 기한 타이머(지나면 러너에 `deny`, `expired`).

### 2.4b `packages/claude-runner` (사람의 머신에서 실행 — CLI `dodok-runner`)

Claude Agent SDK 로 Claude Code 에이전트를 돌려 서버 `/runner` 에 붙는 러너. 서버 이미지가 같은 커밋의 tgz 를 품고(`/app/runner`, `pack:runner`) 연결 페이지가 내려준다 — SDK 는 번들에 넣지 않고 설치 때 npm 에서 받는다. 설치·운영은 `docs/guides/deploy.md` 「Claude 러너 설치」 절.
- `src/main.ts` — 인자·설정 읽기·SIGINT/SIGTERM(도는 런을 멈추고 최대 5초). `src/config.ts` — 설정 파일 `RunnerConfig`(strict)·토큰 파일 0600 경고. `src/connection.ts` — 연결·hello·재접속 백오프(1~30초)·서버가 끊으면 종료 2·연결 세대. `src/scheduler.ts` — 동시 상한·대기.
- `src/run.ts` — 런 하나(`query()` 하나, `buildQueryOptions` — preset·`append`·`snapshot: false`·훅·`strictMcpConfig`·`settingSources: []`·env 허용 목록, 「이미 있는 세션」이면 `resume` 재시도, 런 비용 차이). `src/stream-map.ts` — SDK 스트림 → `RunEvent`. `src/sdk.ts` — SDK 를 import 하는 유일한 파일(`SdkPort`).
- `src/post-tool.ts`·`src/files.ts` — `mcp__dodok__post`(카드·파일, 작업 디렉터리 경계, macOS `O_NOFOLLOW_ANY`·Linux `/proc/self/fd`). `src/approvals.ts` — `canUseTool` → 승인 프레임·요약 이스케이프. `src/images.ts`·`src/attachments-http.ts` — 트리거 이미지 받기·파일 올리기. `src/mask.ts` — 호스트 경로 가림(못 알아보는 모양은 머리 주석).
- `scripts/build.mjs` — esbuild 단일 번들 `dist/main.js`(SDK external, 정확 핀 확인). `scripts/fake-messages-api.ts` — 런 0회 하네스의 로컬 가짜 Messages API(`docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」 절).

### 2.5 `apps/web`

Phase 1 ② 웹 MVP 실물(스펙 `docs/superpowers/specs/2026-09-19-web-mvp-design.md`, 계획 `docs/superpowers/plans/2026-09-19-web-mvp.md`)
위에 Phase 2 ① 활동 패널·승인(스펙 `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`)과
Phase 2 ② components v1 렌더러(스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md`, 계획 `docs/superpowers/plans/2026-09-21-components-v1.md`)와
Phase 2 ③ 첨부·이미지(스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md`, 계획 `docs/superpowers/plans/2026-09-23-attachments.md`)와
Phase 2 ④ PWA·푸시(스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`, 계획 `docs/superpowers/plans/2026-09-23-pwa-push.md`, 구현과 달라진 것은 스펙 11장)와
Phase 3 ② 설정 마법사의 연결 페이지(스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`, 계획 `docs/superpowers/plans/2026-09-24-setup-wizard.md`, 구현과 달라진 것은 스펙 「구현과 맞춘 것」 장)와
Phase 3 ③ 운영 화면(스펙 `docs/superpowers/specs/2026-09-25-ops-hardening-design.md`, 계획 `docs/superpowers/plans/2026-09-25-ops-hardening.md`, 구현과 달라진 것은 스펙 「구현과 맞춘 것」 장)과
Phase 4 ① 스레드·검색(스펙 `docs/superpowers/specs/2026-09-25-threads-search-design.md`, 계획 `docs/superpowers/plans/2026-09-25-threads-search.md`, 구현과 달라진 것은 스펙 「구현과 맞춘 것」 장)이 얹혔다.
React 19 + Vite 8 + TanStack(Query·Router·Virtual) + Tiptap 작성기 + Streamdown 렌더 + Tailwind 4·shadcn. 의존성은 전부 정확 핀이고 웹 MVP 태스크 2 에서 한 번에 넣었다(Phase 2 ③ 은 0).
Phase 2 ④ 가 PWA·오프라인 사본 몫으로 더했다 — `vite-plugin-pwa`(dev)·`workbox-precaching`·`workbox-routing`·`workbox-window`·`@tanstack/query-persist-client-core`·`@tanstack/query-async-storage-persister`·`idb-keyval`.
코드 하이라이트는 `shiki` — `shiki/core`·JS 정규식 엔진·언어 문법을 하나씩 동적 import 한다(초기 조각에 없다). shiki 가 든 조각은 `hl-` 이름을 달고 서비스 워커 사전 저장에서 빠진다(`vite.config.ts` 의 `chunkFileNames`·`globIgnores`).
`zod` 는 CSP 때문에 웹이 직접 의존한다 — 앱(`main.tsx`)과 서비스 워커(`sw.ts`)의 첫 import 인 `lib/zodJitless.ts` 가 `config({ jitless: true })` 로 스키마를 만들기 전에 문자열 코드 실행(`Function`)을 끈다. 빌드에서는 zod 와 그 설정을 `zod` 조각 하나에 묶는다(`codeSplitting` 그룹) — 따로 두면 zod 가 든 공용 조각이 설정보다 먼저 평가돼 CSP 위반 보고가 난다(앱은 돈다). 조각 배치를 바꿨으면 `docs/guides/deploy.md` 「보안」의 CSP 확인을 다시 한다.
서버 상태의 진실은 Query 캐시이고 wire 이벤트가 그것을 패치한다. 스트리밍 중인 런만 Zustand 스토어에 둔다(스펙 4장, 데이터 흐름 A).
캐시 모양: 채널 `["timeline", ch]` 은 **루트만**(답글은 seq 만 기록 — 채널 `lastSeq` 는 루트·답글 모두의 최대 seq 라 답글 뒤의 루트가 거짓 빈틈이 되지 않는다),
스레드 `["thread", ch, root]` 는 루트+답글 seq 순 한 목록(REST 로 처음 받고 그 뒤는 wire 가 고친다, 캐시가 없는 스레드의 답글은 버린다 — 칩은 루트 `message.updated` 가 맞춘다).
**같은 Query 키의 관찰자는 모두 같은 `queryFn` 을 준다** — TanStack Query 는 마지막으로 다시 그려진 관찰자의 옵션을 쿼리 옵션으로 쓰고, `invalidateQueries` 뒤 다시 받기는 그 `queryFn` 으로 돈다
(읽기만 하는 관찰자가 `skipToken` 을 주면 다시 받기가 `Missing queryFn` 으로 실패한다). 읽기만 할 때도 그 키의 쿼리 옵션(`timelineQuery`·`threadQuery`)을 펼쳐 `select` 만 더한다.
**REST 로 받는 동안 온 wire 변경은 `withThreadEdits`·`withTimelineEdits`(`realtime/timelineCache.ts`)가 모아 받은 페이지에 다시 적용한다** — 그래서 `updateThread`·`updateTimeline` 에 넘기는 함수는
새 페이지에 다시 적용돼도 맞아야 한다(upsert·멱등, 과거 페이지 붙이기는 「가장 옛 항목이 같을 때만」).

```
index.html                 lang="ko", color-scheme light dark, /favicon.svg, theme-color 둘(라이트 #f6f7f8·다크 #18191c), apple-touch-icon
vite.config.ts             별칭 @ → src, dev 프록시(/api·/socket.io → DODOK_API_ORIGIN, 기본 http://127.0.0.1:3000 — 브라우저에게 같은 출처),
                           빌드 청크(editor·markdown), Vitest(jsdom, test/setup.ts).
                           VitePWA(injectManifest, src/sw.ts, registerType prompt, injectRegister false, 매니페스트 — includeManifestIcons false).
                           개발 모드 SW 는 셸 환경 VITE_PWA_DEV=1 일 때만(기본 끔 — 스펙 11장 R4). define `__BUILD_ID__` = VITE_BUILD_ID ?? 빌드 시각(오프라인 사본 buster)
tsconfig.sw.json           서비스 워커 타입 검사 — lib ES2023·WebWorker, include src/sw.ts·src/pwa/sw-logic.ts. 앱 tsconfig 는 sw.ts 를 뺀다(sw-logic.ts 는 둘 다).
                           typecheck·build 가 두 설정을 모두 돈다
public/                    favicon.svg + PWA 아이콘 PNG 다섯(pwa-64·192·512, maskable-icon-512, apple-touch-icon-180 — @vite-pwa/assets-generator 로 한 번 만들어 커밋)
components.json            shadcn 규약(new-york·neutral, 별칭 @/ui·@/lib/utils) — CLI 는 워크스페이스에서 돌리지 않는다(upstream 이 npm 패키지를 넣는다)
src/
├─ main.tsx                진입점 — bootApp(createApp(), …) 뒤 virtual:pwa-register 동적 import → startPwa(렌더를 막지 않는다)
├─ sw.ts                   서비스 워커(Phase 2 ④) — 미리 저장(주입 자리 self.__WB_MANIFEST 는 한 번만 읽는다)·탐색 폴백(목록에 index.html 이 있을 때, /api/·/socket.io/ 제외)·
│                          SKIP_WAITING · push → 알림 · notificationclick → 같은 출처 창에 focusAndNavigate(focus 가 거절·던져도 postMessage({ type: "navigate" }) 는 보낸다), 없으면 openWindow ·
│                          pushsubscriptionchange → 다시 구독·등록
├─ styles.css              Tailwind 진입(@import) + theme/tokens.css, Streamdown 클래스 @source, 한국어 줄바꿈(word-break: keep-all)
├─ app/
│  ├─ App.tsx              Provider 조립(Query·Router·Wire·Tooltip·Toaster) + Query 밖 401 등록
│  ├─ createApp.ts         앱 하나의 QueryClient·Router·onUnauthorized(`/login?next=` 로 replace, `ignoreBlocker` — 원문 대화상자의 이동 막기를 건너뛴다. 로그인 없이 여는 화면(isPublicPath — `/join/`·`/reset/`)이면 상태만 비우고 머문다) (테스트는 메모리 히스토리를 넘긴다). notify(승인 알림의 화면 사정 + 채널 이동 알림 onLocationChange —
│  │                       router.subscribe("onResolved")), 서비스 워커의 navigate 메시지 → safeNotificationUrl → router.navigate, captureInstallPrompt
│  ├─ boot.tsx             bootApp — onlineManager.setOnline(navigator.onLine) → 오프라인 사본 복원(최대 1초) → registerSessionReset(사본 지우기) → 렌더. main 과 테스트가 같은 것을 부른다
│  ├─ router.tsx           라우트(/login·/join/$token·/reset/$token(둘은 가드 밖)·가드 레이아웃·/·/c/$channelId(+/settings·/activity·/t/$rootId)·/agents·/settings/connection·/settings/operations·/settings/members), safeNext, isPublicPath(가드 밖 두 라우트 판정 — `/join/`·`/reset/`), 라우트 코드 분할
│  ├─ queryClient.ts       Query 기본값 — 전역 오류 토스트(`meta.silent` 로 끔, 폼 오류 VALIDATION·CONFLICT 제외), 재시도는 네트워크·5xx 만, 401 → 로그인.
│  │                       403 FORBIDDEN 은 「권한이 없습니다」(토스트 id `forbidden` 하나) + `silent` 와 무관하게 me 를 다시 받아 관리 화면을 잠근다(역할이 내려간 직후 남은 버튼).
│  │                       me 는 토스트하지 않고, 값이 없는 me 의 401(첫 가드)은 가드에 맡기며, 값을 가진 me 의 401(사본으로 뜬 뒤 세션 만료)은 onUnauthorized
│  ├─ session.ts           로그아웃·401 정리(resetClientState — 등록된 정리 훅: 오프라인 사본 지우기·dropLocalPush)와 Query 밖 REST 401 통지
│  ├─ fileDrop.ts          앱 수준 파일 드롭 막기(브라우저가 파일을 열어 앱을 떠나지 않게) + 「이미지는 입력 칸에 놓아 주세요」 한 문구·한 토스트 id. 작성기가 받은 드롭은 건드리지 않는다
│  ├─ NotFound.tsx         없는 경로(defaultNotFoundComponent)
│  ├─ RouteError.tsx       라우트 오류 화면(연결 문제 ↔ 코드 오류를 가른다)
│  └─ layout/
│     ├─ AppShell.tsx      사이드바 + 배너 + 페이지. 768px 미만은 사이드바를 왼쪽 시트로, 닫히면 초점 복귀. 검색 대화상자(`⌘K`/`Ctrl+K` — 다른 대화상자가 열려 있으면 무시,
│     │                    `preventDefault`)와 그것을 여는 컨텍스트 `OpenSearchContext`
│     ├─ Sidebar.tsx       워크스페이스 이름·검색 칸(누르면 검색 대화상자, `⌘K` 표시)·채널 목록·「채널 만들기」·「에이전트」·「멤버」·「운영」(admin 이상 — useCanManage)·「연결」(owner — useIsOwner)·연결 상태·「내 계정」·로그아웃.
│     │                    「운영」 옆 배지 = ops/status 의 unacked warn + error(0 이면 없음, 100 이상 「99+」, sr-only 「(확인 안 한 사건 n건)」) — `ops.event` 로 실시간, 주기 재조회는 없다
│     ├─ ChannelHeader.tsx 채널 이름·주제, 에이전트 아바타 묶음(+N), 설정 패널 여닫기, 좁은 화면 메뉴 버튼
│     ├─ Banners.tsx       wire 끊김·`rejected`·`protocol_mismatch` 배너 + OpenClaw 미연결 배너(둘은 함께 보일 수 있다, owner 에게는 「연결 설정 보기」 링크) + 오프라인 배너
│     │                    「오프라인 — 저장된 내용을 보여 줍니다」(useOffline — 그때는 「서버에 다시 연결하는 중…」을 내지 않는다)
│     ├─ ConnectionDots.tsx Gateway·플러그인 점 — wire 가 끊기면 마지막 값을 믿지 않고 「알 수 없음」
│     ├─ NotifySettings.tsx 사이드바 하단 「알림」(벨) → Dialog 패널(Phase 2 ④, 옛 NotifyToggle 을 흡수) — 이 기기의 푸시 상태 다섯(미지원·설치 필요(iOS)·거절됨·꺼짐·켜짐)·
│     │                    「푸시 알림 켜기」·「끄기」·실패 이유(role=alert, 거절이면 상태 줄 하나)·「앱 설치」. 켜고 끄는 동안 닫히지 않는다.
│     │                    푸시가 없는 브라우저(iOS 아님)에서 권한이 default 면 「탭이 열려 있을 때만 알림 켜기」(옛 동작)
│     ├─ PanelTabs.tsx     오른쪽 패널의 탭 셸(「설정」·「활동」, 스레드를 연 동안만 「스레드」, `data-testid="page-channel-panel"`). 넓은 화면은 360px `<aside>`, 좁은 화면은 전체 시트.
│     │                    내용은 포털 하나로 옮겨 다녀 탭을 바꿔도 안쪽이 리마운트되지 않는다.
│     │                    초점: 좁은 화면 시트는 열면 지금 탭 링크(`data-tab-id`), Esc·닫기면 헤더 「채널 설정」 링크. 넓은 화면은 「설정 닫기」·「활동 닫기」
│     │                    링크를 누르면 패널이 내려가기 전에 같은 헤더 링크로 옮긴다(헤더에 활동을 여는 자리가 없어 두 탭 모두 그 자리).
│     │                    스레드 탭은 칩·「스레드에서 답하기」로 열었고 그 요소가 아직 붙어 있으면 닫을 때 그리로(`features/threads/threadOpener.ts` — 넓은 화면 닫기 링크·좁은 화면 시트 모두),
│     │                    주소·검색·푸시로 열었거나 다른 스레드로 옮겼으면 헤더 「채널 설정」
│     └─ sidebarSheet.tsx  좁은 화면 시트 열기 컨텍스트 + 지금 화면의 메뉴 버튼(초점 복귀 대상). admin 이상이고 확인 안 한 warn·error 가 있으면 메뉴 버튼에 빨간 점과
│                          「채널 목록 열기 (확인 안 한 운영 사건 N)」(member 이거나 넓은 화면이면 ops API 를 부르지 않는다)
├─ api/
│  ├─ http.ts              같은 출처 REST(`/api/v1`) — 인증은 httpOnly 쿠키, 토큰을 다루지 않는다. ApiRequestError(서버 봉투의 `details` 까지 — 폼은 formErrors.ts `detailField` 로 칸을 가른다)·NetworkError
│  ├─ queries.ts           쿼리 키 `qk` 와 공용 훅(me·channels·channel·members·agents·adapter). 운영 키 opsStatus·opsRuns(days)·opsEvents(severity)·opsEventsAll,
│  │                       스레드 키 thread(ch, root)·threads(ch — 무효화 앞머리)·threadsAll·recentThreads(채널 → 마지막으로 연 루트) 도 여기. useCachedMe — me 캐시를 관찰자 없이 캐시 구독으로 읽는다(useIsOwner 는 그 `role === "owner"`, useRole·useCanManage(admin 이상 — 관리 동작을 보일지), 가입 폼의 「지금 로그인한 계정」 줄).
│  │                       팀: usePeople(`GET /people` — 작성자·@ 후보·나간 멤버, 키 people), 멤버 표·대기 초대는 키 앞머리 `team`(teamMembers·invites)
│  │                       (useSyncExternalStore — useMe 관찰자를 두면 401 정리 뒤 me 를 다시 불러 로그인 이동을 되돌린다). role 이 없는 옛 me 는 owner 가 아니다
│  └─ formErrors.ts        VALIDATION·CONFLICT 를 폼 칸·문구로 잇는 도우미
├─ realtime/
│  ├─ wire.ts              Socket.IO 클라이언트(토큰 없음 — 쿠키 인증, `transports: ["websocket"]` 만: polling 첫 GET 에는 Origin 이 없다), WireStatus, WireAckError.
│  │                       소켓은 `io()` 가 아니라 `WireManager`(Manager 하위 클래스)가 연다 — socket.io-client 의 Manager 는 여는 동안 engine `error` 만 들어, WebSocket 이 핸드셰이크 전에
│  │                       오류 없이 close 로만 닫히면 그 시도를 실패로 몰라 연결 제한시간(20초)까지 다음 시도를 잡지 않는다. WireManager 가 그 close 를 engine `error`
│  │                       (`"<reason> before handshake"`)로 알려 백오프 → 다음 시도로 보낸다. protected `emitReserved` 등 내부 가정에 기대므로 socket.io-client 는 정확 핀이고,
│  │                       판을 올리면 `wire.test.ts`(실제 Manager + 가짜 전송)가 가정이 깨졌는지 잡는다
│  ├─ WireProvider.tsx     로그인(me 캐시)이 확인되면 소켓을 만들어 붙인다 + `useChannelSubscription`. presence.update(연결마다 강제, visibilitychange·채널 이동 때 값이 바뀌면,
│  │                       끊겨 있으면 안 보냄, 채널 id 는 uuid 일 때만) · 로그인 확인 때 syncPushSubscription · 세션 정리 훅과 「값 없는 me 의 401」에서 dropLocalPush
│  ├─ handlers.ts          서버 이벤트 → Query 캐시·런 스토어·작성 중 저장소·연결 상태. `system.notice` 토스트 지속시간.
│  │                       메시지 분배: 루트 → 채널 캐시(+ 연 스레드의 루트), 답글 → 채널은 seq 만(noteSeq)·캐시가 있는 스레드에 upsert.
│  │                       `ops.event` → 상태 캐시의 unacked 를 곧바로 덮고(상태를 아직 안 받았으면 만들지 않는다) opsStatus·사건 목록 무효화.
│  │                       `people.changed` → 사람 목록을 통째로 바꾸고 `team`(멤버 표·대기 초대) 무효화, 목록의 내 역할이 me 와 다르면 me 를 곧바로 다시 받는다(정본은 `/auth/me`).
│  │                       탭 안 승인 알림은 admin 이상에게만(`notifyApproval` 을 부르기 전에 여기서 거른다)
│  │                       첫 연결이 아닌 재연결이면 adapter·opsStatus·opsEventsAll 을 무효화한다 — 끊긴 사이의 변화는 팬아웃으로 다시 오지 않는다
│  ├─ subscriptions.ts     한 채널 구독·빈틈 이어 받기·과거 페이지 REST(5쪽 초과면 타임라인 리셋). 재동기화 응답은 루트는 채널, 답글은 연 스레드 캐시에만, `threadRoots` 는 가진 루트만
│  │                       갈아 끼운다. REST 이어 받기(루트만)로 넘어가거나 `fresh` 로 캐시를 버리면 그 채널의 스레드 캐시를 낡은 것으로(staleThreads — 보고 있는 스레드는 곧바로 다시 받는다)
│  ├─ timelineCache.ts     `["timeline", channelId]`·`["thread", channelId, rootId]` 읽기·쓰기(updateTimeline·updateThread) + withTimelineEdits·withThreadEdits(받는 동안 온 변경을 기록해 결과에 다시 적용)
│  ├─ runReplay.ts         `run.events.replay` 와 실시간 `run.event` 의 경합(ack 전 이벤트는 버퍼)
│  └─ typing.ts            받은 `typing` 저장(5초 TTL)과 작성 중 행위자 목록
├─ features/
│  ├─ activity/            ActivityPanel.tsx(`/c/$channelId/activity` — 맨 위 미해결 승인 카드 1장 + 런 목록 + 타임라인. REST 목록과 런 스토어를 합치고,
│  │                       종료를 한 번 본 런은 재조회가 늦어도 목록에 붙들어 둔다 — REST 「위」.
│  │                       끊긴 사이 끝난 런은 마지막으로 본 상태를 자리값으로 REST 「밑에」 깔고 목록을 다시 받는다 — 서버 사실이 오면 물러난다.
│  │                       더는 진행 중이 아닌 줄 아는 자리값에는 `frozenAt` 을 달아 소요를 멈춘다) · RunList.tsx(`max-h-[40%]`, 진행 중 소요는 `useNowTick`) ·
│  │                       RunTimeline.tsx · ToolCallRow.tsx(인자·결과 접힘 기본, `[+N chars hidden]` 이면 「잘렸습니다」) · Notice.tsx(패널 안 상태 문구·「다시 시도」) ·
│  │                       timeline.ts(순수: 런 이벤트 → 행. 텍스트 델타는 행이 되지 않는다. mergeRuns·mergeRunEvents 로 REST 바탕 + 실시간) ·
│  │                       useLiveRunEvents.ts(고른 런의 `run.event` 를 소켓에서 직접 — 런 스토어는 텍스트와 마지막 seq 만 들고 있어 행을 못 만든다)
│  ├─ approvals/           approvalStore.ts(Zustand, 채널별. 승인이 들어오는 길 둘: 구독 ack 의 `pendingApprovals`(syncPending)·wire `approval.requested/resolved`(apply) — 활동 탭은 읽기만 한다.
│  │                       확정 뒤에 온 `pending` 은 늦은 프레임이라 무시) · ApprovalCard.tsx(제목·severity 색·툴 인자·카운트다운·`allowedDecisions` 버튼만,
│  │                       누르면 잠그고 ack 대기, 확정되면 결과 한 줄로 남는다. member 에게는 버튼 대신 「관리자가 결정합니다」, ack FORBIDDEN 이면 me 를 다시 받는다. 결정 뒤 초점은 그 결과 줄로 — 「이 카드에서 누른 승인 id」일 때만 옮긴다) · countdown.ts(남은 시간 문구 — 공용 틱 `useNowTick` 을 본다) ·
│  │                       notify.ts(브라우저 알림 — 권한·지원 여부를 한 자리에서 가르고, 중복은 모듈 `Set` 으로 막는다(확정되면 `forgetApproval` 로 지운다 — 한 탭 안에서만 산다).
│  │                       이 기기에 푸시가 켜져 있으면(`pushOnThisDevice`) 쉰다 — 푸시가 대신 울린다(PWA 스펙 결정 8).
│  │                       이미 답한 승인은 `handlers.ts` 가 `apply` **뒤** 들어온 페이로드의 `status` 로 거른다. `tag` 는 `approval:<id>`)
│  ├─ attachments/         Phase 2 ③. 메시지 첨부와 작성기 올리기. url.ts(`artifact://<id>` → `/api/v1/attachments/<id>[?download=1]`) ·
│  │                       resolve.ts(순수: 카드의 `artifact://<ref>` → **그 메시지의** 첨부. 이름 후보를 우선순위로 — 그대로 → 디코드 → 관대한 디코드 → 저장 규칙으로 다듬은 것,
│  │                       마지막에 id. `https://` 는 그대로, 그 밖은 blocked — 스펙 11장 Ruling 5) · format.ts(크기 문구) ·
│  │                       AttachmentGrid.tsx(1장은 360×320 안에 비율대로, 2장 이상 2열, 자리는 저장된 가로·세로로 미리, 못 불러오면 파일 카드로 물러남) ·
│  │                       FileCard.tsx(아이콘·이름·크기·종류·「내려받기」 — `download` 속성 없이 서버 Content-Disposition 에 맡긴다) ·
│  │                       ImageViewer.tsx(크게 보기 — ui/dialog 위, ←/→·`n / 전체`·「원본 내려받기」·Esc, 닫으면 연 이미지로 초점. `useImageViewer` 를 메시지 격자와 media 블록이 같이 쓴다) ·
│  │                       MessageAttachments.tsx(본문 아래 이미지 격자 + 파일 카드, 카드가 가리킨 첨부는 뺀다) ·
│  │                       upload.ts(XHR 업로드·진행·취소, 형식·5 MB 검사와 문구, 507 이면 본문과 무관하게 「서버 디스크 여유가 부족해 올리지 못했습니다」) · useComposerAttachments.ts(작성기 칩 상태 — 넣는 즉시 올리고, 빼면 끊고, 채널이 바뀌면 모두 비운다. 10장 상한)
│  ├─ auth/                LoginPage(이메일·비밀번호가 기본, 접힌 「owner 로컬 토큰으로 로그인」) · JoinPage(`/join/<token>`)·ResetPage(`/reset/<token>`) — invite.tsx 의 InviteGate 가
│  │                       `POST /invites/lookup` 을 본문 토큰으로 부른 뒤 폼(무효·다른 종류 링크는 한 문구, 초대 경로 IP 버킷이라 `retry: false`, 쿼리 키에 토큰 원문 대신 `useId` — 토큰이 바뀌면 `key={token}` 으로 다시 마운트), 409 는 `details.field` 칸 아래, 수락 404 는 무효 화면.
│  │                       성공하면 `useFinishInvite` 가 클라이언트 상태를 비우고 `/` 로 replace(주소창의 토큰을 걷는다). 로그인된 채 열면 폼 위에 「지금 @<핸들> 로 로그인돼 있습니다 — 가입하면 이 브라우저는 새 계정으로 바뀝니다」 ·
│  │                       fields.tsx(AuthField·비밀번호 규칙·로그인 전 경로 공통 문구 authErrorText — 429 는 버킷을 따른다: 로그인 「(1분 5회)」, 초대 경로는 숫자 없이 ·
│  │                       fieldErrorText — 알려진 칸 오류(핸들·이메일 409, 예약 핸들 400, 현재 비밀번호 400)는 서버 문구 대신 고정 문구(합쇼체), 칸 오류가 나면 그 칸으로 초점) ·
│  │                       mutations(useLogin(`{ token }`·`{ email, password }`)·useAcceptInvite·useResetPassword·useLogout — 응답 `sessionToken` 은 쓰지 않는다, gcTime 0. 로그아웃은 disablePush 를 최대 3초 기다린 뒤 POST /auth/logout)
│  ├─ account/             AccountDialog(사이드바 하단 「내 계정」 — 표시 이름 `PATCH /me`(me 캐시의 user 를 고친다), 비밀번호 바꾸기 `POST /me/password`(틀린 현재 비밀번호는 400 `field: "current"` → 그 칸 아래).
│  │                       owner 에게는 비밀번호 칸 대신 「로컬 토큰은 .env 의 LOCAL_AUTH_TOKEN」 안내) · mutations
│  ├─ members/             Phase 4 ② 팀. 멤버 화면 `/settings/members` — admin 이상(member 는 API 를 부르지 않고 「권한이 없습니다」).
│  │                       MembersPage.tsx(멤버 표 — 핸들·이름·이메일·역할(「소유자」·「관리자」·「멤버」)·가입일, 390px 에서는 제 상자(`relative overflow-x-auto`) 안에서 가로 스크롤 ·
│  │                       대기 중인 초대 — 역할·만료·「폐기」, admin 에게는 admin 초대의 폐기 버튼이 없다) · MemberRowActions.tsx(역할 셀렉트 — owner 만·owner 줄 제외·바꾸는 즉시 적용,
│  │                       「재설정 링크」(확인 → 링크 한 번)·「내보내기」(확인 대화상자)) · InviteDialog.tsx(owner 는 역할 라디오, admin 은 member 고정 문구 → 링크 한 번) ·
│  │                       IssuedLink.tsx(원문 링크 — CopyBlock wrap, 「이 링크는 다시 볼 수 없습니다」, 「복사했습니다」로만 닫힘, useLeaveGuard) · queries · mutations(역할 바꾸기·내보내기 뒤 대기 초대를 다시 받는다 —
│  │                       서버가 그 사람이 발급한 링크를 폐기한다). 날짜는 로컬 시간대(`Intl.DateTimeFormat("ko-KR")`)
│  ├─ components/          components v1 카드 렌더러(Phase 2 ②). 사람·에이전트 메시지(MessageItem)와 시스템 카드(SystemCard 의 「이어가기」)가 함께 쓴다.
│  │                       Components.tsx(카드 전체: 블록을 배열 순서대로 → 모달 트리거 → 결과 줄 `@핸들 — 라벨: 값`(오래된 것부터, 20건이면 「최근 20건」).
│  │                       결정 뒤 초점은 ack 이 돌려준 **내** 상호작용 id 의 결과 줄로만) ·
│  │                       state.ts(순수: 비활성 규칙 한 곳 — 연결 → 만료 → 소비 → 권한(`allowedUsers` 가 비어 있지 않을 때만) → 전송 중, 사유 문구) ·
│  │                       useInteract.ts(`component.interact` 래퍼 — `send` 는 거부하지 않고 `SendResult` 로 성공·실패를 돌려준다. 버튼·셀렉트는 토스트(RUN_LIMIT·RATE_LIMITED 는 한국어 문구 — run_error 「다시 실행」도 이 길),
│  │                       모달은 `toast: false`. 소켓·`components.id` 가 없으면 보내지 않고 `DISCONNECTED`) ·
│  │                       DisabledHint.tsx(비활성 사유를 **보이는 글**로 — `aria-hidden` 인 12px 글을 컨트롤이 `aria-describedby` 로 가리킨다, `title` 은 안 쓴다) ·
│  │                       OptionList.tsx(옵션 목록 한 렌더러 — 단일=라디오·다중=체크박스, fieldset+legend, 6개 넘으면 스크롤 상자. 셀렉트와 모달 select·radio 가 함께) ·
│  │                       interactions.ts(순수: 결과 줄 문구 `summarize`·순서 `oldestFirst` — 라벨 해석은 서버 `formatInteractionText` 의 사람 쪽과 같다) ·
│  │                       blocks/(ActionsBlock — 버튼 줄 + 셀렉트, 링크 버튼은 `https://` 와 풀린 첨부만 새 탭 · SelectItem — 고르기 + 「보내기」 확정 ·
│  │                       SectionBlock — MessageBody 로 마크다운 · SeparatorBlock · MediaBlock — https 이미지(`no-referrer`·`lazy`, 실패하면 링크로)와 풀린 첨부 이미지·파일 카드, 누르면 크게 보기 ·
│  │                       FileBlock — 첨부면 FileCard, https 면 이름·크기 + 「열기」 · artifact.tsx — 못 푼 값의 문구 둘 「첨부를 찾을 수 없습니다」·「열 수 없는 링크입니다」, 셋이 `resolveRef` 와 같이 쓴다) ·
│  │                       modal/(ComponentModal — `triggerLabel` 버튼 + Dialog + 제출, ack 오류는 대화상자 안 · fields.tsx — 필드 7종 → 위젯, 못 읽는 입력은
│  │                       제출 때 `validity.badInput` · validate.ts — 순수 화면 검사(서버 `fieldSchema` 와 같은 경계, 코드 포인트로 센다), 칸 id 로 찾는 객체는 프로토타입 없이)
│  ├─ channels/            ChannelList · CreateChannelDialog(만들면 설정으로) · HomeRedirect(`/` → 첫 채널, 들어올 때 받은 목록으로만 판단) · mutations
│  ├─ messages/            timeline.ts(입장·과거·upsert·낙관적 교체·빈틈 · 떨어진 창 `hasNewer` — around 로 갈아 끼운 창에는 창 안(가장 새 항목의 seq 이하)과 가진 것만 넣고
│  │                       `lastSeq` 만 올린다, lastSeq 는 내려가지 않는다)·groupRows.ts(날짜 구분선·묶음)·useTimeline(timelineQuery — 채널 skipToken·스레드 threadQuery)·useOlderPages·useAuthors(작성자·사람 멘션은 사람 목록으로 — 나간 멤버(role 없음)는 「나간 멤버 @<leftHandle>」 흐린 글씨, 멘션은 옛 핸들),
│  │                       결과로 가기 jump.ts(jumpToSeq — around 로 갈아 끼우기·loadNewer 아래로 이어 받기·loadLatest 최신으로)·jumpTarget.ts(목표 zustand 스토어 — URL 에 두지 않는다, 강조 2초)·
│  │                       useJump(구독 응답 뒤(`lastSeq > 0`)에만 around, 목표 행으로 스크롤·강조)·useNewerPages(떨어진 창의 아래 끝에서 다음 쪽),
│  │                       MessageList.tsx(TanStack Virtual, 끝 붙기·「새 메시지」 칩 — 기준은 가진 마지막 메시지의 seq, 떨어진 창이면 「최신 메시지로」·`followOnAppend` 끔·보내는 중 항목이 생기면 먼저 최신으로(loadLatest), `threadRootId` 면 영역 이름
│  │                       「스레드 메시지」에 칩·메뉴 없음), MessageItem(루트 아래 ThreadChip·「스레드에서 답하기」)·MessageBody(Streamdown, 원시 HTML 끔,
│  │                       단일 개행 → br, 마크다운 이미지는 링크로, 확정 본문만 코드 하이라이트 — codeHighlight.ts(Streamdown 플러그인·언어 목록과 별칭, 실패는 페이지 수명 동안 칠하지 않음)·
│  │                       shikiEngine.ts(지연 로딩되는 shiki 엔진 — 밝음·어두움 github 테마, 바탕은 앱 토큰))·MentionChip·mentionMarkdown·SystemCard(MessageItem 과 SystemCard 의 components 는 `features/components` 의 `<Components>` 가 그린다)·
│  │                       PendingItem(보내는 중 첨부는 서버 경로로, 크게 보기 없음, 사유 rate_limited 면 rateLimited.ts 의 「너무 빠르게 보내고 있습니다 — 잠시 뒤 다시」)·pendingActions·MessageErrorBoundary,
│  │                       SystemCard 의 run_limit 은 admin 이상에게만 링크 — scope workspace 면 「운영에서 한도 바꾸기」, channel 이면 「채널 설정에서 한도 바꾸기」, 모르는 kind 는 정보 모양, ChannelPage.tsx(채널 확인 뒤에만 안을 그린다, 확인되면 touchRecentChannel).
│  │                       MessageItem 은 본문이 비면 본문을 그리지 않고, 본문 아래 `MessageAttachments` → components 카드 순으로 그린다
│  ├─ ops/                 Phase 3 ③. 운영 화면 `/settings/operations` — admin 이상(member·role 없는 옛 me 는 ops API 를 부르지 않고 「권한이 없습니다」).
│  │                       OpsPage.tsx(섹션 넷 — 상태를 30초마다 다시 받는 것은 이 화면만(OPS_STATUS_POLL_MS, 탭이 가려지면 쉰다)) ·
│  │                       StatusCard.tsx(Gateway·플러그인·Gateway 버전(drift 면 「저장소가 검증한 버전(<핀>)과 다릅니다」)·디스크·직전 종료·서버·DB, 문제가 있는 줄만 `data-problem` 강조 + sr-only 「문제:」.
│  │                       연결 두 줄은 wire 가 connected 이고 어댑터 캐시가 있으면 `useAdapterStatus`(배너·연결 점과 같은 캐시), 아니면 ops/status 값) ·
│  │                       RunsTable.tsx(「오늘 / 7일」, 채널별·에이전트별 런·실패·중지·차단, 채널 이름은 채널 링크. usageTrusted 가 false 면 「토큰·금액은 측정 불가 — … (ADR 0005)」 한 줄,
│  │                       768px 미만은 표 대신 카드 목록) ·
│  │                       LimitForm.tsx(워크스페이스 일일 상한 — 빈칸 null(무제한), 1~10000 정수 아니면 보내지 않음, 오늘 사용량 막대 또는 「오늘 n회 · 무제한」, 「오늘 워크스페이스 상한으로 막힌 런 n회」,
│  │                       채널별 한도는 각 채널 설정 「릴레이 정책」이라는 안내 문장) ·
│  │                       EventList.tsx(심각도 필터·「모두 확인」·「더 보기」(useInfiniteQuery), 확인 안 한 줄 굵게·확인한 줄 흐리게, 모르는 severity 는 정보 아이콘·원문 라벨) ·
│  │                       copy.ts(kind → 고정 문구 — 모르는 kind 는 「알 수 없는 사건 (kind)」, 런 한도는 「(워크스페이스)」·「(#채널 이름)」·「(채널)」, 끊김은 「(지금도)」 또는 detail.downMs 로
│  │                       「(n분 동안)」, 「×n」, 시각은 끊김이면 끊긴 때(firstAt − detail.thresholdMs) 아니면 lastAt) ·
│  │                       queries.ts(useOpsStatus({ poll, enabled })·useOpsRuns·useOpsEvents) · mutations.ts(useAckEvents — 성공하면 status·목록을 다시 받는다(0 으로 덮지 않는다), useSaveRunLimit).
│  │                       ops 쿼리는 오프라인 사본(`pwa/persist.ts`)에서 먼저 뺀다
│  ├─ runs/                runStore.ts(Zustand, seq 중복 제거·재생. 런의 스레드 소속 = run.state.threadRootId 1순위, 없으면 RUN_STARTED.sessionKey 를 parseDodokSessionKey 로 —
│  │                       런 id → 루트는 remove 뒤에도 남겨 확정 승인 카드가 채널로 새지 않게, selectScopeRuns(ch, root?) 로 버블·`/stop` 을 가른다)·bubblePhase.ts(상태 → 버블 모양)·
│  │                       StreamingBubble.tsx·useChannelBubbles(범위별 — 끝난 런은 그 범위를 볼 때만 지운다)·abortError
│  ├─ composer/            Composer.tsx(Tiptap — `/new` 는 admin 이상, member 면 「「새 대화」는 관리자만 시작할 수 있습니다」 토스트·입력 유지) · mentions·MentionList(@ 후보 = 채널 에이전트 + 사람 전원(나간 멤버 제외)) · serialize.ts(→ `<@a:id>` 토큰 bodyMd, 줄 머리 이스케이프) ·
│  │                       submitKeys(Enter 전송·IME) · slash.ts(`/stop`·`/new`) · useSendMessage(ack·10s 타임아웃 → failed, ack RATE_LIMITED 면 사유 rate_limited, 첨부 id 를 싣고 재시도도 같은 clientMsgId·id.
│  │                       `threadRootId` 면 루트를 싣고 보내는 중·확정은 스레드 캐시에) · useTyping·TypingIndicator(스레드 작성기는 typing 을 보내지 않는다 — wire Typing 이 채널 단위) ·
│  │                       PendingAttachments.tsx(칩 — 미리보기·진행 막대·사유·「<이름> 빼기」, 빼면 초점을 옆 칩·「이미지 첨부」로). Composer 는 「이미지 첨부」 버튼·붙여넣기·
│  │                       작성기 상자 전체의 끌어다 놓기로 칩을 넣고, 올리기가 끝나야 보낸다(사유: 끊김 → 「이미지를 올리는 중입니다」 → 「올리지 못한 이미지를 빼 주세요」). 글 없이 이미지만 보낼 수 있다
│  ├─ agents/              AgentsPage·AgentRow(사용 토글·기본 프롬프트 — member 에게는 값만, 등록 버튼 없음 · claude 면 묶인 러너 라벨, 폐기됐으면 다시 묶으라는 안내 — 다시 묶기는 연결 페이지 러너 카드) · DiscoverDialog(「Gateway 에서 가져오기」) · ManualAgentForm·handleFrom ·
│  │                       resetSession·ResetSessionDialog(「새 대화」 — 작성기 `/new` 와 설정 패널이 함께 쓴다) · mutations
│  ├─ search/              Phase 4 ①. SearchDialog.tsx(`⌘K` 대화상자 — 390px 전체 시트, 필터 채널·사람/에이전트·기간, 결과를 누르면 requestJump 뒤 그 채널·스레드로, 닫으면 연 자리로 초점 —
│  │                       Trigger 없이 여는 대화상자라 `onOpenAutoFocus` 에서 기억한 요소로 돌려준다) · SearchResults.tsx(2글자면 「2글자는 최근 90일에서 50개까지만 찾습니다」·「더 보기」 없음,
│  │                       429·오류는 대화상자 안 한 줄, 다음 쪽 실패는 받은 결과를 두고 목록 아래 한 줄, 입력이 2글자 미만이면 옛 결과를 곧바로 숨긴다) ·
│  │                       useSearch.ts(useInfiniteQuery, 디바운스 300ms, 재시도·전역 토스트 없음) · highlight.tsx(STX·ETX 스니펫 → 강조 조각) ·
│  │                       openSearch.ts(isSearchShortcut — `e.code === "KeyK"` 도 받는다(한글 입력기), otherModalOpen — 검색 표지가 없는 열린 대화상자가 있으면 ⌘K 무시)
│  ├─ setup/               Phase 3 ②. 연결 페이지 `/settings/connection` — owner 만(아니면 setup API 를 부르지 않고 「권한이 없습니다」).
│  │                       ConnectionPage.tsx(섹션 넷: 서버·Gateway·플러그인·브리지 토큰 — 지금은 첫 Gateway 하나를 그린다(Gateway 카드 목록은 멀티 Gateway 태스크 6),
│  │                       Gateway 가 없으면 빈 상태 한 줄이고 브리지 토큰 블록은 없다, 활성 토큰 0 이면 「쓸 수 있는 토큰이 없습니다 — 발급하세요」) ·
│  │                       sections.tsx(Section · CopyBlock — 기본은 줄 구조를 지키고 제 상자 안에서 가로 스크롤, `wrap` 이면 아무 글자에서나 줄바꿈(토큰), 래퍼 min-w-0 ·
│  │                       GatewaySection — 페어링 대기면 `openclaw devices approve <requestId>`, requestId 가 빈 문자열이면 `openclaw devices list`, 5분 넘으면 강조 ·
│  │                       PluginSection — 같은 빌드 문구 셋, 받기는 `pluginFile.available` 로만, installCommands(`docs/guides/deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」 절의 [B] 블록을 글자 그대로 —
│  │                       패치 줄만 빼고 파일 이름·번들 sha 를 채운다, `connection.test.tsx` 가 그 블록과 대조한다)) ·
│  │                       IssueTokenDialog.tsx(라벨 → 발급 → 원문·설정 조각 한 번. 원문은 컴포넌트 상태에만 — 「복사했습니다」로만 닫히고, 그동안 라우트 이동은 useBlocker 로 한 번 더 묻고
│  │                       탭 닫기·새로고침은 beforeunload. 막힌 채 언마운트되면 이동을 이어 보낸다) ·
│  │                       TokenList.tsx(라벨·`dbt_` + 앞 6자(라벨 `env` 는 「.env 에서 이어받음」)·만든 때·마지막 사용·「지금 접속 중」·폐기됨·「이제 폐기해도 됩니다」, 폐기는
│  │                       ConfirmDialog — 접속 중이면 경고, 마지막 활성 토큰이면 `escalated` 두 번째 확인(600ms 무장), 폐기 뒤 초점은 아래 줄 「폐기」 또는 「새 토큰 발급」) ·
│  │                       queries.ts(setupStatus·bridgeTokens — `setup.status` wire 가 상태를 덮는다) · mutations.ts(발급은 결과를 뮤테이션 캐시에 두지 않고 콜백으로만(gcTime 0),
│  │                       폐기, 플러그인 받기는 fetch → blob — 404·409 를 문구로). setup 쿼리는 오프라인 사본(`pwa/persist.ts`)에서 먼저 뺀다
│  ├─ threads/             Phase 4 ①. ThreadPanel.tsx(`/c/$channelId/t/$rootId` — 오른쪽 패널의 스레드 탭·좁은 화면 시트, MessageList 를 `threadRootId` 로 재사용(버블·카드·첨부·승인 행 그대로),
│  │                       스레드 작성기, 에이전트 줄의 「새 대화」(그 스레드 세션), 404·VALIDATION 이면 「스레드를 찾을 수 없습니다」, 답글 결과면 첫 페이지 뒤 around 로 갈아 끼운다) ·
│  │                       ThreadChip.tsx(루트 아래 「답글 N · 마지막 시각 · 에이전트 아바타」와 「스레드에서 답하기」 — 둘 다 라우터 Link) ·
│  │                       queries.ts(스레드 REST·threadQuery(`withThreadEdits` 안에서 받는다)·touchRecentThread·threadRootOf(답글이면 그 루트)·isThreadMissing) ·
│  │                       threadOpener.ts(스레드를 연 자리 — 칩·「스레드에서 답하기」가 누른 요소를 적고 PanelTabs 가 닫을 때 돌려준다)
│  └─ settings/            ChannelSettingsPanel(패널 셸은 `app/layout/PanelTabs` 가 맡고 여기는 안쪽만) ·
│                          BasicSection·PromptSection·MembersSection·AgentMemberRow·RelayPolicySection(+relayPolicyForm)·autoRespond(채널당 하나 보장)·
│                          Section·ConfirmDialog·mutations(응답은 보낸 필드만 캐시 병합 — 늦은 응답이 wire 값을 덮지 않게).
│                          member 에게는 채널 프롬프트·릴레이 정책(일일 한도 포함)·에이전트 줄의 자동 응답·오버라이드가 값만 보이고 잠긴다(「관리자만 바꿀 수 있습니다」 — 잠기면 저장 안 된 초안이 아니라 서버 값),
│                          「새 대화」는 숨기고, 이름·주제·에이전트 넣기·빼기는 열려 있다. 「에이전트 등록」 안내 링크는 admin 이상에게만
├─ pwa/                    Phase 2 ④. register.ts(startPwa — 등록, 대기 워커가 있으면 showUpdateToast 「새 버전이 있습니다」+「새로고침」, 무기한 — 누를 때만 SKIP_WAITING) ·
│                          sw-logic.ts(순수, SW·앱 공용: safeNotificationUrl(`/c/<uuid>`·`/c/<uuid>/activity`·`/c/<uuid>/t/<uuid>` 만, 그 밖 `/`) · focusAndNavigate(focus 를 try/catch 로 감싸고 이동은 늘 보낸다) · notificationFromPush(PushPayload 파싱,
│                          실패하면 「dodok — 새 알림」, 승인만 renotify, 빈 tag 면 tag·renotify 없음) · pickClient(같은 출처: 보임+포커스 → 보임 → 포커스 → 첫 창) · urlBase64ToUint8Array) ·
│                          push.ts(상태 다섯 판정, enablePush(userId) — 권한 → SW ready(10초) → 공개키 → 구독(userVisibleOnly) → 등록, 실패하면 기기 해지 · disablePush(서버 해지 → 기기 해지) ·
│                          dropLocalPush(세션 없을 때 기기만) · syncPushSubscription(userId — 앱을 열 때, 켠 사람이 아니면 해지, 키가 바뀌면 다시 구독) ·
│                          pushOnThisDevice — 플래그 localStorage `dodok.push` = 켠 사용자 id) ·
│                          install.ts(isStandalone·isIos(iPadOS 포함)·captureInstallPrompt·useInstallPrompt) ·
│                          persist.ts(오프라인 사본 — IndexedDB(idb-keyval) 키 `dodok.query` 하나. me·channels·agents·people(사람 목록 — 멤버 표·대기 초대 `team` 은 이메일이 들어 뺀다)·recentChannels + 최근 5채널의 channel·members·timeline(50개,
│                          pending 없이, lastSeq 0 — 복원 채널은 fresh 구독), 7일·buster, me 없는 캐시는 지움, 저장마다 세대(epoch) — 지운 뒤 옛 저장이 되살아나지 않게,
│                          gc 된 최근 채널 항목은 이전 사본에서 이어 붙임(carryOver). 스레드는 recentThreads 로 최근 채널마다 마지막으로 연 하나 — 루트 + 마지막 답글 50, 복원 뒤 낡은 것으로) ·
│                          offline.ts(useOffline — navigator.onLine·onlineManager, 또는 값을 가진 me 의 NetworkError)
├─ hooks/
│  ├─ useIsNarrow.ts       768px 미만(사이드바 시트·패널 전체 화면)
│  ├─ useLeaveGuard.ts     원문을 한 번만 보이는 대화상자의 떠나기 막기(라우트 이동 useBlocker·탭 닫기 beforeunload, 막힌 채 언마운트되면 이동을 이어 보낸다) — 브리지 토큰·초대·재설정 링크가 같이 쓴다
│  └─ useNowTick.ts        「지금」을 1초마다 새로 읽는 앱 공용 시계 **하나** — 구독자가 몇이든 타이머 하나·같은 틱에 같은 값(런 소요·승인 카운트다운).
│                          흐르는 값이 없으면 구독하지 않고, 마지막 구독자가 떠나면 거둔다. 테스트는 `resetNowTick` 을 `test/setup.ts` afterEach 에서 부른다
├─ lib/                    josa.ts(받침에 따른 조사) · utils.ts(cn)
├─ theme/                  agentColor.ts(핸들 → 8색 색인) · tokens.css(중립 회색 램프·강조색 하나·상태색·에이전트 8색·모션 줄이기)
└─ ui/                     18개 — shadcn 복사본(alert·avatar·badge·button·checkbox·dialog·dropdown-menu·input·label·radio-group·scroll-area·
                           separator·sheet·sonner·switch·textarea·tooltip)과 직접 만든 field-error(칸 아래 오류 라이브 영역).
                           radio-group 은 Phase 2 ② 가 더했다(이미 있던 `radix-ui` 의 RadioGroup, 의존성 추가 없음). `ui/select.tsx` 는 없다 — 옵션은 OptionList 가 그린다.
                           손으로 두고 `@/lib/utils` 로 잇는다 — CLI 를 워크스페이스에서 돌리지 않는다
```

사람이 이미지가 아닌 파일을 올리는 것은 범위 밖이다(첨부 스펙 결정 1).

테스트: 소스 옆 `*.test.ts(x)`(순수 로직 + jsdom 렌더·라우팅·wire 핸들러) + `apps/web/test/`(`setup.ts`, 공용 도우미 `shellApi`·`messages`·`composerHarness`·`fakeSocket`·`fakeXhr`(가짜 XHR 업로드·object URL 스텁)·`fixtures`·`scrollLayout`·`settingsServer`·`agentsPage`·`domStubs`·`media`·`memoryStorage`(오프라인 사본 저장소 주입)·`pushStubs`(가짜 serviceWorker·PushManager·구독), `ui.test.tsx`). E2E 파일은 두지 않는다 — 브라우저 검증은 워커가 `dev:fake` 위에서 한 번 돌고 보고서로 남긴다(스펙 10.2).

---

운영 번들 스크립트(`apps/server/scripts/`, Phase 3 ① — 정본은 각 파일 머리 주석):
- `build.mjs`(`pnpm -F @dodok/server build`) — esbuild 로 `src/main.ts` → `dist/main.js`, `src/backup-main.ts` → `dist/backup.js`(ESM, 소스맵). external 은 `better-sqlite3` 하나, 번들 밖에서 런타임에 찾는 것의 목록 `runtimeDeps`(`better-sqlite3`·`ws`)를 `dist/runtime-deps.json` 으로 쓴다. 배너가 CommonJS 의존성용 `require`·`__filename`·`__dirname` 을 만든다.
- `prune-runtime-deps.mjs` — `pnpm deploy --prod` 산출물에서 `runtime-deps.json` 이름들의 닫힘(dependencies·optional·peer)만 평평한 `node_modules` 로 옮긴다. `infra/Dockerfile.server` 의 `deploy` 단계와 `bundle-smoke` 가 같은 명령으로 쓴다.
- `bundle-smoke.mjs`(`pnpm -F @dodok/server bundle:smoke`, build 뒤) — 저장소 밖 임시 디렉터리에 매니페스트 사본으로 `pnpm deploy --prod --legacy --offline` → 가지치기 → 번들을 띄워 ① `/healthz` 200·`/socket.io/socket.io.js` 400 뒤 생존 ② `DODOK_MIGRATIONS_DIR` 없으면 설정 오류 ③ `dist/backup.js` 성공·실패 한 줄을 본다. 원본 워크스페이스 상태는 바꾸지 않고, 중단에도 임시 디렉터리를 지운다.
- dev:fake 는 `DEV_FAKE_HOST`(기본 `127.0.0.1`)로 리슨 주소를 받는다 — 로컬 검증의 `devfake` 컨테이너가 `0.0.0.0` 을 준다.

## 3. 런타임 토폴로지

```
[브라우저/PWA] ⇄ Socket.IO/HTTP ⇄ [Caddy] ⇄ [apps/server (+openclaw-adapter)]   ← 본인 서버 A (Compose)
                                                   ├─ Socket.IO 네임스페이스 /bridge (토큰)  ⇐ 아웃바운드 접속 ⇐ [openclaw-plugin @ Gateway]
                                                   └─ operator 클라이언트 ⇒ wss:// ⇒ [OpenClaw Gateway]   ← 본인 서버 B (원격)
```

- 기본값: 본인이 운영하는 원격 Gateway에 연결(연결 페이지에서 Gateway 주소 `wss://...`·공유 토큰을 추가 — 여럿 붙일 수 있다). 플러그인은 그 Gateway에 설치되어 `BRIDGE_PUBLIC_URL`로 우리 서버에 접속하고, 서버는 브리지 토큰으로 어느 Gateway 의 플러그인인지 가른다.
- 배포: `infra/compose.yml` 로 서버 A 에 `app`·`caddy` 를 띄운다(`docs/guides/deploy.md`). Caddy 가 `/api`·`/socket.io`(wire·브리지 WebSocket)·`/bridge/*`(플러그인의 첨부 HTTP)·`/healthz` 를 서버로 넘기고 나머지는 웹 정적이다. Gateway 는 Compose 밖이다(동반 기동 프로필은 뺐다 — 배포 패키징 스펙 결정 5).
- 로컬 개발: Gateway 는 원격에 붙거나 `openclaw --dev`(`docs/guides/live-smoke.md`). 원격 Gateway의 플러그인을 개발 PC의 브리지에 붙이려면 터널(cloudflared/tailscale 등)로 `BRIDGE_PUBLIC_URL`을 만든다.
- 응답 정본은 플러그인 경로, WS 경로는 미리보기(델타)·툴 이벤트·승인. `runId`로 dedupe.

---

## 4. 환경 변수 (`.env.example`)

정본은 `apps/server/src/config.ts`(zod). 소스 실행의 서버는 저장소 루트를 작업 디렉터리로 삼고 루트 `.env` 를 읽는다(운영 번들은 `.env` 파일을 읽지 않고 compose 의 `env_file` 로 받는다 — 배포 값은 `docs/guides/deploy.md` 「설정 — `.env`」) — **이미 설정된 환경 변수는 `.env` 가 덮지 않는다**(`process.loadEnvFile`, 실연에서 확인). 빈 값(`KEY=`)은 설정하지 않은 것으로 보고 기본값을 쓴다.
OpenClaw Gateway 주소·공유 토큰과 브리지 토큰은 env 가 아니라 DB 다(연결 페이지 — `modules/gateways/`). 서버는 Gateway 가 0개여도 뜨고, 옛 `.env` 에 남은 `OPENCLAW_*`·`BRIDGE_TOKEN` 은 읽지 않는다.

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 리슨 주소 |
| `PORT` | `3000` | 리슨 포트. REST `/api/v1`·wire(기본 네임스페이스)·브리지 `/bridge` 가 모두 여기 |
| `APP_ORIGIN` | (필수) | 웹 앱 오리진 — Socket.IO CORS·Better Auth `baseURL`/`trustedOrigins`·세션 쿠키 Secure(https 일 때)·초대·재설정 링크(`<APP_ORIGIN>/join/<token>`·`/reset/<token>`). 로컬 `http://localhost:5173` |
| `TRUST_PROXY` | `false` | 리버스 프록시 뒤면 `true` — 레이트리밋·브리지 실패 카운터·브리지 거절 로그의 주소가 X-Forwarded-For 첫 값이 된다. 배포 compose 는 `true` 로 고정한다 |
| `TZ` | 프로세스 기본(컨테이너는 UTC) | 「하루」의 경계 — 일일 런 상한이 이 시간대의 자정에 풀리고 운영 화면 「오늘」·「7일」 집계도 그 자정을 따른다(`docs/guides/deploy.md` 「설정 — `.env`」). `.env.example` 에는 없다 — Node 가 읽는 표준 변수라 config.ts 가 검증하지 않는다 |
| `DATA_DIR` | `./data` | 런타임 데이터(DB·첨부 블롭·VAPID 키 `vapid.json`·Gateway 마다 Ed25519 디바이스 아이덴티티와 디바이스 토큰 `gateways/<Gateway id>/`(`device.json`·`device-tokens.json`)) |
| `DB_PATH` | `<DATA_DIR>/dodok.sqlite` | SQLite 파일 |
| `ATTACHMENTS_DIR` | `<DATA_DIR>/attachments` | 첨부 블롭 디렉터리(`<sha 앞 2자>/<sha256>`). 부팅 때 만든다. 한 서버 프로세스만 쓴다 — sha 잠금이 프로세스 안에서만 맞다 |
| `LOG_LEVEL` | `info` | `fatal`~`trace` (pino, 토큰 키는 redact) |
| `DODOK_WORKSPACE_NAME` | `dodok` | 부팅 때 워크스페이스가 없으면 이 이름으로 만든다 |
| `OWNER_HANDLE` | `owner` | owner 핸들(`left-` 예약 검사는 지나지 않는다 — `left-` 로 시작하게 두지 않는다) |
| `LOCAL_AUTH_TOKEN` | (필수, ≥16자) | 로컬 로그인 토큰 = owner 비밀번호. 바꾸면 기존 세션이 끊긴다 |
| `BETTER_AUTH_SECRET` | (필수, ≥32자) | Better Auth 서명 비밀 |
| `OPENCLAW_FRAME_DUMP_PATH` | — | 진단용 — 어댑터가 받은 Gateway `chat`·`agent`·`session.message` 프레임을 Gateway 마다 `<이 경로>.<Gateway id>` 파일에 JSONL(`{ receivedAt, frame }`)로 append. 본문이 들어가므로 `data/` 아래에. usage 출처 확인용(live-smoke 5.4) |
| `BRIDGE_PUBLIC_URL` | `APP_ORIGIN` 의 `https:`→`wss:`(`http:`→`ws:`) + `/bridge` | 플러그인 계정 설정 `bridgeUrl` 에 적을 공개 주소 — 연결 페이지가 보여 주고 발급 결과의 설정 조각에 들어간다(서버는 이 값으로 리슨하지 않는다). 예 `wss://dodok.example.com/bridge` |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | — | 웹 푸시 VAPID 키 쌍 — **둘 다** 있어야 쓴다. 없으면 `<DATA_DIR>/vapid.json` 을 만들어(0600) 쓴다. 키가 바뀌면 모든 기기의 푸시 구독이 무효가 된다. 비밀 키는 로그에서 가린다 |
| `VAPID_SUBJECT` | `mailto:dodok@localhost` | 푸시 서비스가 연락할 주체 — `mailto:…` 또는 `https://…`. 호스트가 `localhost`·`127.0.0.1`·`*.local` 이면 시작 때 warn(Apple Push 는 `403 BadJwtToken`) — 배포는 실제 연락처로(`docs/guides/live-smoke.md` 14.2) |
| `DODOK_MIGRATIONS_DIR` | 소스 `apps/server/drizzle` | drizzle 마이그레이션 폴더. 운영 번들은 **필수**(없으면 설정 오류) — 이미지·compose 가 `/app/drizzle` 로 준다 |
| `DODOK_PLUGIN_DIR` | — | 연결 페이지가 내려줄 플러그인 tgz 를 찾을 디렉터리(가장 최근 tgz). 소스 실행이면 그 뒤에 `packages/openclaw-plugin/dist` 도 본다. 배포에서는 이미지·compose 가 `/app/plugin` 으로 고정한다(그때 `.env` 의 값은 무시된다) |
| `DODOK_RUNNER_DIR` | — | 연결 페이지가 내려줄 러너 tgz 를 찾을 디렉터리(가장 최근 tgz). 소스 실행이면 그 뒤에 `packages/claude-runner/dist` 도 본다. 배포에서는 이미지·compose 가 `/app/runner` 로 고정한다(그때 `.env` 의 값은 무시된다) |
| `DODOK_DOMAIN` | — | **배포 전용**(서버는 읽지 않음) — Caddy 가 인증서를 받을 공개 도메인. compose 변수 치환이라 배포 호스트에 `infra/.env → ../.env` 링크가 필요하다 |
| `BRIDGE_URL` | — | **스파이크 러너 전용**(서버는 읽지 않음) — 러너가 브리지를 리슨할 오리진(`/bridge` 없음) |

플러그인은 env 가 아니라 Gateway 계정 설정 `channels.dodok.accounts.<id>.bridgeUrl`(오리진 + `/bridge`)로 접속한다(ADR 0002 10절). 서버 쪽 공개 주소는 `BRIDGE_PUBLIC_URL` 하나로 정리됐고, 스파이크의 `BRIDGE_URL` 은 러너 전용으로 남았다.
웹(`apps/web`)은 `.env` 를 읽지 않는다 — 브라우저에 들어가는 설정이 없다. `vite.config.ts` 가 셸 환경으로 받는 것은 셋이다 — dev 서버의 프록시 대상 `DODOK_API_ORIGIN`(기본 `http://127.0.0.1:3000`), 개발 모드 서비스 워커 `VITE_PWA_DEV=1`(기본 끔), 빌드 식별자 `VITE_BUILD_ID`(없거나 비면 빌드 시각 — 오프라인 사본을 버리는 기준. 배포 이미지는 compose 의 `DODOK_WEB_BUILD_ID` 를 빌드 인자로 받는다 — `docs/guides/deploy.md` 「기동」). 서버 포트를 바꾸면 `APP_ORIGIN`(서버)·`DODOK_API_ORIGIN`(Vite)·브라우저 주소를 함께 맞춘다 — wire 는 핸드셰이크 `Origin` 이 `APP_ORIGIN` 과 같을 때만 쿠키를 받는다.

Postgres 전환 시 `DB_PATH` 대신 연결 문자열.

우리가 관리하는 OpenClaw 설정 조각(사용자가 Gateway 호스트에 적용 — 연결 페이지의 토큰 발급이 `accounts.default` 의 `bridgeUrl`·`token` 조각을 만들어 주고, 나머지는 손으로):

```json5
{
  // 첨부(Phase 2 ③)의 attachments.ttlHours·tools.fs.workspaceOnly 는 운영자가 호스트에 맞춰 정한다 — docs/guides/live-smoke.md 6절
  tools: { agentToAgent: { enabled: false }, sessions: { visibility: "tree" } },   // 루트 sessions 키는 거부된다 (ADR 0002)
  channels: {
    dodok: {
      accounts: { default: { bridgeUrl: "wss://dodok.example.com/bridge", token: "dbt_…" /* 연결 페이지 발급 */ /* , mediaMaxMb: 20 (선택) */ } },
      channels: { "<channelId>": { requireMention: true, systemPrompt: "..." } }
    }
  }
}
```

---

## 5. 개발 순서 (Phase 0 → 1 착수 순서)

0. ~~원격 Gateway를 2026.9.4로 업그레이드~~(스파이크 1 시점에 이미 2026.9.4), 세 패키지를 같은 버전으로 핀(**3종 모두 완료** — adapter 는 스파이크 1, plugin 의 `openclaw` devDependency 는 스파이크 2). `agentToAgent`·`visibility` 설정 적용은 사용자 몫 — 미확인.
1. 모노레포 스캐폴드, `shared` 타입·스키마부터 (계획서 5.4 components v1, 6장 테이블, wire·bridge 계약).
2. ~~`openclaw-adapter/gateway/client.ts` — wss 접속·페어링·`hello-ok.features` 덤프·`chat.send`·`chat` 델타·`session.tool` 콘솔 출력까지 (스파이크 1)~~ **완료** → `docs/adr/0001-gateway-client-spike.md`. 페어링은 공유 토큰이면 자동 승인, 툴 진행은 `session.tool` 이 아니라 `agent` `stream:"tool"`, `features` 는 참고 목록.
3. ~~`openclaw-plugin` 스켈레톤 — 원격 Gateway에 tarball 설치, 터널로 브리지 접속, 인바운드 수신·`message` 툴 아웃바운드·components 스키마 노출 확인, 봇 루프 보호 상호작용 확인 (스파이크 2)~~ **완료** → `docs/adr/0002-channel-plugin-spike.md` (로컬 dev Gateway 로 실측; 원격 호스트 설치는 9절 사람 절차). `ui_render` 대안은 불필요했으나 components 조각의 SDK 방침 충돌은 결정 필요(ADR 12절).
4. ~~채널 프롬프트 설정 갱신을 플러그인 내부 쓰기로 반영·확인 (스파이크 3)~~ **완료** → `docs/adr/0003-channel-prompt-spike.md`: 설정 쓰기는 live 이나 claude-cli 기존 세션은 리셋·새 키에서만 반영, 인바운드 경로(프리픽스·ChannelPromptContext)는 매 턴 반영. Gateway 설정 메서드(a-2)는 같은 문제를 풀지 못한다.
5. 스파이크 통과 후 `server` 모듈 → `web` 순으로 MVP 코어(Phase 1).

각 스파이크 결과는 `docs/adr/`에 한 장씩 남긴다.

---

## 6. 컨벤션

- TypeScript strict, ESM only, `pnpm`, oxlint(린트)+oxfmt(포맷), Vitest, Playwright. 커밋 전 `pnpm lint`·`pnpm fmt:check` 통과. oxfmt 는 `*.md`·`pnpm-lock.yaml`·`drizzle/meta`·`*.sql` 을 제외한다(`.oxfmtrc.json`).
- Turbo: `test`·`typecheck` 는 `cache: false`. 검증 태스크는 캐시 재생으로 「통과」가 찍히면 안 된다 — 새 검증 태스크도 같은 설정.
- 코드 변경은 워크트리에서, 실행 주체는 Orca 워커 — `docs/guides/worktree-workflow.md`. 화면 확인은 `docs/guides/browser-verification.md`.
- 커밋할 파일은 경로를 명시해 stage. `git add -A`·`git commit -a` 금지(최상위 체크아웃은 공유 자원).
- 모든 외부 입력(HTTP, Socket.IO, 브리지, Gateway 이벤트)은 경계에서 Zod 파싱 후 내부로.
- **URL 을 받아 링크·이미지로 그리는 렌더러의 테스트는 나쁜 값에 우회 모양 셋을 넣는다** — 부분 문자열(`http://evil.example/?next=https://ok.example`)·
  앞 공백(` https://…`)·상대 주소(`//evil.example/…` 와 `/api/me`). 그리고 그 값이 계약(`ComponentsV1.parse`)에 먼저 걸러지지 않게 **파싱을 건너뛰고** 넣는다 —
  계약이 앞에서 막으면 렌더러의 허용목록이 안 잠긴다. Phase 2 ② 에서 `media`·`file` 과 링크 버튼이 **각각 세 번씩** 리뷰에 걸렸다 — 허용목록이
  계약 뒤에 가려 안 잠김(링크 버튼은 스킴 검사 자체가 없었다) → `startsWith` 를 `includes` 로 바꾸는 돌연변이가 초록 → `|| startsWith("/")` 를 더하는 돌연변이가 초록.
  두 번째·세 번째는 운영 코드가 이미 `startsWith("https://")` 인데 테스트의 나쁜 값 목록이 얇아 돌연변이가 산 것이다. 본보기: `apps/web/src/features/components/blocks/blocks.test.tsx`
  「media·file — 계약 밖 주소」, `components.test.tsx` 의 링크 버튼 테스트.
- 커밋: Conventional Commits. 패키지 스코프 사용(`feat(plugin): …`).
- OpenClaw 패키지 버전은 정확히 핀(`--save-exact`), Gateway와 같은 버전. 업그레이드는 Gateway와 같은 PR에서, 업그레이드 전 `@openclaw/gateway-protocol` CHANGELOG의 보류 항목 확인.
- 시크릿·디바이스 아이덴티티·브리지 토큰은 `data/`와 `.env`에만, 커밋 금지.
- 마이그레이션은 Drizzle Kit, SQLite/Postgres 양쪽에서 통과해야 머지.

---

## 7. `CLAUDE.md`

저장소 루트의 `CLAUDE.md` 가 정본이다. 초안은 코드 착수 때 그 파일로 옮겼고, 같은 내용을 두 곳에 두지 않는다 —
가르치는 자리가 둘이면 둘 다 맞아야 하므로 한 곳만 남긴다. 작업 방식(워크트리·Orca 워커·커밋 규칙)은
`docs/guides/worktree-workflow.md` 가 정본이고 `CLAUDE.md` 는 그 요약이다.
