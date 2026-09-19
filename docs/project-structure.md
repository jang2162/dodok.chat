# 프로젝트 구성 가이드 (Claude Code 인계용)

작성일: 2026-09-14 · 계획서 v0.4 기준 · 이 문서는 "어떻게 구성할지"만 다룬다. 배경·결정 근거는 `docs/plan.md` 참고.

---

## 1. 저장소 구조 (pnpm workspaces + Turborepo)

```
dodok.chat/
├─ apps/
│  ├─ web/                    # @dodok/web — React 19 + Vite PWA
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
│  ├─ guides/                 # 작업 지침 (worktree-workflow.md, browser-verification.md)
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
├─ data/                      # 런타임 데이터 (SQLite, 업로드, 디바이스 아이덴티티) — git 제외
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
├─ domain/        workspace, user, agent, channel, message, run, approval 타입 + Zod
├─ components/    components v1 스키마 (blocks/actions/button/select/modal/media/file) + 제약 검증
├─ events/        RunEvent 유니온 (AG-UI 이벤트명 채택: TEXT_MESSAGE_START/CONTENT/END,
│                 TOOL_CALL_START/ARGS/END, RUN_STARTED/FINISHED/ERROR, STATE_SNAPSHOT, CUSTOM)
├─ wire/          클라이언트↔서버 Socket.IO 이벤트 계약 (server→client, client→server 타입 맵)
├─ bridge/        플러그인↔서버 브리지 메시지 계약 (인바운드 전달, 아웃바운드 수신, 컴포넌트 결과, 설정 변경, 헬스)
└─ mention.ts     @멘션 파싱 (사람/에이전트 별칭 → id), 릴레이 감지에 공용
```

규칙: 여기의 Zod 스키마가 단일 진실. 서버 입력 검증·클라이언트 폼·플러그인 아웃바운드 검증·브리지 양단 검증이 전부 같은 스키마를 import한다. 브리지 계약이 `shared`에 있는 이유는 플러그인과 서버가 서로 다른 프로세스·호스트에서 같은 메시지를 파싱하기 때문이다.

### 2.2 `apps/server`

Phase 1 ① 서버 코어 실물(스펙 `docs/superpowers/specs/2026-09-15-server-core-design.md`, 계획 `docs/superpowers/plans/2026-09-15-server-core.md`). 한 프로세스 안에 REST·wire·브리지·어댑터가 같이 뜬다.

```
src/
├─ main.ts                프로세스 진입점: cwd 를 저장소 루트로 옮기고 루트 .env 로드(이미 있는 env 는 덮지 않음) → createApp → listen, SIGINT/SIGTERM → close
├─ app.ts                 createApp: 부팅 순서(DB → 워크스페이스 → 인증·owner → Fastify → Socket.IO → 어댑터 → 서비스 → 라우트 → wire → 부팅 정리 → adapter.connect),
│                         종료 순서(새 wire 거부 → 오케스트레이터 stop → adapter.close → io.close → Fastify → DB, 10s 상한), /healthz, Gateway 재접속 60s 알림
├─ config.ts              env 를 zod 로 검증한 ServerConfig. OPENCLAW_TARGET 이 원격/dev Gateway 쌍과 디바이스 파일을 고른다
├─ logger.ts              pino, 토큰·비밀 키 redact
├─ wiring.ts              createServices(라우터 ⇄ 오케스트레이터 상호 참조, RunsFacade), sessionRecoverTargets(재접속 복구 대상)
├─ db/
│  ├─ schema.sqlite.ts    Drizzle 스키마 (계획서 6장 테이블 + agent_sessions)
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
│  ├─ channels/           CRUD·멤버(에이전트 promptOverride·autoRespond·aliases)·프롬프트 리비전, 프롬프트 변경 시 어댑터 config.set, 「새 대화」(resetAgentSession)
│  ├─ agents/             에이전트 등록·수정, GET /agents/discover(Gateway agents.list)
│  ├─ messages/           seq 발급(seq.ts)·사람/에이전트/시스템 메시지 저장·bus 통지·히스토리 페이징
│  ├─ router/             decide.ts(순수: 멘션·릴레이 판정, maxRelayTurns·allowPairs·반복 해시·일일 상한) + service.ts(런 enqueue, relay_limit·relay_denied 시스템 메시지와 continue_relay 버튼)
│  ├─ runs/               orchestrator.ts(세션 직렬화·타이머·신호 → 상태 전이·run_events·정본 상관·부팅 정리), machine.ts(순수 상태머신),
│  │                      store.ts(runs·run_events), context.ts(인바운드 InboundDeliver 조립), timers.ts, routes.ts(런 목록·상세·이벤트 REST)
│  ├─ sessions/           agent_sessions — 채널×에이전트 세션 키 보장, 리셋 뒤 프롬프트 리비전 갱신
│  ├─ components/         interact.ts(순수: 검사 순서·값 스키마·인바운드 텍스트) + service.ts(저장·소비·continue/interaction 런)
│  └─ adapter/            GET /api/v1/adapter/status
├─ adapters/
│  └─ types.ts            AgentAdapter 계열 타입 재수출(구현은 packages/openclaw-adapter)
└─ realtime/
   ├─ bus.ts              ServerBus — 모듈 → realtime 타입드 이벤트
   ├─ socket.ts           wire 인증(세션 토큰·프로토콜)·룸(channel:<id>, user:<id>)·클라이언트 → 서버 핸들러(subscribe 는 lastSeq 이후 ≤200)
   ├─ events.ts           bus → 룸 팬아웃, 소켓별 미전송 500 초과 시 run.event 버림 + run.state { resync }
   └─ types.ts            WireServer·RunsFacade 타입
```

