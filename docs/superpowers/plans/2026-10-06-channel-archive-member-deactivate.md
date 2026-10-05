# 채널 보관·멤버 비활성화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 태스크마다 돈다(`docs/guides/worktree-workflow.md`).

**Goal:** 채널을 지우지 않고 보관·보관 해제하고, 멤버 「내보내기」를 계정을 남기는 비활성화·다시 활성화로 바꾼다.

**Architecture:** 서버는 `channels.archived_at`·`memberships.deactivated_at` 두 열로 상태를 표시하고, 쓰기 경로는 채널 보관을 한 검사 함수로, 요청 인증은 비활성을 「membership 없음」으로 본다. 웹은 에이전트 보관(설정·에이전트 보관·llms.txt 스펙)과 같은 꼴로 거르고 「보관됨」·「비활성」을 붙인다.

**Tech Stack:** Fastify·Drizzle(SQLite)·Socket.IO·Better Auth·Zod(shared) / React·TanStack Router·TanStack Query / Vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-channel-archive-member-deactivate-design.md`

## Global Constraints

- 사용자 문구는 스펙 그대로: 「보관됨」, 「보관된 채널입니다.」, 「보관 해제」, 「채널 보관」, 「#<이름> 을 보관합니다. 기록은 남고 누구나 읽을 수 있으며, 보관 해제하면 그대로 돌아옵니다.」, 「보관된 채널이 없습니다」, 「비활성」, 「비활성화」, 「다시 활성화」, 「비활성 멤버 N」, 「@<핸들> 을 비활성화합니다. 로그인할 수 없게 되고, 쓴 메시지는 남습니다. 다시 활성화하면 그대로 돌아옵니다.」, 「비활성 멤버입니다 — 다시 활성화하세요」, 「비활성화된 계정입니다. 관리자에게 문의하세요.」.
- 새 오류 코드 `CHANNEL_ARCHIVED`(409)·`MEMBER_DEACTIVATED`(로그인 403·초대 409, details `{ userId }`) — shared `ErrorCode`.
- 채널 보관·해제는 admin 이상. 멤버 비활성화·다시 활성화는 지금 내보내기 권한(admin → member, owner → admin, owner 는 대상 아님).
- 새 경로: `POST /api/v1/channels/:id/archive`·`/unarchive`, `POST /api/v1/members/:userId/deactivate`·`/reactivate`. `DELETE /api/v1/members/:userId` 는 없앤다. `GET /api/v1/channels?archived=1`.
- `users.left_handle`·`LEFT_HANDLE_PREFIX`·`leftHandleOf`·shared `Person.leftHandle` 을 걷는다(배포 전 — 데이터 옮기기 없음).
- 마이그레이션은 drizzle-kit 생성 뒤 SQL 을 열어 확인한다(표를 다시 만들면 ON DELETE·FTS 트리거·인덱스가 빠지지 않는지 — `docs/project-structure.md` db 절). 새 열 마이그레이션은 `test/db.test.ts` 의 부분 마이그레이션 테스트로 스키마 객체 INSERT 를 본다.
- 외부 입력은 경계에서 Zod. shared 는 Node 전용 API 금지. 커밋은 경로 명시 stage, Conventional Commits + 패키지 스코프, 트레일러 `Co-Authored-By: <실제 모델명> <noreply@anthropic.com>`.
- 포트 3100·5180·5173·3000 금지. 모델 런 금지. 문서·주석을 고치기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다(스펙 인용은 절 제목으로).

## 계획 판정

- **PC1 — 채널 쓰기 검사는 한 함수다.** `apps/server/src/modules/channels/service.ts` 에 `assertChannelWritable(db, channelId): Channel`(없으면 404, 보관이면 409 `CHANNEL_ARCHIVED`)을 두고 스펙 「보관한 채널에서 서버가 막는 것」의 모든 경로가 이것을 부른다. 태스크 1 이 쓰기 경로를 전수한다(REST·wire·첨부 HTTP).
- **PC2 — 런 관문과 늦은 정본은 에이전트 보관과 같은 자리에서 본다.** 런 관문(`modules/ops/budget.ts`)과 `runs/orchestrator.ts` `onCanonical` 의 보관 가지가 「에이전트 보관 또는 채널 보관」을 함께 본다.
- **PC3 — 비활성은 인증 자리 한곳에서 막는다.** `auth/roles.ts` 의 membership 읽기(요청마다)와 wire 핸드셰이크·로그인이 `deactivated_at` 이 있는 membership 을 없는 것처럼 본다. 역할 판정 함수(`roleOf`)가 비활성이면 `undefined` 를 내는 꼴이 가장 좁다.
- **PC4 — 채널 멤버 읽기 거름은 에이전트 보관과 같은 조회 한곳이다**(사람은 `deactivated_at`, 에이전트는 `archived_at`). 멘션 푸시 수신자와 에이전트 헤더 「참여자:」도 그 결과를 쓴다.
- **PC5 — 마이그레이션 번호.** 태스크 1 은 0016(채널), 태스크 2 는 0017(멤버)을 쓴다. 두 태스크가 병렬이라 나중에 병합되는 쪽은 rebase 뒤 drizzle 저널·스냅숏을 다시 생성해 순서를 맞춘다(생성물 직접 편집 금지).

## Review Focus

1. **보관 중 열린 탭의 쓰기** — 채널을 보관하는 순간 다른 사람이 그 채널 작성기에서 보내던 메시지·누르던 카드는 409 로 막히고, 웹은 「보관된 채널입니다.」로 바뀌어야 한다(오류 토스트가 쌓이지 않게). 테스트: 보관 뒤 wire `message.send` 409 + 웹이 `channel.updated` 를 받아 작성기를 바꾼다.
2. **비활성화 순간의 열린 소켓** — 비활성화 직후 그 사람의 열린 탭이 보내는 wire 요청은 하나도 통과하지 않아야 한다(핸드셰이크를 지나던 소켓 포함). 테스트: 비활성화와 동시에 연결 중인 소켓이 붙지 못함.
3. **다시 활성화 뒤 로그인** — 다시 활성화한 사람은 예전 비밀번호로 곧바로 로그인되고, 비활성 중 폐기된 재설정 링크는 되살아나지 않아야 한다. 테스트: 비활성화 → 재설정 링크 폐기 확인 → 다시 활성화 → 옛 비밀번호 로그인 200 → 옛 링크 404.
4. **검색·결과로 가기** — 보관한 채널의 검색 결과를 누르면 읽기 전용 채널 화면으로 가야 한다(404·빈 화면이 아니라). 테스트: 웹 결과로 가기 + 서버 메시지 목록 200.
5. **비활성 멤버를 겨눈 기록** — 비활성 멤버가 쓴 메시지·멘션 칩이 새로고침·오프라인 사본에서도 「비활성」이고 「알 수 없는 사용자」가 되지 않아야 한다. 테스트: 오프라인 사본 복원 뒤 작성자.

---

### Task 1: 서버 — 채널 보관

**Files:**
- Create: `apps/server/drizzle/0016_channel_archive.sql`(생성 이름을 따른다), `apps/server/test/channels.archive.test.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`, `packages/shared/src/domain/index.ts`(`Channel.archivedAt`), `packages/shared/src/common.ts`(`CHANNEL_ARCHIVED`), `apps/server/src/modules/channels/service.ts`·`routes.ts`, 쓰기 경로(메시지 보내기 wire·카드 상호작용 `modules/components/service.ts`·「새 대화」·첨부 올리기·채널 멤버), `modules/ops/budget.ts`(런 관문), `modules/runs/orchestrator.ts`(보관 때 런 중지·늦은 정본), 푸시 대상(`modules/push/`), 검색 결과(`modules/search/service.ts` — 결과에 `channelArchived`), `apps/server/test/roles.matrix.test.ts`

**Interfaces:**
- Produces: `assertChannelWritable(db, channelId): Channel`, `archiveChannel(deps, id, workspaceId): Promise<Channel>`, `unarchiveChannel(db, id, workspaceId): Channel`, shared `Channel.archivedAt: IsoDateTime | null`, 검색 결과 항목 `channelArchived: boolean`, 오류 `CHANNEL_ARCHIVED`.

- [ ] **Step 1: 실패하는 테스트** — `channels.archive.test.ts`(기존 통합 부트 도우미):
  - admin 보관 200·`archivedAt` 시각·멱등·member 403·없는 id 404, 보관 해제 200·null·멱등.
  - `GET /api/v1/channels` 는 살아 있는 것만, `?archived=1` 은 보관한 것만(member 도 200).
  - 보관 뒤 막히는 것마다 409 `CHANNEL_ARCHIVED`: wire `message.send`(최상위·스레드), 카드 버튼·셀렉트·모달·「다시 실행」(카드 미소비)·「이어가기」, `PATCH /channels/:id`, 멤버 넣기·빼기·멤버 설정, 「새 대화」, 첨부 올리기(그 채널).
  - 보관한 채널의 메시지 목록·스레드·검색은 200(Review Focus 4 서버 쪽), 검색 결과 `channelArchived: true`.
  - 열린 런·대기열 런이 있는 채로 보관 → 모두 닫힘, 걸린 승인 `cancelled`, 보관 뒤 런 0.
  - 보관한 채널의 늦게 온 정본은 저장만(릴레이·푸시 0).
  - 보관·해제마다 workspace 룸 `channel.updated` 한 번.
  - 보관 해제 뒤 멘션이 같은 세션 행으로 런.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/channels.archive.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 스키마·마이그레이션 0016(PC5), shared, PC1 의 `assertChannelWritable` 을 모든 쓰기 경로에(`git grep` 으로 채널 id 를 받는 쓰기 경로 전수), PC2, 라우트, 역할 매트릭스.
- [ ] **Step 4: 통과 확인** — 서버·shared 테스트, 루트 `pnpm typecheck`, `test/db.test.ts` 부분 마이그레이션.
- [ ] **Step 5: 커밋** — `feat(server): archive and unarchive channels`.

### Task 2: 서버 — 멤버 비활성화

**Files:**
- Create: `apps/server/drizzle/0017_member_deactivate.sql`, `apps/server/test/members.deactivate.test.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`(`memberships.deactivatedAt`, `users.leftHandle` 삭제), `packages/shared/src/members/*`·`domain/index.ts`(`Person.deactivatedAt`·`Member.deactivatedAt`, `Person.leftHandle` 삭제), `packages/shared/src/common.ts`(`MEMBER_DEACTIVATED`), `apps/server/src/modules/members/service.ts`(`removeMember` → `deactivateMember`·`reactivateMember`, `leftHandleOf` 삭제)·`manage.routes.ts`·`handles.ts`(`LEFT_HANDLE_PREFIX` 삭제)·`people.ts`·`invites.ts`(같은 이메일 409), `apps/server/src/auth/roles.ts`·`auth/routes.ts`·`auth/index.ts`(PC3, 로그인 403), wire 핸드셰이크(`realtime/socket.ts`), `modules/search/service.ts`(`leftHandle` 걷기), 채널 멤버 읽기·「참여자:」·멘션 푸시(PC4), 기존 내보내기 테스트(`members.manage`·`roles.matrix`)
- Test: `members.deactivate.test.ts`, 바뀐 기존 테스트

**Interfaces:**
- Produces: `deactivateMember(deps, actorId, userId): Promise<void>`, `reactivateMember(deps, actorId, userId): Promise<void>`, shared `Person.deactivatedAt: IsoDateTime | null`, `Member.deactivatedAt: IsoDateTime | null`, 오류 `MEMBER_DEACTIVATED`.

- [ ] **Step 1: 실패하는 테스트** — `members.deactivate.test.ts`:
  - 권한: admin → member 200, admin → admin 403, owner → admin 200, owner 대상 403, 멱등, 없는 id 404. 다시 활성화도 같은 표.
  - 비활성화 뒤: 그 사람 세션 0·열린 소켓 끊김·푸시 구독 0·발급하거나 겨눈 쓰이지 않은 링크 폐기, 그 세션 쿠키 다음 REST 401, 비활성화 순간 핸드셰이크 중인 소켓 거절(Review Focus 2).
  - 로그인: 맞는 비밀번호 403 `MEMBER_DEACTIVATED`, 틀린 비밀번호는 지금 실패 응답 그대로(본문 비교).
  - 초대: 같은 이메일 409 `MEMBER_DEACTIVATED` details `{ userId }`.
  - 채널 멤버 응답·「참여자:」에서 빠지고 행은 남음, 그 사람 멘션 푸시 0, `GET /members`·people 에 `deactivatedAt`.
  - 다시 활성화: 옛 비밀번호 로그인 200, 역할·채널 참여 복귀, 비활성 중 폐기된 재설정 링크는 404 그대로(Review Focus 3).
  - `DELETE /api/v1/members/:userId` 404(경로 없음), `left-` 핸들 가입이 이제 허용(예약 없음), DB 에 `left_handle` 열 없음.
  - `people.changed` 가 비활성화·다시 활성화마다.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/members.deactivate.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 마이그레이션 0017(열 삭제는 표 재생성 — SQL 확인, PC5), PC3·PC4, Better Auth 는 세션만 지우고 사용자·계정은 남긴다, 기존 내보내기 테스트를 비활성화로 옮긴다.
- [ ] **Step 4: 통과 확인** — 서버·shared 테스트, 루트 `pnpm typecheck`(웹이 `Person.leftHandle` 을 쓰면 typecheck 가 깨진다 — 웹의 그 자리는 태스크 4 몫이므로 이 태스크는 웹을 최소로: 컴파일만 되게 `deactivatedAt` 으로 바꾸고 문구는 그대로 둔다. 보고서에 자리 목록).
- [ ] **Step 5: 커밋** — `feat(server): deactivate and reactivate members instead of removing them`.

### Task 3: 웹 — 채널 보관 화면

**Files:**
- Create: `apps/web/src/features/settings-shell/ChannelsPage.tsx`(+ 테스트), 보관 채널 배너·작성기 대체 컴포넌트
- Modify: 사이드바 채널 목록(`features/channels/ChannelList.tsx`), 채널 화면·작성기·스레드 패널·카드(비활성 사유 「보관된 채널입니다」), 채널 설정 패널(「채널 보관」·확인 대화상자), `features/settings-shell/tabs.ts`(채널 탭 — 누구나), 라우터(`/settings/channels`), 검색 결과(「보관됨」), `realtime/handlers.ts`(`channel.updated` 의 `archivedAt`), API 클라이언트(`archiveChannel`·`unarchiveChannel`·보관 목록), 오류 문구(`CHANNEL_ARCHIVED`)

**Interfaces:**
- Consumes: 태스크 1 의 경로·`Channel.archivedAt`·`channelArchived`·`CHANNEL_ARCHIVED`.

- [ ] **Step 1: 실패하는 테스트** — 사이드바에 보관한 채널 없음, 보관한 채널 화면 「보관됨」·작성기 자리 「보관된 채널입니다.」·admin 에게만 「보관 해제」, 카드 단추 비활성, 「새 대화」·설정 편집 숨김, 스레드 읽기 전용, 설정 패널 「채널 보관」(admin 만)·확인 문구·연속 클릭 한 번, 「설정 → 채널」 탭 목록·빈 문구·admin 「보관 해제」, 검색 「보관됨」·결과로 가기가 읽기 전용 화면(Review Focus 4), 열린 채널이 `channel.updated` 로 보관되면 작성기가 바뀌고 오류 토스트 없음(Review Focus 1).
- [ ] **Step 2~4:** 실패 확인 → 구현 → 웹 테스트·typecheck·lint·웹 빌드.
- [ ] **Step 5: 커밋** — `feat(web): archive channels and read them in place`.

### Task 4: 웹 — 멤버 비활성화 화면

**Files:**
- Modify: `features/members/MembersPage.tsx`·`MemberRowActions.tsx`(「비활성화」·확인 문구·「비활성 멤버 N」·「다시 활성화」), 초대(`MEMBER_DEACTIVATED` → 안내·그 줄 링크), 로그인 화면(문구), 작성자·멘션 칩(「나간 멤버 @옛핸들」 → 이름 + 「비활성」, 접근 이름 `@핸들 (비활성)` — 에이전트 「삭제됨」 태그 컴포넌트와 같은 꼴), `features/messages/useAuthors.ts`·`people` 처리, 멘션 후보·채널 멤버 줄 거름, `features/composer/mentions.ts`, 오프라인 사본 복원
- Test: 각 화면 테스트, `people.test.tsx`, `offline.test.tsx`(Review Focus 5)

**Interfaces:**
- Consumes: 태스크 2 의 경로·`Person.deactivatedAt`·`Member.deactivatedAt`·`MEMBER_DEACTIVATED`.

- [ ] **Step 1: 실패하는 테스트** — 멤버 탭 「비활성화」 확인 문구·호출 한 번, 권한별 단추(admin 은 member 줄만, owner 는 admin 까지, owner 줄 없음), 「비활성 멤버 N」 접힘·「다시 활성화」, 초대 409 안내·링크, 로그인 403 문구, 기록 작성자·멘션 칩 「비활성」·접근 이름, 멘션 후보·채널 멤버 줄에 없음, 오프라인 사본 뒤에도 「비활성」, 「나간 멤버」 문구가 소스에 남지 않음.
- [ ] **Step 2~4:** 실패 확인 → 구현 → 웹 테스트·typecheck·lint·웹 빌드.
- [ ] **Step 5: 커밋** — `feat(web): deactivate and reactivate members`.

### Task 5: dev:fake 브라우저 검증 (검증 워커 — 코드를 고치지 않는다)

- [ ] owner·admin·member, 탭 둘: 채널 보관 → 다른 탭 사이드바·열린 채널 읽기 전용(Review Focus 1) → 검색 결과로 가기 → 「설정 → 채널」 → 보관 해제 → 사이드바 복귀·멘션 런. member(mia) 비활성화 → mia 의 열린 탭이 로그인 화면 → mia 로그인 「비활성화된 계정입니다…」 → 기록 「비활성」 → 같은 이메일 초대 409 안내 → 다시 활성화 → 같은 비밀번호 로그인·채널 복귀. 390px. 콘솔 오류. 보고서·스크린샷.

### Task 6: 문서

- [ ] `docs/guides/deploy.md` 「멤버 초대·비밀번호 재설정·내보내기」 절을 비활성화로(절 제목 포함 — 이 제목을 인용하는 자리를 `git grep` 으로 함께), 채널 보관 운영 줄. `docs/guides/user-guide.md`(채널 보관·설정 → 채널·멤버 비활성화·「비활성」), `docs/project-structure.md`(서버·웹 새 자리, `left-` 걷음), `docs/guides/agent-guide.md`(「참여자:」에서 비활성 멤버가 빠짐 — 해당 절이 있으면), 스펙 끝 「구현과 맞춘 것」 장(PC1~PC5·원장 Ruling). `pnpm fmt:check`, 문서 대조 테스트 실행 수.

## 순서

A 태스크 1 ‖ 태스크 2 → B 태스크 3(1 병합 뒤) ‖ 태스크 4(2 병합 뒤) → C 태스크 5 → D 태스크 6.
태스크 1·2 는 shared `common.ts`·`domain/index.ts`·스키마·마이그레이션 저널이 겹친다 — 나중 쪽이 rebase 하고 PC5 대로 다시 생성한다.

## Self-Review

- 스펙 「채널 보관」 데이터·API·막는 것·서버 동작 → 태스크 1, 웹 → 태스크 3. 「멤버 비활성화」 데이터·API·서버 동작·기록 → 태스크 2, 웹 → 태스크 4. 「오류」 표 → 태스크 1·2 테스트. 「테스트·검증」 브라우저 → 태스크 5. 「완료 기준」 3(문서) → 태스크 6.
- 이름 대조: `assertChannelWritable`·`archiveChannel`·`unarchiveChannel`·`deactivateMember`·`reactivateMember`·`CHANNEL_ARCHIVED`·`MEMBER_DEACTIVATED`·`Channel.archivedAt`·`Person.deactivatedAt`·`Member.deactivatedAt`·`channelArchived` 가 태스크 사이에 같다.
