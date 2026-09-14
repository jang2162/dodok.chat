# 프로젝트 구성 가이드 (Claude Code 인계용)

작성일: 2026-09-14 · 계획서 v0.4 기준 · 이 문서는 "어떻게 구성할지"만 다룬다. 배경·결정 근거는 `docs/plan.md` 참고.

---

## 1. 저장소 구조 (pnpm workspaces + Turborepo)

```
dodok.chat/
├─ apps/
│  ├─ web/                    # @dodok/web — React 19 + Vite PWA
│  └─ server/                 # @dodok/server — Node 22 + Fastify + Socket.IO (+ 플러그인 브리지 엔드포인트)
├─ packages/
│  ├─ shared/                 # @dodok/shared — 도메인 타입·Zod 스키마·components v1 규약·RunEvent(AG-UI 매핑)·wire 계약
│  ├─ openclaw-plugin/        # @dodok/openclaw-plugin — OpenClaw 채널 플러그인 (원격 Gateway 안에서 실행)
│  └─ openclaw-adapter/       # @dodok/openclaw-adapter — 서버 측 OpenClaw 어댑터 (브리지 서버 + Gateway WS 클라이언트)
├─ infra/
│  ├─ docker-compose.yml      # server + web(정적) + caddy, `--profile gateway`로 로컬 OpenClaw 동반 기동
│  └─ caddy/Caddyfile         # /, /api, /socket.io, /bridge 를 TLS로 노출
├─ docs/
│  ├─ plan.md                 # 계획서
│  ├─ project-structure.md    # 이 문서
│  └─ adr/                    # 결정 기록 (스파이크 결과마다 한 장; 계획서 10장의 결정은 코드 착수 시 옮김)
├─ data/                      # 런타임 데이터 (SQLite, 업로드, 디바이스 아이덴티티) — git 제외
├─ CLAUDE.md                  # 7장 초안 사용
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
│                 TOOL_CALL_START/ARGS/END, RUN_STARTED/FINISHED/ERROR, STATE_DELTA, CUSTOM)
├─ wire/          클라이언트↔서버 Socket.IO 이벤트 계약 (server→client, client→server 타입 맵)
├─ bridge/        플러그인↔서버 브리지 메시지 계약 (인바운드 전달, 아웃바운드 수신, 컴포넌트 결과, 설정 변경, 헬스)
└─ mention.ts     @멘션 파싱 (사람/에이전트 별칭 → id), 릴레이 감지에 공용
```

규칙: 여기의 Zod 스키마가 단일 진실. 서버 입력 검증·클라이언트 폼·플러그인 아웃바운드 검증·브리지 양단 검증이 전부 같은 스키마를 import한다. 브리지 계약이 `shared`에 있는 이유는 플러그인과 서버가 서로 다른 프로세스·호스트에서 같은 메시지를 파싱하기 때문이다.

### 2.2 `apps/server`

```
src/
├─ app.ts                 Fastify 부트스트랩, Socket.IO 부착, 브리지 WSS 라우트(/bridge) 마운트
├─ config.ts              env 로드 (zod로 검증)
├─ db/
│  ├─ schema.ts           Drizzle 스키마 (계획서 6장 테이블 + push_subscriptions)
│  └─ migrate.ts
├─ auth/                  Better Auth 설정 (MVP: 단일 owner, 로컬 토큰; org 플러그인은 꺼둠)
├─ modules/
│  ├─ channels/           CRUD, 멤버(사람/에이전트), 채널 프롬프트·오버라이드 (변경 시 어댑터 config-sync 호출)
│  ├─ messages/           저장·seq 발급·브로드캐스트·히스토리 페이징
│  ├─ router/             멘션 라우터 + 릴레이 정책 (maxRelayTurns, allowPairs, 반복 해시 가드)
│  ├─ runs/               Run/RunEvent 저장, 스트리밍 버퍼(50ms 코얼레싱), 활동 패널용 조회
│  ├─ components/         상호작용 수신 → 저장 → 인바운드 텍스트 변환 → 어댑터 전달, TTL/allowedUsers 검사
│  ├─ approvals/          승인 카드 상태 미러, resolve 위임
│  ├─ push/               web-push 구독 저장·발송 (멘션/승인/릴레이 한도)
│  └─ uploads/            multipart 저장 + sharp 썸네일
├─ adapters/
│  ├─ types.ts            AgentAdapter 인터페이스 (계획서 5.7)
│  └─ registry.ts         provider → adapter 인스턴스
└─ realtime/
   ├─ socket.ts           Socket.IO 네임스페이스·룸(채널=룸)·재접속 시 lastSeq 이후 재전송
   └─ events.ts           wire 계약 구현
```

### 2.3 `packages/openclaw-adapter` (서버 프로세스 안에서 실행)

