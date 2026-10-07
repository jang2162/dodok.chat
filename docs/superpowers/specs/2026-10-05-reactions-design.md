# 리액션 — 사람이 다는 고정 이모지 8종과 에이전트에게 다음 턴에 알리기 설계

**상태**: 설계 확정(2026-10-05), 구현 전.
**범위**:
- 사람이 보통 메시지에 고정 이모지 8종으로 리액션을 달고, 누가 달았는지 본다
- 에이전트가 쓴 메시지에 달린 리액션을 그 에이전트의 **다음 런** 인바운드에 사실로 싣는다(런을 새로 시작하지 않는다)

**앞선 근거**:
- Slack·Buzz 참고 후보 조사(이 대화의 결론): Buzz 는 리액션을 승인·워크플로 신호로 쓰고, Slack 은 리액션이 기본기다. 리액션을 트리거로 쓰는 것은 예약·웹훅 스펙의 몫이다
- 결과 줄 본보기: components v1 의 `Message.interactions` — 원본 표(`component_interactions`)·`withInteractions` 하이드레이션·wire 경계 팬아웃(`apps/server/src/realtime/events.ts`)·`.default([])`
- 턴 인바운드: 서버 `apps/server/src/modules/runs/context.ts` 의 `buildInboundDeliver`, 계약 `packages/shared/src/bridge/index.ts` 의 `InboundContext`, 플러그인 헤더 `packages/openclaw-plugin/src/context.ts` 의 `formatInboundContext`, 러너 턴 사실 `packages/shared/src/runner/prompt.ts` 의 `buildTurnFacts`(서버 쪽 `packages/runner-adapter` 가 만든다)
- OpenClaw SDK(2026.9.4)의 `enqueueSystemEvent` 는 쓰지 않는다 — 결정 3
- 보관·비활성화: 채널 보관·멤버 비활성화 스펙 `docs/superpowers/specs/2026-10-06-channel-archive-member-deactivate-design.md` — 보관한 채널의 쓰기는 `assertChannelWritable`(`apps/server/src/modules/channels/service.ts`)이 409 `CHANNEL_ARCHIVED` 로 막는다
- 역할: 팀 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」

---

## 0. 결정 (브레인스토밍 2026-10-05)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **사람만 리액션을 달고, 에이전트는 자기 메시지에 달린 것을 다음 턴에 안다** | 사용자 결정. 에이전트가 리액션을 다는 것(👀·✅)과 리액션이 런을 시작하는 것은 범위 밖이다(11장). |
| 2 | **고정 8종** 👍 👎 ❤️ 😂 🎉 👀 ✅ ❓ | 사용자 결정. 에이전트가 받을 때 뜻이 분명하고, 서버 검증이 목록 하나로 끝나며, 피커 의존성이 없다. |
| 3 | **서버가 「아직 안 알린 리액션」을 세션 커서로 기억했다가 다음 런의 `InboundContext.reactions` 에 싣는다** | 사용자 결정. 두 어댑터가 같은 길을 쓰고, 플러그인이 끊긴 동안의 리액션을 잃지 않으며, 알리기 전에 지운 것은 저절로 빠진다. 밀어 넣기(`enqueueSystemEvent`)는 러너용 길을 따로 만들어야 하고 끊긴 동안의 것을 잃는다. |
| 4 | **wire 는 토글이 아니라 「켜기/끄기」**(`on: boolean`) | 두 번 눌리거나 다시 보내도 결과가 같다. |
| 5 | **리액션은 런을 시작하지 않는다** — 그 세션에 다음 런이 없으면 알려지지 않는다 | 결정 1. 비용이 없다. |
| 6 | **알린 뒤 지운 리액션은 되돌려 알리지 않는다** | 「되돌림」 사실은 모델에게 잡음이다. 다시 달면 새 리액션으로 다시 간다. |
| 7 | **리액션은 읽지 않음·푸시에 영향이 없다** | 읽지 않음 스펙의 정의는 메시지만 센다. |

## 1. 범위

**한다**
- `message_reactions` 표, `agent_sessions.reactions_seen_at` 열
- shared `REACTION_EMOJIS`·`MessageReaction`·`Message.reactions`·wire `reaction.set`·`InboundContext.reactions`·`reactionsOmitted`·`formatReactionFacts`
- 서버 `modules/reactions/`(쓰기·집계·커서), `buildInboundDeliver` 의 반응 싣기와 `send` 성공 뒤 커서 올리기, 리셋 때 커서 올리기
- 플러그인 헤더 블록, 러너 어댑터 턴 사실 블록
- 웹 피커·칩
- 역할 매트릭스·문서(`user-guide.md`·`agent-guide.md`·`deploy.md` 「업데이트」·`project-structure.md`)

