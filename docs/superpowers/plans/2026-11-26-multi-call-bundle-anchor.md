# 답 묶음을 「여럿을 부른 글」 아래에 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 답 묶음의 루트를 「체인을 시작한 사람 글」에서 「서로 다른 에이전트 2명 이상을 실제로 부른 글(작성자 무관)」로 바꾸고, 묶음 줄 안의 글이 다시 여럿을 부르면 중첩 묶음으로, 스레드 패널의 루트 아래에도 그 묶음을 보인다.

**Architecture:** 묶는 키를 런의 `triggerMessageId`(없으면 `rootMessageId`)로 바꾼다. `computeBundles` 가 런마다 「부른 글」을 앵커로 삼아 묶음 루트(2명 이상) 또는 「부른 글의 자리를 따라감」(1명)으로 나누고, 그 결과를 평평한 `Map<rootId, Bundle>` 로 낸다 — 바깥 묶음 줄 안의 루트도 같은 맵에 들어가고, `Lane` 이 줄 안 메시지마다 그 맵을 보고 하위 묶음을 그린다. 서버는 `rootRuns` 를 에이전트 글에도, 「그 글이 부른 런」 기준으로 싣는다.

**Tech Stack:** TypeScript, React 19 + TanStack Query/Router + zustand(web), Fastify + drizzle-orm/SQLite(server), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-multi-call-bundle-anchor-design.md`(바꾸는 설계 `docs/superpowers/specs/2026-11-24-multi-agent-reply-bundle-design.md` 도 읽는다)

## Global Constraints

- 묶음 루트 = `kind: "normal"` 이고 (`threadRootId` 없음 또는 `alsoInChannel === true`) 이며 작성자가 `user` 또는 `agent` 인 글 중, 그 글을 앵커로 한 런의 에이전트가 **서로 다른 2명 이상**(진행 중 포함). 멘션 수는 보지 않는다.
- 런의 앵커 = `triggerMessageId`, 없으면 `rootMessageId`.
- 앵커가 묶음 루트가 아니면(1명) 그 런의 메시지는 **앵커 글이 있는 자리**를 따른다: 앵커가 메인이면 메인, 앵커가 어떤 줄 안이면 그 줄 안(seq 순).
- 서버·wire·shared 스키마의 필드 이름·꼴은 바꾸지 않는다(`Message.rootRuns`·`runRoot`·`RunState` 그대로). 바뀌는 것은 서버가 `rootRuns` 를 붙이는 대상과 고르는 런뿐.
- 스레드 패널 안의 스레드 답글은 묶지 않는다 — 패널에는 루트 글의 묶음 하나만 더한다.
- 커밋: 경로를 명시해 stage, Conventional Commits(`feat(web): …`, `feat(server): …`), 메시지 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다.

## Review Focus

1. **늦게 불린 루트** — 앵커 글이 아직 `items` 에 없는(위로 안 불린) 런: 묶지 않고 메인 자기 자리에 그린다(지금 규칙). Task 2 시험 `앵커가 items 에 없으면 메인에 남는다`.
2. **1명 릴레이가 2명이 되는 순간** — 줄 안 글이 처음엔 1명을 불렀다가 둘째 런이 생기면 그 글이 하위 묶음 루트로 바뀐다. 줄 안에 따라가던 메시지가 하위 묶음으로 옮겨 가고 바깥 묶음 줄 수는 그대로. Task 2 시험 `줄 안 글이 둘째 런을 얻으면 하위 묶음`.
3. **순환·자기 참조 방어** — 앵커 사슬을 위로 따라갈 때 깊이 상한(32)과 방문 집합. 깨진 데이터(앵커가 자기 런의 메시지)에서도 무한 루프 없이 메인. Task 2 시험 `앵커 사슬 순환은 메인`.
4. **결과로 가기 중첩** — 하위 묶음 안 메시지로 점프하면 바깥 줄 → 하위 줄 순서로 펼치고 그 메시지를 강조. Task 3 시험.
5. **스레드 패널을 바로 연 경우** — 세션 타임라인 캐시에 그 루트의 답이 없으면(딥링크로 스레드만 연 경우) 묶음을 그리지 않거나 rootRuns 로 줄만 세운다 — 오류·빈 상자 없이. Task 4 시험 `세션 캐시가 없으면 rootRuns 로 줄만`.

---

### Task 1: 서버 — `rootRuns` 를 「그 글이 부른 런」으로, 에이전트 글에도

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts`(`canRootRuns`, `withRootRuns`)
- Modify: `apps/server/src/db/schema.sqlite.ts`(runs 인덱스 `runs_trigger` on `triggerMessageId`)
- Create: `apps/server/drizzle/0046_*.sql` + `meta` 갱신 — `pnpm -F @dodok/server db:generate` 로 만든다(손으로 쓰지 않는다)
- Test: `apps/server/test/messages.service.test.ts`, `apps/server/test/messages.threads.test.ts`(기존 rootRuns 단언이 바뀌면)

