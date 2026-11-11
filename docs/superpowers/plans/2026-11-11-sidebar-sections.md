# 사이드바 개인 섹션 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사람마다 채널·DM 을 개인 섹션으로 묶어 사이드바에 보이고, 메뉴와 끌어다 놓기로 넣고 빼고 순서를 바꾼다.

**Architecture:** 사람마다 배치 한 벌(`user_sidebar_layouts.layout_json`)을 서버에 두고 `GET/PUT /api/v1/me/sidebar` 로 통째로 읽고 쓴다. 저장하면 wire user 룸 `me.sidebar` 로 그 사람의 다른 탭에 보낸다. 웹은 섹션을 기본 두 절 위에 그리고, 항목은 지금의 채널·DM 링크 컴포넌트를 그대로 쓴다. 끌어다 놓기는 `@dnd-kit`.

**Tech Stack:** Zod, Fastify·drizzle·better-sqlite3, Socket.IO, React·TanStack Query, `@dnd-kit/core`·`@dnd-kit/sortable`.

**Spec:** `docs/superpowers/specs/2026-11-11-sidebar-sections-design.md` — 결정 B1~B9.

## Global Constraints

- 섹션 ≤ 50, 이름 trim 뒤 1~40자, 항목 id 는 섹션 사이에서도 중복 금지(B2·B8).
- 배치는 그 사람만 읽고 쓴다(B4). 남의 배치를 읽는 길이 없어야 한다.
- PUT 은 지금 읽을 수 없는 채널 id 를 **지우지 않는다**(B7). DB 에 없는(삭제된) 채널 id 만 걷는다.
- 새 의존성은 정확 핀, 출시 2주 넘은 판(`pnpm-workspace.yaml` 의 `minimumReleaseAge`).
- 화면 문구는 라벨·단추만(2026-11-10 문구 기준).
- 경로 명시 stage, Conventional Commits.

## Review Focus

1. **배치에 있던 채널을 보관·접근 잃음 뒤 되살리면 원래 섹션 자리에 돌아온다** — 그 사이 PUT(다른 항목 옮기기)이 그 id 를 지우지 않는다. (Task 2 시험, Task 4 시험)
2. **섹션에 넣은 항목이 기본 절에서 빠지고, 섹션에서 빼거나 섹션을 지우면 기본 절의 지금 순서 자리로 돌아온다** — 어디에도 안 보이는 순간이 없다. (Task 4 시험)
3. **접힌 섹션 안의 안 읽은 채널은 섹션 머리에 표시되고, 읽으면 사라진다.** (Task 4 시험)
4. **PUT 이 실패하면(네트워크·400) 화면이 저장 전 배치로 돌아오고 토스트가 뜬다.** (Task 4 시험)
5. **두 탭: 한 탭의 저장이 wire 로 다른 탭 사이드바를 바꾼다; 끌기 중인 탭은 끌기가 끝난 뒤 받는다(끌던 항목이 손에서 사라지지 않는다).** (Task 4 시험)

---

### Task 1: shared 계약

**Files:** Create `packages/shared/src/sidebar/index.ts`(내보내기 `packages/shared/src/index.ts`), Modify `packages/shared/src/wire/index.ts`(서버→클라이언트 `me.sidebar`). Test: 새 `packages/shared/test/sidebar.test.ts`.

**Interfaces — Produces:**
- `SidebarSection = z.object({ id: Id, name: z.string().trim().min(1).max(40), collapsed: z.boolean(), items: z.array(Id).max(1000) })`
- `SidebarLayout = z.object({ sections: z.array(SidebarSection).max(50) })` + refine: 섹션 id 중복 금지, 항목 id 전체 중복 금지
- `EMPTY_SIDEBAR_LAYOUT: SidebarLayout = { sections: [] }`
- wire `"me.sidebar": (p: { layout: SidebarLayout }) => void`