**하지 않는다** — 11장.

## 2. 무엇에 달 수 있나

- `kind = "normal"` 메시지(사람·에이전트, 최상위·스레드 답글). 시스템 메시지와 아직 저장되지 않은(보내는 중) 메시지에는 달 수 없다.
- 한 사람이 한 메시지에 이모지 여러 개를 달 수 있고, 같은 이모지는 한 번뿐이다.
- 권한은 owner·admin·member 누구나.
- **보관한 채널의 메시지에는 달지도 지우지도 못한다** — 409 `CHANNEL_ARCHIVED`(`assertChannelWritable`). 이미 달린 칩은 읽기 전용으로 보인다.
- 비활성 멤버의 리액션은 남는다(메시지가 남는 규칙과 같다). 표시는 「@핸들 (비활성)」.

## 3. 데이터 모델

### 3.1 `message_reactions` (새 표)

| 열 | 꼴 | 비고 |
| --- | --- | --- |
| `message_id` | text, FK `messages.id` `ON DELETE CASCADE` | |
| `user_id` | text, FK `users.id` `ON DELETE CASCADE` | 사용자 행은 지워지지 않는다(비활성화) — cascade 는 정합성용 |
| `emoji` | text not null | `REACTION_EMOJIS` 중 하나 |
| `created_at` | ts not null | 커서 비교에 쓴다 |

기본 키 `(message_id, user_id, emoji)`, 인덱스 `(message_id)`·`(created_at)`.

### 3.2 `agent_sessions.reactions_seen_at` (새 열)

nullable ts. `agent_sessions` 에는 생성 시각 열이 없으므로:
- 마이그레이션은 기존 행을 **마이그레이션 시각**으로 채운다 — 리액션 기능 이전에 리액션은 없으니 잃는 것이 없다.
- 세션 행을 새로 만드는 자리는 만들 때 지금 시각을 넣는다.
- 그래도 null 인 행을 만나면 **실을 것이 없는 것**으로 읽고, 그 런의 `send` 가 성공하면 그때 시각으로 채운다 — 옛 리액션을 한꺼번에 싣는 쪽으로 틀리지 않게.

## 4. 계약

### 4.1 shared 도메인

```ts
export const REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🎉", "👀", "✅", "❓"] as const;
export const ReactionEmoji = z.enum(REACTION_EMOJIS);
/** 메시지 하나의 이모지 하나 — 서버가 REACTION_EMOJIS 순서로 모아 싣는다 */
export const MessageReaction = z.object({ emoji: ReactionEmoji, count: z.int().min(1), userIds: z.array(Id) });
// Message 에 더함 — interactions 와 같은 까닭으로 기본값이 있다(없는 채로 message.updated 가 오면 웹 캐시가 칩을 지운다)
reactions: z.array(MessageReaction).max(REACTION_EMOJIS.length).default([]),
```

### 4.2 wire

| 방향 | 이름 | 페이로드 | 비고 |
| --- | --- | --- | --- |
| 클라이언트 → 서버 | `reaction.set` | `{ messageId: Id, emoji: ReactionEmoji, on: boolean }`, ack `null` | 버킷 `chatter` |
| 서버 → 클라이언트 | `message.updated` | (기존) | 상태가 바뀌었을 때만 그 메시지의 채널 룸에. 리액션은 하이드레이션이 붙인다 |

### 4.3 인바운드 (`packages/shared/src/bridge/index.ts`)

```ts
export const InboundReaction = z.object({
  messageId: Id,
  excerpt: z.string().max(60), // 그 메시지의 읽는 글 앞 60자
  emoji: ReactionEmoji,
  by: z.string(),             // 단 사람의 핸들(비활성 멤버도 그 핸들)
  at: IsoDateTime,
});
// InboundContext 에 더함
reactions: z.array(InboundReaction).max(20).optional(),
reactionsOmitted: z.int().min(1).optional(),
```

옛 플러그인은 `z.object` 가 모르는 키를 버리므로 새 필드가 와도 깨지지 않는다(반응만 보이지 않는다).

### 4.4 에이전트가 보는 글 — `formatReactionFacts(reactions, omitted?)` (shared)

```
반응(지난 턴 뒤 네 메시지에 달린 것):
- @mia 👍 "배포 순서는 먼저 DB 마이그레이션을…"
- @owner 👎 "테스트는 모두 통과했습니다"
(외 3개)
```