**Interfaces:**
- Produces: `Message.rootRuns` 가 붙는 글 = 사람 또는 에이전트의 보통 글(최상위 또는 채널에도 보낸 답글). 내용 = `triggerMessageId` 가 그 글인 런 + (`triggerMessageId` 가 null 이고 `rootMessageId` 가 그 글인 런). 글마다 `ROOT_RUNS_MAX` 상한·런 id 순은 그대로.

- [ ] **Step 1: 실패하는 시험** — `messages.service.test.ts` 에:
  - `에이전트 글이 부른 런 둘이 그 에이전트 글의 rootRuns 에 실린다` — owner 글 → 런 A(trigger=owner 글) → A 의 에이전트 글 → 런 B·C(trigger=A 글, root=owner 글). 단언: owner 글 `rootRuns` 의 runId = `[A]`, A 글 `rootRuns` 의 runId = `[B, C]`.
  - `trigger 없는 런은 root 글에 실린다` — `triggerMessageId: null`, `rootMessageId` = 사람 글 → 그 글의 `rootRuns` 에 있다.
- [ ] **Step 2:** `pnpm -F @dodok/server exec vitest run test/messages.service.test.ts` — 새 시험 FAIL.
- [ ] **Step 3:** `canRootRuns` 에서 `authorType === "user"` 조건을 `"user" | "agent"` 로 넓히고, `withRootRuns` 질의를 `triggerMessageId IN ids OR (triggerMessageId IS NULL AND rootMessageId IN ids)` 로, 묶는 키를 `triggerMessageId ?? rootMessageId` 로. 스키마에 `index("runs_trigger").on(t.triggerMessageId)` 를 더하고 `db:generate`. 주석의 「사람 최상위 글」 문구를 새 기준으로 고친다(웹 `bundles.ts canRoot` 와 같은 조건이라는 문장 유지).
- [ ] **Step 4:** `pnpm -F @dodok/server test` — 전부 통과, 실행 수를 보고에 적는다. 기존 rootRuns 시험이 체인 전체를 기대하면 새 기준으로 고친다(고친 시험 이름을 보고에 적는다).
- [ ] **Step 5: Commit** — `feat(server): attach rootRuns by trigger message, agent messages included`

### Task 2: 웹 — `computeBundles` 를 앵커 기준·중첩으로

