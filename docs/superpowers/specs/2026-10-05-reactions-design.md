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