`reactions` 가 비면 빈 문자열. 줄 순서는 `at` 오름차순. 플러그인과 러너 어댑터가 같은 함수를 쓴다 — 두 어댑터의 문구가 갈라지지 않는다.

## 5. 서버

### 5.1 `modules/reactions/`

- `setReaction(db, bus, workspaceId, userId, { messageId, emoji, on }, now)`: 메시지가 없거나 다른 워크스페이스면 `NOT_FOUND`, `kind !== "normal"` 이면 `VALIDATION`. `on` 이면 `INSERT … ON CONFLICT DO NOTHING`, 아니면 `DELETE`. 바뀐 행이 있을 때만 `bus.emit("message.updated", { message })`.
- `withReactions(db, messages)`: 메시지 id 로 IN 질의 한 번, `REACTION_EMOJIS` 순서·이모지마다 `created_at` 순 `userIds`. `apps/server/src/modules/messages/service.ts` 의 `hydrateForClient` 에 끼운다 — `listMessages`·구독 ack·`threadRootsOf`·wire 팬아웃이 모두 그것을 지난다(`message.created` 팬아웃도 리액션을 붙인다 — 새 메시지는 비어 있다).
- `pendingReactionsFor(db, { channelId, agentId, threadRootId, since })`: 그 에이전트가 쓴(`author_type = "agent" AND author_id = agentId`) 그 범위(`threadRootId` 가 없으면 `thread_root_id IS NULL`, 있으면 루트 자신 또는 `thread_root_id = threadRootId`)의 메시지에 `created_at > since` 로 달린 리액션을 `created_at` 오름차순으로. 21개까지 읽어 20개를 넘으면 **최근 20개**를 남기고 나머지 수를 `omitted` 로 센다(전체 수는 `COUNT` 한 번).
- `advanceReactionCursor(db, sessionRowId, to)`: `reactions_seen_at = max(old, to)`.

### 5.2 런에 싣기

- `buildInboundDeliver` 가 세션 행의 `reactions_seen_at` 으로 `pendingReactionsFor` 를 불러 `context.reactions`(·`reactionsOmitted`)를 채우고, 실은 것 가운데 가장 늦은 `created_at` 을 오케스트레이터에 돌려준다(`InboundDeliver` 밖 — 어댑터에 보이지 않는 값).
- 오케스트레이터는 `adapter.send` 가 `ok` 이면 그 값으로 `advanceReactionCursor`. 실패·대기열 거절이면 그대로 둔다(다음 런에 다시 실린다).
- `markSessionReset` 이 `reactions_seen_at` 을 리셋 시각으로 올린다(새 세션은 옛 메시지를 모른다). 채널 규칙 리비전이 바뀌어 러너 세션을 새로 여는 경로도 같다.

### 5.3 어댑터

- **OpenClaw 플러그인**: `formatInboundContext` 가 `formatReactionFacts(d.context.reactions ?? [], d.context.reactionsOmitted)` 가 비어 있지 않으면 헤더의 `---` 바로 앞에 넣는다. 플러그인 번들이 바뀌므로 연결 페이지가 「서버 빌드와 다름」을 보이고, 재설치가 필요하다(`docs/guides/deploy.md` 「업데이트」).
- **러너 어댑터**(`packages/runner-adapter`): `buildTurnFacts` 에 `reactions`·`reactionsOmitted` 를 넘겨 같은 블록을 턴 사실 끝에 붙인다. 턴 사실은 서버가 만들어 보내므로 사람 머신의 `dodok-runner` 는 다시 설치하지 않는다.

## 6. 웹

- 메시지 행의 마우스 올림 동작(타임스탬프가 나타나는 자리, `features/messages/MessageItem.tsx`)에 「반응 추가」 버튼, 좁은 화면은 기존 메시지 메뉴에 같은 항목. 누르면 8개 팝오버(키보드: 화살표·Enter·Esc, 닫히면 초점이 버튼으로).
- 메시지 아래 칩 `👍 3` — 내가 단 칩은 강조(`aria-pressed`), 누르면 켜기/끄기, 마우스 올림·초점 시 「@mia, @owner」(사람 목록 `people` 으로 핸들을 푼다, 비활성 멤버는 「@핸들 (비활성)」). 보관한 채널이면 「반응 추가」를 숨기고 칩은 누를 수 없다.
- 낙관적 갱신: 누르면 캐시의 `reactions` 를 먼저 바꾸고 `reaction.set` 을 보낸다. 실패하면 되돌리고 토스트(「반응을 저장하지 못했습니다」). 서버의 `message.updated` 가 정본이다.
- 시스템 메시지·보내는 중 항목에는 버튼·칩이 없다.
- 기능 폴더 `features/reactions/`(피커·칩·`useSetReaction`).

