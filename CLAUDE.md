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
웹 손 확인: pnpm -F @dodok/server dev:fake(가짜 Gateway·플러그인·대본, 모델 런 없음. 기본 포트 3000, DB data/dev-fake.sqlite 는 시작마다 새로·--keep 이면 유지, 개발 전용 고정 로그인 토큰 dev-fake-local-token) + pnpm -F @dodok/web dev(5173).
브라우저는 http://localhost:5173 으로 연다 — 127.0.0.1 이면 wire 핸드셰이크 Origin 이 APP_ORIGIN 과 달라 거부된다(rejected 배너). 포트를 바꿔 병행하려면 PORT·APP_ORIGIN·DODOK_API_ORIGIN·--port 를 함께 맞춘다.
docker compose -f infra/docker-compose.yml up [--profile gateway]

## 현재 단계
shared 계약·DB 스키마·순수 로직 구현 완료 (docs/superpowers/plans/2026-09-14-shared-contracts.md).
Phase 0 스파이크 1·2·3 완료 — docs/adr/0001(Gateway WS 실물), 0002(채널 플러그인: 인바운드·message 툴·components 동작, 봇 루프 보호는 플러그인이 사실을 넘길 때만), 0003(채널 프롬프트: claude-cli 기존 세션은 리셋·새 키에서만 반영, ChannelPromptContext 는 매 턴 반영; deltaCursor 는 claude-cli 세션에 없음; chat.send 대체 경로는 MVP 미사용).
로컬 dev Gateway: OpenClaw.app 번들 CLI(`openclaw --dev`, Node 24 번들, 상태 ~/.openclaw-dev, 에이전트 dev·fin). 원격 호스트 플러그인 설치는 사람 절차(ADR 0002 9절).
Phase 0 종료, 결정 13건 확정(계획서 10장 #1·#11~#21), Node 24 전환, 플러그인 스파이크 흔적 정리 병합(cd572af — InboundDeliverResult.admission, ChannelPromptContext 고정).
Phase 1 ① 서버 코어 완료 — 스펙 docs/superpowers/specs/2026-09-15-server-core-design.md, 계획 docs/superpowers/plans/2026-09-15-server-core.md(태스크 0~15). 통합 시나리오 1~8(가짜 Gateway·플러그인) 통과, dev Gateway 실연(런 6: 멘션·릴레이·상한·이어가기·리셋 뒤 프롬프트·Gateway 재기동 복구) 통과 — 실연이 찾은 「새 세션 미구독」은 38fa0f1 로 고침, usage 값·진단 로그는 남음(docs/guides/live-smoke.md 5.4).
Phase 1 ② 웹 MVP 완료(2026-09-20) — 스펙 docs/superpowers/specs/2026-09-19-web-mvp-design.md, 계획 docs/superpowers/plans/2026-09-19-web-mvp.md(태스크 0~14). 로그인·채널·메시지 목록·@멘션 작성기·마크다운 렌더·스트리밍 버블·중지·에이전트 등록·채널 설정·「새 대화」. 구성은 docs/project-structure.md 2.5.
dev:fake 위 브라우저 검증은 결함 0 으로 통과(시나리오 1~10, 수정 라운드 2회 뒤 재검증 2회). 남은 문제·후속은 docs/plan.md 8장 「이월」 한곳에. 실물 dev Gateway·실제 모델 실연도 마쳤다(2026-09-20, 런 4: 멘션·릴레이·이어가기 카드 통과, 앱 결함 0 — 중지만 계측 문제로 미확인, docs/guides/live-smoke.md 7절).
Phase 2 ① 활동 패널·승인 완료(2026-09-21) — 스펙 docs/superpowers/specs/2026-09-20-activity-approvals-design.md, 계획 docs/superpowers/plans/2026-09-20-activity-approvals.md(태스크 0~11), 근거 스파이크 .superpowers/sdd/2026-09-20-phase2-approval-spike/. 활동 탭(런 목록·툴 타임라인)·승인 카드(허용·거절·만료·두 자리 동기)·브라우저 알림, Phase 1 이월 아홉(서버 넷·웹 넷·wire-cli typecheck) 정리. 검증은 통합 시나리오 9a~9g(9c′ 포함 8건, 가짜 Gateway·플러그인) 통과 · dev:fake 위 브라우저 검증(결함 11 중 7 수정·4 이월) + 수정 뒤 재검증 9/9 통과. 재검증은 고친 7건을 수치로 확인했고(D1 알림 0→1건 · D2 옛 런 노출 420→0ms · D3 Tab 5→2회 · D10 타임라인 54→128px), 새로 찾은 셋(D12 재접속 뒤 끊긴 사이 끝난 런이 목록에서 사라짐 · D13 결정 뒤 초점이 body · D14 좁은 화면 시트 초점)도 고쳐서 들어갔다(d7e3f9c·94dc365). 테스트 1394(web 615·server 429·adapter 201·shared 92·plugin 57). 남은 이월은 docs/plan.md 8장, 사람이 눈·귀로 볼 것은 docs/guides/live-smoke.md 9절. 다음: Phase 2 ② components v1 완성.
Phase 2 ② components v1 완성(2026-09-22) — 스펙 docs/superpowers/specs/2026-09-21-components-v1-design.md(설계와 달라진 것은 11장), 계획 docs/superpowers/plans/2026-09-21-components-v1.md(태스크 1~9 + 검증 결함 수정). 웹 features/components/ 가 블록 5종·셀렉트(「보내기」 확정)·모달(필드 7종)을 그리고, 누가 무엇을 보냈는지 카드 안 결과 줄로 남는다(서버가 Message.interactions 를 wire 팬아웃·listMessages 에서 하이드레이션 — 새로고침·새 탭에서도 보인다). artifact:// 는 자리표시(해석은 ③). 초점·타이머 이월 셋(넓은 화면 설정 닫기 초점·D6 공용 틱·자리값 소요 정지)도 닫았다. 검증은 통합 시나리오 10a~10g(가짜 Gateway·플러그인) 통과 · dev:fake 위 브라우저 검증 1차 22/24, 결함 1(비활성 사유가 눈에 안 보임)을 고쳤다(aa0d4d8·4864ecb) → 재검증 24/24·결함 0. 재검증은 실제 앱에서 다섯 사유와 사유 셋이 섞인 줄(basis-full 로 줄마다 24px 간격)을 확인했고, 셀렉트 스크롤 상자가 실제로 스크롤되는 것도 처음 봐 c2-t3 이월 하나를 닫았다. 긴 라벨 버튼 390px 넘침·날짜 키 롤오버는 「확인됨」(이월 그대로), lastSeq 재구독은 이번에도 다른 행위자가 필요해 못 쟀다. dev Gateway 실연(태스크 11, 2026-09-23 — 모델 런 3회)까지 마쳤다: 모델이 스키마에 맞는 셀렉트·모달을 냈고 상호작용이 다음 런으로 이어지는 것(Phase 2 완료 기준)을 실물에서 봤다. docs/guides/live-smoke.md 10절.
결함 1 — 모델 런 안에서만 message 툴이 「bridge is not running」 (2026-09-23, 원인 확정·고침·실물 확인 완료). 원인은 2026.9.5 드리프트: Gateway 가 플러그인 번들을 같은 pid·같은 realm 에서 두 번 평가하고(세대마다 임시 복사 경로), startAccount 는 세대 1 에서만 도는데 모델 런의 handleAction·sendText 는 세대 2 로 간다 — 모듈 스코프 Map 이 비어 있었다. 9.4 는 평가 1회라 안 났다(스파이크 B1 이 같은 경로·같은 코드로 성공한 이유). tools.invoke·attach.grant·mcp serve 는 전부 세대 1 이라 못 잡는다. 고침은 ADR 0004 — bridges·correlations 를 globalThis[Symbol.for("dodok.openclaw-plugin.*.v1")] 레지스트리로 옮기고 삭제를 releaseBridge(같은 객체일 때만)로 강제. 서버는 이제 Gateway 버전을 로그에 남긴다(gatewayVersion·gatewayBuildId — 원격이 9.5 인지 접속 한 번에 안다. 같은 줄 pluginBuiltWithSdk 는 빌드 상수라 Gateway 버전이 아니다). **런 0회 하네스**가 생겼다 — 가짜 claude CLI 를 Gateway PATH 앞에 두면 모델 비용 0 으로 모델 런의 툴 경로를 두드린다(live-smoke 11절). 그 하네스로 합격 기준 6/6 통과(12절): runId·replyTo 일치, probe 로 세대 1→2 를 눈으로 확인. 테스트 1706(web 892·server 452·adapter 203·shared 94·plugin 65). 결함 2(ask_user)는 첫 층만 닫혔고 뒷 두 층은 이월.
Phase 2 ③ 첨부·이미지 구현 완료(2026-09-23, 실연 남음) — 스펙 docs/superpowers/specs/2026-09-23-attachments-design.md(구현과 달라진 것은 11장), 계획 docs/superpowers/plans/2026-09-23-attachments.md(태스크 1~10 + 곁가지 a3-c1·c2), 근거 스파이크 .superpowers/sdd/2026-09-23-phase2-attachments-spike/(9.5 실물, 모델 런 2회: 인바운드는 saveMediaBuffer 경로 fact 여야 모델이 본다, 에이전트 파일은 Gateway 호스트 경로로 온다). 사람은 작성기에서 이미지(PNG·JPEG·GIF·WebP, 5 MiB·10장)를 올리고 에이전트가 그 이미지를 본다. 에이전트의 이미지·파일(20 MiB)은 채널에 보이고 내려받는다. 바이트는 브리지 오리진 HTTP(GET·POST /bridge/attachments, 브리지 토큰), 경계를 넘는 꼴은 artifact://<id>, 호스트 경로는 어떤 텍스트에도 쓰지 않는다. 서버 modules/attachments/(매직 바이트 판별·sha256 블롭·sha 잠금·24시간 정리), 플러그인 media-http·inbound-media·outbound-media(모듈 상태 없음, 사유는 오류 코드별 고정 문구), 웹 features/attachments/(격자·파일 카드·크게 보기·해석기 — components 의 artifact://<파일 이름> 은 같은 메시지 첨부를 후보 우선순위로 푼다). 미디어만 있는 최종 응답이 호스트 경로를 채널에 드러내던 결함은 플러그인·서버 두 겹으로 막았다(실물 확인은 실연). 판정 5건(ack·finalizing 제한시간을 이미지·MEDIA 줄 수에 비례, 사유 고정 문구, 공백 든 이름 인코딩, 이름 해석 대안 B)은 스펙 11장. 검증은 통합 11a~11i · 태스크마다 독립 리뷰(변이 테스트)·수정·범위 재리뷰 · dev:fake 위 브라우저 17/17, 결함 1(칩 초점)을 고쳐 실제 앱에서 재 확인. 테스트 1973(web 996·server 562·adapter 206·plugin 108·shared 101). dev:fake 는 APP_ORIGIN 으로 웹 오리진을 바꿀 수 있다(5173 이 막혀 있으면 5180). 남은 이월 13은 docs/plan.md 8장, 사람이 볼 것(실제 OS 클립보드 붙여넣기·끌어다 놓기)은 live-smoke 9절. 다음: 태스크 11 실연(dev Gateway, 모델 런 — 사용자 승인), 그 뒤 Phase 2 ④ PWA·푸시.
