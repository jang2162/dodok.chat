# Phase 2 ② components v1 완성 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹이 components v1 의 모든 블록과 모달을 그리고, 누가 무엇을 보냈는지 카드에 남는다.

**Architecture:** 계약·서버·플러그인은 이미 components v1 전체를 다룬다 — 없는 것은 화면뿐이다. 웹에 `features/components/` 를 새로 만들어 지금의 `ActionButtons`(버튼만)를 흡수하고, 블록 5종·셀렉트·모달을 그린다. 상호작용 기록은 서버가 메시지에 실어(`Message.interactions`) 기존 `message.updated` 팬아웃을 그대로 타므로 새로고침·새 탭에서도 보인다.

**Tech Stack:** pnpm 모노레포(Node 24.21.0, pnpm 11.16.0) · React 19.3 + Vite 8.3 · Zod 4.6 · `radix-ui` 1.6.7 · Vitest + Testing Library · Fastify + Socket.IO + Drizzle(SQLite)

**Spec:** `docs/superpowers/specs/2026-09-21-components-v1-design.md`

## Global Constraints

- **의존성 추가 0.** 모달 필드에 필요한 Radix 원시 요소는 이미 있는 `radix-ui` 1.6.7 에 들어 있다. 새 래퍼는 `apps/web/src/ui/radio-group.tsx` 하나뿐이고 `ui/select.tsx` 는 만들지 않는다(스펙 결정 7·10).
- **`packages/shared/src/components/index.ts` 는 한 줄도 바꾸지 않는다.** 블록·필드·제약 스키마는 그대로다. 계약에 더하는 것은 `domain/index.ts` 의 `MessageInteraction`·`Message.interactions`·`INTERACTIONS_MAX` 뿐이다(스펙 3장).
- **`artifact://` 는 해석하지 않는다** — 비활성 자리표시로 둔다. 해석은 Phase 2 ③(스펙 결정 1).
- **모달은 `triggerLabel` 버튼으로 연다** — 버튼에 `opensModal` 류를 더하지 않는다(스펙 결정 2).
- `node -v` 가 24.21.0 이 아니면 `export PATH="$(mise where node)/bin:$(mise where npm:pnpm)/bin:$PATH"`.
- 끝내기 전 루트에서 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check` 를 돌리고 **각 exit code 를 확인**한다.
- `git add -A` · `git commit -a` **금지** — 바꾼 파일 경로를 하나씩 stage 한다. Conventional Commits, 패키지 스코프.
- 커밋 끝 두 줄: `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01RCZ7VZGV9V7gx1CPYBxSRP`.
- 새로 만든 분기마다 **돌연변이 확인**: 그 줄을 지우거나 조건을 뒤집고 관련 테스트만 돌려 **빨강을 눈으로 보고** 원복한다. 끝나고 `git status` 가 0줄이어야 한다.
- `.env`·`~/.openclaw/openclaw.json`·`~/.openclaw-dev/openclaw.json`·Claude CLI 대화기록 파일은 **읽지 않는다**. 실제 Gateway 접속·모델 런은 태스크 11 뿐이고 그때도 사용자 승인을 받는다.

---

## 파일 구조

| 파일 | 책임 | 태스크 |
| --- | --- | --- |
| `packages/shared/src/domain/index.ts` | `MessageInteraction`·`INTERACTIONS_MAX`·`Message.interactions` | 1 |
| `apps/server/src/modules/messages/service.ts` | `withInteractions` 하이드레이션 | 1 |
| `apps/server/src/modules/components/service.ts` | 상호작용마다 `message.updated` | 1 |
| `apps/web/src/features/components/state.ts` | (순수) 비활성 규칙 한 곳 | 2 |
| `apps/web/src/features/components/useInteract.ts` | `component.interact` 래퍼 — 전송 중·ack 오류·초점 | 2 |
| `apps/web/src/features/components/Components.tsx` | 카드 전체: 블록 순회 → 모달 트리거 → 결과 줄 | 2(골격)·4·6 |
| `apps/web/src/features/components/blocks/ActionsBlock.tsx` | 버튼 줄 + 셀렉트 자리 | 2(버튼)·3(셀렉트) |
| `apps/web/src/ui/radio-group.tsx` | Radix RadioGroup 래퍼 | 3 |
| `apps/web/src/features/components/OptionList.tsx` | 옵션 목록(단일=라디오 / 다중=체크박스) | 3 |
| `apps/web/src/features/components/blocks/SelectItem.tsx` | 셀렉트 하나: 고르기 + 「보내기」 | 3 |
| `apps/web/src/features/components/modal/validate.ts` | (순수) 필드 화면 검사 | 4 |
| `apps/web/src/features/components/modal/fields.tsx` | 필드 7종 → 위젯 | 4 |
| `apps/web/src/features/components/modal/ComponentModal.tsx` | 트리거 + Dialog + 제출 | 4 |
| `apps/web/src/features/components/blocks/SectionBlock.tsx` | `MessageBody` 로 마크다운 | 5 |
| `apps/web/src/features/components/blocks/SeparatorBlock.tsx` | 구분선 | 5 |
| `apps/web/src/features/components/blocks/MediaBlock.tsx` | https 이미지 격자 / artifact 자리표시 | 5 |
| `apps/web/src/features/components/blocks/FileBlock.tsx` | 파일 줄 / artifact 자리표시 | 5 |
| `apps/web/src/features/components/interactions.ts` | (순수) 결과 줄 문구 | 6 |
| `apps/server/test/fakes/scenario.ts` | `ScenarioScript.components` | 7 |
| `apps/server/scripts/dev-fake.ts` | 대본 키워드 다섯 | 7 |
| `apps/server/test/integration/components.test.ts` | 통합 시나리오 | 7 |

**없어지는 파일**: `apps/web/src/features/messages/ActionButtons.tsx`(+ `ActionButtons.test.tsx`) — 태스크 2가 흡수한다.

## 병렬 표

| 태스크 | 선행 | 같이 돌 수 있는 것 |
| --- | --- | --- |
| 1 서버·계약 | — | 8 |
| 2 웹 골격 | 1 없어도 됨(계약만 보면 됨 → 1 병합 뒤 시작) | 7 |
| 3 셀렉트 | 2 | 4, 5 |
| 4 모달 | 2 | 3, 5 |
| 5 나머지 블록 | 2 | 3, 4 |
| 6 결과 줄 | 1, 2 | 7 |
| 7 하네스·통합 | 1 | 3, 4, 5, 6 |
| 8 이월 셋 | — | 1~7 (활동 패널 쪽이라 안 겹친다) |
| 9 브라우저 검증 | 3, 4, 5, 6, 7 | — |
| 10 문서 | 9 | — |
| 11 dev 실연 | 10 | — |

---

### Task 1: 계약 + 서버 하이드레이션

**Files:**
- Modify: `packages/shared/src/domain/index.ts`
- Modify: `apps/server/src/modules/messages/service.ts`
- Modify: `apps/server/src/modules/components/service.ts`
- Modify: `apps/server/src/realtime/socket.ts`(구독 ack), 그리고 `message.created`·`message.updated` 를 emit 하는 자리 전부 — `rg -n 'emit\("message\.(created|updated)"' apps/server/src` 로 찾는다
- Test: `packages/shared/test/domain.test.ts`, `apps/server/test/messages.service.test.ts`, `apps/server/test/components.service.test.ts`

**Interfaces:**
- Consumes: 없음(첫 태스크)
- Produces:

```ts
// @dodok/shared
export const MessageInteraction: z.ZodObject<{
  id; componentId; userId; itemId; values; createdAt;
}>;
export type MessageInteraction = { id: string; componentId: string; userId: string; itemId: string; values: Record<string, unknown>; createdAt: string };
export const INTERACTIONS_MAX = 20;
// Message 에 필드 하나: interactions: MessageInteraction[]  (항상 있다 — 기본값 [])

