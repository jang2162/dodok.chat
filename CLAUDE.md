# dodok.chat

사람과 AI 에이전트가 같은 채널에서 대화하는 에이전트 네이티브 메신저. 1차 연동은 OpenClaw.
계획: docs/plan.md · 구성: docs/project-structure.md · 결정: docs/plan.md 10장, docs/adr/

## 필수 참조 문서
- docs/guides/worktree-workflow.md — 워크트리·Orca 워커·병렬 작업·폐기. 코드 변경 전에 0절로 「직접 처리 / 워크트리」를 정한다.
- docs/guides/browser-verification.md — 이 앱에서 화면을 확인할 때만 해당하는 것(실시간 검증은 처음부터 Playwright 를 neo 에, 기록기, neo 가 잘 하는 것). 도구 순서와 공통 원리는 아래 「BrowserOS neo 가 깔려 있으면 neo 로 본다」와 두 「참조 지침」.

## 에이전트 기본

### 사용자 응답은 한국어로 하고, 코드와 식별자는 원래 형태를 지킨다

요약·설명·대화형 답변은 한국어로 한다. 코드, 식별자, 커밋 메시지는 자연스러운 형태(영문·코드)를 유지한다. 파일 안의 주석은 그 파일의 기존 관례를 따른다.

- **Why:** 식별자와 커밋 메시지까지 한국어로 옮기면 `grep`·도구 연동·외부 참조가 함께 끊긴다. 주석을 파일마다 다른 언어로 쓰면 한 파일 안에서 언어가 갈린다.
- **How to apply:** 설명은 한국어로, 코드 블록 안은 그대로 둔다. 기존 파일을 고칠 때는 그 파일이 쓰던 언어를 따른다.

### 에이전트의 메모리 기능에 프로젝트 지식을 저장하지 않는다

알게 된 결정·제약·관례는 전부 문서에 기록하고 커밋한다.

- **Why:** 메모리는 에이전트별·머신별·세션별로 갈라진다. 다른 에이전트나 다른 사람은 그 내용을 볼 수 없고, 리뷰도 되지 않으며, 코드와 함께 버전 관리되지 않는다. 문서로 남겨야 모든 에이전트에 동일하게 전달된다.
- **How to apply:** 사용자가 "기억해"라고 하거나 재사용할 결정이 확정되면 그 프로젝트의 지침 문서에 추가하고 커밋한다.
- **예외 — 메모리에 남겨도 되는 것은 저장소와 무관한 개인 환경 문제뿐이다.** 로컬 경로, 개인 계정·툴 설정, 머신 특이사항 등. 프로젝트 코드·아키텍처·컨벤션·의사결정은 예외가 아니다.

### 지침을 고쳐야 할 일이 생기면 사용자에게 보고하고 진행한다

작업 중에 지침이 틀렸거나 비어 있는 것을 발견하면 그 자리에서 말한다. 그 자리에서 못 고치는 것은 **어느 문서의 어느 절에 무슨 문장을 넣어야 하는지까지 써서** 보고에 남긴다.

- **Why:** 발견은 세션 안에만 있다. 보고하지 않으면 다음 세션과 다른 에이전트는 같은 지침을 같은 상태로 다시 받고, 같은 자리에서 다시 넘어진다. 「어디에 무슨 문장」이 없는 보고는 다음 사람이 그 판단을 처음부터 다시 하게 만든다.
- **How to apply:** 보고에 세 가지를 적는다 — 무엇이 틀렸는가, 어느 문서 어느 절인가, 넣을 문장은 무엇인가.


## 검증

### 생성물을 직접 편집하지 않는다 — 소스를 고치고 그 자리에서 재생성한다

생성기가 만드는 파일은 소스를 고치고 생성기를 돌려 만든다.

- **Why:** 생성물은 다음 재생성에서 통째로 덮어써진다. 더 나쁜 것은 **재생성을 안 돌렸을 때다** — 생성물이 gitignore 면 `git status` 에 뜨지 않아 아무 경고가 없고, 리뷰에도 안 걸리고, 테스트도 통과한다. 그동안 다른 에이전트와 다음 세션은 **낡은 것을 최신인 줄 알고 받는다.** 소스에는 새 규칙이 적혀 있는데 실제로 읽히는 건 옛 것이다.
- **How to apply:**
  - **소스를 고쳤으면 그 자리에서 재생성한다.** 한 줄을 고쳤든 절을 통째로 다시 썼든, 만들었든 옮겼든 지웠든 예외가 없다. **커밋 전에, 작업이 끝난 그 턴에** 돌린다.
  - **지침 파일을 생성물에 써 넣지 않는다.** 생성물이 다시 소스로 읽히면 재생성마다 자기 자신을 덧붙여 중복으로 오염된다.
  - **옮길 때가 가장 티가 안 난다.** 안 돌리면 옛 위치의 생성물이 그대로 남아 낡은 것이 **새 것과 나란히** 계속 주입된다.
  - **소스를 지웠을 때도 돌린다.** 생성기는 대개 소스가 사라진 경로의 생성물을 치워 주지 않으므로 남은 파일을 직접 지운다.
  - 의심스러우면 그냥 돌린다. 멱등이라 두 번 돌려도 손해가 없다.

### 「통과」를 보기 전에 몇 개가 실행됐는지 확인한다

테스트가 **0개 실행되고도 성공으로 끝나는** 빌드 도구가 있다.

- **Why:** 캐시가 최신이라고 판단했거나 필터가 아무것도 고르지 못하면, 실행이 0건인 채로 성공 메시지가 뜬다. **실패가 없으므로 통과로 읽히고**, 그 상태로 「테스트 통과」를 보고하면 아무도 검증하지 않은 코드가 병합된다.
- **How to apply:** 출력에서 **실제 실행 개수**를 확인하고 보고에 함께 적는다. 개수가 0이면 통과가 아니라 **실행되지 않은 것**이다. 캐시를 무시하는 옵션이 있으면 그것을 쓴다.

### 수를 셀 때는 두 번 세고 표본을 열어 본다

세는 `grep` 은 **틀려도 오류를 내지 않는다.**

