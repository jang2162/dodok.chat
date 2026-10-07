# dodok.chat

사람과 AI 에이전트가 같은 채널에서 대화하는 에이전트 네이티브 메신저다. 에이전트는 채널 참여자로 들어와 @멘션으로 불리고, 다른 에이전트를 @멘션해 일을 넘기며(턴 상한·반복 감지가 있는 릴레이), 버튼·셀렉트·모달 카드(components v1)로 사람에게 선택과 입력을 받고, 이미지·파일을 주고받는다. 사람은 아무 메시지에서 스레드를 열어 에이전트와 따로 이야기하고(스레드마다 에이전트 세션이 따로), `⌘K` 로 채널·스레드 전체를 검색하며, 메시지에 이모지 반응을 단다(에이전트는 자기 답에 달린 반응을 다음 턴에 안다). 관리자는 정한 시각(예약)이나 바깥 서비스의 웹훅에 맞춰 채널에 문구를 올리는 자동화를 만들어, 그 문구로 에이전트를 부른다. 스트리밍 답·툴 활동·승인 요청은 웹(설치형 PWA, 웹 푸시)에서 실시간으로 본다. 사람은 초대 링크로 들이고, 역할(owner·admin·member)로 에이전트 설정·도구 승인 같은 관리를 나눈다 — 대화는 누구나 한다. 1차 연동 대상은 [OpenClaw](https://docs.openclaw.ai) Gateway 다.

## 구성

```
 [브라우저 / PWA]
       │  HTTPS · Socket.IO (wire)
       ▼
 [Caddy] ── 자동 HTTPS, 웹 정적
       │  /api · /socket.io · /bridge/* · /healthz
       ▼
 [apps/server + openclaw-adapter] ───── operator 클라이언트 (wss) ─────▶ [OpenClaw Gateway]   ← 원격 호스트
       ▲                                                                   │
       │  Socket.IO 네임스페이스 /bridge (브리지 토큰) + HTTP /bridge/attachments  │
       └──────────────── 아웃바운드 접속 (wss) ─────────── [openclaw-plugin] ◀┘   (Gateway 안에서 돈다)
```

- **웹**(`apps/web`) — React + Vite PWA.
- **서버**(`apps/server`) — Fastify + Socket.IO. 채널·메시지·스레드·검색·읽지 않음·반응·자동화(예약 틱·웹훅 수신)·런·릴레이 라우터·components·첨부·푸시·멤버(초대·역할)·운영 화면. 서버 안의 `packages/openclaw-adapter` 가 Gateway 에 operator 로 붙어 스트리밍 델타·툴 이벤트·승인을 받는다.
- **플러그인**(`packages/openclaw-plugin`, 채널 id `dodok`) — 원격 Gateway 프로세스 안에서 도는 OpenClaw 채널 플러그인. 서버의 `/bridge` 로 **나가는** 연결만 쓴다 — Gateway 쪽에 포트를 열지 않는다. 에이전트 답의 정본은 이 경로로 온다.
- **러너**(`packages/claude-runner`, 명령 `dodok-runner`) — 사람의 머신에서 Claude Agent SDK 로 Claude Code 에이전트를 돌려 서버 `/runner` 로 **나가는** 연결 하나로 붙는다. 서버 쪽은 `packages/runner-adapter` 다. 에이전트의 `provider` 로 어댑터가 갈리고 한 채널에서 OpenClaw 에이전트와 서로 릴레이한다.
- **계약**(`packages/shared`) — 도메인 타입·Zod 스키마·components v1·wire·브리지 계약. 브라우저·Node·Gateway 세 곳에서 읽힌다.

패키지별 책임과 핵심 파일은 `docs/project-structure.md`.

## 빠른 시작

요구 버전(Node·pnpm)은 `mise.toml` 이 핀한다 — `mise install`.

### 개발 — 모델 없이 웹 전체 돌려 보기

`dev:fake` 는 가짜 Gateway·가짜 플러그인·대본으로 서버를 띄운다. 모델 런도 실제 Gateway 도 없고 `.env` 도 읽지 않는다.

```bash
pnpm i
pnpm -F @dodok/server dev:fake     # 터미널 1 — 서버(포트 3000). DB 는 시작마다 새로(--keep 이면 유지)
pnpm -F @dodok/web dev             # 터미널 2 — 웹(포트 5173)
```

- 브라우저는 **`http://localhost:5173`** 으로 연다. `127.0.0.1` 로 열면 wire 핸드셰이크의 Origin 이 서버 설정과 달라 거부된다.
- 로그인 토큰은 개발 전용 고정값 `dev-fake-local-token` 이다(로그인 화면 아래 「owner 로컬 토큰으로 로그인」). member 역할 화면은 고정 계정 `member@dodok.local` · `dev-fake-member-password`(핸들 `mia`)로 — 다른 브라우저 프로필에서 열면 owner 와 나란히 본다.
- 가짜 Gateway 에는 에이전트 `dev`·`fin` 이 있다. 에이전트로 등록해 채널에 넣고 멘션하면 대본이 답한다. 대본을 고르는 키워드(카드·승인·첨부 등)와 개발 전용 훅은 `apps/server/scripts/dev-fake.ts` 머리 주석과 `DEV_FAKE_KEYWORDS` 에 있다.

검사는 루트에서 `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm fmt:check`. 실제 Gateway·모델로 돌리는 절차는 `docs/guides/live-smoke.md`.

### 운영 — 한 호스트에 올리고 원격 Gateway 잇기

`docs/guides/deploy.md` 「체크리스트 — 처음 배포」 절을 따른다. Docker Compose 로 서버·Caddy 를 올리고, 웹의 연결 페이지에서 플러그인 파일과 브리지 토큰을 받아 Gateway 호스트에 설치하고, 폰에서 PWA·푸시까지 확인하는 순서다. 멤버 초대·비밀번호 재설정·백업·복원·업데이트·브리지 토큰 교체·운영 화면도 같은 문서에 있다.

설치가 끝나면 `docs/guides/agent-guide.md` 로 에이전트에게 dodok 쓰는 법을 알려 준다.

## 문서 지도

| 문서 | 무엇에 답하는가 |
| --- | --- |
| `docs/plan.md` | 무엇을 왜 만드는가 — 요구사항·아키텍처·로드맵·확정된 결정(「결정 사항」)·남은 문제(「로드맵」 장의 「이월」) |
| `docs/project-structure.md` | 어느 코드가 어디에 있고 무슨 책임을 지는가 |
| `docs/guides/deploy.md` | 설치·설정(`.env`)·Claude 러너 설치·멤버 초대·자동화 웹훅·백업·복원·업데이트·운영 화면 — 설치 절차의 정본 |
| `docs/guides/user-guide.md` | 웹 앱을 쓰는 사람(owner·admin·member)이 화면에서 하는 일 — 로그인·채널·읽지 않음·멘션·반응·카드·승인·스레드·검색·설정·자동화·멤버·알림·연결 페이지, 역할별 권한 표, 자주 겪는 문제 |
| `docs/guides/agent-guide.md` | 에이전트가 채널에서 무엇을 받고 어떻게 답하는가(헤더·반응·자동화가 게시한 글·릴레이·components·파일·승인·Claude 러너 에이전트), 에이전트 지시 파일에 붙여 넣을 블록 |
| `docs/guides/live-smoke.md` | 실제 Gateway·플러그인·모델로 돌려 보는 절차와 그 결과 기록, 모델 없이 실물 경로를 두드리는 런 0회 하네스(OpenClaw·Claude 러너) |
| `docs/adr/` | OpenClaw Gateway·플러그인과 Claude Agent SDK 를 실측해서 내린 결정 — 스파이크 결과마다 한 장 |
| `docs/superpowers/specs/`·`plans/` | 기능마다의 설계와 구현 계획 — 발행 시점 기록이다. 구현과 달라진 것은 각 스펙의 「구현과 맞춘 것」 장 |
| `docs/guides/worktree-workflow.md` | 이 저장소의 작업 방식(워크트리·Orca 워커·커밋 규칙) |
| `CLAUDE.md` | 코딩 에이전트가 이 저장소에서 따르는 지침 |
