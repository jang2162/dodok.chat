# dodok.chat

사람과 AI 에이전트가 같은 채널에서 대화하는 에이전트 네이티브 메신저. 1차 연동은 OpenClaw.
계획: docs/guides/plan.md · 구성: docs/guides/project-structure.md · 결정: docs/guides/plan.md 10장, docs/adr/

## 필수 참조 문서
- docs/guides/worktree-workflow.md — 워크트리·Orca 워커·병렬 작업·폐기. 코드 변경 전에 0절로 「직접 처리 / 워크트리」를 정한다.
- docs/guides/browser-verification.md — 이 앱에서 화면을 확인할 때만 해당하는 것(실시간 검증은 처음부터 Playwright 를 neo 에, 기록기, neo 가 잘 하는 것). 도구 순서와 공통 원리는 아래 「BrowserOS neo 가 깔려 있으면 neo 로 본다」와 두 「참조 지침」.

## 구조
pnpm 모노레포, npm 스코프 @dodok. apps/web(React+Vite PWA), apps/server(Fastify+Socket.IO+브리지 엔드포인트),
packages/shared(타입·Zod·components 규약·wire/bridge 계약), packages/openclaw-plugin(원격 Gateway 안 채널 플러그인, id "dodok"),
packages/openclaw-adapter(서버 측 브리지 서버+Gateway WS 클라이언트), packages/runner-adapter(서버 측 /runner 러너 어댑터), packages/claude-runner(사람 머신의 러너 CLI dodok-runner — 로컬 설정은 천장(허용 루트·프로그램·권한 상한)만, 프로젝트·러너 에이전트는 앱에서 만든다. 드라이버는 Claude Code 하나 — Claude Agent SDK, 정확 핀).

## 불변 규칙
- 에이전트 간 소통은 채널 @멘션 릴레이로만. OpenClaw agentToAgent는 꺼둔다.
- 세션 키는 대화(채널의 세션)마다 에이전트별 1개: agent:<agentId>:dodok:channel:<conversationId> — 두 번째 값은 채널 id 가 아니라 대화 id 다(세션 기능 전부터 있던 채널의 「이전 대화」만 id 가 그 채널 id 와 같다). 스레드는 그 아래 하위 세션 …:thread:<rootId 소문자>(스레드마다 1개). 키는 shared dodokSessionKey·parseDodokSessionKey 로만 만들고 푼다(따로 조립·정규식 금지).
- 응답 정본은 플러그인 경로, Gateway WS는 델타/툴 이벤트/승인. runId로 dedupe.
- Gateway는 원격이 기본. 플러그인이 서버 /bridge 로 아웃바운드 WSS 접속. Gateway 쪽 포트를 열지 않는다.
- OpenClaw 패키지 3종은 배포 Gateway와 같은 버전으로 정확 핀(현재 2026.9.4, 프로토콜 v4).
- Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)는 claude-runner 의 dependencies 에만 정확 핀, 번들에 넣지 않는다. 러너 CLI env 는 허용 목록(ANTHROPIC_* 를 넘기지 않는다). 모델 런은 실행 직전 사용자 승인 — 하네스는 번들 CLI + 로컬 가짜 Messages API(docs/guides/live-smoke.md 「Claude 러너 런 0회 하네스」).
- components v1 제약(액션 로우 버튼≤5 또는 셀렉트 1, 옵션≤25, 모달 필드≤5)은 shared 스키마가 강제.
- 외부 입력은 경계에서 Zod 파싱. shared는 Node 전용 API 금지.
- 시크릿·디바이스 아이덴티티·브리지 토큰은 data/ 와 .env 에만. 커밋 금지.

