# Phase 2 ② components v1 완성 설계

**상태**: 설계 · 2026-09-21 작성
**범위**: components v1 웹 렌더러 전부(셀렉트·모달·section·separator·media·file), 상호작용 결과 줄, 초점·타이머 이월 셋
**앞선 근거**: 웹 MVP 스펙 `2026-09-19-web-mvp-design.md` 5.4(버튼만 그리는 Phase 1 범위) · 서버 코어 스펙 `2026-09-15-server-core-design.md` 3.10·9장(상호작용 계약) · Phase 2 ① 스펙 `2026-09-20-activity-approvals-design.md`(검증 규율·초점 규칙)

---

## 0. 결정 (브레인스토밍 2026-09-21)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **`media`·`file` 은 `https://` 만 그리고 `artifact://` 는 비활성 자리표시** | `artifact://` 해석(Gateway `artifacts.download` 단기 URL)은 Phase 2 ③ 첨부·이미지의 일이다. 자리만 만들어 두면 ③이 해석기만 끼운다. |
| 2 | **모달은 `triggerLabel` 버튼으로 연다** | 계약이 이미 그렇게 생겼다(`Modal.triggerLabel`). 버튼에 `opensModal` 류를 더하려면 shared·플러그인 스키마·서버 검증을 함께 고쳐야 하는데 얻는 것이 없다. **계약 변경 0.** |
| 3 | **실물 확인은 끝에 dev Gateway 실연 1회** | 구현·검증은 `dev:fake` 대본으로. 계약이 이미 확정돼 있어(Phase 1 에서 플러그인·서버가 다 돈다) 스파이크로 미리 잴 미지수가 없다. |
| 4 | **상호작용은 카드 안 「결과 줄」로 남긴다** | 지금은 버튼이 회색으로 변할 뿐이라 「내가 방금 뭘 보냈더라」를 되돌아볼 수 없다. 일반 메시지로 치면 버튼 한 번에 메시지가 하나씩 쌓이고 서버 메시지 경로를 고쳐야 한다. |
| 5 | **결과 줄은 메시지에 `interactions` 를 실어 보낸다** (아래 3장) | 테이블이 정본이라 **새로고침·새 탭에서 그대로** 보이고, `reusable` 도 되며, `componentState.consumed`(「더 못 쓴다」)와 뜻이 안 섞인다. 기존 `message.updated` 팬아웃을 그대로 탄다. |
| 6 | **셀렉트는 항상 「보내기」 확정식** | 단일·다중이 같은 모양이라 설명하기 쉽고 오조작이 적다. 단일 선택에 클릭이 한 번 더 드는 것이 대가다. |
| 7 | **옵션 목록은 한 렌더러**(단일→라디오, 다중→체크박스) | Radix `Select` 는 단일 전용이라 다중을 못 그린다. 옵션이 ≤25 뿐이라 목록으로 충분하고, **셀렉트 블록과 모달의 `select`·`radio` 필드가 같은 것을 쓴다** — 접근성을 한 곳에서만 맞춘다. `ui/select.tsx` 는 만들지 않는다. |
| 8 | **`media` 의 `https://` 이미지는 불러온다** — `referrerPolicy="no-referrer"` + `loading="lazy"` | MVP 는 마크다운 이미지를 추적 픽셀 때문에 안 불러오지만, 「이미지를 보여 주는 블록」이 링크만 내면 블록의 뜻이 사라진다. 레퍼러 유출은 막고 **IP 노출은 남는다** — Phase 2 ③에서 `artifact://` 로 가면 자기 서버 경유가 되니 임시 상태다. |
| 9 | **이월은 초점·타이머 계열만 끼운다**(8장) | 이번 하위 프로젝트가 모달·카드 초점과 타이머를 어차피 다룬다. 나머지 이월은 Phase 2 ⑤로. |
| 10 | **의존성 추가 0** | 모달 필드에 필요한 Radix 원시 요소는 이미 있는 `radix-ui` 1.6.7 에 들어 있다. 새 래퍼는 `ui/radio-group.tsx` **하나**. |

---

## 1. 범위

**넣는 것**

- 웹이 components v1 의 **모든 블록**을 그린다: `section`·`separator`·`actions`(버튼 + **셀렉트**)·`media`·`file`.
- **모달** — 필드 7종(text·textarea·number·date·select·checkbox·radio), 화면 검사, 제출, ack 오류 표시.
- **결과 줄** — 누가 무엇을 눌렀는지 카드 안에 남고 새로고침·새 탭에서도 보인다.
- 「이 메시지의 입력 요소는 Phase 2 에서 지원합니다」 자리표시 **제거**.
- 이월 셋(8장).