// apps/server/src/modules/messages/service.ts
export function withInteractions(db: DbOrTx, msgs: Message[]): Message[];
```

- [ ] **Step 1: 계약 실패 테스트**

`packages/shared/test/domain.test.ts` 에:

`describe("Message", …)`(`packages/shared/test/domain.test.ts:67`) 안에 이미 있는 지역 상수 `base` 를 그대로 쓴다 — 새 픽스처를 만들지 마라.

```ts
it("interactions 는 없으면 빈 배열 — 옛 행도 그대로 파싱된다", () => {
  expect(Message.parse(base).interactions).toEqual([]);
});

it("interactions 는 INTERACTIONS_MAX 를 넘으면 거부", () => {
  const one = {
    id: ID(5), componentId: "cmp_1", userId: ID(3), itemId: "ok",
    values: {}, createdAt: NOW,
  };
  const make = (n: number) =>
    Message.safeParse({ ...base, interactions: Array.from({ length: n }, () => one) });
  expect(make(INTERACTIONS_MAX).success).toBe(true);
  expect(make(INTERACTIONS_MAX + 1).success).toBe(false);
});
```

`ID`·`NOW` 는 그 파일이 이미 쓰는 도우미다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- domain`
Expected: FAIL — `INTERACTIONS_MAX is not defined`

- [ ] **Step 3: 계약 구현**

`packages/shared/src/domain/index.ts` 에 — `ItemId` 는 같은 패키지의 `../components` 에서 가져온다(`domain` 은 이미 `ComponentState`·`ComponentsV1` 를 거기서 가져오고 있으니 순환이 아니다):

```ts
import { ComponentState, ComponentsV1, ItemId } from "../components";

/** 이 메시지의 components 에 일어난 상호작용 하나. 정본은 서버의 component_interactions 테이블이다. */
export const MessageInteraction = z.object({
  id: Id,
  componentId: z.string().max(100),
  userId: Id,
  itemId: ItemId,
  values: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});
export type MessageInteraction = z.infer<typeof MessageInteraction>;

/** 메시지에 싣는 상호작용 개수 상한. 넘으면 최신 쪽을 남긴다(설계 3장). */
export const INTERACTIONS_MAX = 20;
```

`Message` 안, `componentState` 줄 아래에:

```ts
  /**
   * 이 메시지 카드에 일어난 상호작용(설계 3장). **기본값이 있어 경계를 넘는 Message 에는 항상 있다** —
   * 없는 채로 message.updated 가 오면 웹 캐시가 기존 결과 줄을 지워 버린다.
   */
  interactions: z.array(MessageInteraction).max(INTERACTIONS_MAX).default([]),
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test -- domain`
Expected: PASS

- [ ] **Step 5: 하이드레이션 실패 테스트**

`apps/server/test/messages.service.test.ts` 에:

```ts
it("withInteractions — components 있는 메시지에만 붙고, 최신 20건이 오름차순", () => {
  // 메시지 둘: 하나는 components 있음, 하나는 없음
  // component_interactions 에 21건을 createdAt 이 1분씩 늘게 넣는다
  const [withC, plain] = withInteractions(db, [msgWithComponents, msgPlain]);
  expect(withC.interactions).toHaveLength(INTERACTIONS_MAX);
  expect(withC.interactions[0]?.createdAt < withC.interactions[19]!.createdAt).toBe(true);
  // 잘린 것은 가장 오래된 1건 — 최신 20건이 남는다
  expect(withC.interactions.some((i) => i.itemId === "oldest")).toBe(false);
  expect(plain.interactions).toEqual([]);
});

it("components 가 하나도 없으면 질의하지 않는다", () => {
  const spy = vi.spyOn(db, "select");
  expect(withInteractions(db, [msgPlain])).toEqual([msgPlain]);
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: 실패 확인**

Run: `pnpm -F @dodok/server test -- messages.service`
Expected: FAIL — `withInteractions is not exported`

- [ ] **Step 7: 하이드레이션 구현**

`apps/server/src/modules/messages/service.ts` 에 — `rowToMessage` 는 **순수한 채로 둔다**:

```ts
import { INTERACTIONS_MAX, type MessageInteraction } from "@dodok/shared";
import { componentInteractions } from "../../db/schema.sqlite";
import { inArray } from "drizzle-orm";

/**
 * 클라이언트가 볼 Message 에 상호작용 기록을 붙인다(설계 4.1·4.2).
 * components 가 있는 메시지만 고른다 — 보통 한 페이지에 0~2건이고, 하나도 없으면 질의하지 않는다.
 * 서버 내부에서만 쓸 Message 에는 붙이지 않는다(트랜잭션마다 질의가 늘어난다).
 */
export function withInteractions(db: DbOrTx, msgs: Message[]): Message[] {
  const ids = msgs.filter((m) => m.components !== undefined).map((m) => m.id);
  if (ids.length === 0) return msgs;
  const rows = db
    .select()
    .from(componentInteractions)
    .where(inArray(componentInteractions.messageId, ids))
    .orderBy(asc(componentInteractions.createdAt), asc(componentInteractions.id))
    .all();
  const byMessage = new Map<string, MessageInteraction[]>();
  for (const r of rows) {
    const list = byMessage.get(r.messageId) ?? [];
    list.push({
      id: r.id,
      componentId: r.componentId,
      userId: r.userId,
      itemId: r.itemId,
      values: r.values,
      createdAt: r.createdAt.toISOString(),
    });
    byMessage.set(r.messageId, list);
  }
  return msgs.map((m) => {
    const list = byMessage.get(m.id);
    if (!list) return m;
    // 넘치면 최신 쪽 20건을 남긴다 — 오래된 것이 잘린다(설계 3장)
    return { ...m, interactions: list.slice(-INTERACTIONS_MAX) };
  });
}
```

- [ ] **Step 8: 통과 확인**

Run: `pnpm -F @dodok/server test -- messages.service`
Expected: PASS

- [ ] **Step 9: 배선 — 클라이언트가 볼 자리 전부**

붙이는 자리(설계 4.2):
- `listMessages` 가 돌려주기 직전
- REST 로 메시지 하나를 돌려주는 자리
- 구독 ack 의 `messages`(`listMessages` 를 쓰면 저절로 따라온다 — 확인만)
- `bus.emit("message.created")` · `bus.emit("message.updated")` 의 페이로드

**붙이지 않는 자리**: `components/service.ts` 의 `interact()` 안, 라우터 등 **서버 내부 전용** 읽기.

`rg -n 'emit\("message\.(created|updated)"' apps/server/src` 로 자리를 모두 찾아 하나씩 처리하고, 보고서에 자리 목록을 적는다.

- [ ] **Step 10: 「항상 방송」 실패 테스트**

`apps/server/test/components.service.test.ts` 에:

```ts
it("reusable 카드도 상호작용마다 message.updated 를 쏜다 — 결과 줄이 실시간으로 는다", async () => {
  // reusable: true 카드를 두 번 누른다
  await interact(deps, first);
  await interact(deps, second);
  const updates = bus.events.filter((e) => e.name === "message.updated");
  expect(updates).toHaveLength(2);
  expect(updates[1]?.payload.message.interactions).toHaveLength(2);
  // 소비 규칙은 그대로 — reusable 은 consumed 가 비어 있다
  expect(updates[1]?.payload.message.componentState?.consumed).toEqual([]);
});
```

- [ ] **Step 11: 실패 확인**

Run: `pnpm -F @dodok/server test -- components.service`
Expected: FAIL — `expected length 2, got 0`(지금은 `!reusable` 일 때만 쏜다)

- [ ] **Step 12: 「항상 방송」 구현**

`apps/server/src/modules/components/service.ts` — 지금은 `if (result.updated) bus.emit(...)` 이다. 소비 갱신이 없을 때도 **그 메시지를 다시 읽어** 방송한다. 소비 갱신 규칙(`!reusable` 일 때만 `consumed` 에 넣는다)은 **그대로 둔다**.

- [ ] **Step 13: 검증 표 나머지 넷 (설계 4.4)**

같은 파일에 네 테스트를 더한다:

```ts
it("상호작용 뒤 새 구독 ack·message.updated·REST 재조회 셋 다 결과 줄을 갖는다", async () => { /* 세 경로를 각각 읽어 비교 */ });
it("interact() 안에서 읽은 메시지에는 interactions 가 없다 — 내부 경로는 하이드레이션하지 않는다", async () => { /* 질의 수를 센다 */ });
it("components 없는 메시지는 질의 0회, interactions 는 []", () => { /* Step 5 의 둘째와 같은 뜻을 서비스 층에서 */ });
it("같은 아이템을 동시에 눌러도 한 번만 통과한다", async () => { /* 기존 동시성 테스트가 있으면 그것을 잇는다 */ });
```

- [ ] **Step 14: 루트 네 검사**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check
```