**Files:**
- Modify: `apps/web/src/features/messages/bundles.ts`
- Test: `apps/web/src/features/messages/bundles.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `rootRuns` 의미(그 글이 부른 런). `BundleRun.triggerMessageId`, `Message.runRoot.triggerMessageId` 는 이미 있다.
- Produces:
  - `computeBundles(items, runs): Map<string, Bundle>` — 시그니처 그대로. 맵에는 **모든 깊이**의 묶음 루트가 든다.
  - `BundleLane` 에 `followRunIds: string[]` 추가 — 그 줄 안 글을 앵커로 따라온 1명 런들(그 줄의 버블·「결과로 가기」에 쓴다). `messageIds`·`systemIds` 에는 따라온 런의 메시지도 seq 순으로 섞여 든다. 단, 하위 묶음 루트가 된 줄 안 글의 **하위 묶음 메시지는 넣지 않는다**(하위 묶음이 가진다).
  - `Bundle` 에 `parent?: { rootId: string; runId: string }` 추가 — 하위 묶음이면 그 루트 글이 든 바깥 묶음·줄.
  - `bundleIndex(bundles)` — `byMessage`·`byRun` 이 **가장 바깥** 묶음 rootId 를 가리킨다(groupRows 가 메인에서 뺄 것을 안다). 하위 묶음 루트 글 자신도 `byMessage` 에 든다(바깥 줄 안에 있으므로).
  - 새 `bundlePath(bundles, messageId): { rootId: string; runId: string }[]` — 바깥부터 그 메시지가 든 줄까지. 없으면 빈 배열. 묶음 꼬리 시스템 글(`tailSystemIds`)은 줄이 없으므로 그 묶음에 이르는 바깥 경로까지만 돌려준다(꼬리 판정은 지금처럼 `useJump` 가 `tailSystemIds.includes` 로).
  - `laneOfMessage` 는 그대로 두되 `followRunIds` 의 메시지도 찾는다(이미 `messageIds` 에 있으므로 변경 없음을 확인만).
  - `canRoot` 에서 `authorType === "user"` 제한을 뺀다(`user` 또는 `agent`).

- [ ] **Step 1: 실패하는 시험** — `bundles.test.ts` 에 새 `describe("computeBundles — 부른 글 기준(2026-11-26)")`:
  - `사람 → 1명, 그 답 → 6명: 묶음 루트는 에이전트 답` — 결과 맵 키 = `[에이전트 글 id]`, 줄 6개, 사람 글 키 없음, `bundleIndex.byMessage` 에 에이전트 글 없음(메인에 남는다).
  - `사람이 2명을 부르면 지금처럼 사람 글이 루트`.
  - `1명 릴레이는 앵커 자리를 따른다(메인)` — 사람 → A, A 글 → B(1명): 맵 비어 있음.
  - `줄 안 글이 1명을 부르면 그 줄에 따라 들어간다` — 사람 → A·B, A 글 → C: 묶음 1개, A 줄의 `messageIds` = [A 글, C 글](seq 순), `followRunIds` = [C 런], 줄 수 2.
  - `줄 안 글이 2명을 부르면 하위 묶음` — 사람 → A·B, A 글 → C·D: 맵 키 둘, 하위의 `parent` = `{ rootId: 사람 글, runId: A 런 }`, A 줄의 `messageIds` 에 C·D 글 없음, `bundleIndex.byMessage.get(C 글) === 사람 글 id`.
  - `줄 안 글이 둘째 런을 얻으면 하위 묶음`(Review Focus 2) — 같은 입력에 D 런만 더해 전후 비교.
  - `bundlePath 는 바깥부터` — C 글 → `[{사람 글, A 런}, {A 글, C 런}]`.
  - `앵커가 items 에 없으면 메인에 남는다`(Review Focus 1).
  - `앵커 사슬 순환은 메인`(Review Focus 3) — 런 X 의 trigger 가 X 자신의 메시지.
  - `trigger 없는 런은 rootMessageId 를 앵커로`.
  - `relay_limit 은 sourceRunId 런의 글 자리` — 그 글이 묶음 루트면 그 묶음 `tailSystemIds`, 줄 안이면 그 줄 `systemIds`, 메인이면 묶음 없음.
  - 기존 시험 중 새 기준과 어긋나는 것(`1명만 불렀어도 릴레이로 둘째가 답하면 묶는다`, `에이전트 글이 루트면 묶지 않는다`)은 새 기대로 고치고 이름도 바꾼다.
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/features/messages/bundles.test.ts` — FAIL.
- [ ] **Step 3:** 구현. 알고리즘:
  1. 런 초안(지금 `drafts`)을 세우되 각 초안에 `anchorId = triggerMessageId ?? rootId` 를 둔다(`rootRuns` 에서 온 런은 그 글이 앵커).
  2. 앵커별 서로 다른 에이전트 수로 묶음 루트 집합 R 을 정한다(앵커가 `items` 에 있고 `canRoot`).
  3. R 에 들지 않는 런은 「따라감」. 각 메시지(그리고 따라간 런)의 자리를 정하는 `placeOf(messageId)` — 메시지의 런의 앵커를 위로 따라가며 처음 만나는 R 의 앵커가 그 런의 줄이 된다. 앵커가 메인 글이면 메인. 방문 집합·깊이 32 로 끊는다.
  4. R 의 각 루트에 대해 줄을 세우고(지금 lane 규칙 그대로), 따라간 런은 자리 줄의 `followRunIds`·`messageIds`·`systemIds` 에 더한다. 하위 루트의 `parent` 는 그 루트 글 자신의 자리.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/messages/` — 통과(`groupRows.test.ts` 포함), 실행 수 보고.
- [ ] **Step 5: Commit** — `feat(web): anchor reply bundles on the message that called the agents`

### Task 3: 웹 — 줄 안 하위 묶음·따라온 런의 버블·결과로 가기

**Files:**
- Modify: `apps/web/src/features/messages/ReplyBundle.tsx`(`ReplyBundle`·`Lane` — 줄 안 메시지 뒤에 하위 `ReplyBundle`, `followRunIds` 의 버블)
- Modify: `apps/web/src/features/messages/MessageList.tsx`(`bundleView` 에 전체 `bundles` 맵 전달)
- Modify: `apps/web/src/features/messages/useJump.ts`(`laneOfMessage` 대신 `bundlePath` 로 바깥부터 펼침)
- Modify: `apps/web/src/features/messages/bundleExpansion.ts`(펼침 키가 rootId+runId 로 이미 구분되면 변경 없음 — 확인)
- Test: `apps/web/src/features/messages/ReplyBundle.test.tsx`, `apps/web/src/features/messages/groupRows.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `Bundle.parent`, `BundleLane.followRunIds`, `bundlePath`.
- Produces: `ReplyBundleProps` 에 `bundles: ReadonlyMap<string, Bundle>` 추가(하위 묶음을 찾는다). 하위 `ReplyBundle` 은 바깥과 같은 props 를 받는다.

