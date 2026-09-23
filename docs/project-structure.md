# 프로젝트 구성 가이드 (Claude Code 인계용)

작성일: 2026-09-14 · 계획서 v0.12 기준(2026-09-24 갱신: Phase 2 ④ PWA·푸시 실물) · 이 문서는 "어떻게 구성할지"만 다룬다. 배경·결정 근거는 `docs/plan.md` 참고.

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
│  └─ openclaw-adapter/       # @dodok/openclaw-adapter — 서버 측 OpenClaw 어댑터 (브리지 서버 + Gateway WS 클라이언트)
├─ infra/
│  ├─ docker-compose.yml      # server + web(정적) + caddy, `--profile gateway`로 로컬 OpenClaw 동반 기동
│  └─ caddy/Caddyfile         # /, /api, /socket.io 를 TLS로 노출 (브리지는 Socket.IO 네임스페이스라 /socket.io 하나로 충분)
├─ docs/
│  ├─ plan.md                 # 계획서
│  ├─ project-structure.md    # 이 문서
│  ├─ guides/                 # 작업 지침 (worktree-workflow.md, browser-verification.md, live-smoke.md)
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
├─ CLAUDE.md                  # 에이전트 지침 (정본)
├─ .mcp.json                  # 프로젝트 MCP — playwright-neo (BrowserOS neo 의 CDP 에 붙는 Playwright)
├─ .oxlintrc.json / .oxfmtrc.json
├─ mise.toml / .npmrc         # Node 24.21.0 · pnpm 11.16.0 핀(openclaw engines >=24.16 <25) · engine-strict
├─ package.json / pnpm-workspace.yaml / turbo.json
└─ .env.example
```

패키지 의존 방향: `web → shared`, `server → shared, openclaw-adapter`, `openclaw-adapter → shared`, `openclaw-plugin → shared`. `shared`는 아무것도 의존하지 않는다(브라우저·Node·Gateway 세 곳에서 다 로드되므로 Node 전용 API 금지).

OpenClaw 패키지 버전은 세 곳(`openclaw-adapter`의 `@openclaw/gateway-client`·`@openclaw/gateway-protocol`, `openclaw-plugin`의 `openclaw` devDependency) 모두 **배포 Gateway와 같은 버전으로 정확 핀**한다. 시작 버전 2026.9.4.

---

## 2. 패키지별 책임과 핵심 파일

### 2.1 `packages/shared`

```
src/
├─ common.ts      Id(UUIDv7)·IsoDateTime·ErrorCode·ApiError·Result/Ack·WIRE_PROTOCOL/BRIDGE_PROTOCOL — 아래 전부가 쓰는 바닥
├─ domain/        workspace, user, agent, channel, message, run, approval 타입 + Zod.
│                 `Message.interactions`(그 메시지 components 의 상호작용 기록, `MessageInteraction[]`, 최신 `INTERACTIONS_MAX`=20건,
│                 `.default([])` — 경계를 넘는 Message 에 늘 있다)
├─ components/    components v1 스키마 (blocks/actions/button/select/modal/media/file) + 제약 검증 — Phase 2 ② 는 이 파일을 안 바꿨다
├─ events/        RunEvent 유니온 (AG-UI 이벤트명 채택: TEXT_MESSAGE_START/CONTENT/END,
│                 TOOL_CALL_START/ARGS/END, RUN_STARTED/FINISHED/ERROR, STATE_SNAPSHOT, CUSTOM)
├─ wire/          클라이언트↔서버 Socket.IO 이벤트 계약 (server→client, client→server 타입 맵).
│                 승인: client→server `approval.resolve`, server→client `approval.requested`·`approval.resolved`,
│                 구독 ack 의 `pendingApprovals`(그 채널의 **미해결**만)
├─ bridge/        플러그인↔서버 브리지 메시지 계약 (인바운드 전달, 아웃바운드 수신, 컴포넌트 결과, 설정 변경, 헬스)
├─ push/          Phase 2 ④. PushSubscriptionInput(https endpoint ≤2048·base64url 키)·PushUnsubscribeInput·PushPayload
│                 ({ kind: mention|approval|relay_limit, channelId, title ≤80, body ≤200, url, tag ≤80 } — 서비스 워커가 경계에서 파싱한다).
│                 wire 쪽 `presence.update`(`PresenceUpdate` { visible, channelId? }, ack 없음)는 `wire/` 의 Typing 옆에 있다
└─ mention.ts     @멘션 파싱 (사람/에이전트 별칭 → id), 릴레이 감지에 공용
```

규칙: 여기의 Zod 스키마가 단일 진실. 서버 입력 검증·클라이언트 폼·플러그인 아웃바운드 검증·브리지 양단 검증이 전부 같은 스키마를 import한다. 브리지 계약이 `shared`에 있는 이유는 플러그인과 서버가 서로 다른 프로세스·호스트에서 같은 메시지를 파싱하기 때문이다.

### 2.2 `apps/server`

Phase 1 ① 서버 코어 실물(스펙 `docs/superpowers/specs/2026-09-15-server-core-design.md`, 계획 `docs/superpowers/plans/2026-09-15-server-core.md`)에
Phase 2 ① 승인(스펙 `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`)과 Phase 2 ② 상호작용 기록 하이드레이션
(스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md` 4장), Phase 2 ③ 첨부(스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md`, 구현과 달라진 것은 11장),
Phase 2 ④ 웹 푸시(스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`, 구현과 달라진 것은 11장)가 얹혔다.
한 프로세스 안에 REST·wire·브리지·어댑터가 같이 뜬다. 첨부 바이트는 브리지와 같은 오리진의 HTTP(`/bridge/attachments`)로 오간다.