**안 넣는 것**

- `artifact://` 해석 — Phase 2 ③.
- 코드 하이라이트(`@streamdown/code`) — Phase 2 ⑤.
- components 계약 확장 — 블록·필드 스키마를 넓히지 않는다. 더하는 것은 `Message.interactions` 하나뿐(3장).
- 첨부 업로드 — Phase 2 ③.

**이미 있어서 안 건드리는 것**

shared 의 블록·필드·제약 스키마, 플러그인의 `message` 툴 JSON Schema 노출, 서버의 검증 5단계(`NOT_FOUND`→`EXPIRED`→`FORBIDDEN`→`CONSUMED`→`VALIDATION`)·저장·소비·런 전달(`apps/server/src/modules/components/`). 이번 작업은 **화면이 없어서 못 쓰던 것을 쓰게 만드는 것**이다.

---

## 2. 구조

### 2.1 웹 — 새 폴더 `apps/web/src/features/components/`

```
features/components/
├─ Components.tsx        카드 전체: 블록 순회 → 모달 트리거 → 결과 줄. 지금 ActionButtons 의 자리를 잇는다
├─ state.ts              (순수) 비활성 규칙 한 곳 — 연결·만료·소비·allowedUsers·전송 중
├─ interactions.ts       (순수) 결과 줄 문구 만들기
├─ useInteract.ts        component.interact 래퍼 — 전송 중 표시·ack 오류 토스트·초점 되돌리기
├─ OptionList.tsx        옵션 목록(단일=라디오 / 다중=체크박스). 셀렉트 블록과 모달 필드가 함께 쓴다
├─ blocks/
│  ├─ SectionBlock.tsx   MessageBody 로 마크다운 렌더
│  ├─ SeparatorBlock.tsx
│  ├─ ActionsBlock.tsx   버튼 줄 + 셀렉트
│  ├─ SelectItem.tsx     셀렉트 하나: 고르기 상태 + 「보내기」
│  ├─ MediaBlock.tsx     https 이미지 격자 / artifact 자리표시
│  └─ FileBlock.tsx      파일 줄 / artifact 자리표시
└─ modal/
   ├─ ComponentModal.tsx 트리거 버튼 + Dialog + 제출
   ├─ fields.tsx         필드 7종 → 위젯
   └─ validate.ts        (순수) 화면 검사 — required·min/max·길이
```

`features/messages/ActionButtons.tsx` 는 **없어진다**. 호출부 둘(`MessageItem.tsx:78`, `SystemCard.tsx:35`)이 `<Components message={message} />` 로 바뀐다.

> **회귀 위험**: 「이어가기」 시스템 카드(`relay_limit`)도 같은 렌더러를 탄다(`SystemCard.tsx`). 그 카드는 버튼 하나(`continue_relay`)뿐이고 서버가 그 id 를 가로채 릴레이를 잇는다(`modules/router/service.ts`). 렌더러를 갈아 끼우면서 **이 카드가 그대로 동작해야 한다** — 이제 결과 줄도 하나 붙는다(「@나 — 이어가기」).

### 2.2 새 UI 래퍼

`apps/web/src/ui/radio-group.tsx` — `radix-ui` 의 `RadioGroup` 래퍼. 다른 `ui/*` 파일과 같은 모양(`cn`, `data-slot`).

### 2.3 서버

- `apps/server/src/modules/messages/service.ts` — `withInteractions(db, msgs)` 하이드레이션 + 읽기 경로에 배선.
- `apps/server/src/modules/components/service.ts` — 상호작용마다 `message.updated` (지금은 `!reusable` 일 때만).
- `apps/server/src/dev/fake-*` — 대본에 components 키워드 다섯(7장).

### 2.4 shared

`packages/shared/src/domain/index.ts` — `MessageInteraction` 타입 + `Message.interactions` 필드 + `INTERACTIONS_MAX`.

---

## 3. 계약 변경 (shared)

`components/index.ts` 는 **한 줄도 바뀌지 않는다.** `domain/index.ts` 에만 더한다.

```ts
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

/** 메시지에 싣는 상호작용 개수 상한. 넘으면 최신 쪽을 남긴다. */
export const INTERACTIONS_MAX = 20;
```