- [ ] **Step 15: 커밋**

```bash
git add packages/shared/src/domain/index.ts packages/shared/test/domain.test.ts \
  apps/server/src/modules/messages/service.ts apps/server/src/modules/components/service.ts \
  apps/server/test/messages.service.test.ts apps/server/test/components.service.test.ts
# Step 9 에서 배선한 파일들도 경로로 명시해 stage
git commit -m "feat(shared,server): 메시지에 상호작용 기록을 실어 새 탭에서도 결과 줄이 보이게"
```

---

### Task 2: 웹 골격 — `features/components/` 와 버튼 이사

**Files:**
- Create: `apps/web/src/features/components/state.ts` + `state.test.ts`
- Create: `apps/web/src/features/components/useInteract.ts`
- Create: `apps/web/src/features/components/Components.tsx` + `components.test.tsx`
- Create: `apps/web/src/features/components/blocks/ActionsBlock.tsx`
- Delete: `apps/web/src/features/messages/ActionButtons.tsx`, `ActionButtons.test.tsx`
- Modify: `apps/web/src/features/messages/MessageItem.tsx:78`, `apps/web/src/features/messages/SystemCard.tsx:35`
- Test: 위 + 「이어가기」 회귀는 `apps/web/src/features/messages/render.test.tsx` 에

**Interfaces:**
- Consumes: Task 1 의 `Message.interactions`(이 태스크는 안 그린다 — 태스크 6)
- Produces:

```ts
// state.ts
export type ItemState = { disabled: boolean; reason?: "disconnected" | "expired" | "consumed" | "forbidden" | "busy" };
export type StateInput = {
  message: Message; connected: boolean; hasSocket: boolean;
  meId: string | undefined; expired: boolean; busy: ReadonlySet<string>;
  allowedUsers: readonly string[] | undefined; itemId: string;
};
export function itemState(input: StateInput): ItemState;
export const DISABLED_REASON_TEXT: Record<NonNullable<ItemState["reason"]>, string>;

// useInteract.ts
export function useInteract(message: Message): {
  busy: ReadonlySet<string>;
  send(itemId: string, values: Record<string, unknown>, opts?: { blockId?: string }): Promise<void>; // 거부하지 않는다 — 오류는 토스트로
  connected: boolean;
  hasSocket: boolean;
};

// Components.tsx
export function Components({ message }: { message: Message }): ReactElement | null;
```

- [ ] **Step 1: `state.ts` 실패 테스트**

```ts
const base: StateInput = {
  message: msg(1, { components: CMP, componentState: { expiresAt: iso(FUTURE), consumed: [] } }),
  connected: true, hasSocket: true, meId: USER, expired: false,
  busy: new Set(), allowedUsers: undefined, itemId: "ok",
};

it("모두 갖추면 눌린다", () => expect(itemState(base).disabled).toBe(false));
it("연결이 끊기면 disconnected", () => expect(itemState({ ...base, connected: false }).reason).toBe("disconnected"));
it("만료되면 expired", () => expect(itemState({ ...base, expired: true }).reason).toBe("expired"));
it("소비됐으면 consumed", () => {
  const m = msg(1, { components: CMP, componentState: { expiresAt: iso(FUTURE), consumed: ["ok"] } });
  expect(itemState({ ...base, message: m }).reason).toBe("consumed");
});
it("reusable 이면 소비돼도 눌린다", () => {
  const m = msg(1, { components: { ...CMP, reusable: true }, componentState: { expiresAt: iso(FUTURE), consumed: ["ok"] } });
  expect(itemState({ ...base, message: m }).disabled).toBe(false);
});
it("allowedUsers 밖이면 forbidden", () => expect(itemState({ ...base, allowedUsers: [uid(99)] }).reason).toBe("forbidden"));
it("전송 중이면 busy", () => expect(itemState({ ...base, busy: new Set(["ok"]) }).reason).toBe("busy"));
```

우선순위는 위 차례다(연결 → 만료 → 소비 → 권한 → 전송 중). 같은 상황이 겹치면 **먼저 나온 사유**를 돌려준다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/web test -- state`
Expected: FAIL — `itemState is not defined`

- [ ] **Step 3: `state.ts` 구현**

지금 `ActionButtons.tsx` 의 `blocked()` 가 하는 판단을 그대로 옮긴다. `components.id` 가 없으면 `disconnected`(서버가 아직 id 를 안 준 카드는 누를 수 없다).

```ts
export const DISABLED_REASON_TEXT = {
  disconnected: "연결이 끊겨 지금은 보낼 수 없습니다",
  expired: "만료되었습니다",
  consumed: "이미 처리되었습니다",
  forbidden: "이 항목을 쓸 권한이 없습니다",
  busy: "보내는 중입니다",
} as const;
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/web test -- state`
Expected: PASS

- [ ] **Step 5: `useInteract.ts` 와 `Components.tsx` 골격**

`useInteract` 는 지금 `ActionButtons` 안의 `interact()`·`busy`·`ERR` 표를 그대로 옮긴다. `Components` 는:

```tsx
export function Components({ message }: { message: Message }) {
  const c = message.components;
  const expired = useExpired(message.componentState?.expiresAt); // ActionButtons 에서 옮긴다
  const io = useInteract(message);
  if (!c) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" data-slot="components">
      {c.blocks.map((b, i) => (
        <BlockView key={i} block={b} message={message} io={io} expired={expired} />
      ))}
    </div>
  );
}
```

`BlockView` 는 이 태스크에서 `actions`(버튼만) 외에는 **아무것도 그리지 않는다**(`null`) — 태스크 3·4·5 가 채운다. 자리표시 문구 `UNSUPPORTED` 는 **더는 만들지 않는다**(태스크 5 가 나머지 블록을 그려 없어질 문구다). 모달도 이 태스크에서는 안 그린다.

`ActionsBlock.tsx` 는 지금 `ActionButtons` 의 버튼 렌더를 그대로 옮기되 `blocked()` 대신 `itemState()` 를 쓰고, 비활성이면 `title`·`aria-describedby` 로 사유를 말한다(`DISABLED_REASON_TEXT`).

- [ ] **Step 6: 호출부 교체와 회귀 테스트**

`MessageItem.tsx:78` 과 `SystemCard.tsx:35` 의 `<ActionButtons message={message} />` 를 `<Components message={message} />` 로 바꾸고, `ActionButtons.tsx`·`ActionButtons.test.tsx` 를 **지운다**. 지운 테스트의 단언은 `components.test.tsx` 로 옮긴다(**버리지 마라** — 링크 버튼, 소비 비활성, 만료 비활성, `allowedUsers`, ack 오류 토스트).

`render.test.tsx` 에 회귀 테스트 하나:

```ts
it("「이어가기」 시스템 카드의 버튼이 그대로 동작한다", async () => {
  // relay_limit 시스템 메시지 + continue_relay 버튼
  // 누르면 component.interact 가 itemId: "continue_relay" 로 나간다
});
```

- [ ] **Step 7: 루트 네 검사 + 돌연변이**

돌연변이 최소 5: `itemState` 의 사유 다섯을 하나씩 지워 빨강을 본다.

- [ ] **Step 8: 커밋**

```bash
git add apps/web/src/features/components apps/web/src/features/messages/MessageItem.tsx \
  apps/web/src/features/messages/SystemCard.tsx apps/web/src/features/messages/render.test.tsx
