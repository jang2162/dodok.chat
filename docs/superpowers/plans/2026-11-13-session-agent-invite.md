# 세션에 에이전트 초대 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사람이 일반 채널의 세션 하나에 그 채널에 없는 에이전트를 초대하고, 그 에이전트가 그 세션(과 스레드)에서만 멘션되고 답하게 한다.

**Architecture:** 초대를 새 표 `conversation_agents`(대화 × 에이전트)에 둔다. 「이 세션에서 부를 수 있는 에이전트」를 채널 멤버 ∪ 그 대화의 초대로 계산하는 함수 하나를 두고, 멘션 라우팅·에이전트 문맥(참여자·릴레이 규칙)·러너 세션 설정이 그것을 쓴다. 채널 멤버만 읽는 나머지 자리는 그대로라 기본이 「다른 세션에는 안 보임」이다.

**Tech Stack:** Zod(shared), Fastify·drizzle·better-sqlite3, Socket.IO wire, React·TanStack Query.

**Spec:** `docs/superpowers/specs/2026-11-13-session-agent-invite-design.md` — 결정 I1~I13 이 정본.

## Global Constraints

- 일반 채널(`kind` 가 DM·direct 가 아닌)의 세션만. DM·그룹 DM 대화에 초대하면 400(I2).
- 세션 하나에 초대 ≤ 8. 이미 그 채널 멤버인 에이전트·보관한 에이전트·없는 에이전트는 거절(I8). OpenClaw·러너 둘 다 됨(I9).
- 초대·내보내기 권한은 `authorizeChannelMemberAdd`·`authorizeChannelMemberRemove` 와 같은 판정(I3). 닫힌 세션은 둘 다 거절(「닫힌 세션입니다」 — 지금 닫힌 세션 거절과 같은 코드·문구).
- 초대한 에이전트는 채널의 `autoResponder` 가 되지 않는다(I5). 스레드 루트 작성자 규칙은 적용된다(I10).
- 릴레이 허용 목록(`allowPairs`)에서 초대한 에이전트가 낀 쌍은 양방향 허용, 턴 한도·반복 차단·일일 상한은 그대로(I11).
- 제어 도구에는 넣지 않는다(I13).
- 화면 문구는 라벨·단추만(2026-11-10 문구 기준). 시스템 메시지 문구는 스펙 I7.
- 경로 명시 stage, Conventional Commits, 실제 모델 런 금지.

## Review Focus

1. **같은 채널의 다른 세션에서 초대한 에이전트를 `@핸들` 로 불러도 실행이 생기지 않고, 그 세션의 실행 헤더 「참여자」·웹 멘션 후보에도 없다.** (Task 2·3·5 시험)
2. **내보내는 순간 그 세션(과 스레드)에서 돌던 그 에이전트의 실행이 멈추고 걸린 승인 카드가 취소된다; 내보낸 뒤 늦게 도착한 정본·릴레이 멘션이 새 실행을 만들지 않는다.** (Task 3 시험)
3. **채널을 보관하거나 에이전트를 보관(삭제)하면 초대한 에이전트도 실행되지 않고, 되살리면 초대가 그대로다; 대화를 지우면 초대 행도 지워진다.** (Task 1·3 시험)
4. **초대한 뒤 그 에이전트를 채널 멤버로 넣으면 초대 행이 지워져 「초대됨」 표시가 사라지고, 다시 채널에서 빼면 그 세션에서도 불리지 않는다.** (Task 3 시험)
5. **허용 목록을 쓰는 채널에서 초대한 에이전트와의 릴레이는 통과하지만, 초대와 무관한 막힌 쌍은 여전히 `pair_not_allowed` 다 — 예외가 목록 전체를 풀지 않는다.** (Task 2 시험)

---

### Task 1: shared 계약·DB

