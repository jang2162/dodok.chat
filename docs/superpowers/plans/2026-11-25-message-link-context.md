# 메시지 링크 복사와 맥락 넘기기 Implementation Plan

> **For agentic workers:** 이 저장소는 Orca 워커가 구현한다(`docs/guides/worktree-workflow.md`). 태스크 순서대로, 태스크마다 시험 → 구현 → 통과 → 커밋. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메시지마다 링크를 복사하고, 링크를 열면 그 메시지로 가며, 링크가 든 글로 시작한 에이전트 런은 링크한 메시지 내용을 문맥으로 받는다.

**Architecture:** shared 에 링크 꼴(만들기·찾기)과 `LinkedMessage`·`formatLinkedMessages` 를 두고, 서버 `buildInboundDeliver` 가 런 주체의 읽기 범위로 펼쳐 `InboundContext.linkedMessages` 에 싣는다. 웹은 새 REST `GET /api/v1/messages/:id` 로 이동·카드를 그린다.

**Tech Stack:** Zod(shared)·Fastify·drizzle·OpenClaw 플러그인·러너 프롬프트·React/TanStack Router·vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-message-link-context-design.md` — 값·규칙의 원본. 계획과 다르면 스펙을 따르고 보고한다.

## Global Constraints

- 링크 꼴: `<origin>/c/<channelId>/s/<conversationId>?m=<messageId>`, 스레드 답글은 `<origin>/c/<channelId>/s/<conversationId>/t/<rootId>?m=<messageId>`. 서버는 `APP_ORIGIN` 과 같은 오리진만 링크로 본다.
- 한 글에서 최대 **3** 개, 같은 id 한 번. `LinkedMessage.text` 4,000자, `root.text` 1,000자, `attachments` 이름 최대 10.
- 펼치는 런 종류: `mention`·`auto_respond`·`relay`. `interaction`·`continue`·`command`·`background` 는 싣지 않는다.
- 읽기 판정: `readableChannelSqlFor({ userId: <그 런의 시킨 사람>, via: "agent", runId: run.id })`(`apps/server/src/auth/channel-access.ts`) — DM·그룹 DM 은 그 런의 DM 일 때만. 못 읽으면 조용히 뺀다.
- 넣는 자리: 플러그인은 `formatInboundContext` 헤더, 러너는 `renderRunnerPrompt`(사용자 메시지 본문). **`buildTurnFacts` 에는 넣지 않는다.**
- `GET /api/v1/messages/:id` — 읽기 판정은 `getReadableConversation` 과 같고 못 읽거나 없으면 404.
- 웹 문구: 「링크 복사」, 토스트 「링크를 복사했습니다」, 404 토스트 「볼 수 없는 메시지입니다」.

## Review Focus

- 링크가 **마크다운 링크 `[글](url)` 안**이거나 **문장 끝 구두점**(`…?m=<id>).`)이 붙어도 찾는다 — Task 1 의 시험.
- 사람이 **자기 DM 링크를 일반 채널에 붙이면** 에이전트 문맥에 실리지 않고, 사람 화면 카드는 본인에게 보인다 — Task 2·5 의 시험.
- 링크한 메시지가 **지워졌거나(없는 id)** 다른 워크스페이스 것이면 오류 없이 빠진다 — Task 2 의 시험.
- 링크한 글의 본문 안 줄이 `---`·`참여자:` 로 시작해도 **헤더의 끝·사실로 읽히지 않는다**(들여쓰기) — Task 1 의 시험.
- `?m=` 주소로 들어왔는데 **메시지가 아직 안 받은 오래된 페이지**에 있으면 around 로 받아 그 자리에 간다 — Task 4 의 시험.

---

### Task 1: shared — 링크 꼴·`LinkedMessage`·`formatLinkedMessages`

**Files:**
- Create: `packages/shared/src/messages/links.ts`(shared 의 기존 디렉터리 관례에 맞춰 자리를 고르고 `index.ts` 에서 내보낸다)
- Modify: `packages/shared/src/bridge/index.ts`(`InboundContext.linkedMessages`)
- Test: 새 `packages/shared/test/message-links.test.ts`, `packages/shared/test/bridge.test.ts`

**Interfaces:**
- Produces: `messageLinkPath(p: { channelId: string; conversationId: string; messageId: string; threadRootId?: string }): string`(오리진 없는 경로+쿼리)
- Produces: `findMessageLinks(text: string, origin: string): string[]`(메시지 id, 순서대로·중복 없이·최대 `MESSAGE_LINKS_MAX = 3`)
- Produces: `LinkedMessage` Zod·타입(스펙 「에이전트 문맥」 칸 그대로), `InboundContext.linkedMessages?: LinkedMessage[]`(max 3)
- Produces: `formatLinkedMessages(list: readonly LinkedMessage[], hhmm: (iso: string) => string): string | null`(빈 목록이면 null)

- [ ] **Step 1: 시험** — `messageLinkPath` 두 꼴. `findMessageLinks`: 같은 오리진만, 다른 오리진 무시, `[글](url)` 안, 끝 `).`·`,`·`?` 구두점, 쿼리 순서 바뀜(`?x=1&m=…`), 넷이면 셋, 중복 하나. `formatLinkedMessages`: 첫 줄 「링크한 메시지 N:」, 각 메시지 `[HH:MM] @handle (#채널 · 세션 「제목」[ · 스레드]): ` 다음 본문, 본문 둘째 줄부터 두 칸 들여쓰기(본문에 `---`·`참여자:` 줄이 있어도 줄 머리에 오지 않음), 스레드 답글이면 루트 한 줄, 첨부 이름 줄. 빈 목록 → null. `bridge.test.ts`: `linkedMessages` 넷이면 parse 실패, 없으면 통과.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/shared exec vitest run test/message-links.test.ts test/bridge.test.ts` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(shared): message link format and linked message context`

### Task 2: 서버 — 펼치기와 `GET /messages/:id`

**Files:**
- Modify: `apps/server/src/modules/runs/context.ts`(`buildInboundDeliver` 가 `linkedMessages` 를 채움), `apps/server/src/modules/messages/routes.ts`(새 라우트), 필요하면 `apps/server/src/modules/messages/service.ts`(id 로 읽기 판정과 함께 가져오는 함수)
- Test: `apps/server/test/runs.context.test.ts`, 새 `apps/server/test/messages.link.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`(새 라우트가 읽기 정책 표에 들면)

**Interfaces:**
- Consumes: Task 1 `findMessageLinks`·`LinkedMessage`.
- Produces: `linkedMessagesFor(db: DbOrTx, input: { run: Run; text: string; origin: string }): LinkedMessage[]`(context.ts 안, 내보내 시험).
- Produces: `GET /api/v1/messages/:id` → `{ message: Message; channelName: string; conversationTitle: string }`(웹 Task 4·5 가 쓴다).

- [ ] **Step 1: 시험** — `runs.context.test.ts`: ① 일반 채널 메시지 링크 → 실림(작성자 핸들·채널 이름·세션 제목·본문 `renderForAgent`) ② 시킨 사람의 에이전트 DM 링크를 일반 채널 런에 → 빠짐 ③ 같은 DM 안 링크를 그 DM 런에 → 실림 ④ 그룹 DM 링크를 다른 채널 런에 → 빠짐 ⑤ 없는 id·다른 워크스페이스 → 빠지고 오류 없음 ⑥ 스레드 답글 링크 → `root` 실림 ⑦ 런 종류 `command`·`interaction`·`continue`·`background` → 키 없음 ⑧ 자동화 글 트리거(사람 없음) → 일반 채널 링크만. 라우트 시험: 읽을 수 있는 메시지 200 과 세 칸, 남의 DM 404, 없는 id 404.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/runs.context.test.ts test/messages.link.routes.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 오리진은 서버 설정의 `APP_ORIGIN`(이미 쓰는 설정 값을 따라간다). 읽기 판정은 Global Constraints 의 `readableChannelSqlFor` 로, 시킨 사람은 `Run` 의 그 필드.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `pnpm -F @dodok/server exec vitest run test/roles.matrix.test.ts` PASS.
- [ ] **Step 5: 커밋** — `feat(server): expand linked messages into agent context`

### Task 3: 플러그인·러너 — 헤더와 프롬프트

**Files:**
- Modify: `packages/openclaw-plugin/src/context.ts`(`formatInboundContext` — 「최근 대화」/스레드 블록 다음, 반응 앞), `packages/shared/src/runner/prompt.ts`(`renderRunnerPrompt` 본문)
- Test: `packages/openclaw-plugin/test/context.test.ts`, `packages/shared/test/runner-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 `formatLinkedMessages`.

- [ ] **Step 1: 시험** — 플러그인 헤더에 그 블록이 `---` 앞에 실림, 없으면 없음. 러너: `renderRunnerPrompt` 결과에 실림, `buildTurnFacts` 결과에는 **없음**.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/openclaw-plugin exec vitest run test/context.test.ts`, `pnpm -F @dodok/shared exec vitest run test/runner-prompt.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 두 자리 다 `formatLinkedMessages`. 플러그인 시각은 그 파일의 `hhmm(iso, tz)`, 러너는 prompt.ts 의 `hhmm`.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(plugin,runner): linked messages in agent prompt`

### Task 4: 웹 — 링크 복사와 `?m=` 진입

**Files:**
- Modify: `apps/web/src/features/messages/MessageItem.tsx`(호버 줄의 🔗 「링크 복사」, 「⋯」 메뉴 줄 — 좁은 화면 길게 누르기 메뉴가 같은 메뉴면 같이), `apps/web/src/app/router.tsx`(세션·스레드 라우트 `validateSearch` 에 `m`), `apps/web/src/features/messages/ChannelPage.tsx`(진입 처리), 새 `apps/web/src/features/messages/messageLink.ts`(복사·조회 쿼리)
- Test: 새 `apps/web/src/features/messages/messageLink.test.tsx`, `apps/web/src/app/router.test.tsx`

**Interfaces:**
- Consumes: Task 1 `messageLinkPath`, Task 2 `GET /api/v1/messages/:id`.
- Produces: `useLinkedMessage(id: string)`(TanStack Query, 키 `["message", id]`, 404 는 `null`) — Task 5 가 쓴다. `copyMessageLink(m: Message): Promise<void>`.

- [ ] **Step 1: 시험** — ① 「링크 복사」 → `navigator.clipboard.writeText` 에 `window.location.origin + messageLinkPath(...)`, 토스트 「링크를 복사했습니다」 ② 클립보드 거절 → 주소가 선택된 읽기 전용 칸 ③ `/c/…/s/…?m=<id>` 진입 → 조회한 seq 로 `useJumpStore` 목표(그 메시지 강조), 그 뒤 주소에서 `m` 을 지움 ④ 스레드 주소 + `?m=` → 스레드 안 그 답글 ⑤ 404 → 「볼 수 없는 메시지입니다」 후 그 대화 ⑥ 오래된 페이지의 메시지 → around 로 받아 도착.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web exec vitest run src/features/messages/messageLink.test.tsx src/app/router.test.tsx` → FAIL.
- [ ] **Step 3: 구현** — 진입은 기존 결과로 가기 길(`useJumpStore`·`jumpToSeq`)을 그대로 쓴다.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(web): copy message link and open it`

### Task 5: 웹 — 인용 카드(작성기·보낸 글)

**Files:**
- Create: `apps/web/src/features/messages/LinkedMessageCard.tsx`
- Modify: `apps/web/src/features/composer/Composer.tsx`(본문의 링크 → 첨부 자리 카드, ✕ 는 작성 중 미리보기만), `apps/web/src/features/messages/MessageItem.tsx`(본문 아래 카드, 최대 3)
- Test: 새 `apps/web/src/features/messages/LinkedMessageCard.test.tsx`, `apps/web/src/features/composer/Composer.test.tsx`

**Interfaces:**
- Consumes: Task 1 `findMessageLinks`, Task 4 `useLinkedMessage`.
- Produces: `<LinkedMessageCard messageId={string} onDismiss?={() => void} />`.

- [ ] **Step 1: 시험** — 카드: 작성자 이름·「# 채널 · 세션 제목(· 스레드) · 시각」·본문 첫 2줄(멘션 `@핸들`, 마크다운 걷음 — `ReplyBundle` 의 `previewOf` 를 내보내 같이 쓴다), 누르면 그 메시지로. 못 읽음(null) → 카드 없음. 작성기: 링크 붙여넣기 → 카드, ✕ → 카드만 사라지고 본문 링크는 남음, 보낸 글에는 카드가 선다. 보낸 글에 링크 넷 → 카드 셋.
- [ ] **Step 2: 실패 확인** — 두 파일 vitest → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 두 파일 PASS, 이어 `pnpm -F @dodok/web test`(단독)·`pnpm typecheck`·`pnpm lint`·`pnpm fmt`.
- [ ] **Step 5: 커밋** — `feat(web): linked message cards`

### Task 6: 문서·확인

**Files:**
- Modify: `docs/guides/agent-guide.md`(헤더의 「링크한 메시지」 블록 — 플러그인 헤더 자리와 러너 본문 자리, 무엇이 빠지는지), `docs/manual/user-guide.md`(「링크 복사」·카드·DM 링크 규칙 한 줄), 스펙 끝에 「구현과 맞춘 것」 장(달라진 것만)

- [ ] **Step 1: 런 0회 하네스** — `docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」로, 링크가 든 글을 러너 에이전트에 보내 가짜 Messages API 가 받은 사용자 메시지에 블록이 있고 `additionalContext`(턴 사실)에는 없음을 확인. **모델 런은 하지 않는다.**
- [ ] **Step 2: 브라우저** — 워크트리 전용 포트 `dev:fake`+web: 복사 → 새 탭에 붙여 열기 → 강조, 작성기 카드·✕, 보낸 글 카드, mia 계정으로 owner 의 DM 링크 → 카드 없음. 스크린샷 경로를 보고에.
- [ ] **Step 3: 문서 쓰기·커밋** — `docs: message links and linked context`