## 7. 권한

wire `reaction.set` 은 owner·admin·member 모두 허용. 사용자 id 는 세션에서만 온다. 팀 스펙 「역할과 권한」 표에 한 줄을 더하고 매트릭스 테스트에 넣는다.

## 8. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 목록 밖 이모지·형식 틀림 | `VALIDATION` |
| 메시지 없음·다른 워크스페이스 | `NOT_FOUND` |
| 시스템 메시지 | `VALIDATION` |
| 보관한 채널 | 409 `CHANNEL_ARCHIVED` |
| 이미 그 상태 | 성공, `message.updated` 없음 |
| 레이트 초과 | `RATE_LIMITED` — 웹은 되돌리고 토스트 |
| 런 보내기 실패 | 커서를 올리지 않는다 — 다음 런에 다시 실린다 |
| 옛 플러그인 | 새 필드를 버린다 — 런은 그대로, 반응만 안 보인다 |

## 9. 테스트·검증

- **shared**: 이모지 enum · `formatReactionFacts`(줄 형식·`at` 순·「외 n개」·빈 배열이면 빈 문자열) · `InboundContext.reactions` 파싱 · **옛 `InboundContext` 스키마(필드 없는 사본)가 새 페이로드를 받아들임**.
- **서버 단위**: 켜기·끄기·같은 상태 다시(이벤트 없음) · 집계 순서·`userIds` 순서 · 시스템 메시지 거절 · `pendingReactionsFor` 범위(채널은 최상위만, 스레드는 루트+답글, 남이 쓴 메시지 제외, 다른 에이전트 메시지 제외) · 알리기 전에 지운 것 빠짐 · 20개 자르기와 `omitted` · 마이그레이션이 기존 세션 행 커서를 채움 · 커서가 null 인 행은 아무것도 싣지 않음.
- **서버 통합(가짜 Gateway·플러그인·러너)**: mia 가 에이전트 답에 👍 → 다음 멘션 런의 `context.reactions` 에 실리고 그다음 런에는 없음 · `send` 실패(가짜 플러그인 끊김) 뒤 다음 런에 다시 실림 · 스레드 리액션은 그 스레드 런에만 · 「새 대화」 뒤에는 안 실림 · 러너 에이전트의 턴 사실에 블록 · 두 창에 `message.updated` 로 칩이 맞음.
- **플러그인 단위**: 헤더 블록이 `---` 앞, 없으면 줄 없음.
- **역할 매트릭스**: `reaction.set` 세 역할 허용, membership 없는 세션 거절.
- **웹 단위**: 피커 키보드·초점 · 칩 켜기/끄기 · 실패 되돌림 · 내 칩 강조 · 툴팁(비활성 멤버) · 보관한 채널에서 버튼 없음·칩 비활성 · 시스템 메시지에 버튼 없음.
- **브라우저(dev:fake, 모델 런 0회)**: owner·mia 두 창 실시간 칩 · 에이전트 답에 단 리액션이 다음 멘션 뒤 가짜 Gateway 가 받은 인바운드에 있음(dev:fake 로그) · 390px 메뉴로 달기.
- **실연(dev Gateway, 런 0회 하네스 — `docs/guides/live-smoke.md` 「런 0회 하네스」)**: 실제 OpenClaw 가 헤더 블록을 모델 입력(가짜 CLI 가 받은 프롬프트)에 싣는다.

## 10. 완료 기준

- 9장의 자동 테스트가 모두 통과하고, 실행 개수를 보고에 적는다.
- dev:fake 브라우저 항목과 런 0회 실연이 통과한다.
- `user-guide.md`(반응 달기), `agent-guide.md`(「반응」 블록의 뜻과 AGENTS.md 에 붙일 문장), `deploy.md` 「업데이트」(플러그인 재설치), `project-structure.md`(`modules/reactions/`·`features/reactions/`)가 있다.

## 11. 열린 문제 (범위 밖 기록)

- **에이전트가 리액션을 다는 것** — OpenClaw `react` 액션(`CHANNEL_MESSAGE_ACTION_NAMES` 의 `react`, `readReactionParams`)과 러너 `mcp__dodok__react`. 👀(받았음)·✅(끝냈음) 자동 표시도 여기.
- **리액션이 런을 시작하는 것**(예: 🔁 = 다시 해 줘) — 예약·웹훅 스펙의 트리거 쪽.
- **이모지 늘리기·자유 이모지** — 목록이 shared 상수 하나라 늘리기는 쉽다. 자유 이모지는 피커 의존성과 「이모지 하나인가」 판정이 필요하다.
- **사람 메시지에 달린 리액션을 에이전트에게 알리기** — 지금은 에이전트가 쓴 메시지만.