**Files:**
- Create: `packages/shared/src/conversations/invited-agents.ts`(이웃 `agent-settings.ts` 옆 — 내보내기 `packages/shared/src/index.ts`), `apps/server/drizzle/0039_conversation_agents.sql`(+meta), `apps/server/src/modules/conversations/invited-agents.ts`(저장·조회)
- Modify: `packages/shared/src/wire/index.ts`(서버→클라이언트 `conversation.agents`), `apps/server/src/db/schema.sqlite.ts`(표 `conversationAgents`)
- Test: 새 `packages/shared/test/invited-agents.test.ts`, 새 `apps/server/test/invited-agents.store.test.ts`

**Interfaces — Produces:**
- `InvitedAgent = z.object({ agentId: Id, invitedBy: Id.nullable(), invitedAt: IsoDateTime })`, `InviteAgentBody = z.object({ agentId: Id })`, `MAX_INVITED_AGENTS = 8`
- wire `"conversation.agents": (p: { channelId: Id; conversationId: Id; invited: InvitedAgent[] }) => void`
- 서버 `listInvited(db, conversationId): InvitedAgent[]`, `invitedAgentIds(db, conversationId): string[]`(보관한 에이전트 제외), `insertInvite(db, { conversationId, agentId, invitedBy }): void`, `deleteInvite(db, { conversationId, agentId }): boolean`, `deleteInvitesForChannelAgent(db, { channelId, agentId }): string[]`(지운 대화 id 들 — I12)
- `sessionAgentIds(db, { channelId, conversationId }): string[]` = 채널 에이전트 멤버 ∪ `invitedAgentIds`(중복 없이)

- [ ] **Step 1:** 시험 — shared 스키마; store: 넣고 읽기, 같은 쌍 두 번 넣기 거절(PK), 대화 삭제 시 행 삭제·에이전트 삭제 시 행 삭제(Review Focus 3), 보관한 에이전트는 `invitedAgentIds` 에서 빠지고 `listInvited` 에는 남음, `sessionAgentIds` 가 다른 대화의 초대를 싣지 않음.
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** `pnpm -F @dodok/shared test`·`pnpm -F @dodok/server test` PASS, `pnpm typecheck` → **Step 5:** 커밋 `feat(server): store agents invited to a conversation`

### Task 2: 라우팅·에이전트 문맥

**Files:**
- Modify: `apps/server/src/modules/router/decide.ts`(`RoutingInput` 에 `invitedAgentIds: readonly string[]`, `isPairAllowed` 호출부의 예외, 활성 판정), `apps/server/src/modules/router/service.ts`(152행 근처 — `agentList` 를 `sessionAgentIds` 로, `invitedAgentIds` 전달), `apps/server/src/modules/runs/context.ts`(참여자·`relayRulesFor`·초대받은 에이전트의 헤더 줄), 문맥 계약에 표시 필드가 필요하면 `packages/shared` 의 `InboundContext` 참여자(선택 필드 `invited?: boolean`)와 그것을 헤더로 그리는 자리(플러그인 `packages/openclaw-plugin/src/` 의 헤더 빌더·러너의 `buildTurnFacts` — 스펙 7장: 어디서 만드는지 찾아 그 자리에)
- Test: `apps/server/test/router.decide.test.ts`, `apps/server/test/router.service.test.ts`, `apps/server/test/runs.context.test.ts`, 헤더를 그리는 쪽의 기존 시험 파일(플러그인·shared 의 헤더 시험 — 있는 이름을 쓴다)

**Interfaces:**
- Consumes: Task 1 `sessionAgentIds`·`invitedAgentIds`
- Produces: `decideRuns` 가 초대한 에이전트를 멘션 대상·스레드 루트 응답자(I10)로 받되 `autoResponder` 로는 받지 않음; 초대한 에이전트가 `from` 이거나 `to` 인 쌍은 `allowPairs` 검사를 건너뜀(I11); 그 세션의 실행 문맥 참여자에 초대한 에이전트가 `(에이전트, 초대됨)` 으로, 초대받은 에이전트 자신의 헤더에 「세션 초대: …」 한 줄(스펙 5.2 문구)