```
src/
├─ index.ts               AgentAdapter 구현 (openclaw)
├─ gateway/
│  ├─ client.ts           @openclaw/gateway-client 래퍼: wss 접속, 디바이스 아이덴티티·토큰을 hostDeps로 data/에 저장,
│  │                      hello-ok(features·policy) 캐시, caps 선언, 재접속 시 프로젝션 재구축
│  ├─ sessions.ts         채널·에이전트 → sessionKey 매핑 (agent:<agentId>:dodok:channel:<channelId>)
│  ├─ events.ts           chat(delta/final/status/error/aborted)/agent/session.tool/session.approval → RunEvent 정규화 (runId+seq 정합)
│  └─ approvals.ts        approval.get/resolve
├─ bridge/
│  ├─ server.ts           플러그인이 아웃바운드로 붙는 WSS 엔드포인트 (Fastify 앱에 /bridge로 마운트; 토큰 인증,
│  │                      인바운드 전달, 아웃바운드 수신, 컴포넌트 결과 전달, 헬스)
│  └─ session.ts          플러그인 연결 1개의 상태 (연결/재연결, 미응답 요청, 중복 제거)
└─ config-sync.ts         채널 프롬프트 변경 → 브리지로 플러그인에 "설정 변경" 전달 → 플러그인이 Gateway 설정 갱신 → 반영 확인
```

### 2.4 `packages/openclaw-plugin` (원격 OpenClaw Gateway 프로세스 안에서 실행)

```
src/
├─ index.ts               definePluginEntry({ id: "dodok", register(api) { api.registerChannel(...) } })
├─ channel.ts             채널 정의: 인바운드 ingress, 아웃바운드 액션 어댑터(describeMessageTool),
│                         채널별 설정 스키마(requireMention, systemPrompt, users, 봇 루프 보호 조정)
├─ components-schema.ts   message 툴에 끼울 components 스키마 조각 (shared/components를 그대로 노출)
├─ bridge-client.ts       서버 브리지 WSS 아웃바운드 접속(BRIDGE_URL·토큰)·지수 백오프 재연결·아웃바운드 큐
├─ config-writer.ts       브리지에서 받은 채널 설정 변경을 SDK(config-mutation / channel-config-writes)로 Gateway 설정에 반영
└─ context.ts             인바운드에 동봉할 최근 채널 메시지 N개 + 참여자 목록 + 릴레이 규칙 요약
```

SDK import 경로: `openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/channel-message`, `openclaw/plugin-sdk/channel-config-schema` 등 서브패스만 사용한다. `openclaw`는 devDependency이며 번들 시 external로 두어 Gateway가 제공하는 런타임을 쓴다.

배포: Gateway 호스트에서 `openclaw plugins install <tarball 또는 git URL>`(초기), 안정화 후 npm `@dodok/openclaw-plugin` 퍼블리시. Gateway 설정에 우리 채널 계정(브리지 URL·토큰)을 넣는다. 플러그인이 **아웃바운드**로 접속하므로 Gateway 호스트에 인바운드 포트를 열 필요는 없다.

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
                                                   ├─ /bridge (WSS, 토큰)  ⇐ 아웃바운드 접속 ⇐ [openclaw-plugin @ Gateway]
                                                   └─ operator 클라이언트 ⇒ wss:// ⇒ [OpenClaw Gateway]   ← 본인 서버 B (원격)
```

- 기본값: 본인이 운영하는 원격 Gateway에 연결(`OPENCLAW_GATEWAY_URL=wss://...`). 플러그인은 그 Gateway에 설치되어 `BRIDGE_PUBLIC_URL`로 우리 서버에 접속한다.
- 로컬 개발: `docker compose --profile gateway up`이면 Gateway도 함께 기동(A=B). 원격 Gateway의 플러그인을 개발 PC의 브리지에 붙이려면 터널(cloudflared/tailscale 등)로 `BRIDGE_PUBLIC_URL`을 만든다.
- 응답 정본은 플러그인 경로, WS 경로는 미리보기(델타)·툴 이벤트·승인. `runId`로 dedupe.

---

## 4. 환경 변수 (`.env.example`)

```
DATABASE_URL=file:./data/app.db            # 이후 postgres://
AUTH_SECRET=
APP_ORIGIN=https://dodok.example.com       # 로컬: http://localhost:5173
OPENCLAW_GATEWAY_URL=wss://gateway.example.com   # 원격 기본. 로컬 동반 기동 시 ws://gateway:18789
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_DEVICE_IDENTITY_PATH=./data/openclaw-device.json
BRIDGE_PUBLIC_URL=wss://dodok.example.com/bridge   # 플러그인이 접속할 공개 주소 (설정 마법사가 표시)
BRIDGE_TOKEN=                              # 플러그인 계정 설정에 넣을 공유 토큰 (마법사가 발급)
VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY= / VAPID_SUBJECT=mailto:...
UPLOAD_DIR=./data/uploads
```