- **Why:** 함정이 셋이고 **셋 다 그럴듯한 수**를 내놓는다 — ① BSD `grep` 의 BRE 는 `\|` 를 교대가 아니라 글자로 본다 ② **배타 조건으로 세면 걸러진 쪽이 통째로 빠진다** ③ **공백 변형**(`foo (` 대 `foo(`)을 놓치면 실제보다 적게 나온다.
- **How to apply:**
  - `grep -E` 를 쓰고, 공백은 `\s*`, 따옴표는 `["']` 로 흡수한다.
  - 센 뒤 **표본을 열어 보고, 같은 것을 다른 방법으로 한 번 더 센다.**
  - **세는 범위를 라벨에 밝힌다.** 같은 이름도 「식별자 줄」·「호출 자리」·「특정 디렉터리 안」에 따라 수가 갈린다. 범위를 안 적으면 두 문서가 다른 수를 말하게 된다.
  - **수치를 고쳤으면 그 수치에서 나온 것을 전부 다시 센다.** 파생 수치를 함께 고치지 않으면 두 문서가 서로 다른 수를 말하고, 겉으로는 어느 쪽이 옛 값인지 구별되지 않는다.
  - **도구를 문서에 실을 때는 그 도구가 보지 않는 것을 같은 자리에 적는다.** 침묵이 보증으로 읽히면 사람은 확인을 건너뛴다.
  - **도구가 「없다」고 말하는 것과 실제로 없는 것은 다르다.** 정적으로는 영영 못 잡는 것이 섞인다(런타임에 조립되는 이름 등). **버킷 이름을 지을 때 그 이름이 사람에게 어떤 행동을 허가하는지 생각한다** — 「죽었다」는 삭제 허가로 읽힌다.


## base 참조 지침

아래 작업을 할 때는 **시작하기 전에** 그 파일을 읽는다. 이 규칙들은 상시 지침에 없다.

| 언제 | 읽을 파일 |
| --- | --- |
| 코드나 문서의 주석을 쓰거나 고치거나 걷을 때 | `docs/guideline/base/03-comments.md` |
| 문서·주석에서 다른 파일이나 문서를 가리키거나, 지침·문서를 쓰거나 고칠 때 | `docs/guideline/base/04-citation.md` |

## BrowserOS neo 가 깔려 있으면 neo 로 본다

`browser` 스택 「무엇이 붙어 있는지 먼저 확인하고 고른다」 의 **고르는 순서만** 바꾼다 — `/Applications/BrowserOS neo.app` 이 있으면 화면 확인은 neo(`mcp__browseros-neo__*`)로 하고, neo 가 없을 때만 그 절의 순서로 고른다. 도구가 없을 때 검증을 건너뛰지 않는 것, 한계에 걸리면 버리지 말고 얹는 것은 그 스택을 따른다.

- **Why:** neo 는 에이전트 전용으로 띄워 둔 **로그인이 살아 있는 실제 브라우저**다. 다른 도구로 새 브라우저를 띄우면 그 로그인과 프로필을 잃고, 사람의 브라우저에 붙는 도구는 사람의 탭과 섞인다.
- **How to apply:**
  - **꺼져 있으면 에이전트가 켠다** — 화면을 뺏지 않게 `-g` 를 준다. MCP 가 열릴 때까지 기다린다(406 이 정상 응답이다). 포트는 neo 설정(`~/Library/Application Support/BrowserClaw/.browseros/config.json`)의 `ports.proxy` 다.
    ```bash
    open -g -a "BrowserOS neo"
    curl -s -o /dev/null -w '%{http_code}\n' --max-time 40 --retry 40 --retry-delay 1 \
      --retry-connrefused http://127.0.0.1:9010/mcp
    ```
  - **세션을 열기 전에 켜 둔다.** 세션이 시작될 때 꺼져 있었으면 켜도 이 세션에는 붙지 않는다 — 고장을 가르는 법은 `browser` 스택 「브라우저 서버가 안 붙을 때」. 앱을 로그인 항목에 넣어 두면 이 조건을 매번 기억하지 않아도 된다.
  - **새 탭은 백그라운드로 연다.** `tabs action="new"` 에는 `background: true` 를 준다. `run` 의 `browser.pages.newPage(url)` 은 기본이 백그라운드다. `windows action="create"` 에는 백그라운드 옵션이 없으니 창 대신 탭으로 연다.
  - neo 가 못 하는 확인(콘솔 `log`, 첫 로드 콘솔, 네트워크, 뷰포트)이면 **neo 에 Playwright 를 얹는다** — 이 스택 「neo 가 못 하는 다섯 가지」·「Playwright 를 neo 에 붙일 때」. 렌더(애니메이션·캔버스)를 재거나 다른 계정의 둘째 클라이언트가 필요한 검증은 neo 가 아니라 독립 브라우저로 한다 — `browser` 스택 「페이지 자동화 도구를 얹을 때」 의 예외.

## browser 참조 지침

아래 작업을 할 때는 **시작하기 전에** 그 파일을 읽는다. 이 규칙들은 상시 지침에 없다.

| 언제 | 읽을 파일 |
| --- | --- |
| 브라우저로 화면을 확인해야 할 때 — 어느 도구로 볼지 고르기 전에 | `docs/guideline/browser/00-tool-choice.md` |
| 브라우저 MCP 서버가 안 붙거나, 워커에게 브라우저 확인을 맡길 때 | `docs/guideline/browser/01-mcp-lifecycle.md` |
| 브라우저 콘솔이나 네트워크 요청을 읽어 판단할 때 | `docs/guideline/browser/02-console-network.md` |
| Playwright 같은 페이지 자동화 도구를 이미 떠 있는 브라우저에 붙일 때 | `docs/guideline/browser/03-cdp.md` |
| 여러 세션이나 워커가 한 브라우저를 함께 쓸 때 | `docs/guideline/browser/04-shared-profile.md` |

## browseros-neo 참조 지침

아래 작업을 할 때는 **시작하기 전에** 그 파일을 읽는다. 이 규칙들은 상시 지침에 없다.

| 언제 | 읽을 파일 |
| --- | --- |
| neo 로 콘솔 로그·네트워크·모바일 레이아웃·렌더(애니메이션·캔버스)를 확인해야 할 때 | `docs/guideline/browseros-neo/01-limits.md` |
| neo 에 Playwright 를 붙이거나, playwright-neo MCP 를 설정할 때 | `docs/guideline/browseros-neo/02-playwright.md` |
| 여러 세션·워커가 neo 를 함께 쓰거나, neo 를 재시작한 뒤 탭을 다시 찾을 때 | `docs/guideline/browseros-neo/03-tabs.md` |

