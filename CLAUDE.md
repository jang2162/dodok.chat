# dodok.chat

사람과 AI 에이전트가 같은 채널에서 대화하는 에이전트 네이티브 메신저. 1차 연동은 OpenClaw.
계획: docs/plan.md · 구성: docs/project-structure.md · 결정: docs/plan.md 10장, docs/adr/

## 필수 참조 문서
- docs/guides/worktree-workflow.md — 워크트리·Orca 워커·병렬 작업·폐기. 코드 변경 전에 0절로 「직접 처리 / 워크트리」를 정한다.
- docs/guides/browser-verification.md — 화면 확인 도구 순서(BrowserOS neo → 그 환경에 있는 것 → Playwright 를 neo 에 얹기).

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

## 작업 방식 (정본: docs/guides/worktree-workflow.md)
- 코드 변경은 기본이 워크트리. 예외는 브레인스토밍·스펙·계획 없이 바로 구현 가능한 것(문서·설정·지침 갱신, 진단 끝난 버그, 기계적 변경)뿐이며 그때만 최상위에서 직접. 최상위에서 checkout/switch 금지.
- Orca 런타임이 살아 있으면(orca status --json) 구현·리뷰·검증은 scripts/orca-worker.sh 로 띄운 워커가 한다. 메인 세션은 디스패치·판정·병합만. superpowers 는 브레인스토밍·스펙·구현계획까지. SDD 의 Agent 디스패치·EnterWorktree 는 Orca 가 없을 때만.
- 흐름: spawn <슬러그> <역할> --brief <파일> → wait(exit 3 은 타임아웃, 다시 부른다) → attach <슬러그> review → 판정(git diff --name-only 를 브리프 목록과 대조) → 병합 → reap <슬러그>. 역할 기본 모델: implement/review=opus, verify/chore=sonnet.
- 워크트리 자리는 .worktrees/dodok.chat/<슬러그>. Orca 앱 repo 설정 worktreeBasePath=.worktrees 가 비어 있으면 spawn 이 실패한다(CLI 로 못 고친다). 손으로 만들면 --base-branch $(git branch --show-current), pnpm install, scripts/orca-worker.sh sync-config <경로>(.env 복사). data/ 는 복사하지 않는다.
- 브라우저 검증도 워커가 한다. BrowserOS neo 는 워커를 띄우기 전에 떠 있어야 한다(spawn 이 켠다). 브리프에 "네가 연 탭은 네가 닫아라".
- 커밋: git add -A / git commit -a 금지, 경로를 명시해 stage. Conventional Commits, 패키지 스코프(feat(plugin): …).

## 명령
pnpm i · pnpm dev(전체) · pnpm -F @dodok/server dev · pnpm -F @dodok/web dev
pnpm test · pnpm typecheck · pnpm lint · pnpm lint:fix · pnpm fmt · pnpm fmt:check (oxlint / oxfmt · test·typecheck 는 Turbo 캐시 off)
scripts/orca-worker.sh status|spawn|attach|wait|reap|stop|keep|sync-config · bash scripts/test/orca-worker.test.sh
docker compose -f infra/docker-compose.yml up [--profile gateway]

## 현재 단계
shared 계약·DB 스키마·순수 로직 구현 완료 (docs/superpowers/plans/2026-09-14-shared-contracts.md).
Phase 0 스파이크 1 완료 — docs/adr/0001-gateway-client-spike.md (Gateway WS 실물: 페어링 자동 승인, runId=idempotencyKey, 툴 진행은 agent stream:tool).
다음: 스파이크 2(채널 플러그인, 원격 Gateway 설치 + 터널)·3(채널 프롬프트 설정 쓰기). 스파이크마다 docs/adr/에 결과 기록.