- [ ] **Step 1:** 시험 — decide: 초대한 에이전트 멘션 → 실행; `invitedAgentIds` 가 빈 다른 세션 입력에서는 같은 멘션이 실행 없음(Review Focus 1); 초대한 에이전트의 글이 루트인 스레드의 멘션 없는 답글 → 그 에이전트(I10); 채널 자동 응답이 초대한 에이전트로 가지 않음; 허용 목록 `[(dev→fin)]` 채널에서 dev→초대·초대→dev 통과, fin→dev 는 `pair_not_allowed`(Review Focus 5); 턴 한도는 초대한 에이전트에도. service: 세션 A 에 초대, 세션 B 의 멘션은 실행 0. context: 세션 A 실행의 참여자에 초대 표시, 세션 B 실행에는 없음; 초대받은 에이전트 헤더의 세션 초대 줄; 릴레이 규칙 줄이 초대한 에이전트를 부를 수 있다고 말함.
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** 해당 패키지 시험 PASS·`pnpm typecheck` → **Step 5:** 커밋 `feat(server): route mentions to agents invited to the session`

### Task 3: REST·wire·내보내기·채널 멤버와의 겹침

**Files:**
- Create: `apps/server/src/modules/conversations/invited-agents.routes.ts`
- Modify: `apps/server/src/app.ts`(등록), `apps/server/src/realtime/events.ts`(채널 룸 `conversation.agents`), `apps/server/src/modules/channels/service.ts`(`addMember` — I12), `apps/server/src/modules/conversations/service.ts`(시스템 메시지 도우미 재사용), 실행 중지 자리(`apps/server/src/modules/runs/orchestrator.ts` 의 대화 단위 중지 — 에이전트 하나만 멈추는 길)
- Test: 새 `apps/server/test/invited-agents.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`, `apps/server/test/conversations.close-runs.test.ts`, `apps/server/test/channels.members.test.ts`(있는 이름을 쓴다)

**Interfaces — Produces:**
- `GET /api/v1/conversations/:id/agents` → `{ invited: InvitedAgent[] }`(그 대화를 읽을 수 있는 사람)
- `POST /api/v1/conversations/:id/agents` body `InviteAgentBody` → `{ invited: InvitedAgent[] }` + 시스템 메시지 「@<핸들> 이(가) @<에이전트> 를 이 세션에 초대했습니다」 + wire
- `DELETE /api/v1/conversations/:id/agents/:agentId` → `{ invited }` + 그 대화(스레드 포함)에서 그 에이전트의 열린 실행 중지·걸린 승인 취소 + 시스템 메시지 「…내보냈습니다」 + wire
- `addMember` 가 에이전트를 채널에 넣을 때 `deleteInvitesForChannelAgent` 로 초대를 지우고 지운 대화마다 wire

- [ ] **Step 1:** 시험 — 초대 200·wire·시스템 메시지; 9번째 400; 채널 멤버·보관·없는 에이전트·DM 대화 400; 닫힌 세션 거절; 남의 DM·읽을 수 없는 대화 404; 권한(지금 채널 멤버 추가 권한과 같은 행렬 — roles.matrix); 내보내기: 진행 중 실행 중지·승인 취소, 내보낸 뒤 그 에이전트 멘션은 실행 0, 내보낸 뒤 늦은 정본이 릴레이를 만들지 않음(Review Focus 2); 세션 닫기 → 초대한 에이전트 실행도 멈추고 다시 열면 초대 유지(I6); 채널 보관·에이전트 보관 중 실행 0, 되살리면 유지(Review Focus 3); 초대 뒤 채널 멤버로 넣으면 행 삭제·wire, 다시 빼면 그 세션 멘션 실행 0(Review Focus 4).
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** `pnpm -F @dodok/server test` PASS(실행 수)·`pnpm typecheck` → **Step 5:** 커밋 `feat(server): invite and remove session agents over REST`

### Task 4: 러너 세션 설정과 잇기

**Files:** Modify `apps/server/src/modules/conversations/agent-settings.ts`(`settingsAgentsOf` — 그 대화의 초대한 러너 에이전트 포함), `apps/server/src/modules/conversations/agent-settings.routes.ts`(필요하면). Test: `apps/server/test/agent-settings.routes.test.ts`.