- [ ] **Step 1: 실패하는 시험** — `ReplyBundle.test.tsx`:
  - `펼친 줄 안 글이 하위 묶음 루트면 그 글 아래에 하위 묶음 group` — 바깥 줄을 펼치면 `role="group"` 이름 「@c·@d 답」이 A 글 다음에 있다.
  - `따라온 런이 스트리밍 중이면 그 줄 안에 버블` — `bubbleRunIds` 에 C 런.
  - `하위 묶음 안 메시지로 결과로 가기 → 바깥 줄과 하위 줄이 펼쳐지고 강조`(Review Focus 4).
  - `groupRows.test.ts`: `하위 묶음 메시지·따라온 런의 버블은 메인 행에 없다`.
- [ ] **Step 2:** 해당 시험 FAIL 확인.
- [ ] **Step 3:** 구현. 하위 묶음은 바깥과 같은 컴포넌트를 들여쓰기만 줄여(`ml-16` 대신 줄 안 기준 작은 왼쪽 여백) 그린다 — 스타일은 기존 토큰 안에서 빌더 판단. 접근성 이름 규칙은 그대로.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/messages/` 통과, 실행 수 보고.
- [ ] **Step 5: Commit** — `feat(web): nested reply bundles inside a lane`

### Task 4: 웹 — 스레드 패널 루트 아래 묶음

**Files:**
- Modify: `apps/web/src/features/messages/MessageList.tsx`(스레드 모드에서 `NO_BUNDLES` 대신 루트 하나의 묶음)
- Modify: `apps/web/src/features/messages/groupRows.ts`(필요하면 — 스레드 모드에서도 루트 뒤 bundle 행)
- Test: `apps/web/src/features/threads/threads.test.tsx`

**Interfaces:**
- Consumes: `computeBundles`, 세션 타임라인 캐시(메인 목록이 쓰는 같은 쿼리 키), 런 저장소.
- Produces: 스레드 패널에서 루트 글 바로 뒤 `ReplyBundle`(그 루트가 묶음 루트일 때만). 묶음 줄의 메시지는 세션 타임라인 캐시의 것 — 스레드 타임라인에 섞지 않는다.

- [ ] **Step 1: 실패하는 시험** — `threads.test.tsx`:
  - `묶음 루트 글의 스레드를 열면 루트 아래 묶음, 그 밑에 스레드 답글` — DOM 순서: 루트 글 → `role="group"` → 첫 스레드 답글.
  - `세션 캐시가 없으면 rootRuns 로 줄만`(Review Focus 5) — 세션 타임라인 캐시 없이 루트 글의 `rootRuns` 만 → 줄은 서고 미리보기 없이 상태 문구, 오류 없음.
  - `묶음 루트가 아닌 글의 스레드에는 묶음 없음`.
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현 — 스레드 모드는 `computeBundles([root, ...세션 캐시 items], runs)` 에서 `rootId` 의 묶음(과 그 하위 묶음들)만 쓴다. 세션 캐시는 읽기만(`getQueryData`/구독) — 새 요청을 내지 않는다.
- [ ] **Step 4:** `pnpm -F @dodok/web test` 통과, 실행 수 보고.
- [ ] **Step 5: Commit** — `feat(web): show the reply bundle under the root in the thread panel`

### Task 5: 문서·전체 검증·화면 확인

**Files:**
- Modify: `docs/manual/user-guide.md`(묶음 단락 — 「여럿을 부른 글 아래에 묶인다, 사람이든 에이전트든」, 중첩, 스레드 패널)
- Modify: `docs/superpowers/specs/2026-11-24-multi-agent-reply-bundle-design.md`(머리에 「묶음 기준은 2026-11-26 설계가 바꿨다」 한 줄)
- Modify: `docs/guides/plan.md` 8장 완료 항목에 한 줄(기존 묶음 항목 옆)

- [ ] **Step 1:** 문서 고침. `---` 앞 빈 줄·표 줄을 눈으로 확인.
- [ ] **Step 2:** `pnpm lint && pnpm fmt:check && pnpm typecheck` 통과, 그 뒤 따로 `pnpm exec turbo run test --continue` — 패키지별 실행 수 보고.
- [ ] **Step 3: 화면 확인(dev:fake, 워크트리 전용 포트)** — 씨앗 채널에서 owner 가 `@dev` 하나를 부르고, dev 의 답이 둘 이상을 부르는 흐름이 대본으로 가능한지 본다. 불가하면 Vitest 의 렌더 시험으로 갈음했다고 보고에 적는다(대본 추가는 하지 않는다). 가능하면 neo 에 Playwright 를 얹어 메인(루트 글 보임·그 아래 묶음)과 스레드 패널(루트 아래 묶음) 스크린샷. 연 탭은 닫는다.
- [ ] **Step 4: Commit** — `docs: reply bundles anchor on the multi-call message`