우리가 관리하는 OpenClaw 설정 조각(설정 마법사가 만들어 주고, 사용자가 Gateway 호스트에 적용):

```json5
{
  tools: { agentToAgent: { enabled: false } },
  sessions: { visibility: "tree" },
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

0. 원격 Gateway를 2026.9.4로 업그레이드, 세 패키지를 같은 버전으로 핀. `agentToAgent`·`visibility` 설정 적용.
1. 모노레포 스캐폴드, `shared` 타입·스키마부터 (계획서 5.4 components v1, 6장 테이블, wire·bridge 계약).
2. `openclaw-adapter/gateway/client.ts` — wss 접속·페어링·`hello-ok.features` 덤프·`chat.send`·`chat` 델타·`session.tool` 콘솔 출력까지 (스파이크 1). 산출: 프로토콜 매핑 표.
3. `openclaw-plugin` 스켈레톤 — 원격 Gateway에 tarball 설치, 터널로 브리지 접속, 인바운드 수신·`message` 툴 아웃바운드·components 스키마 노출 확인, 봇 루프 보호 상호작용 확인 (스파이크 2). **여기서 막히면 대안:** `registerTool("ui_render")`.
4. 채널 프롬프트 설정 갱신을 플러그인 내부 쓰기로 반영·확인 (스파이크 3). 실패 시 Gateway 설정 메서드 또는 인바운드 프리픽스.
5. 스파이크 통과 후 `server` 모듈 → `web` 순으로 MVP 코어(Phase 1).

각 스파이크 결과는 `docs/adr/`에 한 장씩 남긴다.

---

## 6. 컨벤션

- TypeScript strict, ESM only, `pnpm`, Biome(린트+포맷), Vitest, Playwright.
- 모든 외부 입력(HTTP, Socket.IO, 브리지, Gateway 이벤트)은 경계에서 Zod 파싱 후 내부로.
- 커밋: Conventional Commits. 패키지 스코프 사용(`feat(plugin): …`).
- OpenClaw 패키지 버전은 정확히 핀(`--save-exact`), Gateway와 같은 버전. 업그레이드는 Gateway와 같은 PR에서, 업그레이드 전 `@openclaw/gateway-protocol` CHANGELOG의 보류 항목 확인.
- 시크릿·디바이스 아이덴티티·브리지 토큰은 `data/`와 `.env`에만, 커밋 금지.
- 마이그레이션은 Drizzle Kit, SQLite/Postgres 양쪽에서 통과해야 머지.

---

## 7. `CLAUDE.md` 초안 (저장소 루트에 넣을 것)

```md
# dodok.chat

사람과 AI 에이전트가 같은 채널에서 대화하는 에이전트 네이티브 메신저. 1차 연동은 OpenClaw.
계획: docs/plan.md · 구성: docs/project-structure.md · 결정: docs/plan.md 10장, docs/adr/

## 구조
pnpm 모노레포, npm 스코프 @dodok. apps/web(React+Vite PWA), apps/server(Fastify+Socket.IO+브리지 엔드포인트),
packages/shared(타입·Zod·components 규약·wire/bridge 계약), packages/openclaw-plugin(원격 Gateway 안 채널 플러그인, id "dodok"),
packages/openclaw-adapter(서버 측 브리지 서버+Gateway WS 클라이언트).

## 불변 규칙
- 에이전트 간 소통은 채널 @멘션 릴레이로만. OpenClaw agentToAgent는 꺼둔다.
- 세션 키는 채널당 에이전트별 1개: agent:<agentId>:dodok:channel:<channelId>
- 응답 정본은 플러그인 경로, Gateway WS는 델타/툴 이벤트/승인. runId로 dedupe.
- Gateway는 원격이 기본. 플러그인이 서버 /bridge 로 아웃바운드 WSS 접속. Gateway 쪽 포트를 열지 않는다.
- OpenClaw 패키지 3종은 배포 Gateway와 같은 버전으로 정확 핀(현재 2026.9.4, 프로토콜 v4).
- components v1 제약(액션 로우 버튼≤5 또는 셀렉트 1, 옵션≤25, 모달 필드≤5)은 shared 스키마가 강제.
- 외부 입력은 경계에서 Zod 파싱. shared는 Node 전용 API 금지.
- 시크릿·디바이스 아이덴티티·브리지 토큰은 data/ 와 .env 에만. 커밋 금지.

## 명령
pnpm i · pnpm dev(전체) · pnpm -F @dodok/server dev · pnpm -F @dodok/web dev · pnpm test · pnpm lint
docker compose -f infra/docker-compose.yml up [--profile gateway]

## 현재 단계
Phase 0 스파이크 (docs/project-structure.md 5장 순서대로). 스파이크마다 docs/adr/에 결과 기록.
```