git rm apps/web/src/features/messages/ActionButtons.tsx apps/web/src/features/messages/ActionButtons.test.tsx
git commit -m "refactor(web): 버튼 렌더를 features/components 로 옮기고 비활성 규칙을 한 곳에"
```

---

### Task 3: 셀렉트 — 옵션 목록과 「보내기」

**Files:**
- Create: `apps/web/src/ui/radio-group.tsx`
- Create: `apps/web/src/features/components/OptionList.tsx`
- Create: `apps/web/src/features/components/blocks/SelectItem.tsx` + `select.test.tsx`
- Modify: `apps/web/src/features/components/blocks/ActionsBlock.tsx`(셀렉트 분기)

**Interfaces:**
- Consumes: 태스크 2 의 `itemState`·`useInteract`
- Produces:

```ts
// OptionList.tsx — 셀렉트 블록과 모달의 select·radio 필드가 함께 쓴다
export function OptionList(props: {
  name: string;                       // fieldset legend / radiogroup 이름
  options: SelectOption[];
  multi: boolean;
  value: readonly string[];
  onChange(next: string[]): void;
  disabled?: boolean;
  describedBy?: string;
}): ReactElement;

// 고른 값이 min/max 를 만족하는가 — SelectItem 과 모달 검사가 함께 쓴다
export function withinBounds(count: number, min: number, max: number): boolean;
```

- [ ] **Step 1: 실패 테스트**

```ts
const SINGLE = { type: "select", id: "fmt", placeholder: "보고서 형식",
  options: [{ value: "pdf", label: "PDF" }, { value: "md", label: "마크다운" }] } as const;
const MULTI = { ...SINGLE, id: "tags", multi: true, minValues: 2, maxValues: 3,
  options: [a, b, c, d] } as const;