## 작업 방식 (정본: docs/guides/worktree-workflow.md)
- 코드 변경은 기본이 워크트리. 예외는 브레인스토밍·스펙·계획 없이 바로 구현 가능한 것(문서·설정·지침 갱신, 진단 끝난 버그, 기계적 변경)뿐이며 그때만 최상위에서 직접. 최상위에서 checkout/switch 금지.
- Orca 런타임이 살아 있으면(orca status --json) 구현·리뷰·검증은 scripts/orca-worker.sh 로 띄운 워커가 한다. 메인 세션은 디스패치·판정·병합만. superpowers 는 브레인스토밍·스펙·구현계획까지. SDD 의 Agent 디스패치·EnterWorktree 는 Orca 가 없을 때만.
- 흐름: spawn <슬러그> <역할> --brief <파일> → wait(exit 3 은 타임아웃, 다시 부른다) → (구현자 터미널을 끄려면 여기서 stop <슬러그> — `--force` 없이. 끝난 구현자는 회수된 뒤 꺼지고, 「워커가 도는 중이다」로 거부되면 아직 도는 것이니 wait 로 끝을 받는다. 워크트리 단위라 리뷰어를 띄운 뒤에 부르면 리뷰어도 끈다) → attach <슬러그> review(구현자 터미널을 재사용하지 않고 새 에이전트로 띄운다, 구현자의 Dispatch 가 진행 중이면 거부) → 판정(git diff --name-only 를 브리프 목록과 대조) → 병합 → reap <슬러그>. 역할 기본 모델: implement/review=opus, verify/chore=sonnet. `--model` 로 덮어쓴다.
- 워크트리 자리는 .worktrees/dodok.chat/<슬러그>. Orca 의 worktree 경로 설정(이 머신은 글로벌 .worktrees, repo 별 worktreeBasePath 가 있으면 우선)이 그 자리를 내야 spawn 이 된다. git worktree add 로 만든 워크트리는 Orca 가 인식하지 않으므로 워커를 붙일 워크트리는 spawn 으로 만든다. 손으로 만들면 --base-branch $(git branch --show-current), pnpm install, scripts/orca-worker.sh sync-config <경로>(.env 복사·ruler apply). data/ 는 복사하지 않는다.
- 브라우저 검증도 워커가 한다. BrowserOS neo 는 워커를 띄우기 전에 떠 있어야 한다(spawn 이 켠다). 브리프에 "네가 연 탭은 네가 닫아라".
- 커밋: git add -A / git commit -a 금지, 경로를 명시해 stage. Conventional Commits, 패키지 스코프(feat(plugin): …). zsh 는 변수를 단어로 가르지 않고 `=` 로 시작하는 단어를 명령 경로로 펼친다 — `git add`·`cp`·`git checkout` 처럼 여러 경로를 받는 명령에는 경로를 직접 적고(`cp $F` 가 한 인자로 넘어가 조용히 실패한 뒤 이어진 `git checkout` 이 고친 내용을 지운 일이 있다), `=` 로 시작하는 단어(`echo ====` 같은 구분선)는 따옴표로 감싼다.