## 구조
pnpm 모노레포, npm 스코프 @dodok. apps/web(React+Vite PWA), apps/server(Fastify+Socket.IO+브리지 엔드포인트),
packages/shared(타입·Zod·components 규약·wire/bridge 계약), packages/openclaw-plugin(원격 Gateway 안 채널 플러그인, id "dodok"),
packages/openclaw-adapter(서버 측 브리지 서버+Gateway WS 클라이언트), packages/runner-adapter(서버 측 /runner 러너 어댑터), packages/claude-runner(사람 머신의 러너 CLI dodok-runner — Claude Agent SDK, 정확 핀).

## 불변 규칙
- 에이전트 간 소통은 채널 @멘션 릴레이로만. OpenClaw agentToAgent는 꺼둔다.
- 세션 키는 채널당 에이전트별 1개: agent:<agentId>:dodok:channel:<channelId>. 스레드는 그 아래 하위 세션 …:thread:<rootId 소문자>(스레드마다 1개). 키는 shared dodokSessionKey·parseDodokSessionKey 로만 만들고 푼다(따로 조립·정규식 금지).
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
- 흐름: spawn <슬러그> <역할> --brief <파일> → wait(exit 3 은 타임아웃, 다시 부른다) → attach <슬러그> review → 판정(git diff --name-only 를 브리프 목록과 대조) → 병합 → reap <슬러그>. 역할 기본 모델: implement/review=opus, verify/chore=sonnet.
- 워크트리 자리는 .worktrees/dodok.chat/<슬러그>. Orca 의 worktree 경로 설정(이 머신은 글로벌 .worktrees, repo 별 worktreeBasePath 가 있으면 우선)이 그 자리를 내야 spawn 이 된다. git worktree add 로 만든 워크트리는 Orca 가 인식하지 않으므로 워커를 붙일 워크트리는 spawn 으로 만든다. 손으로 만들면 --base-branch $(git branch --show-current), pnpm install, scripts/orca-worker.sh sync-config <경로>(.env 복사). data/ 는 복사하지 않는다.
- 브라우저 검증도 워커가 한다. BrowserOS neo 는 워커를 띄우기 전에 떠 있어야 한다(spawn 이 켠다). 브리프에 "네가 연 탭은 네가 닫아라".
- 커밋: git add -A / git commit -a 금지, 경로를 명시해 stage. Conventional Commits, 패키지 스코프(feat(plugin): …).

