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