```
src/
├─ main.ts                프로세스 진입점: cwd 를 저장소 루트로 옮기고 루트 .env 로드(이미 있는 env 는 덮지 않음) → createApp → listen, SIGINT/SIGTERM → close
├─ app.ts                 createApp: 부팅 순서(DB → 워크스페이스 → 인증·owner → Fastify → Socket.IO → 어댑터 → 서비스 → 라우트 → wire → 부팅 정리 → adapter.connect),
│                         종료 순서(새 wire 거부 → 푸시 트리거 떼기 → 오케스트레이터 stop → adapter.close → io.close → Fastify → 진행 중 푸시 발송 최대 2s(PUSH_DRAIN_TIMEOUT_MS) → DB, 10s 상한),
│                         /healthz, Gateway 재접속 60s 알림. VAPID 키를 읽고(주체가 로컬 자리값이면 warn 한 줄) 발송기(`AppDeps.pushSend`, 없으면 webPushSender)를 배선한다
├─ config.ts              env 를 zod 로 검증한 ServerConfig. OPENCLAW_TARGET 이 원격/dev Gateway 쌍과 디바이스 파일을 고른다
├─ logger.ts              pino, 토큰·비밀 키 redact(VAPID_PRIVATE_KEY·privateKey 포함)
├─ wiring.ts              createServices(라우터 ⇄ 오케스트레이터 상호 참조, RunsFacade), sessionRecoverTargets(재접속 복구 대상)
├─ db/
│  ├─ schema.sqlite.ts    Drizzle 스키마 (계획서 6장 테이블 + agent_sessions + approvals + attachments — 마이그레이션 0003, FK cascade 없음)
│  ├─ auth-schema.ts      Better Auth 테이블
│  └─ client.ts           createDb: better-sqlite3 연결 + 마이그레이션(apps/server/drizzle)
├─ auth/
│  ├─ index.ts            Better Auth(이메일 로그인·가입 비활성), 세션 토큰 검증
│  ├─ owner.ts            부팅 때 owner 보장 — LOCAL_AUTH_TOKEN 이 owner 비밀번호, 바뀌면 기존 세션을 끊는다
│  └─ routes.ts           POST /api/v1/auth/local(5회/분)·GET me·POST logout, requireSession(Bearer 또는 dodok.session 쿠키)
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
│  │                      정리 타이머 startAttachmentSweeper 는 app.ts 에 있다(부팅 때 한 번, 그 뒤 1시간마다, 닫을 때 진행 중인 정리를 기다린다)
│  ├─ approvals/          store.ts(approvals 테이블 — providerApprovalId 유일 upsert, 중복은 병합 후 재발행, 채널 미해결 목록),
│  │                      service.ts(상관 findOpenRunBySession → 저장 → APPROVAL_REQUESTED/RESOLVED 런 이벤트 → 버스, resolve 는 승인 설계 4.4 의 문지기 검사 뒤 어댑터 RPC).
│  │                      REST 라우트는 없다 — 요구·확정은 wire 로만 오간다
│  ├─ channels/           CRUD·멤버(에이전트 promptOverride·autoRespond·aliases)·프롬프트 리비전, 프롬프트 변경 시 어댑터 config.set, 「새 대화」(resetAgentSession)
│  ├─ agents/             에이전트 등록·수정, GET /agents/discover(Gateway agents.list)
│  ├─ messages/           seq 발급(seq.ts)·사람/에이전트/시스템 메시지 저장·bus 통지·히스토리 페이징. 저장과 같은 트랜잭션에서 첨부를 묶는다
│  │                      (사람: 틀린 id 가 하나라도 있으면 VALIDATION, clientMsgId 재전송은 잡기보다 먼저 확인 / 에이전트: 틀린 id 만 빼고 경고).
│  │                      withInteractions(db, msgs): components 가 있는 메시지에만 component_interactions 를 한 번에 읽어
│  │                      `interactions`(createdAt·id 오름차순, 최신 20건)를 싣는다 — 그런 메시지가 없으면 질의하지 않는다.
│  │                      클라이언트가 볼 Message 만 거친다: listMessages(REST `GET /channels/:id/messages`·구독 ack)와 wire 팬아웃(realtime/events.ts).
│  │                      내부 getMessage·bus 페이로드는 거치지 않는다(components v1 스펙 11장 Ruling 1)
│  ├─ router/             decide.ts(순수: 멘션·릴레이 판정, maxRelayTurns·allowPairs·반복 해시·일일 상한) + service.ts(런 enqueue, relay_limit·relay_denied 시스템 메시지와 continue_relay 버튼)
│  ├─ runs/               orchestrator.ts(세션 직렬화·타이머·신호 → 상태 전이·run_events·정본 상관·부팅 정리), machine.ts(순수 상태머신),
│  │                      store.ts(runs·run_events), context.ts(인바운드 InboundDeliver 조립 — 트리거 첨부를 싣고, 이전 메시지 줄의 첨부는 `[이미지 N장]`·`[파일: 이름]` 자리표시로만),
│  │                      media-lines.ts(순수: Gateway 폴백 스냅샷의 단독 `MEDIA:` 줄 걷기 — 줄이 있으면 finalizing 을 줄당 30s, 최대 120s 늘린다), timers.ts, routes.ts(런 목록·상세·이벤트 REST)
│  ├─ sessions/           agent_sessions — 채널×에이전트 세션 키 보장, 리셋 뒤 프롬프트 리비전 갱신
│  ├─ components/         interact.ts(순수: 검사 순서·값 스키마·인바운드 텍스트) + service.ts(저장·소비·continue/interaction 런.
│  │                      상호작용마다 message.updated — reusable 카드도 결과 줄이 실시간으로 는다. 소비(consumed)는 1회용만)
│  ├─ push/               Phase 2 ④. vapid.ts(키: VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY 둘 다 있으면 그것, 아니면 `<DATA_DIR>/vapid.json`(없으면 만들고 0600,
│  │                      망가졌으면 덮어쓰지 않고 던진다)) · presence.ts(소켓별 「보이는가·보는 채널」, 메모리뿐 — isWatching) ·
│  │                      triggers.ts(순수: message.created·approval.requested → 받을 사람·알림 내용 — 멘션(자기 멘션은 작성자가 사람일 때만 뺀다)·승인 요청·relay_limit,
│  │                      제목 늘 `dodok`, 본문은 누가·어디·무엇만) ·
│  │                      service.ts(구독 upsert(endpoint 유일 — 다른 사용자 것이면 옮긴다)·해지·목록, createTriggerLookups(DB 조회), attachPushTriggers(버스 배선 —
│  │                      같은 승인 id 는 한 번만, 최근 1000개), createPushDispatcher(보고 있으면 거름 → 구독마다 병렬 발송, TTL 3600·approval 만 urgency high·topic=tag 의 sha256 앞 32자,
│  │                      404·410 삭제 / 400·403·413 error / 그 밖 warn, 로그에 keys·endpoint·본문 없음, drain), webPushSender(web-push, 요청 timeout 10s)) ·
│  │                      routes.ts(`GET /api/v1/push/vapid-public-key` · `POST`·`DELETE /api/v1/push/subscriptions` — 세션, user-agent 512자)
│  └─ adapter/            GET /api/v1/adapter/status
├─ adapters/
│  └─ types.ts            AgentAdapter 계열 타입 재수출(구현은 packages/openclaw-adapter)
├─ util/
│  └─ josa.ts             받침에 따른 조사(시스템 메시지 병기형). 웹 `lib/josa.ts` 와 두 벌 — 한쪽만 고치면 어긋난다
└─ realtime/
   ├─ bus.ts              ServerBus — 모듈 → realtime 타입드 이벤트
   ├─ socket.ts           wire 인증(세션 토큰·프로토콜)·룸(channel:<id>, user:<id>, workspace:<id>)·클라이언트 → 서버 핸들러(subscribe 는 lastSeq 이후 ≤200,
   │                      ack 에 그 채널의 **미해결** 승인 pendingApprovals · approval.resolve 는 승인 서비스로 넘긴다 ·
   │                      presence.update 는 PresenceUpdate 로 파싱해 push presence 에 — 실패는 버린다, 끊기면 지운다)
   ├─ cookie-auth.ts      wire 핸드셰이크의 dodok.session 쿠키 파싱(웹은 토큰을 다루지 않는다)
   ├─ events.ts           bus → 룸 팬아웃, 소켓별 미전송 500 초과 시 run.event 버림 + run.state { resync }.
   │                      message.created·updated 는 여기서 withInteractions 로 하이드레이션한다 — 그 두 버스 이벤트의 유일한 소비자라
   │                      emit 자리가 늘어도 저절로 덮인다(components v1 스펙 11장 Ruling 1).
   │                      approval.requested·resolved 는 channel.created 와 함께 **워크스페이스 룸**으로 — 지금 구독 중이 아닌 채널의 승인도 닿아야 한다(설계 5.4·Ruling 7)
   └─ types.ts            WireServer·RunsFacade 타입
```