`Message` 에 한 필드:

```ts
interactions: z.array(MessageInteraction).max(INTERACTIONS_MAX).default([]),
```

**`.default([])` 인 까닭**: 경계를 넘는 모든 `Message` 에 이 필드가 **항상 있어야 한다**. 없는 채로 `message.updated` 가 오면 웹 캐시가 그 메시지를 통째로 갈아 끼우면서 기존 결과 줄을 지워 버린다 — Phase 2 ① 이 「구독 ack 에 없으면 새 탭에서 안 보인다」로 한 번 덴 것과 같은 부류다. 기본값이 그 함정을 없앤다. 저장된 옛 행도 그대로 파싱된다(`parseStored`).

`ItemId` 는 `components/index.ts` 에서 가져온다(이미 export 돼 있다).

**상한 20의 대가**: `reusable` 카드는 20을 넘을 수 있다. 넘으면 최신 20건만 오고, 카드는 그때 「최근 20건」이라고 말한다(웹이 `interactions.length === INTERACTIONS_MAX` 로 판단). 정확히 20건일 때도 같은 문구가 나와 더 있는 것처럼 읽힐 수 있다 — **알고 받는 비용**이다. 전체 기록은 DB 와 에이전트에 남는다.

`ComponentInteract`(wire, 클라이언트→서버)는 **바뀌지 않는다**. 셀렉트는 `values: { values: string[] }`, 모달은 `values: { fields: {...} }`, 버튼은 `values: {}` — 서버의 `valuesSchemaFor` 가 이미 그대로 받는다.

---

## 4. 서버

### 4.1 하이드레이션

`modules/messages/service.ts` 에:

```ts
export function withInteractions(db: DbOrTx, msgs: Message[]): Message[];
```

- `components !== undefined` 인 메시지만 고른다(보통 한 페이지에 0~2건). 그런 메시지가 없으면 **질의하지 않고** 원본을 돌려준다.
- `component_interactions` 를 `messageId IN (...)` 한 번으로 읽는다(인덱스 `component_interactions_message` 가 이미 있다).
- 메시지별로 `createdAt` 오름차순 정렬, 20을 넘으면 **최신 쪽 20건**을 남긴다.
- `rowToMessage` 는 **순수한 채로 둔다** — DB 를 모르는 변환이라는 성질을 지킨다.

### 4.2 붙이는 자리 — 클라이언트에 나가는 모든 곳

| 자리 | 지금 | 바뀜 |
| --- | --- | --- |
| `listMessages` 결과 | 순수 행 변환 | `withInteractions` 통과 |
| REST `GET /messages/:id` 류 | 〃 | 〃 |
| 구독 ack 의 `messages` | `listMessages` 를 쓴다 | 자동으로 따라온다 |
| `bus.emit("message.created")` 페이로드 | 순수 행 변환 | `withInteractions` 통과 |
| `bus.emit("message.updated")` 페이로드 | 〃 | 〃 |

**내부 검증용 `getMessage`** (예: `components/service.ts` 의 `interact()` 안, 라우터)는 **붙이지 않는다** — 상호작용 기록이 필요 없고, 붙이면 트랜잭션마다 질의가 하나 는다.

> 규칙 한 줄: **「클라이언트가 볼 Message 는 항상 하이드레이션을 거친다. 서버 내부에서만 쓸 Message 는 거치지 않는다.」** 이 규칙을 테스트로 잠근다(4.4).

### 4.3 `interact()` 변경

- 지금은 `!components.reusable` 일 때만 `message.updated` 를 쏜다. → **상호작용마다 항상 쏜다.** 재사용 카드도 결과 줄이 실시간으로 늘어야 한다.
- 소비 갱신 규칙(`!reusable` 일 때만 `consumed` 에 넣는다)은 **그대로**다.
- 검사·저장·소비가 한 동기 트랜잭션인 성질도 그대로다(같은 아이템을 동시에 눌러도 한 번만 통과).

### 4.4 검증 표 (이 장이 맞는지 재는 방법)