## 12. 구현과 맞춘 것

구현(계획 `docs/superpowers/plans/2026-10-05-reactions.md` 태스크 1~4)·리뷰·수정·브라우저 검증·런 0회 실연(태스크 5)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다.
근거는 실행 폴더 `.superpowers/sdd/2026-10-07-reactions/`(git 제외)의 보고서·리뷰(`t1`~`t5` — 줄 끝 괄호가 출처)다. 본문(0~11장)은 설계를 확정한 때의 기록이라 고치지 않았다 — **본문과 이 장이 다르면 이 장이 구현이다.**
화면 쓰는 법은 `docs/guides/user-guide.md` 「반응」 절, 에이전트가 받는 글은 `docs/guides/agent-guide.md` 「반응 — 지난 턴 뒤 내 메시지에 달린 것」 절, 파일 자리는 `docs/project-structure.md`(서버 `modules/reactions/`·웹 `features/reactions/`), 실연 절차와 결과는 `docs/guides/live-smoke.md` 「리액션 실연」 절이다.

**계획 판정 PR1~PR5**

- **PR1 — 반응은 `buildInboundDeliver` 가 아니라 오케스트레이터가 싣는다.** 「런에 싣기」 절 첫 줄을 대신한다. 순서는 `buildInboundDeliver` → (서버가 세션 id 를 정하는 어댑터 — 러너면) `renewSessionOnPromptChange` 판정 → `getSessionRow` 로 커서를 다시 읽기 → `pendingReactionsFor` → `withReactionFacts` 다. `ensureSession` 이 돌려준 행의 커서는 판정 전 값이라 다시 읽는다 — 러너 세션을 새로 열었으면 커서가 지금으로 올라 그 전 반응을 싣지 않는다. `withReactionFacts` 는 `InboundDeliver` 를 고치지 않고 새로 만들며, 반응이 없으면 같은 객체를 넘겨 `context` 에 `reactions` 키 자체가 없다(옛 플러그인·스냅숏과 글자까지 같게). 실은 것 가운데 가장 늦은 시각(`latestAt`)은 `InboundDeliver` 밖 지역 변수다(계획, t2 판단 2).
- **PR2 — 좁은 화면의 「기존 메시지 메뉴」는 없다.** 「웹」 장 첫 줄의 「좁은 화면은 기존 메시지 메뉴에 같은 항목」은 「마우스가 없는 기기(`@media (hover: none)`)에서는 「반응 추가」가 늘 보이는 작은 아이콘」이고, 「테스트·검증」 장 「브라우저」 줄의 「390px 메뉴로 달기」는 「390px 에서 늘 보이는 「반응 추가」 아이콘으로 달기」다. 버튼은 메시지 행의 동작 줄에 있다 — 채널 행은 「스레드에서 답하기」 왼쪽(`right-12`), 스레드 패널 행은 `right-3`, 보임 규칙은 「스레드에서 답하기」와 같고 메뉴가 열린 동안은 `data-[state=open]` 으로 붙든다(초점이 포털로 나가 행 밖이라)(계획, t4 보고, t4 리뷰 「지침」).
- **PR3 — 세션 행을 만드는 두 insert(`ensureSession` 쪽과 `markSessionReset` 쪽 upsert — 기존 행 갱신 포함)와 `renewSessionOnPromptChange` 가 `reactions_seen_at` 을 지금으로 둔다.** 「새 대화」는 두 제공자 모두 `resetAgentSession` → `markSessionReset` 을 지난다. `renewSessionOnPromptChange` 는 리비전이 바뀌면 늘 올리고(세션 id 가 없어 `false` 를 돌려주는 경우도 같은 update 안에서), 리비전이 그대로면 건드리지 않는다. `agent_sessions` 를 지우는 자리는 없다 — 그래서 에이전트를 채널에서 뺐다 다시 넣어도 커서가 이어지고, 빠진 동안 쌓인 것은 다시 넣은 뒤 첫 런에 최근 20개 + 「외 n개」다(계획, t2 판단 4, t2 리뷰 볼 것 3).
- **PR4 — `hydrateForClient` 는 `withThreadSummaries(db, withReactions(db, withInteractions(db, msgs)))` 다.** `message.created` 팬아웃(`realtime/events.ts`)도 `withReactions(withInteractions(…))` 를 지난다. 두 하이드레이션은 서로 독립이라 순서를 테스트로 가를 수 없다(계획, t1 보고, t2).
- **PR5 — 발췌는 검색 스니펫과 같은 읽는 글 변환(`modules/search/readable.ts`)을 지난 뒤 자른다** — 멘션은 `@핸들`, 마크다운 표시는 걷고, 공백·줄바꿈은 공백 하나로. 그래서 발췌에 줄바꿈이 없어 블록이 `---` 를 흉내 내 헤더를 끊지 못한다(계획, t1 리뷰 볼 것 4, t3 리뷰 볼 것 3).