**Interfaces:** `GET /api/v1/conversations/:id/agent-settings` 가 초대한 러너 에이전트의 줄도 돌려주고 PATCH 가 된다. 새 세션 창용 `GET /api/v1/channels/:id/agent-ceilings` 는 그대로(초대는 세션이 생긴 뒤에만).

- [ ] **Step 1:** 시험 — 초대한 러너 에이전트가 그 대화의 설정 목록에 있고 다른 대화에는 없음, PATCH 저장이 그 세션 실행에 실림, 내보내면 목록에서 빠짐(설정 행은 남아도 됨 — 다시 초대하면 돌아옴).
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** PASS → **Step 5:** 커밋 `feat(server): session settings for invited runner agents`

### Task 5: 웹

**Files:**
- Create: `apps/web/src/features/conversations/invitedAgents.ts`(쿼리·뮤테이션), `apps/web/src/features/conversations/InviteAgentDialog.tsx`
- Modify: `apps/web/src/app/layout/ChannelHeader.tsx`(에이전트 얼굴 줄 — 초대한 에이전트·「초대됨」·「에이전트 초대」·「세션에서 내보내기」), 작성기 멘션 후보를 만드는 자리(`apps/web/src/features/composer/Composer.tsx` 와 그것이 쓰는 후보 훅 — 그 세션의 초대한 에이전트 포함), `apps/web/src/features/composer/AgentSettingsBar.tsx`(초대한 러너 에이전트 줄에 「초대됨」), `apps/web/src/realtime/handlers.ts`(`conversation.agents`)
- Test: 새 `apps/web/src/features/conversations/invitedAgents.test.tsx`, `apps/web/src/features/composer/Composer.mentions.test.tsx`, `apps/web/src/app/layout/layout.test.tsx`, `apps/web/src/realtime/handlers.test.ts`

- [ ] **Step 1:** 시험 — 머리에 초대한 에이전트와 「초대됨」; 「에이전트 초대」 대화상자가 그 채널에 없는·보관되지 않은 에이전트만 보이고 고르면 POST; 「세션에서 내보내기」 DELETE; 멘션 후보에 그 세션의 초대한 에이전트가 있고 **다른 세션에서는 없음**(Review Focus 1); DM·닫힌 세션·새 세션 창에서는 단추 없음; wire 로 다른 사람 화면 반영; 상태 줄의 「초대됨」.
- [ ] **Step 2:** FAIL → **Step 3:** 구현(문구 기준) → **Step 4:** `pnpm -F @dodok/web test` PASS(실행 수) → **Step 5:** 커밋 `feat(web): invite agents to a session`

### Task 6: dev:fake·문서·화면 확인

**Files:** `docs/manual/user-guide.md`(「세션」 절), `docs/guides/agent-guide.md`(참여자의 「초대됨」·세션 초대 줄·릴레이 예외), `docs/guides/project-structure.md`, `docs/guides/docker-deploy.md`(업데이트 절에 마이그레이션 0039 가 필요하면).

- [ ] **Step 1:** 이 워크트리 전용 포트로 dev:fake + 웹, BrowserOS neo(안 붙으면 독립 브라우저 — 보고에 적는다)로: 씨앗 채널 「세션」의 한 세션에 집 Gateway 의 에이전트(`main` 또는 `dev-home`)를 초대 → 그 세션에서 멘션하면 대본 답, 같은 채널의 다른 세션에서는 멘션 후보에 없음·써서 보내도 답 없음, 에이전트 → 초대한 에이전트 릴레이, 내보내기, member(mia) 화면. dev:fake 로그의 인바운드 줄로 참여자·세션 초대 줄을 본다. 탭은 백그라운드로, 연 탭은 닫고, 띄운 것은 끈다.
- [ ] **Step 2:** 문서. 표·`---` 앞 빈 줄.
- [ ] **Step 3:** `pnpm lint`·`pnpm fmt:check`·`pnpm typecheck`·`pnpm exec turbo run test --continue`(실행 수).
- [ ] **Step 4:** 커밋 `docs: session agent invite`