| 재는 것 | 방법 |
| --- | --- |
| 하이드레이션이 **모든** 클라이언트 경로에 붙었나 | 상호작용 뒤 ① 새 구독 ack ② `message.updated` ③ REST 재조회 **셋 다** 결과 줄을 갖는다. 한 자리를 빼면 그 테스트만 빨개진다 |
| 내부 `getMessage` 는 안 붙나 | `interact()` 안에서 읽은 메시지에 `interactions` 가 비어 있다(질의 수를 센다) |
| 상한·정렬 | 21건을 넣고 **최신 20건**이 `createdAt` 오름차순으로 온다 |
| `reusable` 도 방송되나 | `reusable: true` 카드를 두 번 눌러 `message.updated` 가 **두 번** 나가고 결과 줄이 2건 |
| `consumed` 규칙 불변 | `reusable: true` 는 여전히 `consumed` 가 비어 있다 |
| 컴포넌트 없는 메시지 | 질의가 **0회**, `interactions` 는 `[]` |

---

## 5. 웹

### 5.1 카드 구성

```
<Components message>
  1. blocks 를 배열 순서대로
  2. modal 이 있으면 triggerLabel 버튼 한 줄
  3. interactions 결과 줄들 (오래된 것부터)
```

`components` 가 없으면 `null`(지금과 같다).

### 5.2 블록

| 블록 | 그리는 법 |
| --- | --- |
| `section` | `text` 를 **메시지 본문과 같은 렌더러**(`MessageBody`)로. 마크다운 규칙이 두 벌 되지 않는다(원시 HTML 끔, 마크다운 이미지는 링크) |
| `separator` | `ui/separator` 한 줄 |
| `actions` (버튼) | 지금 `ActionButtons` 동작 그대로 — 링크 버튼은 새 탭, 그 밖은 `component.interact` |
| `actions` (셀렉트) | 5.3 |
| `media` | `https://` → 이미지 격자(≤10, `referrerPolicy="no-referrer"`·`loading="lazy"`·`alt` 없으면 빈 문자열로 장식 처리). `artifact://` → 비활성 자리표시 「첨부는 곧 지원합니다」 |
| `file` | `https://` → 이름·크기(있으면) + 「열기」(`target="_blank" rel="noopener noreferrer"`). `artifact://` → 비활성 자리표시 |

### 5.3 셀렉트

- `OptionList` 로 그린다 — `multi: false` 면 라디오, `true` 면 체크박스. 옵션 6개를 넘으면 스크롤 상자. `placeholder` 는 목록 위 이름으로 쓴다(없으면 이름 없이).
- **「보내기」 버튼**이 확정한다. 켜지는 조건: `minValues ?? (multi ? 0 : 1)` 이상, `multi ? (maxValues ?? 25) : 1` 이하.
- 보내면 `component.interact` 에 `values: { values: [...] }`.
- 비활성(5.5)이면 목록과 버튼이 함께 잠긴다.

### 5.4 모달

- `triggerLabel` 버튼 → `ui/dialog`. Radix Dialog 가 초점을 가두고 닫을 때 트리거로 돌려준다.
- 필드 매핑: `text`→`Input` · `textarea`→`Textarea` · `number`→`Input[type=number]` · `date`→`Input[type=date]` · `select`→`OptionList` · `checkbox`→`ui/checkbox` · `radio`→`OptionList`(단일).
- `default` 를 초깃값으로, `required`·`min`/`max`·`minLength`/`maxLength` 를 **제출 전에 화면에서** 막는다(`modal/validate.ts`, 순수).
- 제출 → `values: { fields: { <fieldId>: <값> } }`. 성공하면 닫고, **ack 오류면 열어 둔 채** 필드 아래 또는 대화상자 하단에 문구(`ui/field-error`).
- 서버가 정본이다 — 화면 검사는 편의일 뿐이고 서버 `valuesSchemaFor` 가 다시 본다.

### 5.5 비활성 규칙 (`state.ts`, 순수)

한 함수가 아이템 하나의 상태를 돌려준다:

```ts
type ItemState = { disabled: boolean; reason?: "disconnected" | "expired" | "consumed" | "forbidden" | "busy" };
```

- `disconnected` — wire 가 `connected` 가 아니거나 소켓이 없거나 `components.id` 가 없다
- `expired` — `componentState.expiresAt` 이 지났다(지금처럼 만료 시각에 한 번 다시 그린다)
- `consumed` — `!reusable` 이고 `componentState.consumed` 에 그 `itemId` 가 있다
- `forbidden` — `allowedUsers` 가 있고 내 id 가 그 안에 없다
- `busy` — 그 아이템의 응답을 기다리는 중