**런에 싣기·커서 (태스크 1·2)**

- **커서는 `send` 가 받아들여진 경로에서만 오른다** — `admission` 이 `drop` 이 아니고, ack 를 기다리는 사이 중지·Gateway 오류로 끝나지 않았고, 서버가 닫히는 중이 아닐 때. 올리는 값은 실은 것 가운데 가장 늦은 `created_at` 이라 ack 를 기다리는 사이 달린 반응은 다음 런에 남는다. `send` 가 던지면(플러그인 끊김 → `ADAPTER_UNAVAILABLE`)·`drop`·ack 전 중지면 그대로라 다음 런에 다시 실린다(계획 Review Focus 2 — 통합 테스트가 두 경우를 본다)(t2).
- **러너가 `queued: true` 로 받은 런(러너 대기열에 섬)도 받아들여진 것이라 커서가 오른다** — 그 런이 시작 전에 중지돼도 그 반응은 다시 싣지 않는다(OpenClaw 의 ack 뒤 중지와 같은 꼴). 「런에 싣기」 절의 「실패·대기열 거절이면 그대로 둔다」의 「대기열」은 러너 대기열이 아니다(t2 리뷰 볼 것 2, t2 수정 보고).
- **커서가 null 인 행은 싣지 않고, 받아들여진 순간의 `now()` 로 채운다**(「`agent_sessions.reactions_seen_at`」 절의 문언). 대가는 그런 세션에서만 ack 를 기다리는 사이 달린 반응이 다음 런에 안 실리는 것이다. 마이그레이션(`0019_message_reactions`)과 새 행 채우기 뒤로 null 행은 생기지 않는다(t2 판단 3).
- **루트에 단 반응이 두 세션에 실리는 조건(계획 Review Focus 3)** — 세션 행은 그 세션의 첫 런을 대기열에 넣을 때(`enqueueRun` 의 `ensureSession`) 생기고 커서가 그 시각이다. 그래서 「루트에 달린 리액션은 채널·스레드 두 세션 모두에 실린다」는 **두 세션이 이미 있을 때 단 반응**에만 참이다 — 스레드 세션이 생기기 전에 루트에 단 반응은 그 스레드 세션에는 실리지 않고 채널 세션에만 실린다. 사람에게는 「에이전트 답에 👍 → 곧바로 그 답에서 스레드를 열어 부름 → 그 스레드 대화는 👍 를 모른다」로 보인다. 결정 5(알려지지 않을 수 있다)의 범위라 그대로 두었다 — 바꿀 길은 `docs/plan.md` 「이월」의 「리액션」 묶음. 두 세션의 커서는 따로 오른다(t2 판단 6, t2 리뷰 볼 것 3, t5 실연).
- 이미 단 반응을 다시 켜면 `ON CONFLICT DO NOTHING` 이라 처음 시각이 남는다 — 커서 비교에서 다시 새 반응이 되지 않는다. 끄고 다시 켜면 새 행·새 시각이라 다시 간다(결정 6)(t1 판단 3).
- 같은 시각의 동률은 `rowid` 로 고정한다(`withReactions` 의 `userIds`·`pendingReactionsFor` 의 순서)(t1 판단 4).
- `setReaction` 은 `message.updated` 를 하이드레이션 전 메시지(`rowToMessage`)로 낸다 — `reactions` 는 wire 팬아웃이 붙인다(t1 판단 1).
- **`channel.activity` 는 하이드레이션과 떨어져 있다** — `realtime/events.ts` 가 버스 `message.created` 에 처리기 둘을 등록한다: 채널 룸 `message.created`(하이드레이션)와 워크스페이스 룸 `channel.activity`. PR4 로 모든 새 메시지가 `withReactions` 질의를 지나므로, 한 처리기에 두면 그 질의가 던질 때(하이드레이션 질의의 DB 오류, 계약을 우회한 페이로드) 읽지 않음 신호까지 잃는다. 등록 순서가 버스(EventEmitter)의 호출 순서라 이벤트 순서는 그대로다. 하이드레이션이 던지면 채널 룸 구독자는 그 `message.created` 를 여전히 잃는다 — 원본 메시지로 대신 내지 않았다(t2 리뷰 고칠 것 1, t2 수정 보고, t2 재리뷰).
- wire `reaction.set` 처리기는 역할을 다시 읽지 않는다(`message.send` 와 같다) — membership 이 없는 세션은 핸드셰이크에서 막히고, 비활성화는 소켓을 끊는다. 팀 스펙 「역할과 권한」 표에 그 줄이 있다(t2 판단 5).
- **발췌 길이 — UTF-16 60 단위 안을 글자(코드 포인트) 단위로 채운다.** 계약 `InboundReaction.excerpt` 의 `z.string().max(60)` 은 zod 판본마다 세는 단위가 다르다 — 저장소가 핀한 4.6.5 는 코드 포인트, 의존성 트리의 4.4.3(플러그인 devDependency `openclaw` 가 끌어온다)은 UTF-16. UTF-16 으로 60 안이면 어느 판본으로 세도 넘지 않고, 서로게이트 쌍을 가르지 않는다. 대가는 이모지가 많은 글의 발췌가 60자보다 짧은 것이다. 다시 재는 법은 `apps/server/src/modules/reactions/service.ts` 의 `EXCERPT_MAX` 주석(t1 판단 2, t1 리뷰 F2, t1 수정 보고).
- **남은 스펙 질문의 판정** — 둘 다 구현 그대로 둔다(t1 리뷰 「스펙 쪽에 남길 질문」).
  - **발췌의 말줄임표** — 「에이전트가 보는 글」 절 예시의 인용은 `"…마이그레이션을…"` 처럼 말줄임표로 끝나지만, 구현은 잘린 발췌에 `…` 를 붙이지 않는다. 발췌는 에이전트가 어느 자기 메시지인지 알아보는 표지라 잘렸다는 표시가 판단을 바꾸지 않고, 붙이면 UTF-16 한도 셈에 `…` 를 넣어야 한다. 에이전트 가이드가 「잘려도 표시가 없다」고 적는다.
  - **빈 본문·인용 안의 `"`** — 본문이 없는 에이전트 메시지(카드·첨부만)는 `- @mia 👍 ""` 로, 발췌 안의 `"` 는 그대로 실린다. 발췌에 줄바꿈이 없어(PR5) 줄 형식이 깨지지 않는다. 빈 인용 대신 「최근 대화」처럼 `[카드]`·`[파일: 이름]` 자리표시를 싣는 것은 `docs/plan.md` 「이월」의 「리액션」 묶음.