아직 없는 것(Phase 2 이후): `approvals/`(승인 카드 미러), `push/`, `uploads/`, 어댑터 `registry.ts`(MVP 는 openclaw 하나).

테스트(`apps/server/test/`): 모듈 단위(인메모리 SQLite), `fakes/`(가짜 Gateway·가짜 플러그인·시나리오 대본), `integration/`(시나리오 1~8, 실제 어댑터 + 가짜 둘), `helpers/`(`bootLiveApp`·wire 클라이언트·시나리오 단계).
손으로 두드리는 실연 도구는 루트 `scripts/wire-cli.ts`(`pnpm wire-cli`, `docs/guides/live-smoke.md`).

### 2.3 `packages/openclaw-adapter` (서버 프로세스 안에서 실행)

```
src/
├─ index.ts               배럴: adapter-types · createOpenClawAdapter · FakeAdapter
├─ adapter-types.ts       AgentAdapter 인터페이스(스펙 6.1), AdapterEvent·RunEventBody, AdapterCapabilities(sessionReset·agentsList·configSet), AdapterError
├─ openclaw-adapter.ts    createOpenClawAdapter: 연결 관리자 + 브리지 + 매퍼 조립. send = 런 id 등록 → 세션 구독 → inbound.deliver(플러그인 미접속 120s 대기,
│                         ack 타임아웃 10s·재시도 1s·4s·16s) → admission. 정본 outbound.message → onCanonical. abort(chat.abort)·resetSession(sessions.reset,
│                         FORBIDDEN 이면 capability 내림)·listAgents·syncChannelConfig·forgetRun·status 이벤트
├─ fake-adapter.ts        FakeAdapter — 서버 단위 테스트용(`@dodok/openclaw-adapter/fake` 서브패스), calls 기록·이벤트 주입
├─ config-sync.ts         채널 설정 → 브리지 config.set(10s). 플러그인이 없으면 기다리지 않고 ADAPTER_UNAVAILABLE
├─ gateway/
│  ├─ client.ts           @openclaw/gateway-client 래퍼: connect.challenge → connect(디바이스 서명·공유 토큰, scopes 에 operator.admin 포함,
│  │                      caps DEFAULT_GATEWAY_CAPS) → hello-ok. 실패(PAIRING_REQUIRED 포함)는 그대로 올리고 재시도는 연결 관리자 몫
│  ├─ connection-manager.ts  접속 루프·지수 백오프·상태(down/reconnecting/connected)·요청 타임아웃, 접속마다 복구(sessions.subscribe →
│  │                      대상 세션별 sessions.messages.subscribe → chat.history, 커서 reset 이면 꼬리 페이지 다시).
│  │                      subscribeSession: 접속 뒤 새로 생긴 세션은 send 전에 연결당 한 번 구독 — 실물 Gateway 는 구독한 세션의 이벤트만 보낸다(실연에서 발견, live-smoke 5.4)
│  ├─ device-identity.ts  Ed25519 아이덴티티 생성·저장(0600)·서명 (스파이크 1에서 확정)
│  ├─ events.ts           chat(delta/final/error/aborted)·agent(lifecycle·stream:"tool")·session.message(usage) → RunEvent + RunSignal.
│  │                      우리 런(runId = 우리 런 uuid, ADR 0002 4.3)만. deltaText → TEXT_MESSAGE_CONTENT(replace 면 TEXT_MESSAGE_REPLACE), final 스냅샷은 정본 대체용
│  ├─ frame-dump.ts       OPENCLAW_FRAME_DUMP_PATH — 받은 chat·agent·session.message 프레임 JSONL append(스트림, 쓰기 오류면 warn 뒤 끔, close 에서 닫음)
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
├─ components-schema.ts   message 툴에 끼울 components 스키마 조각 (shared/components를 그대로 노출)
├─ bridge-client.ts       서버 브리지 WSS 아웃바운드 접속(BRIDGE_URL·토큰)·지수 백오프 재연결·아웃바운드 큐
├─ config-writer.ts       브리지에서 받은 채널 설정 변경을 runtime.config.mutateConfigFile 로 Gateway 설정에 반영(channel-config-writes 는 권한 판정).
│                         반영은 설정 스냅샷 기준 live. claude-cli 기존 세션은 리셋·새 키에서만 반영, 드리프트·재시작으로는 미반영 (ADR 0003 3절)
└─ context.ts             인바운드에 동봉할 최근 채널 메시지 N개 + 참여자 목록 + 릴레이 규칙 요약 + 채널 프롬프트 배치(헤더 줄 또는 ChannelPromptContext, ADR 0003)
```