지금 `ActionButtons` 안에 흩어진 판단을 그대로 옮긴 것이다. 버튼·셀렉트·모달이 **같은 함수**를 쓴다.

### 5.6 결과 줄 (`interactions.ts`, 순수)

```ts
export function summarize(
  components: ComponentsV1,
  interaction: MessageInteraction,
): { itemLabel: string; valueText?: string } | undefined;
```

- 버튼 → `{ itemLabel: 버튼 label }`
- 셀렉트 → `{ itemLabel: placeholder ?? id, valueText: 고른 옵션 label 들 }`
- 모달 → `{ itemLabel: modal title, valueText: 필드별 「라벨: 값」 }`
- 카드에서 그 `itemId` 를 못 찾으면 `undefined`(카드가 편집됐거나 계약이 바뀐 경우) → 그 줄은 **그리지 않는다**.

화면 문구는 `@<핸들> — <itemLabel>: <valueText>`. 핸들은 이미 있는 `useAuthors()` 로 풀고, 모르는 사용자면 「알 수 없는 사용자」.

> **서버의 `formatInteractionText` 와 일부러 따로 둔다.** 그쪽은 **에이전트용**이라 기계가 읽는 머리줄(`[dodok interaction] user=… kind=… component=… item=…`)이 붙는다. 청중이 달라 한 벌로 합치면 둘 다 나빠진다. 대신 **같은 라벨 해석 규칙**을 쓰는지 테스트로 맞댄다(7장).

### 5.7 접근성·초점

- 옵션 목록은 `fieldset` + `legend`(또는 `role="radiogroup"` + 이름). 색만으로 상태를 말하지 않는다.
- 모달은 Radix Dialog 의 기본 동작(초점 가둠·Esc·트리거 복귀)을 쓴다.
- **결정 뒤 초점**은 Phase 2 ① D13 규칙 그대로 — **내가 누른** 카드의 결과 줄로 옮긴다. 다른 사람이 누른 것이나 만료로 사라지는 것은 초점을 뺏지 않는다.
- 비활성 사유를 `title`/`aria-describedby` 로 말한다(회색으로만 두지 않는다).

---

## 6. 오류 처리

- `component.interact` ack 오류 코드는 이미 정해져 있다(`EXPIRED`·`CONSUMED`·`FORBIDDEN`·`VALIDATION`·`NOT_FOUND`·`TIMEOUT`). 버튼·셀렉트는 **토스트**, 모달은 **대화상자 안**에 보인다(대화상자가 토스트를 가린다).
- `VALIDATION` 의 `details.issues` 가 필드를 가리키면 그 필드 아래에 붙인다. 못 가리면 하단 한 줄.
- 서버가 만드는 문구를 그대로 쓰지 않는다 — 코드별 한국어 문구는 웹이 정한다(지금 `ERR` 표를 잇는다).
- `media` 이미지 로드 실패는 `alt` 와 링크로 물러난다(깨진 아이콘을 두지 않는다).

---

## 7. 검증

### 7.1 `dev:fake` 대본 키워드 여섯

| 키워드 | 내는 것 |
| --- | --- |
| 「폼」 | 모달 1개 — `text`·`textarea`·`number`·`date`·`select` |
| 「폼 둘」 | 모달 1개 — `checkbox`·`radio` + 필수 `text` 1 |
| 「고르기」 | 셀렉트 단일 1개 + 다중(`minValues`·`maxValues`) 1개 |
| 「카드」 | `section`·`separator`·`actions`·`media`(https + artifact)·`file` 섞인 카드 |
| 「재사용」 | `reusable: true` 버튼 카드 |
| 「짧게」 | `ttlMs` 를 짧게(만료를 눈으로 보려고) |

### 7.2 서버 통합 시나리오

`apps/server/test/integration/` 에 components 시나리오를 더한다 — 4.4 표의 여섯을 실제 어댑터 + 가짜 Gateway·플러그인 위에서.

### 7.3 웹 테스트

블록별 렌더, 셀렉트 min/max 경계, 모달 필드 7종의 화면 검사, 결과 줄 문구, `state.ts` 의 다섯 사유, ack 오류 표시, **「이어가기」 시스템 카드 회귀**.

### 7.4 브라우저 검증 → 수정 → 재검증