**어댑터 (태스크 3)**

- 계획대로다. 플러그인은 `formatInboundContext` 의 `---` 바로 앞(채널·스레드 갈래 뒤라 두 갈래 모두 같은 자리), 러너는 `buildTurnFacts` 의 끝(「자리:」 줄 뒤)에 `formatReactionFacts` 결과를 둔다. 반응이 없거나 빈 배열이면 줄이 없다 — 반응이 없는 헤더·턴 사실은 이전과 글자까지 같다. `reactionsOmitted` 만 있고 `reactions` 가 비면 「(외 n개)」도 싣지 않는다(서버는 21개 이상일 때만 `omitted` 를 채워 실제로는 오지 않는 조합)(t3, t3 리뷰).
- **러너 세션은 앞 턴의 사실을 이력으로 안고 간다** — `resume` 한 세션의 요청에는 앞 턴의 `UserPromptSubmit` 문맥(반응 블록 포함)이 그대로 남는다. 다음 런의 새 턴 사실에는 블록이 없지만 모델은 앞 턴의 블록을 이력으로 본다(「Claude 러너 런 0회 하네스」 절 기준 3 과 같은 성질)(t5 실연).

**웹 (태스크 4)**

- **실패하면 「반대로」가 아니라 서버가 아는 상태로 되돌린다.** 「웹」 장 「낙관적 갱신」 줄의 「실패하면 되돌리고」를 대신한다: 같은 (메시지, 이모지)의 마지막 요청이 실패하면, 이 클라이언트가 서버에게서 마지막으로 들은 내 표(첫 요청 직전 캐시 → 성공한 ack·받은 `message.updated` 순으로 덮어 쓴 값)로 맞춘다. 켜기·끄기가 둘 다 실패하면 서버 상태가 그대로라 `message.updated` 가 오지 않는다 — 「반대로」는 그때 서버에 없는 칩을 새로고침 전까지 남긴다. 앞 요청이 늦게 실패해도 화면은 마지막 상태다(계획 Review Focus 1). `message.updated` 를 받은 뒤 ack 가 `TIMEOUT` 이면(서버는 처리했다) 서버가 말한 칩을 남기고 토스트는 낸다 — 저장됐는지 탭이 확신하지 못하는 경우다(t4 리뷰 고칠 것 1, t4 수정 보고, t4 재리뷰).
- **나가 있는 요청은 클라이언트(QueryClient)마다 센다** — 같은 메시지를 그리는 행이 둘(채널 행·스레드 패널 행)이거나 행이 다시 마운트돼도 한 요청 줄로 묶는다. 훅 인스턴스마다 세면 뒤 행이 앞 행의 낙관값을 「서버 상태」로 잡아, 둘 다 실패했을 때 서버에 없는 칩이 남는다(t4 재리뷰 고칠 것 1, t4 재수정 보고).
- 채널 행의 루트도 스레드 캐시를 고친다 — 채널 행과 열린 스레드 패널의 같은 루트가 함께 바뀐다(연 적 없는 스레드면 그냥 지나간다)(t4 리뷰 고칠 것 2).
- **보관한 채널의 칩은 `disabled` 가 아니라 `aria-disabled` 에 누름 무시다** — 「웹」 장 「칩은 누를 수 없다」 뒤에 붙는다: 키보드 초점으로 툴팁(누가 달았나)을 읽는다(t4 리뷰 고칠 것 3).
- **피커는 가로 한 줄이라 ←·→ 도 ↑·↓ 처럼 옮긴다** — 「웹」 장 「키보드: 화살표·Enter·Esc」 뒤에 붙는다. 끝에서 돌아가지 않는다(메뉴 `loop` 기본값 false 와 같다). 피커는 Radix `DropdownMenu` 다(t4 리뷰 고칠 것 4).
- ack `CHANNEL_ARCHIVED` 는 되돌림 + 기존 보관 토스트(「보관된 채널입니다」) + 채널·채널 목록 다시 받기, 그 밖의 실패는 「반응을 저장하지 못했습니다」(t4 보고).
- 채널 타임라인 캐시는 이미 있을 때만 고친다 — 없는 캐시를 빈 목록으로 만들지 않게(t4 보고).
- 보내는 중 항목은 `PendingItem` 이라 `MessageItem` 에 오지 않는다 — 버튼·칩이 없다(t4 판단 2).