## 이 프로젝트 고유의 지침은 `.ruler/AGENTS.md` 에 쓴다
CLAUDE.md·.mcp.json·.claude/skills 는 ruler 생성물(gitignore)이고, 공용 지침은 지침 서버(https://guideline.develma.com) 사본이다 — 규칙은 아래 「공용 지침 관리」·「ruler 소스와 생성물」. 새 워크트리에는 생성물이 없으므로 `orca.yaml` 셋업과 `scripts/orca-worker.sh` spawn·sync-config 가 `ruler apply` 와 `codegraph init` 을 돌린다(안 돌리면 워커가 지침·MCP 없이, codegraph 는 「not initialized」 로 뜬다).

## 명령
pnpm i · pnpm -F @dodok/server dev · pnpm -F @dodok/web dev (루트 `pnpm dev` 는 없다)
pnpm test · pnpm typecheck · pnpm lint · pnpm lint:fix · pnpm fmt · pnpm fmt:check (oxlint / oxfmt · test·typecheck 는 Turbo 캐시 off) · oxfmt 는 `**/*.md` 를 보지 않는다 — 문서를 고친 뒤 `---` 앞의 빈 줄(빠지면 앞 문단이 H2 가 된다)과 표 줄은 눈으로 본다 · `pnpm test` 는 다른 검사(typecheck·build)와 동시에 돌리지 않는다 — 실제 시간을 재는 웹 테스트가 깨진다 · 다른 워커가 많이 도는 머신에서는 혼자 돌려도 실제 시간 시험이 흔들릴 수 있다 — 실패하면 그 시험만 다시 돌려 보고, 실패가 되풀이되면 단언 순서가 강조 시간(`HIGHLIGHT_MS` 2초)에 기대는지 본다 · 루트 `pnpm test` 는 한 패키지가 실패하면 Turbo 가 나머지 패키지 시험을 끊는다 — 실행 수를 재야 하면 `pnpm exec turbo run test --continue` 로 끝까지 돌리거나 끊긴 패키지를 `pnpm -F <패키지> test` 로 따로 혼자 돌린다
Node 24.21.0 · pnpm 11.16.0 은 mise.toml 핀(`mise install`). Bash 도구는 SessionStart 훅(.claude/hooks/node-env.sh)이 PATH 를 잡는다. `node -v` 가 24 가 아니면 `export PATH="$(mise where node)/bin:$PATH"`.
scripts/orca-worker.sh status|spawn|attach|wait|reap|stop|keep|sync-config · bash scripts/test/orca-worker.test.sh
서버 단독: pnpm -F @dodok/server dev(루트 .env, 이미 있는 env 는 안 덮음) · pnpm wire-cli <origin> [localToken] <명령>(REST·wire 손 점검) · dev Gateway 실연 절차 docs/guides/live-smoke.md(지난 결과 docs/superpowers/reports/*-live-smoke-report.md)
러너: pnpm -F @dodok/runner pack:runner(서버가 부팅 때 dist 의 tgz 를 잰다 — 서버보다 먼저) · 런 0회 하네스 node packages/claude-runner/scripts/fake-messages-api.ts(번들 CLI 감싸개·지금 판의 러너 설정(roots·programs — 옛 agents 키는 거절)·앱에서 프로젝트·러너 에이전트 만들기·CLI cwd 재기는 live-smoke 「Claude 러너 런 0회 하네스」 절). 러너 전용 로그인 ~/.dodok-runner/claude 는 하네스에서 쓰지 않는다.
웹 손 확인: pnpm -F @dodok/server dev:fake(가짜 Gateway·플러그인·대본, 모델 런 없음. 가짜 Gateway 둘 — 사무실(고정 id 00000000-0000-4000-8000-00000000def1, 에이전트 dev·fin)·집(…def2, main·dev — 집 dev 의 핸들은 dev-home, 겹치는 id 는 main 이 아니라 dev), 에이전트 넷은 시작 때 등록(그래서 두 Gateway 상세의 「에이전트 가져오기」 목록은 비어 있는 것이 맞다 — 가져오기·핸들 겹침은 시작 로그 spareGateway 의 주소·토큰으로 「＋ 연결 추가」한 셋째 Gateway 에서), 가짜 Gateway 둘·가짜 러너 둘의 주인은 owner 이고 Gateway 는 승인된 채다(member mia 로 「＋ 연결 추가」한 Gateway 는 「승인 대기」 — owner·admin 이 그 상세의 「승인」, 승인 전에는 서버가 접속하지 않는다), 보관하지 않은 채널이 하나도 없으면(새 DB) 씨앗 채널 「세션」(dev·coder)을 만들고 그 채널에만 「이전 대화」(id = 채널 id)와 「dev:fake 새 세션」을 owner 글 하나씩과 함께 넣는다 — --keep 으로 이어받은 채널(UI 로 만든 것·보관한 것 포함)은 건드리지 않는다(실제 서버처럼 세션 기능 뒤 만든 채널에는 「이전 대화」가 없다), 새 DB(dev 를 처음 등록할 때)는 사무실 dev 의 dmAccess 가 everyone(나머지는 기본 admins — mia 는 dev 와만 DM 을 연다)이고 같은 새 DB 에서 mia ↔ dev DM 에 세션 하나(mia 글 + 대본 답)도 둔다, 같은 조건에서 owner ↔ mia 1:1(owner 글 하나 — 한 줄기)과 owner·mia·사무실 dev 그룹 DM 에 세션 하나(owner 의 `@dev` 글 + 대본 답)도 둔다 — DM 씨앗은 새 DB 에서만 두고 --keep·사무실 플러그인이 못 붙음·dev 보관·꺼짐이면 경고만 남기고 건너뛴다, 새 DB 의 씨앗 채널 새 세션 owner 글에는 사진 둘·PDF 하나, mia ↔ dev DM 의 mia 글에는 사진 하나(owner 의 파일함에 없어야 하는 것)가 묶여 있다 — 같은 새 DB 조건·같은 건너뛰기, 씨앗 채널 조건(보관하지 않은 일반 채널이 없음)은 DM 을 세지 않고 씨앗 채널은 보관한 에이전트를 빼고 만든다, 인바운드 로그 줄 `dev:fake inbound reactions` 은 DM 런이면 dm(헤더 DM 줄)과 session·participants 를 싣는다, 그룹 DM 런이면 groupDm(헤더 그룹 DM 줄)도, 고정 브리지 토큰 dev-fake-bridge-token-office·dev-fake-bridge-token-home. 기본 포트 3000, DB data/dev-fake.sqlite 는 시작마다 새로·--keep 이면 유지, 개발 전용 고정 로그인 토큰 dev-fake-local-token(웹 로그인 화면에서는 「owner 로컬 토큰으로 로그인」을 펼쳐 넣는다), 고정 member 계정(이메일 member@dodok.local·비밀번호 dev-fake-member-password·핸들 mia)도 owner 와 함께 보장, 가짜 플러그인 토큰 바꾸기 POST /__devfake/plugin-token {gatewayId, token}, 운영 훅 POST /__devfake/ops/event·/gateway {gatewayId, state}·/disk, 옛 플러그인 흉내 POST /__devfake/plugin-capabilities {gatewayId, threads} — gatewayId 는 사무실·집의 고정 id(없거나 다르면 400), 가짜 러너 둘 — 「dev-fake」(고정 토큰 dev-fake-runner-token, 루트 src·work, Claude Code 상한 acceptEdits·「설치되지 않음」 Codex, 둘러보기 고정 나무 — git·many 500 넘음·특수 문자 이름·숨김·루트 밖 링크·파일)와 「dev-fake 제한」(dev-fake-runner-token-limited, 루트 sandbox·src, Claude Code 상한 plan·도구 상한 Read·Grep·Glob, 둘러보기 꺼짐, 프로젝트 sandbox/demo). 둘 다 실제 러너처럼 런마다 천장을 본다. 에이전트 coder 는 새 DB 에서 dev-fake 의 프로젝트 src/dodok 로 만든다. 대본 키워드 승인·게시·제어(제어 도구로 채널 주제 — 시킨 사람에게 확인 카드, 「제어 프롬프트」는 admin 일)·구독·실패·천장(RUNNER_CEILING permissionMode 카드). 끊기·붙이기 POST /__devfake/runner {connected, token?, runner?: "main"|"limited", maxPermissionMode?, roots?}(끊기면 스스로 안 붙는다 — roots·maxPermissionMode 는 그 hello 로 다시 붙는다(루트를 빼면 그 프로젝트가 「루트 없음」). 러너 토큰 행은 고정 id 라 설정 → 연결의 러너 상세에서 「다시 발급」하면 그 자리에서는 새 원문을 token 으로 붙이고, --keep 재시작은 고정 토큰으로 되돌린다(프로젝트·coder 는 그 러너에 남는다). 폐기한 러너 토큰은 되살리지 않는다 — 다시 발급도 409) — 모두 owner 세션·application/json, 훅은 서버(API 오리진)에만 있다 — 웹 오리진으로 부르면 404, 쿠키는 웹 오리진에서 읽어 Cookie 헤더로 싣는다. 끊김 임계는 DODOK_DEVFAKE_DISCONNECT_MS) + pnpm -F @dodok/web dev(5173). run_error 「다시 실행」 카드는 plugin-token {"gatewayId":"<id>","token":"nope"} 로 그 Gateway 의 가짜 플러그인을 끊고 그 Gateway 의 에이전트를 멘션하면 120초 뒤 ADAPTER_UNAVAILABLE 로 생긴다(「실패」 대본·Gateway down 으로는 안 생긴다) — 되붙이기 {"gatewayId":"<id>","token":"dev-fake-bridge-token-office"}(집이면 …-home). 로그아웃 단추는 「내 계정」(`/settings/account`)에만 있다 — 채널·활동 탭을 연 채 로그아웃을 재려면 앱 안 이동(`history.pushState` + `popstate`)으로 그 화면에 가서 누른다. 활동 패널이 열린 채 세션이 끝나는 길은 같은 쿠키로 `POST /api/v1/auth/logout` 을 따로 보내 만든다(401·wire UNAUTHORIZED → `onUnauthorized`).
브라우저는 http://localhost:5173 으로 연다 — 127.0.0.1 이면 wire 핸드셰이크 Origin 이 APP_ORIGIN 과 달라 거부된다(「실시간 연결이 거부되었습니다 — …」 배너). Vite 기본값은 macOS 에서 `::1` 에만 열려 127.0.0.1 은 그 전에 연결 거부다 — 배너를 일부러 보려면 웹을 `--host 127.0.0.1` 로 띄운다. 포트를 바꿔 병행하려면 PORT·APP_ORIGIN·DODOK_API_ORIGIN·--port 를 함께 맞춘다.
PWA·푸시 손 확인: 개발 모드 서비스 워커는 기본 꺼짐(`VITE_PWA_DEV=1` 로만) — 빌드본 `pnpm -F @dodok/web build` 뒤 `DODOK_API_ORIGIN=… pnpm -F @dodok/web exec vite preview --port 5180 --strictPort`. 알림 권한이 필요한 자동화는 headed(오프스크린). 절차는 docs/guides/live-smoke.md 「PWA·푸시(Phase 2 ④)」 절. 빌드본을 본 뒤 같은 포트로 dev 에 돌아오면 SW 를 unregister·caches 삭제(docs/guides/browser-verification.md). Playwright 로 dev:fake 훅을 부를 때 쿠키는 웹 오리진(APP_ORIGIN)으로 읽는다(API 오리진으로 거르면 낡은 dodok.session 으로 401).
배포: 루트 `compose.yaml`(앱 컨테이너 하나 — 서버가 웹도 낸다, HTTPS 는 각자 서버의 리버스 프록시)로 `docker compose up -d --build`(절차·`.env`·백업·복원·업데이트는 docs/guides/docker-deploy.md — 웹 빌드 ID 는 루트 `Dockerfile` 의 web 단계가 웹 입력의 내용 해시로 낸다) · 프록시·서버별 값은 서버의 `compose.override.yaml`(git 무시, 내용은 docker-deploy.md 「컨테이너 프록시」) — `TRUST_PROXY` 는 프록시 `/32`(서브넷 전체면 XFF 위조가 통한다, `true` 는 부팅 실패, 「신뢰 주소 — `TRUST_PROXY`」) · Komodo Git Repo Stack 은 그 문서 「부록 — Komodo Git Repo Stack」 · 로컬 검증 `bash scripts/check-deploy.sh app <origin> [컨테이너]`(떠 있는 앱 — 개발용 `.env` 와 부딪히지 않게 임시 env 파일을 `DODOK_ENV_FILE` 로, docker-deploy.md 「확인 — `scripts/check-deploy.sh`」) · `bash scripts/check-deploy.sh proxy`(임시 네트워크·Caddy 로 프록시 꼴·Secure 쿠키·WebSocket·20 MiB 첨부·XFF 위조까지, 만든 것은 스스로 지운다) · 서버 번들 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`. Docker 는 다른 프로젝트와 데몬을 같이 쓴다 — `docker … prune` 금지, 자기가 만든 것만 이름·ID 로 지운다.

## 현재 단계
제품 상태의 정본은 docs/guides/plan.md 8장(완료 항목·「다음 순서 — 실사용」·「이월」)이다. 지난 단계별 완료 기록은 docs/superpowers/reports/2026-10-30-stage-history-report.md(이력 — 지금 규칙으로 읽지 않는다).
- 대화: 채널(주제마다 세션)·스레드·DM(주인 사람 + 에이전트 1:1, 사람 1:1, 사람 여럿 + 에이전트의 그룹 DM — 참여자만 본다)에서 사람과 에이전트가 함께 쓴다 — @멘션·자동 응답·릴레이(턴 한도)·스트리밍 버블·중지, components v1 카드, 첨부(사람도 파일), 파일함(대화마다·전체), 반응, 읽지 않음, 검색(⌘K), 자동화(예약·웹훅), 활동 탭·도구 승인 카드, 프로필(아바타·상태 다섯·상태 메시지·방해 금지)과 사람·에이전트 접속 점.
- 에이전트 연결: OpenClaw Gateway 여럿(설정 → 「연결」 탭에서 추가 — 연결마다 주인이 있어 member 도 자기 연결을 붙이고, member 의 Gateway 는 admin 승인 뒤 접속한다. 플러그인은 발급 대화상자의 설치 한 줄로 깔고 /bridge 로 붙는다)과 러너(dodok-runner — 로컬 설정은 천장만, 로그인은 기본이 그 머신의 평소 claude 로그인, 프로젝트·러너 에이전트는 앱에서). 제어 MCP(바깥 /mcp + 채널 안 에이전트의 제어 도구 — 쓰기는 시킨 사람의 확인 카드).
- 팀·운영: owner·admin·member, 초대·재설정 링크, 멤버 비활성화, 채널·에이전트 보관, 런 한도·「다시 실행」·운영 사건·레이트리밋(설정 → 운영).
- 알림: PWA 설치·오프라인 사본·웹 푸시, 서버의 APNs·FCM 통로(앱 쪽 토큰 등록은 아직 없다).
- 배포: 루트 Dockerfile·compose.yaml 앱 컨테이너 하나(HTTPS 는 각 서버의 프록시) — 로컬 검증(scripts/check-deploy.sh)까지.
- 문서: README(문서 지도)·docs/manual/user-guide.md(쓰는 사람)·docs/guides/agent-guide.md(에이전트가 받는 것)·docs/guides/docker-deploy.md(설치·운영)·docs/guides/live-smoke.md(실연 절차·런 0회 하네스).
- 로컬 dev Gateway 는 스크래치에 설치한 openclaw CLI(`--dev`)로 돌린다 — 글로벌 설치 금지, 원격 Gateway 호스트는 사람이 만진다(live-smoke 「전제」·「원격 Gateway 에서 같은 절차를 돌릴 때 다른 점」).

사람 몫으로 남은 것:
- 실제 서버·도메인·프록시(Komodo)에 배포하고 docker-deploy.md 체크리스트를 따라 「사람이 한 번 따라 한 결과」 표를 채운다.
- 실기기 푸시(live-smoke 「네이티브 푸시 손 확인」)와 자동화가 원리상 못 재는 것(live-smoke 「사람이 눈·귀로 확인할 것」·「PWA·푸시(Phase 2 ④)」 절의 「사람이 볼 것」).
- 원격 Gateway 의 OpenClaw 판 확인과 핀 정책(plan.md 8장 「이월」 「플러그인·OpenClaw 버전」).

다음: plan.md 8장 「다음 순서 — 실사용」 — ① 서버 배포·웹 확인 ② 쓰면서 나온 수정·기능 ③ 데스크톱·모바일 앱(로드맵 docs/superpowers/specs/2026-10-06-native-apps-roadmap.md). Codex·Hermes 어댑터는 미뤘다. 남은 문제는 plan.md 8장 「이월」 한곳에 적는다.
