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
- 워크트리 자리는 .worktrees/dodok.chat/<슬러그>. Orca 의 worktree 경로 설정(이 머신은 글로벌 .worktrees, repo 별 worktreeBasePath 가 있으면 우선)이 그 자리를 내야 spawn 이 된다. git worktree add 로 만든 워크트리는 Orca 가 인식하지 않으므로 워커를 붙일 워크트리는 spawn 으로 만든다. 손으로 만들면 --base-branch $(git branch --show-current), pnpm install, scripts/orca-worker.sh sync-config <경로>(.env 복사). data/ 는 복사하지 않는다.
- 브라우저 검증도 워커가 한다. BrowserOS neo 는 워커를 띄우기 전에 떠 있어야 한다(spawn 이 켠다). 브리프에 "네가 연 탭은 네가 닫아라".
- 커밋: git add -A / git commit -a 금지, 경로를 명시해 stage. Conventional Commits, 패키지 스코프(feat(plugin): …).

## 명령
pnpm i · pnpm dev(전체) · pnpm -F @dodok/server dev · pnpm -F @dodok/web dev
pnpm test · pnpm typecheck · pnpm lint · pnpm lint:fix · pnpm fmt · pnpm fmt:check (oxlint / oxfmt · test·typecheck 는 Turbo 캐시 off)
Node 24.21.0 · pnpm 11.16.0 은 mise.toml 핀(`mise install`). Bash 도구는 SessionStart 훅(.claude/hooks/node-env.sh)이 PATH 를 잡는다. `node -v` 가 24 가 아니면 `export PATH="$(mise where node)/bin:$PATH"`.
scripts/orca-worker.sh status|spawn|attach|wait|reap|stop|keep|sync-config · bash scripts/test/orca-worker.test.sh
서버 단독: pnpm -F @dodok/server dev(루트 .env, 이미 있는 env 는 안 덮음) · pnpm wire-cli <origin> [localToken] <명령>(REST·wire 손 점검) · dev Gateway 실연 절차·결과 docs/guides/live-smoke.md
docker compose -f infra/docker-compose.yml up [--profile gateway]

## 현재 단계
shared 계약·DB 스키마·순수 로직 구현 완료 (docs/superpowers/plans/2026-09-14-shared-contracts.md).
Phase 0 스파이크 1·2·3 완료 — docs/adr/0001(Gateway WS 실물), 0002(채널 플러그인: 인바운드·message 툴·components 동작, 봇 루프 보호는 플러그인이 사실을 넘길 때만), 0003(채널 프롬프트: claude-cli 기존 세션은 리셋·새 키에서만 반영, ChannelPromptContext 는 매 턴 반영; deltaCursor 는 claude-cli 세션에 없음; chat.send 대체 경로는 MVP 미사용).
로컬 dev Gateway: OpenClaw.app 번들 CLI(`openclaw --dev`, Node 24 번들, 상태 ~/.openclaw-dev, 에이전트 dev·fin). 원격 호스트 플러그인 설치는 사람 절차(ADR 0002 9절).
Phase 0 종료, 결정 13건 확정(계획서 10장 #1·#11~#21), Node 24 전환, 플러그인 스파이크 흔적 정리 병합(cd572af — InboundDeliverResult.admission, ChannelPromptContext 고정).
Phase 1 ① 서버 코어 완료 — 스펙 docs/superpowers/specs/2026-09-15-server-core-design.md, 계획 docs/superpowers/plans/2026-09-15-server-core.md(태스크 0~15). 통합 시나리오 1~8(가짜 Gateway·플러그인) 통과, dev Gateway 실연(런 6: 멘션·릴레이·상한·이어가기·리셋 뒤 프롬프트·Gateway 재기동 복구) 통과 — 실연이 찾은 「새 세션 미구독」은 38fa0f1 로 고침, usage 값·진단 로그는 남음(docs/guides/live-smoke.md 5.4). 다음: ② 웹.