**검증 (태스크 5 — 모델 런 0회)**

- **브라우저** — `dev:fake` 위 독립 headless Chromium(Playwright) 하나에 owner·mia·셋째 member(연타 동안 칩이 사라지지 않게 닻 반응을 두는 사람) 컨텍스트, 1280px 과 390px(`isMobile`·`hasTouch` — `(hover: none)` 이 참). 둘째 클라이언트가 다른 계정이라 BrowserOS neo 가 아니라 독립 브라우저로 했다. 「테스트·검증」 장 브라우저 항목과 연타·보관·비활성·스레드 패널·읽지 않음과의 충돌·키보드·보내는 중 항목을 봤다 — 결함 1(D1, 아래), 나머지 통과. 에이전트 쪽은 `dev:fake` 가 가짜 Gateway·러너가 받은 인바운드마다 남기는 `dev:fake inbound reactions` 줄로 봤다(반응이 없어도 빈 배열로 찍는다)(t5 보고).
- **D1 — 390px(마우스 없는 기기)에서 늘 보이는 두 버튼이 머리 없는 이어진 메시지의 본문 글자를 덮는다.** 「반응 추가」(`right-12`, 28px)와 「스레드에서 답하기」(`right-3`)가 행 위쪽에 `absolute` 로 떠 있어, 같은 사람이 이어 쓴 메시지(머리 줄이 없다)의 첫 두 줄 오른쪽 끝을 가린다. 「스레드에서 답하기」 하나일 때부터 있던 겹침을 폭 두 배로 넓혔다. 고칠 길은 `docs/plan.md` 「이월」의 「리액션」 묶음(t5 보고).
- **런 0회 실연** — 스크래치 상태(`OPENCLAW_HOME`)의 실물 OpenClaw 2026.9.5 Gateway 와 소스 실행 서버, 서버가 내려준 이 커밋의 플러그인, 가짜 claude CLI 로 합격 기준을 모두 통과했다: 에이전트 답에 단 반응이 다음 멘션의 모델 입력에 `formatReactionFacts` 글 그대로 실림 · 그다음 멘션엔 없음 · 스레드 런은 스레드 범위만(스레드 답글 반응은 채널 런에 없음) · 반응이 없으면 헤더가 이전과 같음. 「Claude 러너 런 0회 하네스」로 러너 턴 사실의 블록도 봤다(t5 실연, `docs/guides/live-smoke.md` 「리액션 실연」 절).