SDK import 경로: `openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/channel-message`, `openclaw/plugin-sdk/channel-config-schema` 등 서브패스만 사용한다. `openclaw`는 devDependency이며 번들 시 external로 두어 Gateway가 제공하는 런타임을 쓴다.

배포: Gateway 호스트에서 `openclaw plugins install <tarball> --force --accept-capabilities`(초기; tarball 은 `pnpm pack`, `openclaw plugins pack` 은 채널 플러그인 거부, RPC `plugins.install` 은 clawhub/official 만 — ADR 0002 9절), 안정화 후 npm `@dodok/openclaw-plugin` 퍼블리시. Gateway 설정에 우리 채널 계정(브리지 URL·토큰)을 넣는다. 플러그인이 **아웃바운드**로 접속하므로 Gateway 호스트에 인바운드 포트를 열 필요는 없다.

### 2.5 `apps/web`

```
src/
├─ app/                   라우터(TanStack Router), 레이아웃(사이드바 채널 목록 / 메시지 영역 / 활동 패널)
├─ features/
│  ├─ channels/           목록·생성·설정(프롬프트, 에이전트 멤버, 릴레이 정책)
│  ├─ messages/           가상화 목록(TanStack Virtual), 스트리밍 버블, Streamdown 렌더
│  ├─ composer/           Tiptap + Mention 확장, 슬래시 커맨드(/new, /stop), 이미지 붙여넣기
│  ├─ components/         components v1 렌더러 (shadcn 프리미티브), 상호작용 전송
│  ├─ activity/           런 타임라인(AI Elements Tool/Reasoning 조각), 승인 카드
│  ├─ agents/             에이전트 등록(OpenClaw agentId 매핑), 상태 표시
│  └─ setup/              설정 마법사(Gateway URL·토큰·페어링·플러그인 설치 안내·브리지 URL/토큰 발급), 연결 상태
├─ realtime/              Socket.IO 클라이언트, lastSeq 복구, 델타 적용
├─ pwa/                   서비스워커(vite-plugin-pwa), 푸시 구독, iOS 설치 안내
└─ ui/                    shadcn 컴포넌트
```

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
| `DATA_DIR` | `./data` | 런타임 데이터(DB·디바이스 아이덴티티) |
| `DB_PATH` | `<DATA_DIR>/dodok.sqlite` | SQLite 파일 |
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
| `BRIDGE_URL` | — | **스파이크 러너 전용**(서버는 읽지 않음) — 러너가 브리지를 리슨할 오리진(`/bridge` 없음) |

플러그인은 env 가 아니라 Gateway 계정 설정 `channels.dodok.accounts.<id>.bridgeUrl`(오리진 + `/bridge`)로 접속한다(ADR 0002 10절). 서버 쪽 공개 주소는 `BRIDGE_PUBLIC_URL` 하나로 정리됐고, 스파이크의 `BRIDGE_URL` 은 러너 전용으로 남았다.
Phase 2 이후에 더할 것: `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY`·`VAPID_SUBJECT`(푸시), `UPLOAD_DIR`(업로드). Postgres 전환 시 `DB_PATH` 대신 연결 문자열.

우리가 관리하는 OpenClaw 설정 조각(설정 마법사가 만들어 주고, 사용자가 Gateway 호스트에 적용):

```json5
{
  tools: { agentToAgent: { enabled: false }, sessions: { visibility: "tree" } },   // 루트 sessions 키는 거부된다 (ADR 0002)
  channels: {
    dodok: {
      accounts: { default: { bridgeUrl: "wss://dodok.example.com/bridge", token: "<BRIDGE_TOKEN>" } },
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
- 커밋: Conventional Commits. 패키지 스코프 사용(`feat(plugin): …`).
- OpenClaw 패키지 버전은 정확히 핀(`--save-exact`), Gateway와 같은 버전. 업그레이드는 Gateway와 같은 PR에서, 업그레이드 전 `@openclaw/gateway-protocol` CHANGELOG의 보류 항목 확인.
- 시크릿·디바이스 아이덴티티·브리지 토큰은 `data/`와 `.env`에만, 커밋 금지.
- 마이그레이션은 Drizzle Kit, SQLite/Postgres 양쪽에서 통과해야 머지.

---

## 7. `CLAUDE.md`

저장소 루트의 `CLAUDE.md` 가 정본이다. 초안은 코드 착수 때 그 파일로 옮겼고, 같은 내용을 두 곳에 두지 않는다 —
가르치는 자리가 둘이면 둘 다 맞아야 하므로 한 곳만 남긴다. 작업 방식(워크트리·Orca 워커·커밋 규칙)은
`docs/guides/worktree-workflow.md` 가 정본이고 `CLAUDE.md` 는 그 요약이다.