- [ ] **Step 1:** 시험 — 51번째 섹션 거절, 이름 공백만 거절, 41자 거절, 두 섹션에 같은 채널 거절, 같은 섹션 id 둘 거절, 정상 배치 통과.
- [ ] **Step 2:** `pnpm -F @dodok/shared test` FAIL → **Step 3:** 구현 → **Step 4:** PASS·`pnpm typecheck` → **Step 5:** 커밋 `feat(shared): sidebar layout contract`

### Task 2: 서버 저장·REST·wire

**Files:** Modify `apps/server/src/db/schema.sqlite.ts`(표 `userSidebarLayouts`), Create `apps/server/drizzle/0038_user_sidebar_layouts.sql`(+meta — 이웃 꼴), Create `apps/server/src/modules/sidebar/routes.ts`·`apps/server/src/modules/sidebar/store.ts`, Modify `apps/server/src/app.ts`(등록), `apps/server/src/realtime/events.ts`(user 룸 `me.sidebar` — `me.status` 꼴). Test: 새 `apps/server/test/sidebar.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`(새 라우트 줄).

**Interfaces — Produces:**
- `getSidebarLayout(db, userId): SidebarLayout`(행 없으면 `EMPTY_SIDEBAR_LAYOUT`)
- `saveSidebarLayout(db, userId, layout): SidebarLayout` — DB 에 없는 채널 id 를 걷어 저장하고 그 결과를 돌려준다
- `GET /api/v1/me/sidebar` → `SidebarLayout`; `PUT /api/v1/me/sidebar` 본문 `SidebarLayout` → 저장한 `SidebarLayout` + bus 이벤트 → user 룸 `me.sidebar`
- 로그인한 누구나(member 포함), 비활성 멤버는 지금 인증 규칙대로 막힘

- [ ] **Step 1:** 시험 — 처음 GET 빈 배치; PUT 뒤 GET 같은 값; PUT 이 그 사람 user 룸에만 `me.sidebar` 하나; 다른 사람의 GET 은 자기 것(섞이지 않음); 남의 DM id·보관 채널 id 를 넣은 PUT 은 200 이고 그 id 를 **유지**(Review Focus 1); 없는 채널 id 는 걷힘; 상한 위반 400; 로그인 없음 401. roles.matrix 줄.
- [ ] **Step 2:** FAIL → **Step 3:** 구현(이웃 모듈 꼴, 경계 Zod) → **Step 4:** `pnpm -F @dodok/server test` PASS(실행 수)·`pnpm typecheck` → **Step 5:** 커밋 `feat(server): personal sidebar layout`

### Task 3: 웹 — 섹션 그리기·메뉴

**Files:** Create `apps/web/src/features/sidebar/queries.ts`(GET·PUT 뮤테이션·낙관적 갱신·실패 되돌림), `apps/web/src/features/sidebar/SidebarSections.tsx`, `apps/web/src/features/sidebar/SectionHeader.tsx`, `apps/web/src/features/sidebar/MoveToSectionMenu.tsx`, `apps/web/src/features/sidebar/layout.ts`(순수 함수 — 아래). Modify `apps/web/src/app/layout/Sidebar.tsx`(섹션을 두 절 위에), `apps/web/src/features/channels/ChannelList.tsx`·`apps/web/src/features/dms/DmSection.tsx`(섹션에 든 id 를 빼고 그리기; 링크 컴포넌트 `ChannelLink`·`DmLink` 를 섹션에서 쓰도록 내보내기 — 동작은 그대로), `apps/web/src/realtime/handlers.ts`(`me.sidebar`). Test: 새 `apps/web/src/features/sidebar/sidebar.test.tsx`, 새 `apps/web/src/features/sidebar/layout.test.ts`, `apps/web/src/app/layout/layout.test.tsx`, `apps/web/src/features/channels/channels.test.tsx`, `apps/web/src/features/dms/dms.test.tsx`.