아직 없는 것: 어댑터 `registry.ts`(MVP 는 openclaw 하나). 업로드는 Phase 2 ③ 의 `modules/attachments/`, 웹 푸시는 Phase 2 ④ 의 `modules/push/` 가 맡는다.

테스트(`apps/server/test/`): 모듈 단위(인메모리 SQLite), `fakes/`(가짜 Gateway·가짜 플러그인·시나리오 대본 — 대본의 `components` 는 실물 플러그인
`buildOutboundMessage` 를 지나 스키마를 어기면 거절된다), `integration/`(시나리오 1~8 `relay`·`prompt`·`recovery`, 시나리오 9a~9g `approvals`(9c′ 포함 8건),
시나리오 10a~10g `components`(셀렉트·모달 → 다음 런, 결과 줄 세 경로, reusable, 상한 20, 동시 두 번, 스키마 위반 거절), 시나리오 11a~11i `attachments`(올리기·권한·판별·에이전트 첨부·미디어만·폴백 `MEDIA:`·정리·문맥 자리표시),
시나리오 12a~12h `push`(멘션·보고 있으면 거름·승인·릴레이 한도·410 정리·자기 멘션·페이로드에 본문 없음·소켓 둘 + 종료 drain), 실제 어댑터 + 가짜 둘),
`helpers/`(`bootLiveApp`·wire 클라이언트·시나리오 단계·`png.ts`(테스트 PNG 생성기 `makePng`·`PDF_BYTES`) — `bootTestApp` 은 앱마다 임시 `ATTACHMENTS_DIR` 을 만들고 닫으면 지운다.
`bootTestApp`·`bootLiveApp` 은 `deps.pushSend` 가 없으면 가짜 발송기 `noExternalPush` 를 넣고, `env.ts` 의 `testEnv` 는 프로세스마다 만든 VAPID 키를 환경변수로 준다 — 테스트가 밖으로 푸시를 보내거나 `data/vapid.json` 을 만들지 않는다).
가짜 플러그인은 브리지 HTTP 로 첨부를 받고 올리며(`uploadAttachment`·`downloadAttachment`), 대본 `ScenarioScript` 에 `attachments`·`attachmentIds`·`withholdCanonical` 이 있다.
손으로 두드리는 실연 도구는 루트 `scripts/wire-cli.ts`(`pnpm wire-cli`, `docs/guides/live-smoke.md`).

개발 모드 `apps/server/scripts/dev-fake.ts`(`pnpm -F @dodok/server dev:fake`, 웹 MVP 스펙 9.2): 위 `test/fakes/` 를 그대로 가져다 가짜 Gateway·가짜 플러그인·대본과 함께 서버를 띄운다 —
실제 `OpenClawAdapter` 가 가짜 Gateway 에 `OPENCLAW_TARGET=dev` 로 붙으므로 모델 런·실제 Gateway 없이 웹 전체를 돌릴 수 있다. `.env` 를 읽지 않고 개발 전용 고정값을 쓴다(로그인 토큰 `dev-fake-local-token` — 시크릿이 아니라 로그에 찍는다),
DB 는 `data/dev-fake.sqlite`(시작마다 새로, `--keep` 이면 유지), 기본 포트 3000(Vite 프록시 대상). 운영 코드(`src/`)는 건드리지 않는다.
받은 글의 키워드로 대본을 고른다 — 드롭·실패·느리게·도구·승인(승인 둘·승인 항상), components 는 「폼」(모달 필드 5종)·「폼 둘」(checkbox·radio + 필수 text — 둘이 합쳐 필드 7종)·
「고르기」(단일 셀렉트 + 옵션 12개 다중 셀렉트 — 스크롤 상자가 실제로 넘친다)·「카드」(블록 5종, media·file·링크 버튼에 `artifact://` 하나씩)·「재사용」(reusable 버튼 + 모달)·
「짧게」(TTL 20초, 다른 키워드와 오면 그 카드의 TTL 만 줄인다), 첨부(Phase 2 ③)는 「이미지 보여줘」(chart.png 480×320)·「보고서 줘」(report.pdf)·「카드에 이미지」(media·file·링크 버튼이 `artifact://<이름>` 으로 첨부를 가리키고 하나는 없는 이름)·「미디어만」(글 없는 응답).
푸시(Phase 2 ④)는 「나 불러」(답 `@<부른 사람> 확인해 주세요` — 멘션 푸시, 「느리게」와 함께면 채널을 옮길 시간이 난다). 사람이 첨부를 붙여 부르면 답 앞에 `받은 첨부 N개, 첫 이미지 W×H` 줄을 붙인다. 대본이 내는 글·라벨·파일 이름에 키워드가 없음을 `DEV_FAKE_KEYWORDS` 전수 테스트가 본다.
웹을 다른 포트로 띄우면 `PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake` + `DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web dev --port 5180`(`APP_ORIGIN` 기본은 `http://localhost:5173`).
⚠ `dev:fake` 는 **실제 `web-push` 발송기**를 쓴다 — 브라우저에서 푸시를 켜고 트리거를 일으키면 실제 푸시 서비스(FCM 등)로 나간다(`startDevFake` 의 `pushSend` 옵션으로만 바꾼다). `<dataDir>/vapid.json` 은 시작마다 지우지 않는다 — 새 키면 브라우저 구독이 매번 무효가 된다.