## 명령
pnpm i · pnpm -F @dodok/server dev · pnpm -F @dodok/web dev (루트 `pnpm dev` 는 없다)
pnpm test · pnpm typecheck · pnpm lint · pnpm lint:fix · pnpm fmt · pnpm fmt:check (oxlint / oxfmt · test·typecheck 는 Turbo 캐시 off)
Node 24.21.0 · pnpm 11.16.0 은 mise.toml 핀(`mise install`). Bash 도구는 SessionStart 훅(.claude/hooks/node-env.sh)이 PATH 를 잡는다. `node -v` 가 24 가 아니면 `export PATH="$(mise where node)/bin:$PATH"`.
scripts/orca-worker.sh status|spawn|attach|wait|reap|stop|keep|sync-config · bash scripts/test/orca-worker.test.sh
서버 단독: pnpm -F @dodok/server dev(루트 .env, 이미 있는 env 는 안 덮음) · pnpm wire-cli <origin> [localToken] <명령>(REST·wire 손 점검) · dev Gateway 실연 절차·결과 docs/guides/live-smoke.md
러너: pnpm -F @dodok/claude-runner pack:runner(서버가 부팅 때 dist 의 tgz 를 잰다 — 서버보다 먼저) · 런 0회 하네스 node packages/claude-runner/scripts/fake-messages-api.ts(절차·번들 CLI 감싸개는 live-smoke 「Claude 러너 런 0회 하네스」 절). 러너 전용 로그인 ~/.dodok-runner/claude 는 하네스에서 쓰지 않는다.
웹 손 확인: pnpm -F @dodok/server dev:fake(가짜 Gateway·플러그인·대본, 모델 런 없음. 기본 포트 3000, DB data/dev-fake.sqlite 는 시작마다 새로·--keep 이면 유지, 개발 전용 고정 로그인 토큰 dev-fake-local-token(웹 로그인 화면에서는 「owner 로컬 토큰으로 로그인」을 펼쳐 넣는다), 고정 member 계정(이메일 member@dodok.local·비밀번호 dev-fake-member-password·핸들 mia)도 owner 와 함께 보장, 가짜 플러그인 토큰 바꾸기 POST /__devfake/plugin-token {token}, 운영 훅 POST /__devfake/ops/event·/gateway {state}·/disk, 옛 플러그인 흉내 POST /__devfake/plugin-capabilities {threads}, 가짜 Claude 러너(고정 러너 토큰 dev-fake-runner-token·에이전트 coder 는 시작 때 등록, 대본 키워드 승인·게시·구독·실패) 끊기·붙이기 POST /__devfake/runner {connected, token?}(끊기면 스스로 안 붙는다 — 폐기 뒤에는 새 토큰을 token 으로) — 모두 owner 세션·application/json, 끊김 임계는 DODOK_DEVFAKE_DISCONNECT_MS) + pnpm -F @dodok/web dev(5173). run_error 「다시 실행」 카드는 plugin-token {"token":"nope"} 로 가짜 플러그인을 끊고 멘션하면 120초 뒤 ADAPTER_UNAVAILABLE 로 생긴다(「실패」 대본·Gateway down 으로는 안 생긴다) — 되붙이기 {"token":"dev-fake-bridge-token"}.
브라우저는 http://localhost:5173 으로 연다 — 127.0.0.1 이면 wire 핸드셰이크 Origin 이 APP_ORIGIN 과 달라 거부된다(rejected 배너). 포트를 바꿔 병행하려면 PORT·APP_ORIGIN·DODOK_API_ORIGIN·--port 를 함께 맞춘다.
PWA·푸시 손 확인: 개발 모드 서비스 워커는 기본 꺼짐(`VITE_PWA_DEV=1` 로만) — 빌드본 `pnpm -F @dodok/web build` 뒤 `DODOK_API_ORIGIN=… pnpm -F @dodok/web exec vite preview --port 5180 --strictPort`. 알림 권한이 필요한 자동화는 headed(오프스크린). 절차는 docs/guides/live-smoke.md 14절. 빌드본을 본 뒤 같은 포트로 dev 에 돌아오면 SW 를 unregister·caches 삭제(docs/guides/browser-verification.md). Playwright 로 dev:fake 훅을 부를 때 쿠키는 웹 오리진(APP_ORIGIN)으로 읽는다(API 오리진으로 거르면 낡은 dodok.session 으로 401).
배포(Phase 3 ①): 배포 호스트에서 `ln -s ../.env infra/.env` 뒤 `docker compose -f infra/compose.yml up -d --build`(웹 빌드 ID·백업·복원·업데이트는 docs/guides/deploy.md) · 로컬 검증 `docker compose --env-file infra/local.env -f infra/compose.yml -f infra/compose.local.yml up -d --build`(127.0.0.1:8443, `bash infra/check-caddy.sh https://localhost:8443`) · 서버 번들 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`. Docker 는 다른 프로젝트와 데몬을 같이 쓴다 — `docker … prune` 금지, 자기가 만든 것만 이름·ID 로 지운다.

## 현재 단계
shared 계약·DB 스키마·순수 로직 구현 완료 (docs/superpowers/plans/2026-09-14-shared-contracts.md).
Phase 0 스파이크 1·2·3 완료 — docs/adr/0001(Gateway WS 실물), 0002(채널 플러그인: 인바운드·message 툴·components 동작, 봇 루프 보호는 플러그인이 사실을 넘길 때만), 0003(채널 프롬프트: claude-cli 기존 세션은 리셋·새 키에서만 반영, ChannelPromptContext 는 매 턴 반영; deltaCursor 는 claude-cli 세션에 없음; chat.send 대체 경로는 MVP 미사용).
로컬 dev Gateway: 스크래치에 설치한 `openclaw@2026.9.5` CLI(`openclaw --dev`, mise Node 24.21, 상태 ~/.openclaw-dev, 에이전트 dev·fin — OpenClaw.app 2026.9.6 번들에는 CLI 가 없다, docs/guides/live-smoke.md 「전제」 절. 글로벌 설치 금지). 원격 호스트 플러그인 설치는 사람 절차(ADR 0002 9절).
Phase 0 종료, 결정 13건 확정(계획서 10장 #1·#11~#21), Node 24 전환, 플러그인 스파이크 흔적 정리 병합(cd572af — InboundDeliverResult.admission, ChannelPromptContext 고정).
Phase 1 ① 서버 코어 완료 — 스펙 docs/superpowers/specs/2026-09-15-server-core-design.md, 계획 docs/superpowers/plans/2026-09-15-server-core.md(태스크 0~15). 통합 시나리오 1~8(가짜 Gateway·플러그인) 통과, dev Gateway 실연(런 6: 멘션·릴레이·상한·이어가기·리셋 뒤 프롬프트·Gateway 재기동 복구) 통과 — 실연이 찾은 「새 세션 미구독」은 38fa0f1 로 고침, usage 값·진단 로그는 남음(docs/guides/live-smoke.md 5.4).
Phase 1 ② 웹 MVP 완료(2026-09-20) — 스펙 docs/superpowers/specs/2026-09-19-web-mvp-design.md, 계획 docs/superpowers/plans/2026-09-19-web-mvp.md(태스크 0~14). 로그인·채널·메시지 목록·@멘션 작성기·마크다운 렌더·스트리밍 버블·중지·에이전트 등록·채널 설정·「새 대화」. 구성은 docs/project-structure.md 2.5.
dev:fake 위 브라우저 검증은 결함 0 으로 통과(시나리오 1~10, 수정 라운드 2회 뒤 재검증 2회). 남은 문제·후속은 docs/plan.md 8장 「이월」 한곳에. 실물 dev Gateway·실제 모델 실연도 마쳤다(2026-09-20, 런 4: 멘션·릴레이·이어가기 카드 통과, 앱 결함 0 — 중지만 계측 문제로 미확인, docs/guides/live-smoke.md 7절).
Phase 2 ① 활동 패널·승인 완료(2026-09-21) — 스펙 docs/superpowers/specs/2026-09-20-activity-approvals-design.md, 계획 docs/superpowers/plans/2026-09-20-activity-approvals.md(태스크 0~11), 근거 스파이크 .superpowers/sdd/2026-09-20-phase2-approval-spike/. 활동 탭(런 목록·툴 타임라인)·승인 카드(허용·거절·만료·두 자리 동기)·브라우저 알림, Phase 1 이월 아홉(서버 넷·웹 넷·wire-cli typecheck) 정리. 검증은 통합 시나리오 9a~9g(9c′ 포함 8건, 가짜 Gateway·플러그인) 통과 · dev:fake 위 브라우저 검증(결함 11 중 7 수정·4 이월) + 수정 뒤 재검증 9/9 통과. 재검증은 고친 7건을 수치로 확인했고(D1 알림 0→1건 · D2 옛 런 노출 420→0ms · D3 Tab 5→2회 · D10 타임라인 54→128px), 새로 찾은 셋(D12 재접속 뒤 끊긴 사이 끝난 런이 목록에서 사라짐 · D13 결정 뒤 초점이 body · D14 좁은 화면 시트 초점)도 고쳐서 들어갔다(d7e3f9c·94dc365). 테스트 1394(web 615·server 429·adapter 201·shared 92·plugin 57). 남은 이월은 docs/plan.md 8장, 사람이 눈·귀로 볼 것은 docs/guides/live-smoke.md 9절. 다음: Phase 2 ② components v1 완성.
Phase 2 ② components v1 완성(2026-09-22) — 스펙 docs/superpowers/specs/2026-09-21-components-v1-design.md(설계와 달라진 것은 11장), 계획 docs/superpowers/plans/2026-09-21-components-v1.md(태스크 1~9 + 검증 결함 수정). 웹 features/components/ 가 블록 5종·셀렉트(「보내기」 확정)·모달(필드 7종)을 그리고, 누가 무엇을 보냈는지 카드 안 결과 줄로 남는다(서버가 Message.interactions 를 wire 팬아웃·listMessages 에서 하이드레이션 — 새로고침·새 탭에서도 보인다). artifact:// 는 자리표시(해석은 ③). 초점·타이머 이월 셋(넓은 화면 설정 닫기 초점·D6 공용 틱·자리값 소요 정지)도 닫았다. 검증은 통합 시나리오 10a~10g(가짜 Gateway·플러그인) 통과 · dev:fake 위 브라우저 검증 1차 22/24, 결함 1(비활성 사유가 눈에 안 보임)을 고쳤다(aa0d4d8·4864ecb) → 재검증 24/24·결함 0. 재검증은 실제 앱에서 다섯 사유와 사유 셋이 섞인 줄(basis-full 로 줄마다 24px 간격)을 확인했고, 셀렉트 스크롤 상자가 실제로 스크롤되는 것도 처음 봐 c2-t3 이월 하나를 닫았다. 긴 라벨 버튼 390px 넘침·날짜 키 롤오버는 「확인됨」(이월 그대로), lastSeq 재구독은 이번에도 다른 행위자가 필요해 못 쟀다. dev Gateway 실연(태스크 11, 2026-09-23 — 모델 런 3회)까지 마쳤다: 모델이 스키마에 맞는 셀렉트·모달을 냈고 상호작용이 다음 런으로 이어지는 것(Phase 2 완료 기준)을 실물에서 봤다. docs/guides/live-smoke.md 10절.
결함 1 — 모델 런 안에서만 message 툴이 「bridge is not running」 (2026-09-23, 원인 확정·고침·실물 확인 완료). 원인은 2026.9.5 드리프트: Gateway 가 플러그인 번들을 같은 pid·같은 realm 에서 두 번 평가하고(세대마다 임시 복사 경로), startAccount 는 세대 1 에서만 도는데 모델 런의 handleAction·sendText 는 세대 2 로 간다 — 모듈 스코프 Map 이 비어 있었다. 9.4 는 평가 1회라 안 났다(스파이크 B1 이 같은 경로·같은 코드로 성공한 이유). tools.invoke·attach.grant·mcp serve 는 전부 세대 1 이라 못 잡는다. 고침은 ADR 0004 — bridges·correlations 를 globalThis[Symbol.for("dodok.openclaw-plugin.*.v1")] 레지스트리로 옮기고 삭제를 releaseBridge(같은 객체일 때만)로 강제. 서버는 이제 Gateway 버전을 로그에 남긴다(gatewayVersion·gatewayBuildId — 원격이 9.5 인지 접속 한 번에 안다. bridge plugin hello 줄의 pluginBuiltWithSdk 는 빌드 상수라 Gateway 버전이 아니다). **런 0회 하네스**가 생겼다 — 가짜 claude CLI 를 Gateway PATH 앞에 두면 모델 비용 0 으로 모델 런의 툴 경로를 두드린다(live-smoke 11절). 그 하네스로 합격 기준 6/6 통과(12절): runId·replyTo 일치, probe 로 세대 1→2 를 눈으로 확인. 테스트 1706(web 892·server 452·adapter 203·shared 94·plugin 65). 결함 2(ask_user)는 첫 층만 닫혔고 뒷 두 층은 이월.
Phase 2 ③ 첨부·이미지 완료(2026-09-23, 실연까지) — 스펙 docs/superpowers/specs/2026-09-23-attachments-design.md(구현과 달라진 것은 11장), 계획 docs/superpowers/plans/2026-09-23-attachments.md(태스크 1~10 + 곁가지 a3-c1·c2), 근거 스파이크 .superpowers/sdd/2026-09-23-phase2-attachments-spike/(9.5 실물, 모델 런 2회: 인바운드는 saveMediaBuffer 경로 fact 여야 모델이 본다, 에이전트 파일은 Gateway 호스트 경로로 온다). 사람은 작성기에서 이미지(PNG·JPEG·GIF·WebP, 5 MiB·10장)를 올리고 에이전트가 그 이미지를 본다. 에이전트의 이미지·파일(20 MiB)은 채널에 보이고 내려받는다. 바이트는 브리지 오리진 HTTP(GET·POST /bridge/attachments, 브리지 토큰), 경계를 넘는 꼴은 artifact://<id>, 호스트 경로는 어떤 텍스트에도 쓰지 않는다. 서버 modules/attachments/(매직 바이트 판별·sha256 블롭·sha 잠금·24시간 정리), 플러그인 media-http·inbound-media·outbound-media(모듈 상태 없음, 사유는 오류 코드별 고정 문구), 웹 features/attachments/(격자·파일 카드·크게 보기·해석기 — components 의 artifact://<파일 이름> 은 같은 메시지 첨부를 후보 우선순위로 푼다). 미디어만 있는 최종 응답이 호스트 경로를 채널에 드러내던 결함은 플러그인·서버 두 겹으로 막았다(실연에서 확인). 판정 6건(ack·finalizing 제한시간을 이미지·MEDIA 줄 수에 비례, 사유 고정 문구, 공백 든 이름 인코딩, 이름 해석 대안 B, 스트리밍 MEDIA 줄 필터)은 스펙 11장. 검증은 통합 11a~11i · 태스크마다 독립 리뷰(변이 테스트)·수정·범위 재리뷰 · dev:fake 위 브라우저 17/17, 결함 1(칩 초점)을 고쳐 실제 앱에서 재 확인. dev:fake 는 APP_ORIGIN 으로 웹 오리진을 바꿀 수 있다(5173 이 막혀 있으면 5180). 실연(dev Gateway 2026.9.5, docs/guides/live-smoke.md 13절): 런 0회 하네스 합격 기준 9/9 + 모델 런 2회(이미지 속 단어 맞힘 · 모델이 MEDIA: 줄로 파일을 보냄 → 파일 카드). 실연이 찾은 결함 A(최종 응답 MEDIA: 줄이 스트리밍 델타로 흘러 호스트 경로가 버블·run_events 에 남음)는 서버가 델타·REPLACE 를 저장·팬아웃 전에 런별 줄 필터(대소문자 무시)로 걷게 고쳐 런 0회로 실물 확인(13.7절, 스펙 11장 Ruling 6). 테스트 2003(web 996·server 592·adapter 206·plugin 108·shared 101). 남은 이월(느린 링크의 Ruling 1·2, 9.4 런타임, 코어가 프롬프트에 붙이는 스테이징 경로, 활동 탭 툴 인자의 호스트 경로 등)은 docs/plan.md 8장, 사람이 볼 것(실제 OS 클립보드 붙여넣기·끌어다 놓기)은 live-smoke 9절. 다음: Phase 2 ④ PWA·푸시.
Phase 2 ④ PWA·푸시 완료(2026-09-24, 실연까지) — 스펙 docs/superpowers/specs/2026-09-23-pwa-push-design.md(구현과 달라진 것은 11장), 계획 docs/superpowers/plans/2026-09-23-pwa-push.md(태스크 1~8). 설치형 PWA(vite-plugin-pwa injectManifest, 새 버전은 토스트로만), 최근 채널 5개 오프라인 사본(IndexedDB, 로그아웃·401 이면 지움, 복원한 채널은 fresh 재구독), 웹 푸시(VAPID — 환경변수 또는 data/vapid.json, 멘션·승인 요청·릴레이 한도, 누가·어디만 싣고 그 채널을 보고 있으면 서버가 거른다, 이 기기에 푸시가 켜져 있으면 탭 안 승인 알림은 쉰다). 서버 modules/push/, 웹 src/pwa/·sw.ts·app/boot.tsx·NotifySettings. 태스크마다 독립 리뷰(변이 테스트)·수정·범위 재리뷰, 브라우저 검증 16/16·결함 0(실제 web-push→FCM 왕복 포함). 실연(dev Gateway 2026.9.5, live-smoke 14.4): 런 0회 하네스 7/7 + 모델 런 1회(멘션·finalSource=plugin 통과, 그 런의 알림 표시는 미확인 — 새 프로필 FCM 누락 줄기로 이월). 실연이 의심한 「탭을 닫은 뒤 45초 거름」은 곁가지 p4-c1 측정에서 재현 안 됨(웹 pagehide 방어·서버 LOG_LEVEL=debug 거름/발송 로그 추가). Playwright 로 실제 FCM 을 받으려면 --disable-background-networking 을 뺀다. 테스트 2185(web 1101·server 657·adapter 206·shared 113·plugin 108). 이월(세션과 묶이지 않은 구독 행, lastSeq 이어 받기의 message.updated 누락, 가려진 창 경계 등)은 docs/plan.md 8장, 사람이 볼 것(실제 OS 알림 클릭·설치 끝까지·iOS/안드로이드는 Phase 3)은 live-smoke 14절. 다음: Phase 3(배포·실기기).
Phase 3 ① 배포 패키징 완료(2026-09-24, 로컬 Compose 검증까지) — 스펙 docs/superpowers/specs/2026-09-24-deploy-packaging-design.md(구현과 달라진 것은 12장), 계획 docs/superpowers/plans/2026-09-24-deploy-packaging.md(태스크 1~5), 운영 절차 docs/guides/deploy.md. Phase 3 은 ① 패키징 → ② 설정 마법사 → ③ 운영 보강 → ④ 문서로 나눴다. infra/ 에 서버 이미지(esbuild 번들 dist/main.js + 런타임에 찾는 의존성 닫힘만 — better-sqlite3·ws, 비루트, 소스맵)·웹을 구운 Caddy 2.11.4 이미지·compose.yml(app·caddy, 호스트 포트는 Caddy 80·443 뿐)·Caddyfile(자동 HTTPS·SPA 폴백·캐시·/bridge/* 프록시)·compose.local.yml·check-caddy.sh. 서버는 번들이면 chdir·.env 읽기를 하지 않고 DODOK_MIGRATIONS_DIR 로 마이그레이션을 찾으며, serveClient:false, 부팅 때 DATA_DIR 쓰기 검사. 백업 node dist/backup.js(온라인 전체 복사, .partial-* → rename, 기본 7개). 웹 빌드 ID 는 빌드 인자(DODOK_WEB_BUILD_ID — 서버만 바뀐 배포에 새 버전 토스트가 뜨지 않게). 검증: 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰, 로컬 Compose 12/12·Review Focus 5 통과(XFF 위조로 레이트리밋 우회 불가, 복원 때 WAL·SHM 을 안 지우면 조용히 무효). 테스트 2226(web 1101·server 698·adapter 206·shared 113·plugin 108). 실제 서버·도메인·폰(실기기 푸시)은 사람이 deploy.md 체크리스트를 따라 하고 결과 표를 채운다. 이월은 docs/plan.md 8장. 다음: Phase 3 ② 설정 마법사.
Phase 3 ② 설정 마법사 완료(2026-09-25, 실연까지) — 스펙 docs/superpowers/specs/2026-09-24-setup-wizard-design.md(구현과 달라진 것은 「구현과 맞춘 것」 장), 계획 docs/superpowers/plans/2026-09-24-setup-wizard.md(태스크 1~8), 운영 절차 docs/guides/deploy.md 「[웹 → B] 플러그인 설치·브리지 토큰」·「브리지 토큰 교체」. owner 전용 웹 연결 페이지(/settings/connection)가 Gateway·페어링·플러그인·브리지 상태를 보이고, 브리지 토큰을 발급·폐기한다. 토큰 정본은 DB(bridge_tokens, 해시만 — 원문 dbt_… 은 발급 대화상자에서 한 번만), 겹침 교체(옛 토큰도 통하는 동안 새 토큰으로 옮기고 폐기하면 그 세션만 끊김). .env 의 BRIDGE_TOKEN 은 선택 — 토큰 행이 하나도 없을 때(폐기된 행 포함) 라벨 env 로 한 번 이어받고, 그 뒤 바꾸면 warn·envTokenIgnored. 서버 이미지가 같은 커밋의 플러그인 tgz 를 품고(/app/plugin, DODOK_PLUGIN_DIR) 내려주며, 플러그인이 hello 에 싣는 bundleSha256(tgz 가 아니라 안의 번들 파일)으로 「같은 빌드」를 가른다. 서버 modules/setup/, 웹 features/setup/, 플러그인 bundle-hash.ts. 검증: 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰, dev:fake 위 브라우저 1~10(결함 1 — 390px 원문 잘림 — 고침), 로컬 dev Gateway 실연 13/13·모델 런 0(docs/guides/live-smoke.md 15절 — 9.5 는 플러그인 설정 패치를 핫 리로드, 브리지 14ms 끊김). 테스트 2400(web 1158·server 759·adapter 240·shared 131·plugin 112). 이월(발급 조각 bridgeUrl 이 공개 주소 파생, 교체 순간 진행 중인 런, 폐기 알림 system.notice, hello 로그 tokenId 등)은 docs/plan.md 8장, 사람이 볼 것(beforeunload·member 화면·페어링 대기 블록·오버레이 스크롤바)도 거기. 다음: Phase 3 ③ 운영 보강.
Phase 3 ③ 운영 보강 완료(2026-09-25, 실연까지) — 스펙 docs/superpowers/specs/2026-09-25-ops-hardening-design.md(구현과 달라진 것은 「구현과 맞춘 것」 장), 계획 docs/superpowers/plans/2026-09-25-ops-hardening.md(태스크 1~9), 운영 절차 docs/guides/deploy.md 「운영 화면」, usage 판정 docs/adr/0005-usage-values.md. 서버 modules/ops/ 가 운영 사건(ops_events — 같은 kind·key 는 확인 전 1시간 안이면 한 줄로 묶고 30일 보존, 기록은 OpsService 로만 — unacked 캐시)과 워크스페이스 설정(workspaces.ops_json)을 맡는다. 런을 만드는 모든 경로는 런 관문(RunGate)을 지난다 — 워크스페이스 일일 상한(키 없으면 300, null 무제한)과 채널 dailyRunLimit 이 사람 멘션·자동 응답·상호작용·다시 실행까지 센다, 막히면 scope 마다 하루 한 번 시스템 메시지. 실패한 런은 run_error 카드의 1회용 「다시 실행」 버튼(컴포넌트 — 트리거 메시지가 있는 런만, 한도에 걸리면 소비 안 됨, 쌍 허용만 다시 봄). 레이트리밋 숫자는 modules/ops/limits.ts 한곳(REST 사용자별·wire 소켓별 버킷·replay 는 자기 버킷·소켓 20·Better Auth·로컬 로그인), 브리지 실패 카운터(어댑터 BridgeAuthGuard)를 핸드셰이크·첨부 HTTP 가 함께 쓴다. /healthz 는 {ok, db} 만. 안정성: 처리 안 된 예외·비정상 종료 표지·60초 넘는 Gateway·플러그인 끊김(downMs 는 실제 끊긴 때부터)·버전 드리프트(핀 OPENCLAW_PINNED_VERSION)·디스크 여유(256 MiB 미만이면 첨부 507)·run_failed 사건, compose 가 TRUST_PROXY·로그 로테이션·stop_grace_period 15s 를 고정. 웹 /settings/operations(owner — 상태·런·한도·사건·배지, 연결 줄은 wire 어댑터 상태, 재연결 때 다시 받음). usage 는 출력 토큰·비용이 OpenClaw claude-cli 층에서 틀려 USAGE_TRUSTED=false — 운영 화면은 「측정 불가」. 검증: 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰, dev:fake 브라우저 11/12(member 확인 불가) → 결함 D1·D2·N1 고친 뒤 재검증, 로컬 Compose, usage 스파이크 모델 런 1회($0.60), dev Gateway 실연 6/6·모델 런 0(docs/guides/live-smoke.md 16절). 테스트 2762(web 1255·server 992·adapter 252·shared 151·plugin 112). 이월은 docs/plan.md 8장. 다음: Phase 3 ④ 문서화(설치, 에이전트 프롬프트 가이드).
Phase 3 ④ 문서화 완료(2026-09-25) — 루트 README.md(소개·구성·빠른 시작·문서 지도 — 설치 단계는 docs/guides/deploy.md 한곳에만), 에이전트 가이드 docs/guides/agent-guide.md(에이전트가 받는 헤더·채널 프롬프트 반영 시점·릴레이·일일 한도·components v1·파일·승인, AGENTS.md·채널 프롬프트에 붙여 넣을 블록 — 플러그인은 주입하지 않는다). 같은 채널에 message 툴을 쓴 런의 최종 답은 채널에 안 올라갈 수 있다(ADR 0002) — 가이드는 할 말을 message 본문에 쓰라고 가르친다. 가이드의 components 예시는 packages/shared/test/agent-guide-examples.test.ts 가 ComponentsV1 로 파싱한다(펜스 json dodok-components·json dodok-components-invalid <경로> <코드>·json dodok-message — 틀린 예는 위반 하나, 유효 예는 모르는 키 없음). 코드와 대조하다 찾은 것: 에이전트의 「기본 프롬프트」는 에이전트에게 닿지 않는다(화면 안내 없음 — 이월). 테스트 2778(web 1255·server 992·adapter 252·shared 167·plugin 112). Phase 3 ①~④ 끝. 남은 것은 사람이 docs/guides/deploy.md 체크리스트로 실제 서버·도메인·폰에서 따라 하고 결과 표를 채우는 일, 이월은 docs/plan.md 8장. 다음: Phase 4(확장 — 순서 재검토).
Phase 4 ① 스레드·검색 완료(2026-09-26, 실연까지) — 스펙 docs/superpowers/specs/2026-09-25-threads-search-design.md(구현과 달라진 것은 「구현과 맞춘 것」 장 — 판정 R1~R5·R3′), 계획 docs/superpowers/plans/2026-09-25-threads-search.md(태스크 1~9 + 곁가지 p4t-c1), 실측 ADR 0006. 스레드는 스레드마다 에이전트 하위 세션(채널과 병렬, 채널 대화 없음, 최상위 전송 금지, 옛 플러그인이면 PLUGIN_OUTDATED 카드), 검색은 FTS5 trigram(2글자는 LIKE 90일·50)·⌘K·결과로 가기(around·떨어진 창). hello 의 모르는 capability 는 버리고 받는다(R1) — Phase 3 서버는 새 플러그인을 거절하므로 되돌리기는 플러그인도(docs/guides/deploy.md 「업데이트」). providerAgentId 는 소문자만 등록(R4). messages 를 재생성하는 마이그레이션은 FTS 트리거·백필을 다시 넣는다(docs/project-structure.md). 검증: 통합 threads 11 · 태스크마다 독립 리뷰(변이)·수정 · dev:fake 브라우저 11항목 중 9 통과, 재접속 결함(Phase 4 이전부터 — 핸드셰이크 전 깨끗한 close 에 20초 멈춤)은 WireManager 로 고침(22~24s → 약 3s) · 실연 docs/guides/live-smoke.md 「스레드(Phase 4 ①) 실연」 절(런 0회 하네스 8/8 + 모델 런 2회, 결함 0 — 9.5 는 message 툴을 쓴 런의 최종 답을 억제하지 않는다, 9.4 는 억제). 테스트 3193(web 1385·server 1151·adapter 264·shared 247·plugin 146). 이월은 docs/plan.md 8장. 다음: Phase 4 나머지(순서 재검토).
Phase 4 ② 팀(초대·멤버·역할) 완료(2026-09-27, 실연까지) — 스펙 docs/superpowers/specs/2026-09-26-team-members-design.md(구현과 달라진 것은 「구현과 맞춘 것」 장 — 판정 R1~R4), 계획 docs/superpowers/plans/2026-09-26-team-members.md(태스크 1~8 + 곁가지 p4m-c1~c5), 운영 절차 docs/guides/deploy.md 「멤버 초대·비밀번호 재설정·내보내기」. owner(로컬 토큰)·admin·member — 대화는 누구나, 에이전트 동작·비용 설정·「새 대화」·도구 승인·에이전트 등록·멤버 관리·운영은 admin 이상, 연결 페이지·admin 초대·역할 바꾸기는 owner. 서버가 요청마다 membership 을 읽어 막는다(auth/roles.ts — 매트릭스 정본은 스펙 「역할과 권한」 표, 본문 필드로 가르는 목록 밖 필드는 admin). 1회용 초대·재설정 링크(원문은 발급 응답 한 번, sha256 만 저장, 메일 없음 — 링크는 APP_ORIGIN 으로 만든다), 멤버는 이메일·비밀번호 로그인(이메일은 소문자로), 초대 경로 IP 버킷 20 은 로그인 5 와 따로. 서버 modules/members/(초대·가입·관리·people — 핸들 검사는 handles.ts 한 함수, `left-` 는 나간 사람 몫으로 예약), 웹 features/members/·features/account/. 세션을 지우는 자리(재설정·비밀번호 변경·로그아웃·내보내기)는 그 세션 소켓도 지우기 → 끊기 순서로 끊고, Better Auth HTTP 는 허용 목록(/ok)만 통과한다(세션 폐기·비밀번호 확인·세션 목록 경로가 열리지 않게). 재설정 링크는 조회·수락 때 발급자·대상의 지금 역할로 다시 본다. 승인 결정자는 이긴 결정을 누른 사람으로 남는다. 사람은 채널에 처음 쓰거나 멘션받으면 자동 참여, 에이전트 헤더 「참여자:」는 참여한 사람만. 검증: 역할 매트릭스 테스트 · 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰(수정 라운드도 리뷰어 워커) · dev:fake 브라우저 11항목 중 9, D1·D2 수정 뒤 재검증 7/7 · 전체 브랜치 최종 리뷰(I1 재설정 링크 권한·I2 Better Auth HTTP 수정 뒤 재리뷰 닫힘) · 실연 docs/guides/live-smoke.md 「팀(Phase 4 ②) 실연」 절(모델 런 0회 6/6). 테스트 3538(web 1486·server 1382·adapter 264·shared 260·plugin 146). 이월은 docs/plan.md 8장. 다음: Phase 4 나머지(어댑터·앱 — 순서 재검토).
Phase 4 ③ Claude 러너 완료(2026-09-29, 런 0회 하네스까지 — 모델 런 실연은 사용자 승인 3회) — 스펙 docs/superpowers/specs/2026-09-27-claude-runner-design.md(구현과 달라진 것은 「구현과 맞춘 것」 장 — 계획 판정 P1~P10·판정 R1~R5·M4·최종 리뷰 수정), 계획 docs/superpowers/plans/2026-09-27-claude-runner.md(태스크 1~9), 실측 ADR 0007(모델 런 5회, 「구현이 고른 것」 절). 사람의 머신에서 dodok-runner(packages/claude-runner)가 Claude Agent SDK 로 Claude Code 를 돌려 서버 /runner(Socket.IO 네임스페이스, 러너 토큰 drn_ — 연결 페이지 owner)로 붙고, 서버는 provider 로 어댑터를 고른다(AdapterRegistry, 계약은 packages/shared/src/adapter/). 런 하나 = query() 하나, 채널 규칙은 틀 입힌 systemPrompt.append + snapshot:false(매 런), 턴 사실은 UserPromptSubmit 훅, 카드·파일은 mcp__dodok__post(작업 디렉터리 안만, 파일은 macOS·Linux), 쓰기 도구는 도구 승인 카드(10분 — 기한 타이머는 러너 어댑터), 러너 대기열 런은 서버가 runMs 로 기다린다, 대화형·예약 도구는 러너가 기본으로 막는다. 러너 토큰 첨부 읽기는 열린 런의 트리거 첨부·자기 업로드만(R5), providerAgentId 는 제공자를 가로질러 유일(R2), 서버 재시작엔 러너가 다시 붙고 토큰 폐기·교체면 CLI 를 멈춘 뒤 종료 2(R4). 러너는 답 글·도구 인자·결과의 호스트 경로를 가린다. 운영 화면은 러너 런 토큰·금액(구독이면 「환산 포함」, 섞이면 「런 m/n개만」). 설치 docs/guides/deploy.md 「Claude 러너 설치」, 에이전트 쪽 docs/guides/agent-guide.md 「Claude 러너 에이전트」. 검증: 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰, dev:fake 가짜 러너 위 브라우저 11/11(결함 D1 고침), 런 0회 하네스 12/12(docs/guides/live-smoke.md 「Claude 러너 런 0회 하네스」 — 실제 서버·러너 설치본·번들 CLI + 가짜 Messages API, 모델 런 0), 전체 브랜치 최종 리뷰(I1 러너 대기열 TIMEOUT·P1 고아 CLI 등 고친 뒤 재리뷰 닫힘). 테스트 4052(web 1524·server 1478·shared 350·openclaw-adapter 264·claude-runner 233·plugin 146·runner-adapter 57). 이월은 docs/plan.md 8장. 다음: 러너 실연(live-smoke 「Claude 러너(Phase 4 ③) 실연」 — 모델 런 3회).