**Interfaces — Produces(`layout.ts`, 순수):**
- `moveItem(layout, itemId, to: { sectionId: string; index: number } | null): SidebarLayout` — null 이면 섹션에서 뺀다
- `addSection(layout, name, id): SidebarLayout`, `renameSection(layout, id, name)`, `removeSection(layout, id)`, `moveSection(layout, id, index)`, `setCollapsed(layout, id, collapsed)`
- `sectionedIds(layout): Set<string>`

- [ ] **Step 1:** 시험 — layout 순수 함수 각각; 화면: 섹션이 두 절 위에 그려지고 섹션에 든 채널이 「채널」 절에서 빠짐; 메뉴로 넣기·다른 섹션으로·빼기·새 섹션; 섹션 지우면 기본 절로(Review Focus 2); 보관 채널 id 는 그리지 않음; 접힌 섹션의 안 읽은 표시(Review Focus 3); PUT 실패 되돌림·토스트(Review Focus 4); wire `me.sidebar` 반영; 「⋯」 이름 바꾸기·위·아래·지우기.
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** `pnpm -F @dodok/web test` PASS → **Step 5:** 커밋 `feat(web): personal sidebar sections with menus`

### Task 4: 웹 — 끌어다 놓기

**Files:** Modify `apps/web/package.json`(`@dnd-kit/core`·`@dnd-kit/sortable`·필요하면 `@dnd-kit/utilities` 정확 핀), `pnpm-lock.yaml`, `apps/web/src/features/sidebar/SidebarSections.tsx`, `apps/web/src/app/layout/Sidebar.tsx`(DndContext 를 섹션·두 절을 감싸게), Create `apps/web/src/features/sidebar/dnd.tsx`(센서·충돌 판정·announcements 한국어). Test: `apps/web/src/features/sidebar/sidebar.test.tsx`.

**Interfaces — Consumes:** Task 3 의 `moveItem`·`moveSection`. 놓으면 그 결과로 Task 3 뮤테이션 하나.

- [ ] **Step 1:** 시험(키보드 센서로 — jsdom 에서 포인터 끌기는 흉내가 약하다): 항목을 다른 섹션으로·같은 섹션 안 순서·기본 절로(=빼기)·섹션 순서; 끌기 중 `me.sidebar` 가 오면 놓은 뒤 반영(Review Focus 5); 안내 문구가 스크린 리더 라이브 영역에.
- [ ] **Step 2:** FAIL → **Step 3:** 구현 — 터치는 길게 누르기(지연 센서), 링크 클릭과 끌기가 갈리게 활성 거리. **Step 4:** PASS → **Step 5:** 커밋 `feat(web): drag and drop for sidebar sections`

### Task 5: dev:fake·문서·화면 확인

**Files:** `docs/manual/user-guide.md`(「화면 구성」 또는 새 「섹션」 절), `docs/guides/project-structure.md`(sidebar 모듈), `docs/guides/docker-deploy.md`(업데이트 절에 마이그레이션 0038 이 필요하면).

- [ ] **Step 1:** 이 워크트리 전용 포트로 dev:fake + 웹, BrowserOS neo(안 붙으면 독립 브라우저 — 보고에 적는다)로: 섹션 만들기·메뉴 옮기기·마우스 끌기·키보드 끌기·좁은 화면 시트에서 길게 눌러 끌기·두 탭 반영·새로고침 뒤 유지·member(mia)와 owner 의 배치가 섞이지 않음. 탭은 백그라운드로, 연 탭은 닫고, 띄운 것은 끈다.
- [ ] **Step 2:** 문서. 표·`---` 앞 빈 줄.
- [ ] **Step 3:** `pnpm lint`·`pnpm fmt:check`·`pnpm typecheck`·`pnpm exec turbo run test --continue`(실행 수).
- [ ] **Step 4:** 커밋 `docs: sidebar sections`