### 2.3 `packages/openclaw-adapter` (서버 프로세스 안에서 실행)

```
src/
├─ index.ts               배럴: adapter-types · createOpenClawAdapter · FakeAdapter · ProviderApproval·parseSessionKey(서버 승인 상관이 쓴다)
├─ adapter-types.ts       AgentAdapter 인터페이스(스펙 6.1), AdapterEvent(+ kind:"approval")·RunEventBody, AdapterCapabilities(sessionReset·agentsList·configSet),
│                         resolveApproval(providerApprovalId, kind, decision), AdapterError
├─ openclaw-adapter.ts    createOpenClawAdapter: 연결 관리자 + 브리지 + 매퍼 조립. send = 런 id 등록 → 세션 구독 → inbound.deliver(플러그인 미접속 120s 대기,
│                         ack 타임아웃 10s + 트리거 이미지 첨부당 30s·재시도 1s·4s·16s) → admission. 정본 outbound.message → onCanonical. abort(chat.abort)·resetSession(sessions.reset,
│                         FORBIDDEN 이면 capability 내림)·listAgents·syncChannelConfig·forgetRun·status 이벤트
├─ fake-adapter.ts        FakeAdapter — 서버 단위 테스트용(`@dodok/openclaw-adapter/fake` 서브패스), calls 기록·이벤트 주입
├─ config-sync.ts         채널 설정 → 브리지 config.set(10s). 플러그인이 없으면 기다리지 않고 ADAPTER_UNAVAILABLE
├─ gateway/
│  ├─ approvals.ts        Gateway 승인 프레임 → ProviderApproval 정규화(순수). 정본 전역 plugin|exec|openclaw.approval.requested/resolved(request 블록·toolCallId 있음)와
│  │                      보조 session.approval(presentation 블록·toolCallId 없음)·재접속 approvalReplay 를 한 모양으로 모으고, 만료의 비대칭
│  │                      (plugin 은 deny+resolvedBy:null, session 은 expired)도 여기서 흡수한다. **우리 세션만** 거른다(전역 프레임이라 다른 채널·TUI 승인도 온다).
│  │                      계약 상한 초과는 승인을 버리지 않는다(fail-open) — 승인을 버리면 카드도 못 보고 TTL 만료만 보게 된다.
│  │                      보여 주는 값(title·description·detail·toolName·pluginId·urlPath)은 잘라서 끝에 … 를 붙이고,
│  │                      상관 키 toolCallId 는 자르지 않고 통째로 버린다(자른 id 는 어느 툴 호출과도 안 맞는다 — 채널 수준 승인이 된다)
│  ├─ client.ts           @openclaw/gateway-client 래퍼: connect.challenge → connect(디바이스 서명·공유 토큰, scopes 에 operator.admin 포함,
│  │                      caps DEFAULT_GATEWAY_CAPS) → hello-ok. 실패(PAIRING_REQUIRED 포함)는 그대로 올리고 재시도는 연결 관리자 몫
│  ├─ connection-manager.ts  접속 루프·지수 백오프·상태(down/reconnecting/connected)·요청 타임아웃, 접속마다 복구(sessions.subscribe →
│  │                      대상 세션별 sessions.messages.subscribe → chat.history, 커서 reset 이면 꼬리 페이지 다시).
│  │                      subscribeSession: 접속 뒤 새로 생긴 세션은 send 전에 연결당 한 번 구독 — 실물 Gateway 는 구독한 세션의 이벤트만 보낸다(실연에서 발견, live-smoke 5.4).
│  │                      세션 구독에 includeApprovals: true — 켜야 session.approval 과 응답의 approvalReplay(재접속 되감기)가 온다
│  ├─ device-identity.ts  Ed25519 아이덴티티 생성·저장(0600)·서명 (스파이크 1에서 확정)
│  ├─ events.ts           chat(delta/final/error/aborted)·agent(lifecycle·stream:"tool")·session.message(usage) → RunEvent + RunSignal.
│  │                      우리 런(runId = 우리 런 uuid, ADR 0002 4.3)만. deltaText → TEXT_MESSAGE_CONTENT(replace 면 TEXT_MESSAGE_REPLACE), final 스냅샷은 정본 대체용
│  ├─ frame-dump.ts       OPENCLAW_FRAME_DUMP_PATH — 받은 chat·agent·session.message·session.approval·plugin|exec.approval.requested/resolved 프레임 JSONL append
│  │                      (스트림, 쓰기 오류면 warn 뒤 끔, close 에서 닫음)
│  └─ sessions.ts         sessionKeyFor(agent:<agentId>:dodok:channel:<channelId> 원형 고정 — 「새 대화」는 sessions.reset, 세대 접미사 없음: 계획서 10장 #15·#19),
│                         sessions.reset·chat.history 응답 파싱
├─ bridge/
│  ├─ server.ts           attachBridge: Socket.IO 네임스페이스 /bridge(HTTP 경로는 /socket.io/). 토큰 인증 → hello → inbound.deliver·config.set·agents.list 요청,
│  │                      outbound.message·status 수신, close 때 system.notice { reason: "shutdown" }
│  └─ session.ts          토큰 비교(상수 시간)·클라이언트 이벤트 Zod 파싱·연결 단계·outboundId 중복 제거
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
│                         플러그인이 에이전트 작성 인바운드에 사실을 넘길 때만 동작한다 (ADR 0002 7절)
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
├─ outbound.ts            buildOutboundMessage·coerceComponents — components 의 `artifact://` 값 안 공백류를 검증 전에 퍼센트 인코딩(Ruling 4)
├─ config-writer.ts       브리지에서 받은 채널 설정 변경을 runtime.config.mutateConfigFile 로 Gateway 설정에 반영(channel-config-writes 는 권한 판정).
│                         반영은 설정 스냅샷 기준 live. claude-cli 기존 세션은 리셋·새 키에서만 반영, 드리프트·재시작으로는 미반영 (ADR 0003 3절)
└─ context.ts             인바운드에 동봉할 최근 채널 메시지 N개 + 참여자 목록 + 릴레이 규칙 요약 + 채널 프롬프트 배치(헤더 줄 또는 ChannelPromptContext, ADR 0003)
```

SDK import 경로: `openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/channel-message`, `openclaw/plugin-sdk/channel-config-schema` 등 서브패스만 사용한다. `openclaw`는 devDependency이며 번들 시 external로 두어 Gateway가 제공하는 런타임을 쓴다.

배포: Gateway 호스트에서 `openclaw plugins install <tarball> --force --accept-capabilities`(초기; tarball 은 `pnpm pack`, `openclaw plugins pack` 은 채널 플러그인 거부, RPC `plugins.install` 은 clawhub/official 만 — ADR 0002 9절), 안정화 후 npm `@dodok/openclaw-plugin` 퍼블리시. Gateway 설정에 우리 채널 계정(브리지 URL·토큰)을 넣는다. 플러그인이 **아웃바운드**로 접속하므로 Gateway 호스트에 인바운드 포트를 열 필요는 없다.

### 2.5 `apps/web`

Phase 1 ② 웹 MVP 실물(스펙 `docs/superpowers/specs/2026-09-19-web-mvp-design.md`, 계획 `docs/superpowers/plans/2026-09-19-web-mvp.md`)
위에 Phase 2 ① 활동 패널·승인(스펙 `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`)과
Phase 2 ② components v1 렌더러(스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md`, 계획 `docs/superpowers/plans/2026-09-21-components-v1.md`)와
Phase 2 ③ 첨부·이미지(스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md`, 계획 `docs/superpowers/plans/2026-09-23-attachments.md`)와
Phase 2 ④ PWA·푸시(스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`, 계획 `docs/superpowers/plans/2026-09-23-pwa-push.md`, 구현과 달라진 것은 스펙 11장)가 얹혔다.
React 19 + Vite 8 + TanStack(Query·Router·Virtual) + Tiptap 작성기 + Streamdown 렌더 + Tailwind 4·shadcn. 의존성은 전부 정확 핀이고 웹 MVP 태스크 2 에서 한 번에 넣었다(Phase 2 ③ 은 0).
Phase 2 ④ 가 PWA·오프라인 사본 몫으로 더했다 — `vite-plugin-pwa`(dev)·`workbox-precaching`·`workbox-routing`·`workbox-window`·`@tanstack/query-persist-client-core`·`@tanstack/query-async-storage-persister`·`idb-keyval`.
서버 상태의 진실은 Query 캐시이고 wire 이벤트가 그것을 패치한다. 스트리밍 중인 런만 Zustand 스토어에 둔다(스펙 4장, 데이터 흐름 A).

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
│                          SKIP_WAITING · push → 알림 · notificationclick → 같은 출처 창 focus + postMessage({ type: "navigate" }), 없으면 openWindow · pushsubscriptionchange → 다시 구독·등록
├─ styles.css              Tailwind 진입(@import) + theme/tokens.css, Streamdown 클래스 @source, 한국어 줄바꿈(word-break: keep-all)
├─ app/
│  ├─ App.tsx              Provider 조립(Query·Router·Wire·Tooltip·Toaster) + Query 밖 401 등록
│  ├─ createApp.ts         앱 하나의 QueryClient·Router·onUnauthorized (테스트는 메모리 히스토리를 넘긴다). notify(승인 알림의 화면 사정 + 채널 이동 알림 onLocationChange —
│  │                       router.subscribe("onResolved")), 서비스 워커의 navigate 메시지 → safeNotificationUrl → router.navigate, captureInstallPrompt
│  ├─ boot.tsx             bootApp — onlineManager.setOnline(navigator.onLine) → 오프라인 사본 복원(최대 1초) → registerSessionReset(사본 지우기) → 렌더. main 과 테스트가 같은 것을 부른다
│  ├─ router.tsx           라우트(/login·가드 레이아웃·/·/c/$channelId(+/settings·/activity)·/agents), safeNext, 라우트 코드 분할
│  ├─ queryClient.ts       Query 기본값 — 전역 오류 토스트(`meta.silent` 로 끔, 폼 오류 VALIDATION·CONFLICT 제외), 재시도는 네트워크·5xx 만, 401 → 로그인.
│  │                       me 는 토스트하지 않고, 값이 없는 me 의 401(첫 가드)은 가드에 맡기며, 값을 가진 me 의 401(사본으로 뜬 뒤 세션 만료)은 onUnauthorized
│  ├─ session.ts           로그아웃·401 정리(resetClientState — 등록된 정리 훅: 오프라인 사본 지우기·dropLocalPush)와 Query 밖 REST 401 통지
│  ├─ fileDrop.ts          앱 수준 파일 드롭 막기(브라우저가 파일을 열어 앱을 떠나지 않게) + 「이미지는 입력 칸에 놓아 주세요」 한 문구·한 토스트 id. 작성기가 받은 드롭은 건드리지 않는다
│  ├─ NotFound.tsx         없는 경로(defaultNotFoundComponent)
│  ├─ RouteError.tsx       라우트 오류 화면(연결 문제 ↔ 코드 오류를 가른다)
│  └─ layout/
│     ├─ AppShell.tsx      사이드바 + 배너 + 페이지. 768px 미만은 사이드바를 왼쪽 시트로, 닫히면 초점 복귀
│     ├─ Sidebar.tsx       워크스페이스 이름·채널 목록·「채널 만들기」·「에이전트」·연결 상태·로그아웃
│     ├─ ChannelHeader.tsx 채널 이름·주제, 에이전트 아바타 묶음(+N), 설정 패널 여닫기, 좁은 화면 메뉴 버튼
│     ├─ Banners.tsx       wire 끊김·`rejected`·`protocol_mismatch` 배너 + OpenClaw 미연결 배너(둘은 함께 보일 수 있다) + 오프라인 배너
│     │                    「오프라인 — 저장된 내용을 보여 줍니다」(useOffline — 그때는 「서버에 다시 연결하는 중…」을 내지 않는다)
│     ├─ ConnectionDots.tsx Gateway·플러그인 점 — wire 가 끊기면 마지막 값을 믿지 않고 「알 수 없음」
│     ├─ NotifySettings.tsx 사이드바 하단 「알림」(벨) → Dialog 패널(Phase 2 ④, 옛 NotifyToggle 을 흡수) — 이 기기의 푸시 상태 다섯(미지원·설치 필요(iOS)·거절됨·꺼짐·켜짐)·
│     │                    「푸시 알림 켜기」·「끄기」·실패 이유(role=alert, 거절이면 상태 줄 하나)·「앱 설치」. 켜고 끄는 동안 닫히지 않는다.
│     │                    푸시가 없는 브라우저(iOS 아님)에서 권한이 default 면 「탭이 열려 있을 때만 알림 켜기」(옛 동작)
│     ├─ PanelTabs.tsx     오른쪽 패널의 탭 셸(「설정」·「활동」, `data-testid="page-channel-panel"`). 넓은 화면은 360px `<aside>`, 좁은 화면은 전체 시트.
│     │                    내용은 포털 하나로 옮겨 다녀 탭을 바꿔도 안쪽이 리마운트되지 않는다.
│     │                    초점: 좁은 화면 시트는 열면 지금 탭 링크(`data-tab-id`), Esc·닫기면 헤더 「채널 설정」 링크. 넓은 화면은 「설정 닫기」·「활동 닫기」
│     │                    링크를 누르면 패널이 내려가기 전에 같은 헤더 링크로 옮긴다(헤더에 활동을 여는 자리가 없어 두 탭 모두 그 자리)
│     └─ sidebarSheet.tsx  좁은 화면 시트 열기 컨텍스트 + 지금 화면의 메뉴 버튼(초점 복귀 대상)
├─ api/
│  ├─ http.ts              같은 출처 REST(`/api/v1`) — 인증은 httpOnly 쿠키, 토큰을 다루지 않는다. ApiRequestError·NetworkError
│  ├─ queries.ts           쿼리 키 `qk` 와 공용 훅(me·channels·channel·members·agents·adapter)
│  └─ formErrors.ts        VALIDATION·CONFLICT 를 폼 칸·문구로 잇는 도우미
├─ realtime/
│  ├─ wire.ts              Socket.IO 클라이언트(토큰 없음 — 쿠키 인증, `transports: ["websocket"]` 만: polling 첫 GET 에는 Origin 이 없다), WireStatus, WireAckError
│  ├─ WireProvider.tsx     로그인(me 캐시)이 확인되면 소켓을 만들어 붙인다 + `useChannelSubscription`. presence.update(연결마다 강제, visibilitychange·채널 이동 때 값이 바뀌면,
│  │                       끊겨 있으면 안 보냄, 채널 id 는 uuid 일 때만) · 로그인 확인 때 syncPushSubscription · 세션 정리 훅과 「값 없는 me 의 401」에서 dropLocalPush
│  ├─ handlers.ts          서버 이벤트 → Query 캐시·런 스토어·작성 중 저장소·연결 상태. `system.notice` 토스트 지속시간
│  ├─ subscriptions.ts     한 채널 구독·빈틈 이어 받기·과거 페이지 REST(5쪽 초과면 타임라인 리셋)
│  ├─ timelineCache.ts     `["timeline", channelId]` 읽기·쓰기
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
│  │                       누르면 잠그고 ack 대기, 확정되면 결과 한 줄로 남는다. 결정 뒤 초점은 그 결과 줄로 — 「이 카드에서 누른 승인 id」일 때만 옮긴다) · countdown.ts(남은 시간 문구 — 공용 틱 `useNowTick` 을 본다) ·
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
│  │                       upload.ts(XHR 업로드·진행·취소, 형식·5 MB 검사와 문구) · useComposerAttachments.ts(작성기 칩 상태 — 넣는 즉시 올리고, 빼면 끊고, 채널이 바뀌면 모두 비운다. 10장 상한)
│  ├─ auth/                LoginPage · mutations(useLogin·useLogout — 응답 `sessionToken` 은 쓰지 않는다, gcTime 0. 로그아웃은 disablePush 를 최대 3초 기다린 뒤 POST /auth/logout)
│  ├─ components/          components v1 카드 렌더러(Phase 2 ②). 사람·에이전트 메시지(MessageItem)와 시스템 카드(SystemCard 의 「이어가기」)가 함께 쓴다.
│  │                       Components.tsx(카드 전체: 블록을 배열 순서대로 → 모달 트리거 → 결과 줄 `@핸들 — 라벨: 값`(오래된 것부터, 20건이면 「최근 20건」).
│  │                       결정 뒤 초점은 ack 이 돌려준 **내** 상호작용 id 의 결과 줄로만) ·
│  │                       state.ts(순수: 비활성 규칙 한 곳 — 연결 → 만료 → 소비 → 권한(`allowedUsers` 가 비어 있지 않을 때만) → 전송 중, 사유 문구) ·
│  │                       useInteract.ts(`component.interact` 래퍼 — `send` 는 거부하지 않고 `SendResult` 로 성공·실패를 돌려준다. 버튼·셀렉트는 토스트,
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
│  ├─ messages/            timeline.ts(입장·과거·upsert·낙관적 교체·빈틈)·groupRows.ts(날짜 구분선·묶음)·useTimeline·useOlderPages·useAuthors,
│  │                       MessageList.tsx(TanStack Virtual, 끝 붙기·「새 메시지」 칩 — 기준은 가진 마지막 메시지의 seq), MessageItem·MessageBody(Streamdown, 원시 HTML 끔,
│  │                       단일 개행 → br, 마크다운 이미지는 링크로)·MentionChip·mentionMarkdown·SystemCard(MessageItem 과 SystemCard 의 components 는 `features/components` 의 `<Components>` 가 그린다)·
│  │                       PendingItem(보내는 중 첨부는 서버 경로로, 크게 보기 없음)·pendingActions·MessageErrorBoundary, ChannelPage.tsx(채널 확인 뒤에만 안을 그린다, 확인되면 touchRecentChannel).
│  │                       MessageItem 은 본문이 비면 본문을 그리지 않고, 본문 아래 `MessageAttachments` → components 카드 순으로 그린다
│  ├─ runs/                runStore.ts(Zustand, seq 중복 제거·재생)·bubblePhase.ts(상태 → 버블 모양)·StreamingBubble.tsx·useChannelBubbles·abortError
│  ├─ composer/            Composer.tsx(Tiptap) · mentions·MentionList(@ 후보) · serialize.ts(→ `<@a:id>` 토큰 bodyMd, 줄 머리 이스케이프) ·
│  │                       submitKeys(Enter 전송·IME) · slash.ts(`/stop`·`/new`) · useSendMessage(ack·10s 타임아웃 → failed, 첨부 id 를 싣고 재시도도 같은 id) · useTyping·TypingIndicator ·
│  │                       PendingAttachments.tsx(칩 — 미리보기·진행 막대·사유·「<이름> 빼기」, 빼면 초점을 옆 칩·「이미지 첨부」로). Composer 는 「이미지 첨부」 버튼·붙여넣기·
│  │                       작성기 상자 전체의 끌어다 놓기로 칩을 넣고, 올리기가 끝나야 보낸다(사유: 끊김 → 「이미지를 올리는 중입니다」 → 「올리지 못한 이미지를 빼 주세요」). 글 없이 이미지만 보낼 수 있다
│  ├─ agents/              AgentsPage·AgentRow(사용 토글·기본 프롬프트) · DiscoverDialog(「Gateway 에서 가져오기」) · ManualAgentForm·handleFrom ·
│  │                       resetSession·ResetSessionDialog(「새 대화」 — 작성기 `/new` 와 설정 패널이 함께 쓴다) · mutations
│  └─ settings/            ChannelSettingsPanel(패널 셸은 `app/layout/PanelTabs` 가 맡고 여기는 안쪽만) ·
│                          BasicSection·PromptSection·MembersSection·AgentMemberRow·RelayPolicySection(+relayPolicyForm)·autoRespond(채널당 하나 보장)·
│                          Section·ConfirmDialog·mutations(응답은 보낸 필드만 캐시 병합 — 늦은 응답이 wire 값을 덮지 않게)
├─ pwa/                    Phase 2 ④. register.ts(startPwa — 등록, 대기 워커가 있으면 showUpdateToast 「새 버전이 있습니다」+「새로고침」, 무기한 — 누를 때만 SKIP_WAITING) ·
│                          sw-logic.ts(순수, SW·앱 공용: safeNotificationUrl(`/c/<uuid>`·`/c/<uuid>/activity` 만, 그 밖 `/`) · notificationFromPush(PushPayload 파싱,
│                          실패하면 「dodok — 새 알림」, 승인만 renotify, 빈 tag 면 tag·renotify 없음) · pickClient(같은 출처: 보임+포커스 → 보임 → 포커스 → 첫 창) · urlBase64ToUint8Array) ·
│                          push.ts(상태 다섯 판정, enablePush(userId) — 권한 → SW ready(10초) → 공개키 → 구독(userVisibleOnly) → 등록, 실패하면 기기 해지 · disablePush(서버 해지 → 기기 해지) ·
│                          dropLocalPush(세션 없을 때 기기만) · syncPushSubscription(userId — 앱을 열 때, 켠 사람이 아니면 해지, 키가 바뀌면 다시 구독) ·
│                          pushOnThisDevice — 플래그 localStorage `dodok.push` = 켠 사용자 id) ·
│                          install.ts(isStandalone·isIos(iPadOS 포함)·captureInstallPrompt·useInstallPrompt) ·
│                          persist.ts(오프라인 사본 — IndexedDB(idb-keyval) 키 `dodok.query` 하나. me·channels·agents·recentChannels + 최근 5채널의 channel·members·timeline(50개,
│                          pending 없이, lastSeq 0 — 복원 채널은 fresh 구독), 7일·buster, me 없는 캐시는 지움, 저장마다 세대(epoch) — 지운 뒤 옛 저장이 되살아나지 않게,
│                          gc 된 최근 채널 항목은 이전 사본에서 이어 붙임(carryOver)) ·
│                          offline.ts(useOffline — navigator.onLine·onlineManager, 또는 값을 가진 me 의 NetworkError)
├─ hooks/
│  ├─ useIsNarrow.ts       768px 미만(사이드바 시트·패널 전체 화면)
│  └─ useNowTick.ts        「지금」을 1초마다 새로 읽는 앱 공용 시계 **하나** — 구독자가 몇이든 타이머 하나·같은 틱에 같은 값(런 소요·승인 카운트다운).
│                          흐르는 값이 없으면 구독하지 않고, 마지막 구독자가 떠나면 거둔다. 테스트는 `resetNowTick` 을 `test/setup.ts` afterEach 에서 부른다
├─ lib/                    josa.ts(받침에 따른 조사) · utils.ts(cn)
├─ theme/                  agentColor.ts(핸들 → 8색 색인) · tokens.css(중립 회색 램프·강조색 하나·상태색·에이전트 8색·모션 줄이기)
└─ ui/                     18개 — shadcn 복사본(alert·avatar·badge·button·checkbox·dialog·dropdown-menu·input·label·radio-group·scroll-area·
                           separator·sheet·sonner·switch·textarea·tooltip)과 직접 만든 field-error(칸 아래 오류 라이브 영역).
                           radio-group 은 Phase 2 ② 가 더했다(이미 있던 `radix-ui` 의 RadioGroup, 의존성 추가 없음). `ui/select.tsx` 는 없다 — 옵션은 OptionList 가 그린다.
                           손으로 두고 `@/lib/utils` 로 잇는다 — CLI 를 워크스페이스에서 돌리지 않는다
```

아직 없는 것: `features/setup/`(설정 마법사 — Phase 3). 사람이 이미지가 아닌 파일을 올리는 것은 범위 밖이다(첨부 스펙 결정 1).

테스트: 소스 옆 `*.test.ts(x)`(순수 로직 + jsdom 렌더·라우팅·wire 핸들러) + `apps/web/test/`(`setup.ts`, 공용 도우미 `shellApi`·`messages`·`composerHarness`·`fakeSocket`·`fakeXhr`(가짜 XHR 업로드·object URL 스텁)·`fixtures`·`scrollLayout`·`settingsServer`·`agentsPage`·`domStubs`·`media`·`memoryStorage`(오프라인 사본 저장소 주입)·`pushStubs`(가짜 serviceWorker·PushManager·구독), `ui.test.tsx`). E2E 파일은 두지 않는다 — 브라우저 검증은 워커가 `dev:fake` 위에서 한 번 돌고 보고서로 남긴다(스펙 10.2).

---

## 3. 런타임 토폴로지

```
[브라우저/PWA] ⇄ Socket.IO/HTTP ⇄ [Caddy] ⇄ [apps/server (+openclaw-adapter)]   ← 본인 서버 A (Compose)
                                                   ├─ Socket.IO 네임스페이스 /bridge (토큰)  ⇐ 아웃바운드 접속 ⇐ [openclaw-plugin @ Gateway]
                                                   └─ operator 클라이언트 ⇒ wss:// ⇒ [OpenClaw Gateway]   ← 본인 서버 B (원격)
```

- 기본값: 본인이 운영하는 원격 Gateway에 연결(`OPENCLAW_GATEWAY_URL=wss://...`). 플러그인은 그 Gateway에 설치되어 `BRIDGE_PUBLIC_URL`로 우리 서버에 접속한다.
- 로컬 개발: `docker compose --profile gateway up`이면 Gateway도 함께 기동(A=B). 원격 Gateway의 플러그인을 개발 PC의 브리지에 붙이려면 터널(cloudflared/tailscale 등)로 `BRIDGE_PUBLIC_URL`을 만든다.
- 응답 정본은 플러그인 경로, WS 경로는 미리보기(델타)·툴 이벤트·승인. `runId`로 dedupe.

---

## 4. 환경 변수 (`.env.example`)

정본은 `apps/server/src/config.ts`(zod). 서버는 저장소 루트를 작업 디렉터리로 삼고 루트 `.env` 를 읽는다 — **이미 설정된 환경 변수는 `.env` 가 덮지 않는다**(`process.loadEnvFile`, 실연에서 확인). 빈 값(`KEY=`)은 설정하지 않은 것으로 보고 기본값을 쓴다.

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 리슨 주소 |
| `PORT` | `3000` | 리슨 포트. REST `/api/v1`·wire(기본 네임스페이스)·브리지 `/bridge` 가 모두 여기 |
| `APP_ORIGIN` | (필수) | 웹 앱 오리진 — Socket.IO CORS·Better Auth `baseURL`/`trustedOrigins`·세션 쿠키 Secure(https 일 때). 로컬 `http://localhost:5173` |
| `TRUST_PROXY` | `false` | 리버스 프록시 뒤면 `true` — 로그인 레이트리밋이 X-Forwarded-For 의 클라이언트 IP 로 걸린다 |
| `DATA_DIR` | `./data` | 런타임 데이터(DB·첨부 블롭·디바이스 아이덴티티·VAPID 키 `vapid.json`) |
| `DB_PATH` | `<DATA_DIR>/dodok.sqlite` | SQLite 파일 |
| `ATTACHMENTS_DIR` | `<DATA_DIR>/attachments` | 첨부 블롭 디렉터리(`<sha 앞 2자>/<sha256>`). 부팅 때 만든다. 한 서버 프로세스만 쓴다 — sha 잠금이 프로세스 안에서만 맞다 |
| `LOG_LEVEL` | `info` | `fatal`~`trace` (pino, 토큰 키는 redact) |
| `DODOK_WORKSPACE_NAME` | `dodok` | 부팅 때 워크스페이스가 없으면 이 이름으로 만든다 |
| `OWNER_HANDLE` | `owner` | owner 핸들 |
| `LOCAL_AUTH_TOKEN` | (필수, ≥16자) | 로컬 로그인 토큰 = owner 비밀번호. 바꾸면 기존 세션이 끊긴다 |
| `BETTER_AUTH_SECRET` | (필수, ≥32자) | Better Auth 서명 비밀 |
| `OPENCLAW_TARGET` | `remote` | `remote` \| `dev` — 어댑터가 붙을 Gateway 쌍과 디바이스 파일을 고른다 |
| `OPENCLAW_GATEWAY_URL` · `OPENCLAW_GATEWAY_TOKEN` | — | 원격 Gateway(`wss://…`). `remote` 면 둘 다 필수 |
| `OPENCLAW_DEV_GATEWAY_URL` · `OPENCLAW_DEV_GATEWAY_TOKEN` | — | 로컬 dev Gateway(`ws://127.0.0.1:19001`, `openclaw --dev gateway run`). `dev` 면 둘 다 필수 |
| `OPENCLAW_DEVICE_IDENTITY_PATH` | `<DATA_DIR>/openclaw-device.json` (dev: `openclaw-device-dev.json`) | Ed25519 디바이스 아이덴티티 — 원격·dev 페어링이 섞이지 않게 대상별로 나뉜다 |
| `OPENCLAW_FRAME_DUMP_PATH` | — | 진단용 — 어댑터가 받은 Gateway `chat`·`agent`·`session.message` 프레임을 이 파일에 JSONL(`{ receivedAt, frame }`)로 append. 본문이 들어가므로 `data/` 아래에. usage 출처 확인용(live-smoke 5.4) |
| `BRIDGE_TOKEN` | (필수, ≥16자) | 플러그인 계정 설정 `channels.dodok.accounts.<id>.token` 과 같은 공유 토큰 |
| `BRIDGE_PUBLIC_URL` | — | 플러그인 계정 설정 `bridgeUrl` 에 적을 공개 주소(정보용 — 서버는 이 값으로 리슨하지 않는다). 예 `wss://dodok.example.com/bridge` |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | — | 웹 푸시 VAPID 키 쌍 — **둘 다** 있어야 쓴다. 없으면 `<DATA_DIR>/vapid.json` 을 만들어(0600) 쓴다. 키가 바뀌면 모든 기기의 푸시 구독이 무효가 된다. 비밀 키는 로그에서 가린다 |
| `VAPID_SUBJECT` | `mailto:dodok@localhost` | 푸시 서비스가 연락할 주체 — `mailto:…` 또는 `https://…`. 호스트가 `localhost`·`127.0.0.1`·`*.local` 이면 시작 때 warn(Apple Push 는 `403 BadJwtToken`) — 배포는 실제 연락처로(`docs/guides/live-smoke.md` 14.2) |
| `BRIDGE_URL` | — | **스파이크 러너 전용**(서버는 읽지 않음) — 러너가 브리지를 리슨할 오리진(`/bridge` 없음) |

플러그인은 env 가 아니라 Gateway 계정 설정 `channels.dodok.accounts.<id>.bridgeUrl`(오리진 + `/bridge`)로 접속한다(ADR 0002 10절). 서버 쪽 공개 주소는 `BRIDGE_PUBLIC_URL` 하나로 정리됐고, 스파이크의 `BRIDGE_URL` 은 러너 전용으로 남았다.
웹(`apps/web`)은 `.env` 를 읽지 않는다 — 브라우저에 들어가는 설정이 없다. `vite.config.ts` 가 셸 환경으로 받는 것은 셋이다 — dev 서버의 프록시 대상 `DODOK_API_ORIGIN`(기본 `http://127.0.0.1:3000`), 개발 모드 서비스 워커 `VITE_PWA_DEV=1`(기본 끔), 빌드 식별자 `VITE_BUILD_ID`(기본 빌드 시각 — 오프라인 사본을 버리는 기준). 서버 포트를 바꾸면 `APP_ORIGIN`(서버)·`DODOK_API_ORIGIN`(Vite)·브라우저 주소를 함께 맞춘다 — wire 는 핸드셰이크 `Origin` 이 `APP_ORIGIN` 과 같을 때만 쿠키를 받는다.

Postgres 전환 시 `DB_PATH` 대신 연결 문자열.

우리가 관리하는 OpenClaw 설정 조각(설정 마법사가 만들어 주고, 사용자가 Gateway 호스트에 적용):

```json5
{
  // 첨부(Phase 2 ③)의 attachments.ttlHours·tools.fs.workspaceOnly 는 운영자가 호스트에 맞춰 정한다 — docs/guides/live-smoke.md 6절
  tools: { agentToAgent: { enabled: false }, sessions: { visibility: "tree" } },   // 루트 sessions 키는 거부된다 (ADR 0002)
  channels: {
    dodok: {
      accounts: { default: { bridgeUrl: "wss://dodok.example.com/bridge", token: "<BRIDGE_TOKEN>" /* , mediaMaxMb: 20 (선택) */ } },
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