Phase 2 ① 규율 그대로:
- 리뷰 브리프에 **돌연변이 확인 의무**(리뷰어가 직접 분기를 죽여 빨강을 눈으로 본다).
- 수정 라운드 뒤에는 **범위 한정 재리뷰가 기본**. Phase 2 ① 에서 **수정이 만든 회귀 둘**을 이 단계가 잡았다.
- 브라우저 검증도 1차 → 수정 → **재검증**(1차 재현 절차를 그대로 밟고 전·후를 수치로).

### 7.5 dev Gateway 실연 (마지막)

실제 모델이 `message` 툴로 셀렉트·모달을 만들어 내는지. **모델 런 수는 그때 사용자 승인을 받는다.** 결과는 `docs/guides/live-smoke.md` 에 절로 남긴다.

확인할 것: 모델이 스키마를 올바로 채우는가(특히 `id` 유일성·`actions` 제약·`options` 상한), 못 채울 때 플러그인이 내는 오류 문구가 모델에게 쓸모 있는가, 카드가 실제로 그려지고 눌리는가, 상호작용이 그 에이전트의 다음 런으로 이어지는가.

---

## 8. 이월 끼워넣기 (초점·타이머 계열)

`docs/plan.md` 8장 「이월」 에서 셋만 가져온다. 나머지는 그대로 둔다.

1. **넓은 화면 「설정 닫기」 초점 되돌리기** — 누르면 그 링크가 언마운트되며 초점이 `body` 로 간다. 이번에 모달·카드 초점을 다루니 같은 규칙으로 닫는다.
2. **D6 — 같은 승인의 카운트다운 둘이 15% 프레임에서 1초 어긋난다** — 카드마다 `setInterval` 을 따로 돌린다. `useNowTick`(Phase 2 ① 에서 만든 공용 틱)으로 묶는다.
3. **자리값의 「소요」가 목록 조회 실패 중에도 흐른다** — 앱은 그 런이 더는 진행 중이 아님을 아는데 줄은 계속 흐른다. 자리값에 「더 안 흐른다」 표시를 달아 `hasFlowingDuration` 에서 뺀다(같은 훅을 건드리므로 2번과 함께).

---

## 9. 완료 기준

1. **에이전트가 버튼/모달로 사용자 입력을 받아 작업을 이어간다**(계획서 8장 Phase 2 완료 기준). → 확인: 통합 시나리오 + `dev:fake` 브라우저 검증에서 모달 제출 → 그 에이전트의 다음 런이 제출 값을 받는다.
2. components v1 의 **모든 블록과 필드**가 화면에 그려지고, 자리표시 문구가 없다. → 확인: 블록 5종·필드 7종 각각의 웹 테스트 + 브라우저 검증 「카드」·「폼」 시나리오.
3. **결과 줄이 새로고침·새 탭에서도 보인다.** → 확인: 4.4 표의 세 경로 + 브라우저 검증에서 새 탭으로 확인.
4. 「이어가기」 시스템 카드가 **그대로 동작한다**. → 확인: 웹 테스트 + 브라우저 검증 회귀 시나리오.
5. 8장 이월 셋이 정리되고 루트 네 검사(`pnpm test`·`typecheck`·`lint`·`fmt:check`)가 통과한다.
6. 실제 모델이 셀렉트·모달을 만들어 내는 것을 dev Gateway 실연으로 한 번 본다(7.5).

---

## 10. 열린 문제 (범위 밖 기록)

- **`media` 의 IP 노출** — 결정 8의 대가. Phase 2 ③ 에서 `artifact://` 가 자기 서버 경유가 되면 사라진다. 외부 `https://` 이미지는 그 뒤에도 남는다 — 프록시를 둘지는 그때 판단한다.
- **`interactions` 상한 20** — `reusable` 카드가 많이 눌리면 오래된 것이 잘린다(3장). 늘려야 할 근거가 생기면 페이지 넘김을 붙인다.
- **`ComponentsV1.text`(대체 텍스트)를 웹이 안 쓴다** — 「컴포넌트를 못 그리는 곳」용인데 이제 웹은 다 그린다. 푸시 알림 본문(Phase 2 ④)이 쓸 자리다.
- **모달은 메시지당 1개** — 계약이 그렇다. 둘 이상이 필요하면 카드를 나누면 된다. 계약을 넓히는 것은 components v2 의 일이다.
- **결과 줄의 라벨 해석이 서버와 두 벌** — 청중이 달라 일부러 나눴다(5.6). 같은 규칙을 쓰는지는 테스트로 맞대지만, 한쪽만 고치면 갈릴 수 있다.