it("단일 셀렉트는 라디오로 그리고, 고르기 전에는 「보내기」가 꺼져 있다", () => {});
it("하나 고르면 「보내기」가 켜지고, 누르면 values: { values: [\"pdf\"] } 로 나간다", async () => {});
it("다중 셀렉트는 체크박스 — minValues 미만이면 「보내기」가 꺼져 있다", async () => {});
it("maxValues 를 넘겨 고를 수 없다", async () => {});
it("소비·만료·권한 밖이면 목록과 「보내기」가 함께 잠긴다", () => {});
it("옵션 라벨이 화면에 보이고 value 는 안 보인다", () => {});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/web test -- select`
Expected: FAIL — `SelectItem is not defined`

- [ ] **Step 3: `ui/radio-group.tsx`**

다른 `ui/*` 와 같은 모양으로 만든다(`cn`, `data-slot`, `radix-ui` 의 `RadioGroup`):

```tsx
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) { /* data-slot="radio-group" */ }
function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) { /* Indicator 안에 점 */ }
export { RadioGroup, RadioGroupItem };
```

- [ ] **Step 4: `OptionList` 구현**

- `multi: false` → `RadioGroup` + `RadioGroupItem`. `multi: true` → `ui/checkbox` 목록.
- 감싸개는 `fieldset` + `legend`(=`name`). 색만으로 상태를 말하지 않는다.
- 옵션이 6개를 넘으면 `max-h-56 overflow-y-auto` 스크롤 상자.
- 옵션의 `description`·`emoji` 가 있으면 라벨 옆·아래에 그린다.
- `withinBounds(count, min, max)` 는 순수 함수로 같은 파일에서 export 한다.

- [ ] **Step 5: `SelectItem` 구현**

```tsx
const min = item.minValues ?? (item.multi ? 0 : 1);
const max = item.multi ? (item.maxValues ?? 25) : 1;
// 고른 값 상태는 이 컴포넌트가 들고, 「보내기」에서 io.send(item.id, { values }, { blockId })
```

`max` 에 다다르면 안 고른 항목을 비활성해 **넘겨 고를 수 없게** 한다(다중만). 「보내기」는 `withinBounds` 와 `itemState().disabled` 를 함께 본다.

- [ ] **Step 6: 통과 확인**

Run: `pnpm -F @dodok/web test -- select`
Expected: PASS

- [ ] **Step 7: 루트 네 검사 + 돌연변이**

돌연변이 최소 5: `min` 기본값 뒤집기 · `max` 상한 제거 · `multi` 분기 제거 · 「보내기」의 `withinBounds` 제거 · `values` 키 이름 바꾸기.

- [ ] **Step 8: 커밋**

```bash
git add apps/web/src/ui/radio-group.tsx apps/web/src/features/components
git commit -m "feat(web): components 셀렉트 — 옵션 목록과 「보내기」 확정"
```

---

### Task 4: 모달

**Files:**
- Create: `apps/web/src/features/components/modal/validate.ts` + `validate.test.ts`
- Create: `apps/web/src/features/components/modal/fields.tsx`
- Create: `apps/web/src/features/components/modal/ComponentModal.tsx` + `modal.test.tsx`
- Modify: `apps/web/src/features/components/Components.tsx`(모달 트리거 한 줄)

**Interfaces:**
- Consumes: 태스크 2 의 `itemState`·`useInteract`, 태스크 3 의 `OptionList`
- Produces:

```ts
// validate.ts (순수)
export type FieldValues = Record<string, unknown>;
export function initialValues(fields: Field[]): FieldValues;   // default 를 채운다
export function validateFields(fields: Field[], values: FieldValues): Record<string, string>; // fieldId → 오류 문구, 없으면 {}
```

- [ ] **Step 1: `validate.ts` 실패 테스트**

```ts
it("required 인데 비면 오류", () => {
  expect(validateFields([{ type: "text", id: "t", label: "제목", required: true }], { t: "" })).toEqual({ t: "필수 항목입니다" });
});
it("number 의 min·max", () => {
  const f = [{ type: "number", id: "n", label: "수", required: false, min: 1, max: 5 }] as Field[];
  expect(validateFields(f, { n: 0 })).toEqual({ n: "1 이상이어야 합니다" });
  expect(validateFields(f, { n: 6 })).toEqual({ n: "5 이하여야 합니다" });
  expect(validateFields(f, { n: 3 })).toEqual({});
});
it("text 의 minLength·maxLength", () => {});
it("select 는 required 면 하나 이상", () => {});
it("radio 는 required 면 골라야 한다", () => {});
it("checkbox 는 required 면 켜져 있어야 한다", () => {});
it("initialValues 는 default 를 채우고 없는 칸은 비운다", () => {
  expect(initialValues([{ type: "checkbox", id: "c", label: "동의", required: false, default: true }])).toEqual({ c: true });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/web test -- validate`
Expected: FAIL — `validateFields is not defined`

- [ ] **Step 3: `validate.ts` 구현**

서버 `valuesSchemaFor`(`apps/server/src/modules/components/interact.ts`)가 정본이다 — 이 함수는 **같은 규칙을 화면에서 먼저 막는 편의**다. 서버가 막는 것보다 더 느슨하면 안 되고, 더 빡빡해도 안 된다(사용자가 보낼 수 있는 것을 막게 된다).

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/web test -- validate`
Expected: PASS

- [ ] **Step 5: `fields.tsx`·`ComponentModal.tsx` 실패 테스트**

```ts
it("트리거 버튼은 triggerLabel 로 그리고, 누르면 대화상자가 제목과 함께 열린다", async () => {});
it("필드 7종이 각자 위젯으로 그려진다", async () => {}); // text/textarea/number/date/select/checkbox/radio
it("default 가 초깃값으로 채워진다", async () => {});
it("required 를 비우고 제출하면 보내지 않고 칸 아래 오류가 뜬다", async () => {});
it("제출하면 values: { fields: {...} } 로 나가고 성공하면 닫힌다", async () => {});
it("ack 오류면 대화상자가 열린 채 문구가 뜬다 — 토스트가 아니라", async () => {});
it("VALIDATION 의 details.issues 가 가리키는 필드 아래에 붙는다", async () => {});
it("만료·소비·권한 밖이면 트리거 버튼이 잠긴다", () => {});
```

- [ ] **Step 6: 실패 확인**

Run: `pnpm -F @dodok/web test -- modal`
Expected: FAIL — `ComponentModal is not defined`

- [ ] **Step 7: 구현**

- `ui/dialog` 재사용. 초점 가둠·Esc·트리거 복귀는 Radix Dialog 가 한다 — **직접 만들지 마라**.
- 필드 매핑: `text`→`Input` · `textarea`→`Textarea` · `number`→`Input[type=number]` · `date`→`Input[type=date]` · `select`→`OptionList` · `checkbox`→`ui/checkbox` · `radio`→`OptionList`(단일).
- 칸마다 `ui/label` 과 `ui/field-error`. 오류가 있을 때만 `aria-describedby` 로 가리킨다(`field-error.tsx` 주석의 관습 그대로 — **빈 채로 늘 둔다**).
- 제출: 화면 검사 → 통과하면 `io.send(modal.id, { fields })`. 성공하면 닫고, ack 오류면 **열어 둔 채** 표시.
- `Components.tsx` 에 트리거 한 줄: `{c.modal && <ComponentModal modal={c.modal} message={message} io={io} expired={expired} />}` — 블록들 **아래**.

- [ ] **Step 8: 통과 확인 + 루트 네 검사 + 돌연변이**

돌연변이 최소 6: 필드 7종 중 셋의 위젯 분기 제거 · `initialValues` 의 `default` 무시 · 제출 전 검사 제거 · ack 오류를 토스트로 돌리기 · 트리거 비활성 조건 제거.

- [ ] **Step 9: 커밋**

```bash
git add apps/web/src/features/components
git commit -m "feat(web): components 모달 — 필드 7종·화면 검사·ack 오류 표시"
```

---

### Task 5: 나머지 블록 — section·separator·media·file

**Files:**
- Create: `apps/web/src/features/components/blocks/SectionBlock.tsx`
- Create: `apps/web/src/features/components/blocks/SeparatorBlock.tsx`
- Create: `apps/web/src/features/components/blocks/MediaBlock.tsx`
- Create: `apps/web/src/features/components/blocks/FileBlock.tsx`
- Create: `apps/web/src/features/components/blocks/blocks.test.tsx`
- Modify: `apps/web/src/features/components/Components.tsx`(`BlockView` 분기 채우기)

**Interfaces:**
- Consumes: 태스크 2 의 `Components`/`BlockView` 골격
- Produces: `BlockView` 가 다섯 종류를 모두 그린다 — 남는 `null` 분기가 없다.

- [ ] **Step 1: 실패 테스트**

```ts
it("section 은 마크다운으로 그린다 — 메시지 본문과 같은 규칙", () => {
  // "**굵게**" 가 <strong> 이 되고, 원시 HTML 은 글자로 남는다
});
it("separator 는 구분선 하나", () => {});
it("media 의 https 이미지는 불러오되 referrerPolicy=no-referrer·loading=lazy", () => {
  const img = screen.getByRole("img", { name: "미리보기" });
  expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(img).toHaveAttribute("loading", "lazy");
});
it("media 의 alt 가 없으면 장식으로 — 접근 이름이 없다", () => {});
it("media 의 artifact:// 는 이미지를 만들지 않고 자리표시로", () => {
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText(/첨부는 곧 지원/)).toBeInTheDocument();
});
it("file 의 https 는 이름·크기와 「열기」 링크 — target=_blank rel=noopener noreferrer", () => {});
it("file 의 artifact:// 는 링크가 아니라 자리표시", () => {
  expect(screen.queryByRole("link")).toBeNull();
});
it("size 가 없으면 크기를 적지 않는다", () => {});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/web test -- blocks`
Expected: FAIL — `SectionBlock is not defined`

- [ ] **Step 3: 구현**

- `SectionBlock` — `<MessageBody bodyMd={block.text} />`. **같은 렌더러를 쓰는 것이 요점**이다(마크다운 규칙이 두 벌 되지 않게).
- `SeparatorBlock` — `ui/separator`.
- `MediaBlock` — `https://` 로 시작하는 항목만 `<img referrerPolicy="no-referrer" loading="lazy" alt={item.alt ?? ""} />`. 항목이 `artifact://` 면 그 항목만 자리표시. 격자는 항목 수에 따라 1~3열.
- `FileBlock` — `https://` 면 `<a target="_blank" rel="noopener noreferrer">`, `artifact://` 면 `<span>` 자리표시. 크기는 있을 때만 사람이 읽는 단위로.

`artifact://` 자리표시 문구는 **한 곳에 상수로** 두고 두 블록이 같이 쓴다: `const ARTIFACT_PENDING = "첨부는 곧 지원합니다";`

> 이미지를 불러오는 것은 스펙 결정 8 이다 — 마크다운 이미지는 추적 픽셀 때문에 안 불러오지만 `media` 블록은 「이미지를 보여 주는 블록」이라 불러온다. `referrerPolicy="no-referrer"` 로 레퍼러를 막고, **IP 노출은 남는 대가**다. 이 까닭을 파일 주석에 적어라.

- [ ] **Step 4: 통과 확인 + 루트 네 검사 + 돌연변이**

돌연변이 최소 6: `referrerPolicy` 제거 · `loading` 제거 · `artifact://` 분기 제거(이미지를 만들게) · `rel="noopener noreferrer"` 제거 · `MessageBody` 대신 평문 렌더 · `size` 없을 때도 적기.

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/features/components
git commit -m "feat(web): components section·separator·media·file 블록"
```

---

### Task 6: 결과 줄

**Files:**
- Create: `apps/web/src/features/components/interactions.ts` + `interactions.test.ts`
- Modify: `apps/web/src/features/components/Components.tsx`(결과 줄 렌더)
- Modify: `apps/web/src/features/components/useInteract.ts`(결정 뒤 초점)
- Test: `apps/web/src/features/components/components.test.tsx`

**Interfaces:**
- Consumes: Task 1 의 `Message.interactions`, 태스크 2 의 `Components`
- Produces:

```ts
// interactions.ts (순수)
export function summarize(
  components: ComponentsV1,
  interaction: MessageInteraction,
): { itemLabel: string; valueText?: string } | undefined;
```

- [ ] **Step 1: 실패 테스트**

```ts
it("버튼 — 라벨만", () => {
  expect(summarize(CMP, { ...IX, itemId: "ok", values: {} })).toEqual({ itemLabel: "확인" });
});
it("셀렉트 — placeholder 와 고른 옵션 라벨들", () => {
  expect(summarize(CMP, { ...IX, itemId: "fmt", values: { values: ["pdf", "md"] } }))
    .toEqual({ itemLabel: "보고서 형식", valueText: "PDF, 마크다운" });
});
it("셀렉트에 placeholder 가 없으면 id 를 쓴다", () => {});
it("모달 — 제목과 필드별 「라벨: 값」", () => {
  expect(summarize(CMP, { ...IX, itemId: "form", values: { fields: { title: "보고서", agree: true } } }))
    .toEqual({ itemLabel: "새 작업", valueText: "제목: 보고서 · 동의: 예" });
});
it("checkbox 는 예/아니요, radio·select 는 라벨로 푼다", () => {});
it("카드에서 못 찾는 itemId 면 undefined — 그 줄은 그리지 않는다", () => {
  expect(summarize(CMP, { ...IX, itemId: "없는것" })).toBeUndefined();
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/web test -- interactions`
Expected: FAIL — `summarize is not defined`

- [ ] **Step 3: 구현**

라벨 해석 규칙은 서버 `formatInteractionText`(`apps/server/src/modules/components/interact.ts`)의 사람이 읽는 부분과 **같아야** 한다 — 그쪽은 에이전트용이라 기계가 읽는 머리줄이 붙어 합치지 않는다(스펙 5.6). `checkbox`→`예`/`아니요`, `select`·`radio`→옵션 라벨, 그 밖→`String(v)`.

- [ ] **Step 4: 카드에 결과 줄**

`Components.tsx` 맨 아래(모달 트리거 뒤):

```tsx
{message.interactions.length > 0 && (
  <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-slot="interaction-log">
    {message.interactions.map((ix) => {
      const s = summarize(c, ix);
      if (!s) return null;
      return (
        <li key={ix.id} data-interaction-id={ix.id}>
          @{handleOf(ix.userId)} — {s.itemLabel}{s.valueText ? `: ${s.valueText}` : ""}
        </li>
      );
    })}
    {message.interactions.length === INTERACTIONS_MAX && <li>최근 {INTERACTIONS_MAX}건</li>}
  </ul>
)}
```

`handleOf` 는 이미 있는 `useAuthors()`(`features/messages/useAuthors.ts`)로 푼다 — 모르는 사용자는 「알 수 없는 사용자」.

- [ ] **Step 5: 결정 뒤 초점 (Phase 2 ① D13 규칙)**

`useInteract.send` 가 성공하면 **내가 방금 보낸** 상호작용의 결과 줄로 초점을 옮긴다. **내가 누른 것에만** 옮긴다 — 다른 사람이 누른 것이나 만료로 사라지는 것은 초점을 뺏지 않는다. Phase 2 ① 에서 이 규칙을 `acted` 가 승인 id 에 안 묶여 어긴 회귀가 났으니, **보낸 `itemId` 를 기억**해 그것이 결과 줄로 나타날 때만 옮긴다.

테스트 둘:

```ts
it("내가 보낸 뒤 초점이 그 결과 줄로 간다", async () => {});
it("다른 사람이 보낸 상호작용이 도착해도 초점을 뺏지 않는다", async () => {});
```

- [ ] **Step 6: 카드 테스트**

```ts
it("결과 줄이 오래된 것부터 그려진다", () => {});
it("상한에 닿으면 「최근 20건」을 덧붙인다", () => {});
it("summarize 가 못 푸는 줄은 건너뛴다 — 카드가 깨지지 않는다", () => {});
```

- [ ] **Step 7: 통과 확인 + 루트 네 검사 + 돌연변이**

돌연변이 최소 6: `summarize` 의 세 분기 각각 · `undefined` 건너뛰기 제거 · 상한 문구 조건 제거 · 초점을 **모든** 상호작용에 옮기기.

- [ ] **Step 8: 커밋**

```bash
git add apps/web/src/features/components
git commit -m "feat(web): 상호작용 결과 줄과 결정 뒤 초점"
```

---

### Task 7: 하네스·통합 시나리오

**Files:**
- Modify: `apps/server/test/fakes/scenario.ts`(`ScenarioScript.components`)
- Modify: `apps/server/scripts/dev-fake.ts`(키워드 다섯)
- Create: `apps/server/test/integration/components.test.ts`
- Modify: `apps/server/test/dev-fake.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Message.interactions`
- Produces:

```ts
// ScenarioScript 에 한 필드
/** 정본 메시지에 실을 components v1. 서버가 id·componentState 를 부여한다 */
components?: ComponentsV1;
```

- [ ] **Step 1: 하네스 실패 테스트**

`apps/server/test/integration/components.test.ts`:

```ts
it("에이전트가 셀렉트를 낸 뒤 사람이 고르면 그 에이전트의 다음 런이 고른 값을 받는다", async () => {
  // 대본: components 에 셀렉트 하나 → 메시지 도착 → component.interact → 다음 인바운드의 text 에 고른 라벨
});
it("모달 제출이 다음 런으로 간다", async () => {});
it("결과 줄이 새 구독 ack 에 실려 온다", async () => {});
it("reusable 카드를 두 번 눌러도 둘 다 전달되고 결과 줄이 2건", async () => {});
it("21건을 넘기면 최신 20건만 실린다", async () => {});
it("같은 아이템을 동시에 두 번 눌러도 한 번만 통과한다", async () => {});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/server test -- integration/components`
Expected: FAIL — 대본이 `components` 를 안 받는다

- [ ] **Step 3: 하네스 구현**

`scenario.ts` 의 `plugin.sendOutbound({...})` 에 `...(script.components ? { components: script.components } : {})` 를 더한다. 플러그인 `outbound.message` 가 이미 `components` 를 받는다(`packages/openclaw-plugin/src/outbound.ts`).

> **하네스가 실물보다 친절하면 결함이 숨는다**(Phase 2 ① p2-t6 교훈). 대본이 내는 `components` 는 **플러그인의 Zod 검증을 실제로 지나야** 한다 — 검증을 건너뛰는 지름길을 만들지 마라.

- [ ] **Step 4: `dev:fake` 키워드 다섯**

`fakeAgentScript` 에 더한다:

| 키워드 | 내는 것 |
| --- | --- |
| 「폼」 | 모달 1개 — `text`·`textarea`·`number`·`date`·`select`(필수·기본값 섞음) |
| 「폼 둘」 | 모달 1개 — `checkbox`·`radio` + 필수 `text` 1. **둘이 합쳐 필드 7종을 덮는다**(`Modal.fields` 가 ≤5 라 한 모달에 7종을 못 넣는다) |
| 「고르기」 | 셀렉트 단일 1개 + 다중(`minValues: 2`·`maxValues: 3`) 1개 |
| 「카드」 | `section`·`separator`·`actions`(버튼 셋)·`media`(https 하나 + `artifact://` 하나)·`file`(https 하나 + `artifact://` 하나) |
| 「재사용」 | `reusable: true` 버튼 카드 |
| 「짧게」 | `ttlMs: 20_000`(만료를 눈으로 보려고 — 승인 대본의 TTL 을 줄인 것과 같은 까닭) |

`dev-fake.test.ts` 에 「키워드마다 스키마를 통과하는 components 가 나온다」를 잠근다(`ComponentsV1.parse` 로).

- [ ] **Step 5: 통과 확인 + 루트 네 검사 + 돌연변이**

돌연변이 최소 5: `sendOutbound` 의 `components` 전달 제거 · 키워드 셋 각각 제거 · 「짧게」의 `ttlMs` 무시.

- [ ] **Step 6: 커밋**

```bash
git add apps/server/test/fakes/scenario.ts apps/server/scripts/dev-fake.ts \
  apps/server/test/integration/components.test.ts apps/server/test/dev-fake.test.ts
git commit -m "test(server): 가짜 Gateway components 대본과 통합 시나리오"
```

---

### Task 8: 이월 셋 — 초점·타이머

**Files:**
- Modify: `apps/web/src/app/layout/PanelTabs.tsx`(넓은 화면 「설정 닫기」 초점)
- Modify: `apps/web/src/features/approvals/countdown.ts`·`ApprovalCard.tsx`(공용 틱)
- Modify: `apps/web/src/features/activity/RunList.tsx`·`timeline.ts`(자리값 소요)
- Test: 각 파일의 테스트

**Interfaces:**
- Consumes: Phase 2 ① 의 `useNowTick`(`apps/web/src/hooks/useNowTick.ts`), `hasFlowingDuration`(`features/activity/timeline.ts`)
- Produces: 없음(행동 수정)

- [ ] **Step 1: 실패 테스트 셋**

```ts
// 1) 넓은 화면 「설정 닫기」
it("넓은 화면에서 설정을 닫으면 초점이 body 로 떨어지지 않는다", async () => {});
// 2) D6 공용 틱
it("같은 승인의 카드 둘이 같은 초를 보인다", () => {
  // 두 카드를 함께 그리고 가짜 시계를 밀어 텍스트가 같은지
});
it("카드가 여럿이어도 1초 타이머는 하나다", () => {
  expect(vi.getTimerCount()).toBe(/* 공용 틱 하나 */);
});
// 3) 자리값 소요
it("목록 조회가 실패해 자리값으로 남은 런의 소요는 더 흐르지 않는다", () => {});
it("흐르는 런이 하나도 없으면 1초 틱이 멈춘다", () => {});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/web test -- countdown activity layout`
Expected: FAIL

- [ ] **Step 3: 구현 — 「설정 닫기」 초점**

Phase 2 ① 이 좁은 화면 시트에만 넣은 초점 되돌리기를 **넓은 화면 패널**까지 넓힌다. 돌려줄 자리는 헤더의 「채널 설정」 링크다. 활동 탭에는 헤더 자리가 없으니 **그 탭의 탭 링크**로 돌려준다.

- [ ] **Step 4: 구현 — 공용 틱**

`countdown.ts` 의 카드별 `setInterval` 을 `useNowTick` 하나로 바꾼다. 카드가 몇 개든 틱은 하나이고, 모든 카드가 **같은 `now`** 를 본다.

- [ ] **Step 5: 구현 — 자리값 소요**

자리값으로 남은 런에 「더 안 흐른다」 표시를 달고 `hasFlowingDuration` 에서 뺀다. 「남는 쪽이 사라지는 쪽보다 낫다」는 Phase 2 ① 판정은 **그대로 둔다** — 표시만 정직하게 한다.

- [ ] **Step 6: 통과 확인 + 루트 네 검사 + 돌연변이**

돌연변이 최소 5: 초점 되돌리기 제거 · 공용 틱을 카드별로 되돌리기 · 「더 안 흐른다」 표시 무시 · `hasFlowingDuration` 조건 되돌리기 · 언마운트에서 틱 안 거두기.

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/app/layout/PanelTabs.tsx apps/web/src/features/approvals apps/web/src/features/activity
git commit -m "fix(web): 넓은 화면 설정 닫기 초점·카운트다운 공용 틱·자리값 소요 정지 (이월)"
```

---

### Task 9: 브라우저 검증 (verify 워커 — 코드 변경 없음)

**Files:**
- Create: `.superpowers/sdd/2026-09-21-components-v1/t9-report.md`, `…/screens/t9-*.png`(둘 다 git-ignored)

**Interfaces:**
- Consumes: `PORT=3000 pnpm -F @dodok/server dev:fake`(토큰 `dev-fake-local-token`, 키워드 「폼」·「고르기」·「카드」·「재사용」·「짧게」 + 기존 「도구」·「승인」), `pnpm -F @dodok/web dev`(5173), 브라우저는 **http://localhost:5173**
- Produces: 시나리오 표·결함 목록(조율자가 수정 라운드로 넘긴다)

- [ ] **Step 1: 준비** — 새 DB(`--keep` 없이). 도구 순서는 `docs/guides/browser-verification.md`. 서버를 끌 때 `lsof -ti:3000 -sTCP:LISTEN`.

- [ ] **Step 2: 시나리오**

1. **카드** — 「@dev 카드」 → `section` 마크다운·구분선·버튼 셋·이미지(https 는 뜨고 `artifact://` 는 자리표시)·파일 줄. 이미지 요청에 `Referer` 헤더가 **없는지** 네트워크 탭으로 확인.
2. **고르기(단일)** — 하나 고르고 「보내기」 → 결과 줄이 뜨고 에이전트가 이어받는다.
3. **고르기(다중)** — `minValues` 미만이면 「보내기」가 꺼져 있고, `maxValues` 를 넘겨 고를 수 없다.
4. **폼·폼 둘** — 두 모달을 각각 채워 제출 → 대화상자가 닫히고 결과 줄에 필드별 값. **둘이 합쳐 필드 7종**을 본다. 필수를 비우면 안 닫히고 칸 아래 오류.
5. **재사용** — 같은 버튼을 세 번 → 결과 줄 3건, 버튼은 계속 눌린다.
6. **짧게** — 20초 기다려 만료 → 버튼·셀렉트·모달 트리거가 함께 잠기고 사유가 보인다.
7. **새 탭·새로고침** — 결과 줄이 그대로 있다.
8. **이어가기 회귀** — 릴레이 상한 카드의 「이어가기」가 그대로 동작한다.
9. **키보드만으로** — 셀렉트 고르기·「보내기」·모달 열기·필드 이동·제출·닫기. 제출 뒤 초점이 `body` 로 떨어지지 않는다.
10. **390px** — 카드·모달·옵션 목록이 넘치지 않는다.
11. **회귀** — 메시지 보내기·스트리밍·중지·활동 탭·승인 카드가 그대로.
12. **콘솔** — 앱 JS 예외 0, `ResizeObserver` 0, favicon 404 0.

- [ ] **Step 3: 보고** — 시나리오 표(통과·실패·스크린샷·콘솔 수), 결함 목록(심각도·재현·짐작 가는 파일), 걱정. **코드는 고치지 않는다.** 결함이 있으면 조율자가 수정 라운드를 돌리고 이 태스크를 다시 돈다(1차 → 수정 → 재검증).

---

### Task 10: 문서

**Files:**
- Modify: `docs/project-structure.md`(웹 `features/components/`, 서버 하이드레이션), `CLAUDE.md`(현재 단계), `docs/plan.md`(8장 Phase 2 ②·이월에서 끼운 셋 제거), `docs/superpowers/specs/2026-09-21-components-v1-design.md`(「구현과 맞춘 것」)
- Test: 없음(문서). 루트 네 명령은 돌린다.

- [ ] **Step 1: 문서 갱신**

- `project-structure.md`: 웹 `features/components/` 트리와 서버 `withInteractions` 를 **실물 파일 목록을 `ls` 로 확인해** 반영한다.
- `CLAUDE.md` 「현재 단계」: 「Phase 2 ② components v1 완성(날짜) — 다음: ③ 첨부·이미지」. 테스트 수는 `pnpm test` 를 직접 돌려 확인한다.
- `docs/plan.md`: 8장 Phase 2 의 `components` v1 줄에 완료 표시와 실물 요약. 「이월」에서 **이번에 끼운 셋**(넓은 화면 설정 닫기 초점·D6 카운트다운·자리값 소요)만 지운다. 나머지는 그대로.
- 스펙 끝에 「구현과 맞춘 것」 — 설계와 달라진 결정이 있으면 한 줄씩. 브라우저 검증이 찾은 것 중 문서로 남기기로 한 것도.

- [ ] **Step 2: 검증·커밋**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check
git add docs/project-structure.md CLAUDE.md docs/plan.md docs/superpowers/specs/2026-09-21-components-v1-design.md
git commit -m "docs: Phase 2 ② components v1 — 구성 가이드·현재 단계·계획서"
```

---

### Task 11: dev Gateway 실연 (모델 런 — 사용자 승인 필요)

**Files:**
- Modify: `docs/guides/live-smoke.md`(components 절)

**Interfaces:**
- Consumes: `docs/guides/live-smoke.md` 2절 시크릿 규칙·3절 (a)~(f) 절차
- Produces: 실연 결과와 「모델이 스키마를 어떻게 채우는가」

- [ ] **Step 1: 사용자 승인** — 조율자가 **모델 런 상한을 먼저 받는다.** 승인 없이 런을 돌리지 않는다.

- [ ] **Step 2: 실연**

`live-smoke.md` 3절 (a)~(e) 로 dev Gateway·서버·웹을 띄우고, 실제 에이전트에게 컴포넌트를 만들어 달라고 한다. 확인할 것:

- 모델이 스키마를 **올바로 채우는가** — 특히 `id` 유일성, `actions` 제약(버튼 ≤5 또는 셀렉트 1), `options` ≤25, 모달 필드 ≤5.
- **못 채울 때** 플러그인이 내는 오류 문구가 모델에게 쓸모 있는가(`components: v1 스키마 위반 — …`).
- 카드가 실제로 그려지고 눌리는가.
- 상호작용이 그 에이전트의 **다음 런**으로 이어지는가(`[dodok interaction]` 머리줄이 모델에게 읽히는가).

- [ ] **Step 3: 정리·문서**

3절 (f) 대로 내리고, `live-smoke.md` 에 components 절을 더한다 — 환경 실물, 런 표, 모델이 틀린 곳, 다음 사람이 그대로 따라 할 수 있는 절차. **시크릿 규칙**(`.env`·`openclaw.json` 을 `cat`·`grep` 하지 않는다, 토큰은 env 로만, 로그는 `grep -c -F -- "$TOK"` 로 0 확인)을 그대로 지킨다.

---

## Self-Review

**1. 스펙 대응**

| 스펙 절 | 태스크 |
| --- | --- |
| 0장 결정 1~10 | 1(결정 5)·2(결정 10 의 래퍼 없음 확인)·3(결정 6·7·10)·4(결정 2)·5(결정 1·8)·6(결정 4) |
| 1장 범위 | 태스크 1~11 전체 |
| 2장 구조 | 파일 구조 절 |
| 3장 계약 | 태스크 1 |
| 4.1 하이드레이션 | 태스크 1 Step 5~8 |
| 4.2 붙이는 자리 | 태스크 1 Step 9 |
| 4.3 `interact()` 변경 | 태스크 1 Step 10~12 |
| 4.4 검증 표 | 태스크 1 Step 13 + 태스크 7 |
| 5.1 카드 구성 | 태스크 2(골격)·4(모달 줄)·6(결과 줄) |
| 5.2 블록 | 태스크 2(버튼)·3(셀렉트)·5(나머지 넷) |
| 5.3 셀렉트 | 태스크 3 |
| 5.4 모달 | 태스크 4 |
| 5.5 비활성 규칙 | 태스크 2 |
| 5.6 결과 줄 | 태스크 6 |
| 5.7 접근성·초점 | 태스크 3(옵션 목록)·4(Dialog)·6(결정 뒤 초점) |
| 6장 오류 처리 | 태스크 2(토스트)·4(대화상자 안)·5(이미지 실패) |
| 7.1 `dev:fake` 키워드 | 태스크 7 |
| 7.2 통합 시나리오 | 태스크 7 |
| 7.3 웹 테스트 | 태스크 2~6 각각 |
| 7.4 브라우저 검증 | 태스크 9 |
| 7.5 dev 실연 | 태스크 11 |
| 8장 이월 셋 | 태스크 8 |
| 9장 완료 기준 | 태스크 7·9·11 |

**2. 자리표시 점검** — 「TBD」·「적절히」·코드 없는 구현 단계는 없다. 태스크 1 Step 9 는 자리를 `rg` 로 찾게 했다 — emit 자리 수가 이 계획 작성 시점에 확정되지 않아 의도한 것이고, **찾는 명령과 붙이지 않을 자리**를 못 박았다. 태스크 9 의 시나리오는 워커가 눈으로 볼 것이라 코드가 아니다.

**3. 타입 일관성** — `itemState(input: StateInput): ItemState` 는 태스크 2 가 정의하고 3·4 가 그대로 쓴다. `OptionList` 의 `props` 는 태스크 3 이 정의하고 4 의 `select`·`radio` 필드가 그대로 쓴다. `useInteract().send(itemId, values, opts?)` 는 태스크 2 가 정의하고 3·4·6 이 쓴다. `summarize(components, interaction)` 는 태스크 6 만 쓴다. `ScenarioScript.components` 는 태스크 7 만 쓴다. `withInteractions(db, msgs)` 는 태스크 1 만 쓴다. 이름이 갈리는 곳은 없다.

**4. 이 계획이 남기는 위험**

- **「이어가기」 시스템 카드 회귀** — 렌더러를 통째로 갈아 끼운다. 태스크 2 Step 6 에 회귀 테스트를, 태스크 9 시나리오 8 에 눈 확인을 뒀다.
- **`Message.interactions` 를 빠뜨린 emit 자리** — 하나라도 놓치면 그 경로로 온 메시지가 결과 줄을 지운다. 태스크 1 Step 13 의 첫 테스트가 세 경로를 함께 재고, 자리를 `rg` 로 전수 확인하게 했다.
- **모델이 스키마를 못 채울 수 있다** — 태스크 11 에서야 드러난다. 드러나면 고칠 곳은 플러그인의 스키마 설명(`components-schema.ts`)이지 계약이 아니다.
- **`media` 의 IP 노출** — 스펙 결정 8 의 알고 받는 대가다. Phase 2 ③ 에서 `artifact://` 가 자기 서버 경유가 되면 줄어든다.
