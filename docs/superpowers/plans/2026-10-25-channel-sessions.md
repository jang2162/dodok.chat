# 채널 세션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나. 태스크마다 main 에 병합해도 초록이어야 한다.

**Goal:** 한 채널 안의 대화를 주제마다 「세션」으로 나눈다 — 세션마다 메시지 목록과 에이전트 맥락이 따로이고, 세션은 닫았다 다시 열 수 있으며, 채널마다 누가 세션을 만들지 정한다. 「새 대화」(에이전트 세션 리셋)는 없앤다.

**Architecture:** 새 표 `conversations` 가 채널 아래 세션 행을 들고, `messages`·`runs`·`agent_sessions`·읽음·자동화가 대화 id 를 갖는다. seq 는 채널 하나의 번호를 모든 세션이 같이 쓰고, wire 구독도 채널 룸 하나다. 에이전트 세션 키는 모양 그대로 `channel:` 자리에 대화 id 를 넣는다 — 마이그레이션이 기존 채널마다 만든 「이전 대화」의 id 를 채널 id 와 같게 둬 저장된 키와 OpenClaw 쪽 이력이 그대로 맞는다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Router/Query · zustand · OpenClaw 2026.9.4 플러그인 SDK · Claude Agent SDK(러너). **새 의존성 없음.**

**Spec:** `docs/superpowers/specs/2026-10-25-channel-sessions-design.md` — 결정 0장, 범위 1장, 데이터 2장, 권한 3장, 동작 4장, wire·REST 5장, 웹 6장, 오류 7장, 검증 8장, 완료 기준 9장. 로드맵 `docs/superpowers/specs/2026-10-25-sessions-dm-runner-roadmap.md`. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- 세션 키는 shared `dodokSessionKey(providerAgentId, conversationId, threadRootId?)`·`parseDodokSessionKey` 로만 만들고 푼다. 키 모양·정규식은 그대로 — 두 번째 값의 이름만 `conversationId`.
- 마이그레이션의 「이전 대화」: 채널마다 하나, **id = 그 채널 id**, `title` 「이전 대화」, `title_source` `user`, 만든 사람 = 채널 `created_by`, `created_at` = 채널 `created_at`, `last_seq`·`last_message_at` 은 그 채널의 마지막 메시지 값.
- 세션 제목 1~80자. 자동 제목은 첫 메시지 본문의 읽는 글(멘션 `@핸들`, 마크다운 표시 걷음, 줄바꿈 → 공백) 앞 40 코드 포인트, 비면 「새 세션」.
- 세션 정책 `{ create: "members" | "managers" }`, 기본 `members`. 채널 멤버(사람) 역할 `member` · `manager`, 기본 `member`.
- 새 오류 코드 `CONVERSATION_CLOSED`(HTTP 409). 닫힌 세션에 보내기·카드·리액션·첨부 묶기는 이 코드.
- 문구(합쇼체, 그대로): 「새 세션」 · 「이전 대화」 · 「닫힌 세션입니다」 · 「다시 열기」 · 시스템 메시지 `@<핸들> <이/가> 이 세션을 닫았습니다`·`… 이 세션을 다시 열었습니다`(조사는 `josa`) · 에이전트 헤더 줄 `세션: <제목>` · 대화 밖 전송 거절 사유 「이 대화에만 보낼 수 있습니다」 · 자동화 세션 제목 `⚙ <자동화 이름>`.
- 세션 목록 REST 는 최근 활동순 20개 페이지, `q` 는 제목 부분 일치(대소문자 무시).
- 권한은 서버가 요청마다 `auth/policies.ts` 의 함수로 판정한다(웹이 숨기는 것은 편의). 새 경로는 `apps/server/test/roles.matrix.test.ts` 와 팀 스펙(`docs/superpowers/specs/2026-09-26-team-members-design.md`) 「역할과 권한」 표에 더한다.
- 쓰기 막기 순서: `assertChannelWritable`(보관 채널 `CHANNEL_ARCHIVED`) → `assertConversationWritable`(닫힌 세션 `CONVERSATION_CLOSED`).
- 외부 입력(HTTP·wire·브리지·러너 페이로드)은 경계에서 Zod 파싱. shared 는 Node 전용 API 금지. 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳(새 숫자 없음 — 세션 REST 는 기존 사용자 버킷).
- 생성물(drizzle SQL·meta)은 `pnpm -F @dodok/server db:generate` 로 만든다. 데이터 옮기기·FTS 는 생성된 파일 끝에 손으로 덧붙이고 다시 generate 해 「No schema changes」인지 본다. `messages` 를 다시 만드는 마이그레이션 뒤에는 `apps/server/drizzle/0007_search_fts.sql` 의 트리거 셋·백필을 새로 넣는다(`docs/guides/project-structure.md` 「검색(0007, 커스텀)」 줄).
- 포트 5173·3000 금지(사용자 인스턴스 3100·5180 도 건드리지 않는다 — 워커는 브리프가 주는 포트). 프로세스는 자기 PID 로만, `pkill` 금지. **모델 런 없음.**
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프(`feat(shared): …`·`feat(server): …`·`feat(web): …`·`feat(plugin): …`·`feat(runner): …`). 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 문서·주석을 쓰기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`, 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`, 플러그인을 바꿨으면 `pnpm -F @dodok/openclaw-plugin build`.

## 계획 판정 (스펙과 맞춘 것)

조사한 코드에 맞춰 스펙을 구체화한 것. 태스크 9 가 스펙에 「구현과 맞춘 것」 장을 만들어 옮긴다.

- **PS1 — 태스크 1 은 동작을 바꾸지 않는다.** 태스크 1 동안은 「채널마다 대화 하나, id = 채널 id」가 불변이다 — 채널을 만들면 같은 트랜잭션에서 id 가 채널 id 인 「이전 대화」를 만든다. 그래서 세션 키·OpenClaw 피어 id 값이 지금과 같고 기존 테스트가 이름 바꾸기만으로 통과한다. 태스크 3 이 채널 만들기에서 이 대화를 걷는다(스펙 결정 7 — 빈 세션은 만들지 않는다). 걷으면 새 채널의 자동화 게시가 대화를 못 찾으므로, 태스크 3 은 `automations/post.ts` 에 「열린 대화가 없으면 「⚙ <이름>」 대화를 만든다」 다리를 두고 태스크 4 가 자동화 자기 세션으로 바꾼다.
- **PS2 — 브리지·러너의 나가는 글은 대화 id 하나만 싣는다.** `OutboundMessage` 의 `channelId` 를 `conversationId` 로 바꾼다(서버가 채널을 찾는다). 플러그인의 message 툴 대상 `channel:<id>` 의 id 도 대화 id 다(OpenClaw 피어 id = 대화 id). 브리지·러너의 첨부 올리기 헤더는 `x-dodok-channel-id` 대신 `x-dodok-conversation-id`(서버가 그 대화의 채널로 묶는다). `InboundDeliver` 는 `channelId`(플러그인의 채널 설정·프롬프트 조회 — `ConfigSet` 은 채널 단위 그대로)와 `conversationId` 를 함께 싣는다.
- **PS3 — 대화가 정해지지 않은 시스템 메시지는 `latestOpenConversation(tx, channelId)` 한 함수로 자리를 찾는다**(스펙 4.2 — 최근 활동한 열린 대화, 없으면 undefined = 남기지 않음). 영구 함수다. 런·트리거 메시지가 있는 자리(라우터 차단, 런 오류, 런 한도, 이어가기)는 그 대화를 쓴다.
- **PS4 — wire `message.send` 의 전환 다리.** 태스크 3 에서 `MessageSend` 에 `conversationId?`·`newConversation?` 를 더하고, 둘 다 없으면 서버가 `latestOpenConversation` → 없으면 자동 제목 새 세션으로 받는다(태스크 3·4 동안 웹이 지금 꼴로 보내도 앱이 돈다). 태스크 5 가 웹을 바꾸면서 다리를 걷고 스키마를 「둘 중 정확히 하나」로 조인다.
- **PS5 — 채널 경로 메시지 REST(`GET /api/v1/channels/:id/messages`·`…/threads/:rootId/messages`)는 태스크 5 까지 남긴다.** 태스크 3 이 대화 경로(`/api/v1/conversations/:id/messages`·`…/threads/:rootId/messages`)를 더하고, 태스크 5 가 웹을 옮긴 뒤 채널 경로를 걷는다. `channel.subscribe` 응답도 태스크 5 에서 바꾼다(처음 구독은 `messages: []` — 첫 페이지는 대화 REST, `lastSeq` 재동기화는 지금처럼 채널 전체 ≤200).
- **PS6 — 웹 타임라인 캐시는 대화 단위.** `qk.timeline(conversationId)`·`qk.thread(conversationId, rootId)`. 구독의 빈틈 커서는 채널 단위 `qk.channelSeq(channelId)`(본 가장 큰 seq)로 따로 둔다. 재동기화가 200 을 넘으면(`hasMore`) 그 채널의 대화 타임라인·스레드 캐시를 모두 버리고 지금 보는 세션만 REST 로 다시 받는다 — 지금의 `MAX_PAGES` 이어 받기는 채널 경로 REST 가 없어져 걷는다.
- **PS7 — `RunState`·`Approval`·`ChannelActivity`·`Typing`·`PresenceUpdate`·`SearchHit` 에 `conversationId`.** 스트리밍 버블·승인 카드·입력 중 표시는 그 대화에서만 보이고, 푸시 거름(「보고 있으면 안 보냄」)은 대화 단위다 — 같은 채널의 다른 세션을 보고 있으면 멘션 푸시가 간다.
- **PS8 — 세션 관리자는 `channel_members.role = 'manager'`.** 경로 `PUT /api/v1/channels/:id/session-managers/:userId`(채널에 없으면 참여시키고 역할을 올린다)·`DELETE …`(역할을 `member` 로), 둘 다 admin 이상. `ChannelMember` 의 사람 행에 `role`, `Channel` 에 `sessionPolicy`. 정책은 `PATCH /api/v1/channels/:id { sessionPolicy }`(admin 이상 — `MEMBER_EDITABLE_CHANNEL_FIELDS` 밖).
- **PS9 — 새 세션 첫 메시지의 멱등.** `newConversation` 을 실은 재전송(ack 유실)은 `(authorId, clientMsgId)` 가 이미 있으면 대화를 만들지 않고 그 메시지·그 대화로 답한다(지금 `findUserMessage` 가 먼저 보는 순서 그대로).
- **PS10 — 「새 대화」 걷기 범위.** REST `POST /api/v1/channels/:id/agents/:agentId/reset`·`resetAgentSession`·`markSessionReset`·`AgentAdapter.resetSession`(shared 계약과 OpenClaw·러너·가짜 어댑터)·웹 `ResetSessionDialog`·`resetSession.ts`·`/new` 슬래시. `agent_sessions` 의 `sessionStartedAt`·`lifecycleRevision` 열은 남긴다 — 지금은 읽는 코드가 없고, 「새 대화」를 걷은 뒤에는 늘 null 이다(Gateway 가 스스로 리셋한 것을 가를 때를 위해 남긴다 — 태스크 2 리뷰 S1). 능력 `AdapterCapabilities.sessionReset` 도 걷는다(읽던 곳·내리던 곳이 리셋뿐 — 웹 `api/queries.ts` 의 같은 이름 타입도). 손 점검 도구 `scripts/wire-cli.ts` 의 `reset` 명령도 걷는다. 채널 설정의 「프롬프트를 바꾸면 「새 대화」부터 반영」류 안내는 「새 세션부터 반영됩니다」로.

- **PS11 — 시스템 메시지는 대화의 활동 시각(`last_message_at`)을 올리지 않는다**(태스크 3 리뷰 낮음 5, 메인 세션 판정). `last_seq` 는 올린다(읽음 깎기). 닫기·다시 열기·런 한도·제어 변경 같은 서버 알림이 닫은 세션을 목록 맨 위로, 다시 연 옛 세션을 `latestOpenConversation` 1순위로 올리지 않게 — 목록 순서와 「최근 세션으로 넘김」은 사람·에이전트의 대화를 따른다.
- **PS12 — `conversation.updated` 는 제목·닫기·다시 열기 때만 낸다**(태스크 3 판단 — 스펙 5장의 `last_message_at` 은 싣지 않는다). 메시지마다 내면 `message.created` 와 짝으로 두 번씩 나간다. 웹 목록 순서는 `message.created` 의 `conversationId`·`createdAt` 으로 올린다(시스템 메시지는 올리지 않는다 — PS11).

## Review Focus

1. **새 세션의 첫 메시지 ack 를 잃고 같은 `clientMsgId`·`newConversation` 으로 다시 보냄** — 세션이 둘 생기지 않고 같은 메시지·같은 세션으로 답한다(PS9). → 태스크 3.
2. **두 탭 — 한 탭이 세션을 닫는 사이 다른 탭이 그 세션에 보내는 중** — 보내기는 `CONVERSATION_CLOSED`, 웹의 보내는 중 항목은 「다시 보내기」 없이 실패 사유 「닫힌 세션입니다」로 남고, 작성기 자리가 닫힌 세션 안내로 바뀐다(`conversation.updated` 를 받아서). → 태스크 3(서버)·태스크 6(웹).
3. **닫힌 세션의 열린 스레드에 답글·카드 상호작용·리액션, 그리고 닫는 순간 돌던 런의 늦은 정본** — 셋은 409, 정본은 저장만(릴레이·푸시 없음). → 태스크 3.
4. **에이전트가 message 툴 `to` 에 같은 채널의 다른 세션 id 나 채널 id 를 넣음(런이 있든 없든)** — 플러그인이 고정 사유로 툴 호출을 거절하고, 플러그인을 거치지 않은 정본도 서버가 저장하지 않는다. → 태스크 4.
5. **오래 끊겼다 다시 붙어 재동기화가 200 을 넘음(여러 세션에 흩어짐)** — 그 채널의 대화 캐시를 모두 버리고 지금 세션만 다시 받는다. 다른 세션을 열면 그때 받는다. 굵게·배지는 스냅숏으로 다시 맞는다(PS6). → 태스크 5.

각 줄의 테스트는 해당 태스크의 단계에 들어 있다.

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/session-key.ts`·`domain/index.ts`·`bridge/index.ts`·`adapter/index.ts`·`runner/index.ts` | 1 | 대화 id 를 키·계약에 |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/00xx_*`(새) | 1·3·4·8 | `conversations`, 대화 id 열들, 「이전 대화」 옮기기·FTS 다시 넣기 |
| `apps/server/src/modules/conversations/store.ts`(새) | 1·3 | 대화 행 읽기·만들기·`latestOpenConversation`·`touch`(seq·시각) |
| `apps/server/src/modules/messages/service.ts`·`runs/*`·`sessions/service.ts`·`router/service.ts` | 1·4 | 저장·런·세션이 대화 단위 |
| `packages/openclaw-plugin/src/{inbound,outbound,channel,context,media-http}.ts`·`packages/openclaw-adapter/src/*`·`packages/runner-adapter/src/*`·`packages/claude-runner/src/{post-tool,attachments-http}.ts`·`packages/shared/src/runner/prompt.ts` | 1·4 | 피어 id·나가는 글·헤더 |
| `apps/server/src/modules/conversations/{service,routes}.ts`(새)·`auth/policies.ts`·`realtime/{socket,events,bus}.ts`·`modules/channels/{service,routes}.ts` | 3 | 세션 만들기·목록·제목·닫기·정책·세션 관리자·wire 이벤트 |
| `apps/server/src/modules/channels/{service,routes}.ts`·`packages/*-adapter`·`apps/web/src/features/{agents,composer}/*` | 2 | 「새 대화」 걷기 |
| `apps/server/src/modules/{ops/budget,control/service,automations/*}.ts`·플러그인·러너 | 4 | 한도 알림·제어 메시지 자리·자동화 세션·대화 밖 전송 거절·헤더 |
| `apps/web/src/app/router.tsx`·`realtime/{subscriptions,handlers,timelineCache}.ts`·`features/messages/*`·`features/threads/*`·`features/composer/useSendMessage.ts`·`pwa/persist.ts` | 5 | 세션 경로·캐시·보내기·오프라인 사본 |
| `apps/web/src/features/conversations/*`(새)·`app/layout/ChannelHeader.tsx`·`features/settings/*` | 6 | 세션 목록·머리·닫기·설정 칸 |
| `apps/server/src/modules/{reads,search,push,control}/*`·`apps/web/src/features/{reads,search}/*`·`sw-logic.ts` | 7 | 읽음·검색·푸시·제어 도구를 세션 단위로 |
| `apps/server/scripts/dev-fake.ts`·`apps/server/test/integration/*` | 8 | 가짜 환경·통합 시나리오·브라우저 검증 |
| 문서 | 9 | 실연·`.ruler/AGENTS.md`·가이드·매뉴얼·스펙 「구현과 맞춘 것」·`docs/guides/plan.md` |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 기반 — 대화 id 를 계약·표·저장에(동작 변화 없음) | — |
| B | 2 「새 대화」 걷기 | 1 |
| C | 3 서버 — 세션 만들기·목록·제목·닫기·정책 | 2(둘 다 `channels/routes.ts`) |
| D | 4 서버·어댑터 — 런과 에이전트가 세션 단위로 | 3 |
| E | 5 웹 — 세션 경로·캐시·보내기 | 4 |
| F | 6 웹 — 세션 목록·머리·닫기·설정 ‖ 7 읽음·검색·푸시·제어 도구 | 5(6 과 7 은 `ChannelPage.tsx` 를 같이 만진다 — 나중 병합이 맞춘다) |
| G | 8 dev:fake·통합 시나리오·브라우저 검증 | 6·7 |
| H | 9 실연·문서 | 8 |

---

### Task 1: 기반 — 대화 id 를 계약·표·저장에 (동작 변화 없음)

**Files:**
- Modify: `packages/shared/src/session-key.ts`·`domain/index.ts`·`bridge/index.ts`(첨부 헤더 이름 `H` 포함)·`adapter/index.ts`·`runner/index.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`; Create(생성기 + 덧붙임): `apps/server/drizzle/00xx_*.sql`·meta
- Create: `apps/server/src/modules/conversations/store.ts`
- Modify: `apps/server/src/modules/{messages/service,sessions/service,runs/orchestrator,runs/store,runs/context,router/service,channels/service,attachments/*,automations/post,control/service,ops/budget}.ts`·`realtime/socket.ts`
- Modify: `packages/openclaw-plugin/src/{inbound,outbound,channel,media-http}.ts`·`packages/openclaw-adapter/src/{fake-adapter,gateway/*}.ts`·`packages/runner-adapter/src/*.ts`·`packages/claude-runner/src/{post-tool,attachments-http}.ts`·`apps/server/test/fakes/*`·`apps/server/scripts/dev-fake.ts`
- Test: `packages/shared/test/session-key.test.ts`, `apps/server/test/db.test.ts`(마이그레이션), `apps/server/test/conversations.store.test.ts`(새), 기존 테스트의 이름 바꾸기

**Interfaces:**
- Produces(shared `domain/index.ts`):

```ts
export const ConversationTitle = z.string().trim().min(1).max(80);
export const Conversation = z.object({
  id: Id,
  channelId: Id,
  title: ConversationTitle,
  titleSource: z.enum(["user", "auto"]),
  createdBy: z.object({ type: z.enum(["user", "automation"]), id: Id }),
  createdAt: IsoDateTime,
  lastMessageAt: IsoDateTime.optional(),
  lastSeq: z.int().min(0),
  closedAt: IsoDateTime.optional(),
  closedBy: Id.optional(),
});
export type Conversation = z.infer<typeof Conversation>;
```

  `Message`·`Run`(따라서 `RunState` 의 pick 에도)·`Approval` 에 `conversationId: Id`. `ProviderApproval.channelId` → `conversationId`(키에서 푼 값 — 채널은 서버가 대화로 찾는다).
- Produces(shared 세션 키): `dodokSessionKey(providerAgentId: string, conversationId: string, threadRootId?: string): string` · `type ParsedDodokSessionKey = { providerAgentId: string; conversationId: string; threadRootId?: string }`. `AgentAdapter.sessionKeyFor(providerAgentId, conversationId, threadRootId?)`.
- Produces(shared 브리지·러너): `InboundDeliver` 에 `conversationId: Id`(그대로 `channelId` 도), `OutboundMessage` 는 `channelId` 대신 `conversationId: Id`(따라서 `RunnerOutboundPost` 도), 첨부 헤더 `H.conversationId = "x-dodok-conversation-id"`(`H.channelId` 는 걷는다).
- Produces(DB): `conversations`(스펙 2.1 의 열 — `id`·`channel_id` FK·`title`·`title_source`·`created_by_type`·`created_by_id`·`created_at`·`last_message_at`·`last_seq` default 0·`closed_at`·`closed_by`, 인덱스 `conversations_channel_open_recent (channel_id, closed_at, last_message_at)`). `messages.conversation_id`·`runs.conversation_id` NOT NULL FK, `agent_sessions.conversation_id` NOT NULL FK. 인덱스: `messages_conversation_thread_seq (conversation_id, thread_root_id, seq)`, `agent_sessions` 의 유일 인덱스 둘을 `conversation_id` 로(`agent_sessions_conversation_agent_thread`·`agent_sessions_conversation_session … WHERE thread_root_id IS NULL`), `runs_conversation_created (conversation_id, created_at)`.
- Produces(서버 `modules/conversations/store.ts`):

```ts
export type ConversationRow = typeof conversations.$inferSelect;
export function rowToConversation(row: ConversationRow): Conversation;
/** 다른 워크스페이스·없는 대화면 undefined */
export function getConversation(db: DbOrTx, id: string, workspaceId?: string): Conversation | undefined;
/** 열린 대화 가운데 last_message_at(없으면 created_at) 이 가장 늦은 것 — 대화가 정해지지 않은 시스템 메시지의 자리(PS3) */
export function latestOpenConversation(db: DbOrTx, channelId: string): string | undefined;
/** storeMessage 가 같은 트랜잭션에서 부른다 — last_seq·last_message_at 를 올린다 */
export function touchConversation(tx: DbOrTx, conversationId: string, seq: number, at: Date): void;
/** 태스크 1 동안만 채널 만들기가 부른다(PS1) — id = 채널 id, 「이전 대화」 */
export function createLegacyConversation(tx: DbOrTx, channel: { id: string; createdBy: string; createdAt: Date }): void;
```

- Produces(서버 저장): `CreateUserMessageInput`·`CreateAgentMessageInput`·`CreateAutomationMessageInput`·`CreateSystemMessageInput` 의 `channelId` → `conversationId`(채널은 대화에서 찾는다). `storeMessage(tx, conversationId, threadRootId, build)` 가 대화를 읽고, 답글이면 루트의 `conversation_id` 가 같아야 한다(아니면 `VALIDATION`). `EnsureSessionInput = { conversationId; agentId; threadRootId? }`. `InsertRunInput` 에 `conversationId`. `RunPlan & { channelId; conversationId }`. `RunGate.check(conversationId: string, threadRootId?: string)`(채널은 대화에서 찾는다 — 한도는 채널·워크스페이스 단위 그대로, 알림이 그 대화에 남는다).

- [ ] **Step 1: 실패하는 테스트 — shared.** `session-key.test.ts` 의 기존 사례가 `conversationId` 로 푼 값을 본다(값은 그대로). `Conversation` 이 81자 제목·빈 제목을 거절, `titleSource: "x"` 거절.
- [ ] **Step 2: 실패하는 테스트 — 마이그레이션.** `db.test.ts`: 직전 마이그레이션까지 적용한 DB 에 채널 둘(메시지 3·0개, 스레드 답글 하나, 런 하나, 에이전트 세션 채널 행 하나·스레드 행 하나)을 넣고 새 마이그레이션을 얹으면 — 채널마다 대화 한 행(id = 채널 id, 「이전 대화」, `title_source user`, `last_seq` 3·0), 모든 메시지·런·세션 행의 `conversation_id` = 채널 id, 세션 행의 `session_key` 가 `dodokSessionKey(providerAgentId, conversationId, threadRootId)` 와 같다. 기존 `search.service.test.ts` 의 백필 가드(모든 마이그레이션 뒤 트리거 셋·제 id 로만 찾힘)가 그대로 초록.
- [ ] **Step 3: 실패하는 테스트 — 저장소.** `conversations.store.test.ts`: `createChannel` 이 id 가 채널 id 인 대화를 만든다 · `latestOpenConversation` 이 닫힌 대화를 건너뛰고 최근 활동순 · 메시지를 저장하면 그 대화의 `last_seq`·`last_message_at` 이 오른다 · 다른 대화의 루트로 답글을 저장하면 `VALIDATION`.
- [ ] **Step 4: 실패 확인.** `pnpm -F @dodok/shared test` · `pnpm -F @dodok/server test -- db conversations.store` — 새 사례가 실패하는지 본다.
- [ ] **Step 5: 구현 — 스키마·마이그레이션.** 스키마를 고치고 `db:generate`. 생성된 SQL 이 `messages`·`runs`·`agent_sessions` 를 다시 만드는 꼴이면, 복사 전에 대화 행이 있어야 FK 가 선다 — 생성된 파일의 `__new_*` 복사 **앞**에 `INSERT INTO conversations … SELECT … FROM channels`(위 Global Constraints 값)를, 복사 문의 `conversation_id` 자리에는 `channel_id` 를 넣는다. 끝에 `0007_search_fts.sql` 의 트리거 셋과 백필을 덧붙인다. 다시 `db:generate` → 「No schema changes」.
  - **구현에서 맞춘 것(0025):** 생성기는 표 다시 만들기가 아니라 SQLite 가 받지 않는 `ALTER … ADD … NOT NULL REFERENCES …` 를 내서 SQL 본문을 손으로 썼다. 마이그레이터는 FK 를 켠 트랜잭션에서 돌아 `PRAGMA foreign_keys=OFF` 가 듣지 않으므로, 다시 만드는 표의 자식 행(`attachments`·`component_interactions`·`message_reactions`·`run_events`·`approvals`)을 TEMP 표로 옮겨 두고 다시 만든 뒤 되돌린다 — 안 그러면 리액션이 cascade 로 조용히 지워진다. `approvals.conversation_id` NOT NULL FK 도 더했다(`Approval.conversationId` 의 자리). 태스크 9 가 스펙 「구현과 맞춘 것」과 `docs/guides/project-structure.md` DB 절로 옮긴다.
- [ ] **Step 6: 구현 — 저장·런·세션.** 위 Interfaces 대로 이름을 바꾸고 값을 흘린다. 대화를 아는 자리: 사람 보내기(태스크 1 은 `latestOpenConversation(채널)` — 불변식상 늘 있다), 정본(세션 키에서 `parseDodokSessionKey(...).conversationId`), 런(트리거 메시지·상호작용 메시지의 대화), 라우터 차단·런 오류·런 한도·이어가기(그 메시지·런의 대화), 자동화(`latestOpenConversation`), 제어 변경 메시지(`latestOpenConversation`). 세션 키는 모두 `run.conversationId` 로 만든다.
- [ ] **Step 7: 구현 — 어댑터·플러그인·러너.** 플러그인 인바운드의 키 대조·피어 id·`to` 대상과 나가는 글이 `conversationId`, 첨부 헤더가 `H.conversationId`(서버 브리지·러너 첨부 경로가 그 대화의 채널로 묶는다). 러너 어댑터의 post 대조 `post.conversationId !== d.conversationId`. 승인 정규화는 `conversationId` 를 싣고 서버가 채널을 찾는다.
- [ ] **Step 8: 통과 확인.** 새 사례와 기존 전체 — 패키지별 실행 개수를 적는다. 기존 사례는 이름 바꾸기 말고 기대값을 고치지 않는다(PS1 — 바꿔야 했다면 동작이 바뀐 것이니 멈추고 보고).
- [ ] **Step 9: 끝내기 검사 + 서버 번들 스모크 + 플러그인 빌드.**
- [ ] **Step 10: 커밋** — `feat(shared): carry the conversation id through keys and contracts`, `feat(server): add conversations and move each channel into its legacy conversation`, `feat(plugin): address dodok peers by conversation id`, `feat(runner): post by conversation id`.

---

### Task 2: 「새 대화」 걷기

**Files:**
- Modify: `apps/server/src/modules/channels/{routes,service}.ts`·`modules/sessions/service.ts`·`packages/shared/src/adapter/index.ts`·`packages/openclaw-adapter/src/{openclaw-adapter,fake-adapter,connection/gateway-connection}.ts`·`packages/runner-adapter/src/runner-adapter.ts`·`apps/server/test/fakes/fake-gateway.ts`·`apps/server/scripts/dev-fake.ts`
- Delete: `apps/web/src/features/agents/{ResetSessionDialog.tsx,resetSession.ts,resetSession.test.tsx}`; Modify: `apps/web/src/features/composer/{slash.ts,Composer.tsx}`·채널 설정·에이전트 행에서 「새 대화」를 부르는 자리
- Test: `apps/server/test/roles.matrix.test.ts`(경로 빠짐), `apps/web/src/features/composer/Composer.slash.test.tsx`. `apps/server/test/channels.archive.test.ts`·`integration/{prompt,threads,reactions}.test.ts` 의 리셋 사례는 지운다(세션을 새로 여는 사례는 태스크 4 의 통합 시나리오가 갖는다).

**Interfaces:**
- Consumes: 태스크 1.
- Produces: `AgentAdapter` 에 `resetSession` 이 없다. `markSessionReset`·`resetAgentSession`·`ResetAgentSessionDeps` 가 없다. 웹 `parseSlash` 는 `/new` 를 모른다(보통 글로 보낸다).

- [ ] **Step 1: 실패하는 테스트.** `roles.matrix.test.ts`: `POST /api/v1/channels/:id/agents/:agentId/reset` → 404(라우트 없음). `Composer.slash.test.tsx`: `/new @dev` 를 보내면 보통 메시지로 나간다(대화상자 없음).
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.** PS10 의 목록을 걷는다. `grep -rnE 'resetSession|markSessionReset|resetAgentSession|ResetSessionDialog|kind: "new"|agents/[^ "]*/reset'`(소스·테스트·`scripts/` 모두)가 OpenClaw 스파이크(`packages/openclaw-adapter/src/spike/`)와 브리지 dedupe 결과(`bridge/session.ts` `acceptOutbound` 의 `{ kind: "new" }` 와 그 테스트 — 리셋과 무관) 말고는 비어야 한다. Gateway `sessions.reset` 원시 호출은 `gateway-connection.ts` 에서도 걷는다(부를 곳이 없다). 프롬프트 칸의 안내 문구를 PS10 대로.
- [ ] **Step 4: 통과 확인 + 끝내기 검사 + 서버 번들 스모크 + 웹 빌드.**
- [ ] **Step 5: 커밋** — `refactor(server): drop the agent session reset`, `refactor(web): drop the new-conversation command`.

---

### Task 3: 서버 — 세션 만들기·목록·제목·닫기·정책

**Files:**
- Create: `apps/server/src/modules/conversations/{service,routes}.ts`
- Modify: `apps/server/src/modules/conversations/store.ts`·`db/schema.sqlite.ts`(+ 새 마이그레이션 — `channel_members.role`·`channels.session_policy_json`)·`auth/policies.ts`·`modules/channels/{service,routes}.ts`·`modules/messages/{service,routes}.ts`·`modules/components/*`·`modules/reactions/*`·`modules/attachments/*`·`modules/runs/orchestrator.ts`(`abortConversation`·닫힌 세션의 늦은 정본)·`realtime/{socket,events,bus}.ts`·`app.ts`
- Modify: `packages/shared/src/{domain,wire,common}/…`(`ErrorCode`·`Channel.sessionPolicy`·`ChannelMember.role`·`MessageSend`·wire 이벤트)
- Test: `apps/server/test/conversations.service.test.ts`(새), `conversations.routes.test.ts`(새), `roles.matrix.test.ts`, `apps/server/test/integration/conversations.test.ts`(새, 가짜 Gateway·플러그인)

**Interfaces:**
- Consumes: 태스크 1 의 `conversations` 저장소·`latestOpenConversation`.
- Produces(shared):

```ts
export const SessionPolicy = z.object({ create: z.enum(["members", "managers"]) });
// Channel 에 sessionPolicy: SessionPolicy (default { create: "members" }), ChannelMember 의 사람 행에 role: z.enum(["member", "manager"]).optional()
// ErrorCode 에 "CONVERSATION_CLOSED"
export const NewConversation = z.object({ title: ConversationTitle.optional() });
// MessageSend 에 conversationId: Id.optional(), newConversation: NewConversation.optional() — refine: 둘 다 있으면 안 된다(PS4 — 둘 다 없음은 태스크 5 까지 받는다)
// message.send ack: { message: Message; conversation?: Conversation } — conversationId 를 주지 않은 보내기(newConversation·다리)면 그 메시지의 세션, 재전송도 같다(태스크 3 판정 — Review Focus 1)
export const ConversationPatch = z.object({ title: ConversationTitle.optional(), closed: z.boolean().optional() })
  .refine((p) => p.title !== undefined || p.closed !== undefined);
export const ConversationList = z.object({ conversations: z.array(Conversation), nextCursor: z.string().optional() });
// ServerToClientEvents: "conversation.created": (p: { conversation: Conversation }) => void; "conversation.updated": (p: { conversation: Conversation }) => void — 둘 다 채널 룸
```

- Produces(서버 `conversations/service.ts`):

```ts
/** 닫힌 대화면 CONVERSATION_CLOSED, 없는·다른 워크스페이스면 NOT_FOUND. 채널 보관 검사를 먼저 한다 */
export function assertConversationWritable(db: DbOrTx, conversationId: string, workspaceId?: string): Conversation;
/** 사람 보내기의 대화 고르기 — conversationId · newConversation · (PS4 다리) 채널의 최근 열린 대화 · 자동 제목 새 대화 */
export function resolveSendConversation(tx: DbOrTx, input: { channelId: string; userId: string; role: TeamRole; conversationId?: string; newConversation?: { title?: string } }, now: Date): { conversationId: string; created?: Conversation };
/** 첫 메시지로 자동 제목 — title_source auto 이고 아직 메시지가 없을 때만, storeMessage 와 같은 트랜잭션 */
export function autoTitle(readable: string): string;
export type CloseDeps = { db: Db; bus: ServerBus; runs?: { abortConversation(conversationId: string): Promise<void> } };
export async function setConversationClosed(deps: CloseDeps, input: { conversationId: string; byUserId: string; closed: boolean }): Promise<Conversation>;
export function renameConversation(db: Db, bus: ServerBus, conversationId: string, title: string): Conversation;
export function listConversations(db: DbOrTx, channelId: string, q: { status: "open" | "closed" | "all"; q?: string; cursor?: string; limit: 20 }): ConversationList;
```

- Produces(`auth/policies.ts`): `authorizeConversationCreate(role, policy: SessionPolicy, isManager: boolean): void` · `authorizeConversationManage(role, actor: { isCreator: boolean; isManager: boolean }): void`(제목·닫기·다시 열기 — 스펙 3장 표) · `authorizeSessionManagers(role): void`(admin 이상). `MEMBER_EDITABLE_CHANNEL_FIELDS` 는 그대로(`sessionPolicy` 는 admin).
- Produces(REST): `GET /api/v1/channels/:id/conversations?status=open|closed|all&q=&cursor=` · `PATCH /api/v1/conversations/:id` · `GET /api/v1/conversations/:id/messages`(쿼리는 지금 `HistoryQuery`) · `GET /api/v1/conversations/:id/threads/:rootId/messages` · `PUT|DELETE /api/v1/channels/:id/session-managers/:userId`. 채널 경로 목록은 PS5 대로 남긴다.
- Produces(오케스트레이터): `Orchestrator.abortConversation(conversationId: string): Promise<void>` — 그 대화의 열린 런을 지금 `run.abort` 경로로 멈추고 승인을 `cancelled`.

- [ ] **Step 1: 실패하는 테스트 — 서비스.** `conversations.service.test.ts`:
  - 새 세션 보내기: 대화 행과 메시지가 함께 생기고 제목은 준 값, 안 주면 `autoTitle`. `autoTitle("@dev 안녕\n**굵게**")` → `"@dev 안녕 굵게"`, 첨부만(빈 본문) → `"새 세션"`, 45자 → 40 코드 포인트(이모지가 반으로 갈리지 않음).
  - 멱등(Review Focus 1): 같은 `clientMsgId` 로 `newConversation` 을 두 번 → 대화 1행·메시지 1행, 두 번째 응답의 메시지·대화가 첫 번째와 같다.
  - 정책 `managers`: member → `FORBIDDEN`, 세션 관리자·admin → 생성. 정책 `members`: member → 생성.
  - 닫기(Review Focus 2·3): 닫으면 그 대화로 보내기·카드 상호작용·리액션·첨부 묶기·스레드 답글이 `CONVERSATION_CLOSED`, 닫힘·다시 열기 시스템 메시지가 그 대화에 남고 `conversation.updated` 가 한 번씩. 다시 열면 보내기가 된다. 보관 채널의 대화는 `CHANNEL_ARCHIVED` 가 먼저.
  - 제목 바꾸기·닫기 권한: 만든 member → 자기 것 됨, 남의 것 `FORBIDDEN`; 세션 관리자·admin → 남의 것 됨. 비활성 멤버의 세션 관리자 행은 판정에서 빠진다.
  - 목록: 최근 활동순 20개, `status`·`q`(대소문자 무시) 필터, `nextCursor` 로 다음 쪽이 겹치지 않음.
  - 채널 만들기가 대화를 만들지 않는다(PS1 끝 — 태스크 1 의 `createLegacyConversation` 호출을 걷는다). 대화가 없는 채널에 다리(PS4)로 보내면 자동 제목 새 세션이 생긴다.
- [ ] **Step 2: 실패하는 테스트 — 경로·매트릭스.** `conversations.routes.test.ts`·`roles.matrix.test.ts`: 위 REST 다섯 개의 역할별 결과(스펙 3장 표), 다른 워크스페이스 대화 404, `PUT session-managers` 가 채널에 없는 사람을 참여시킨다.
- [ ] **Step 3: 실패하는 테스트 — 통합.** `integration/conversations.test.ts`: 닫기 순간 도는 런이 멈추고(가짜 Gateway 에 abort), 그 뒤 온 늦은 정본은 그 대화에 저장만 되고 릴레이·푸시 없음.
- [ ] **Step 4: 실패 확인.**
- [ ] **Step 5: 구현.** 마이그레이션(두 열, 기본값 있음 — 표 다시 만들기 없음). `storeMessage` 가 대화를 쓰기 검사하는 것은 사람·자동화·카드·리액션 쪽이고, 에이전트 정본과 시스템 메시지는 닫힌 대화에도 저장된다(정본은 저장만 — 스펙 7장). 늦은 정본 판정은 지금 `archivedTarget` 옆에 「대화가 닫혔다」를 더한다. wire `message.send` 는 `resolveSendConversation` 을 `findUserMessage` 뒤에 부른다(PS9). 스레드 답글(`threadRootId` 있음)은 다리(PS4)에서도 **루트의 대화**를 쓴다 — 태스크 1 의 `socket.ts` 는 답글도 `latestOpenConversation` 으로 골라, 세션이 둘이 되는 순간 다른 세션의 루트에 단 답글이 `VALIDATION` 에 걸린다(태스크 1 리뷰 N-b). 이벤트는 `bus` 에 `conversation.created`·`conversation.updated` 를 더하고 `realtime/events.ts` 가 채널 룸으로 낸다.
- [ ] **Step 6: 통과 확인 + 끝내기 검사 + 서버 번들 스모크.**
- [ ] **Step 7: 커밋** — `feat(shared): add conversation contracts and the closed error`, `feat(server): create, list, rename and close channel sessions`.

---

### Task 4: 서버·어댑터 — 런과 에이전트가 세션 단위로

**Files:**
- Modify: `apps/server/src/modules/runs/{context,orchestrator}.ts`·`modules/ops/budget.ts`·`modules/control/service.ts`·`modules/automations/{post,store}.ts`·`modules/messages/service.ts`(`createAutomationMessage` 가 대화를 고르는 함수를 받는다)·`modules/reactions/service.ts`(`pendingReactionsFor` 를 대화 단위로 — 태스크 4 리뷰 중간 A)·`db/schema.sqlite.ts`(+ 마이그레이션 — `automations.conversation_id` nullable FK)
- Modify: `packages/shared/src/bridge/index.ts`(`InboundDeliver.conversationTitle`)·`packages/shared/src/runner/prompt.ts`·`packages/openclaw-plugin/src/{context,outbound,channel}.ts`·`packages/runner-adapter/src/runner-adapter.ts`(`buildTurnFacts` 에 제목)
- Test: `apps/server/test/integration/conversations.test.ts`(이어서), `ops.budget.test.ts`, `control.service.test.ts`, `automations.*.test.ts`, `late-canonical.test.ts`, `packages/openclaw-plugin/test/*`, `packages/shared/test/runner-prompt*.test.ts`(있는 것), `packages/claude-runner/test/adapter-integration.test.ts`

**Interfaces:**
- Consumes: 태스크 3 의 `assertConversationWritable`·`latestOpenConversation`·`Conversation`.
- Produces: `InboundDeliver.conversationTitle: ConversationTitle`. 플러그인 헤더(`context.ts`)와 러너 턴 사실(`runner/prompt.ts`)의 `[dodok context]` 줄 다음에 `세션: <제목>` 한 줄. 서버 정본 대조 `assertCanonicalConversation(msg: OutboundMessage): string`(세션 키의 대화 id 와 `msg.conversationId` 가 다르면 `AdapterError("FORBIDDEN", "이 대화에만 보낼 수 있습니다")` — 런이 있든 없든). `automations.conversationId: string | null`. 런 한도 알림의 「오늘 이미 남겼나」는 `(conversationId, scope)` 단위(`budget.ts` `announcedToday`).

- [ ] **Step 1: 실패하는 테스트 — 맥락.** `integration/conversations.test.ts`: 한 채널의 두 세션에서 같은 에이전트를 멘션하면 세션 키 둘(`dodokSessionKey(dev, A)`·`(dev, B)`)이 따로 돌고, B 런의 `recentMessages` 에 A 의 글이 없다 · 두 런이 병렬(한쪽이 `streaming` 인 동안 다른 쪽도 시작) · 스레드는 그 세션 안의 하위 키 · 인바운드 헤더에 `세션: <B 제목>`. 릴레이는 같은 세션 안에서만 이어진다(A 의 에이전트 답이 B 의 에이전트를 깨우지 않는다).
- [ ] **Step 2: 실패하는 테스트 — 대화 밖 전송(Review Focus 4).** 서버: 세션 키가 A 인 정본이 `conversationId: B`(같은 채널)·`conversationId: <다른 채널의 대화>` 로 오면 런이 있든 없든 저장되지 않고 `FORBIDDEN`. 플러그인(`packages/openclaw-plugin/test/outbound*.test.ts`): `messageToolSendToOutbound` 에 `to: "channel:<B>"` → `{ ok: false, error: "이 대화에만 보낼 수 있습니다" }`, `to` 없음 → 세션 키의 대화, `to` 가 세션의 대화와 같으면 통과.
- [ ] **Step 3: 실패하는 테스트 — 한도·제어·자동화.** `ops.budget.test.ts`: 같은 날 세션 A 에서 막힌 뒤 세션 B 에서 막히면 알림이 A·B 에 하나씩(지금은 채널에 하나). `control.service.test.ts`: 채널 X 의 런(대화 A)이 X 를 바꾸면 메시지는 A, 다른 채널 Y 를 바꾸면 Y 의 최근 열린 대화, Y 에 열린 대화가 없으면 메시지 없음·운영 사건은 남음, 바깥 `/mcp`(런 없음)도 같은 규칙. 자동화: 첫 게시가 「⚙ <이름>」 세션을 만들어 `automations.conversation_id` 에 달고, 그 세션에 이어 쓰며, 닫혀 있으면 새 세션을 만들어 바꿔 단다 · 정책 `managers` 인 채널에도 게시된다.
- [ ] **Step 4: 실패 확인.**
- [ ] **Step 5: 구현.** `buildInboundDeliver` 의 최근 메시지 질의를 `messages.conversation_id = run.conversationId` 로. `onCanonical` 첫머리(중복 확인 뒤)에 `assertCanonicalConversation`. 플러그인의 `messageToolSendToOutbound` 는 스레드 세션의 「같은 채널만」 검사를 「세션 키의 대화만」으로 넓혀 모든 세션에 건다(스레드 사유 `THREAD_ONLY_REASON` 은 다른 `threadId` 에만 남는다). 코어 일반 전송(`sendText` — 에이전트 컨텍스트 없음)은 그대로 둔다(키를 대상에서 만들어 늘 맞는다 — 서버가 에이전트를 모르면 지금처럼 거절). 러너 어댑터는 이미 「그 런의 대화만」이다. 한도 알림의 「오늘 이미 남겼나」를 대화 단위로. 자동화 세션은 태스크 3 의 다리(`automations/post.ts` — 열린 대화가 없으면 만든다)를 바꾼다: 대화 만들기를 `createAutomationMessage` 의 트랜잭션 안(보관 검사 뒤)으로 옮겨 보관 채널에 빈 세션을 남기지 않고, 새로 만들었으면 커밋 뒤 `conversation.created` 를 낸다(태스크 3 리뷰 중간 3).
- [ ] **Step 6: 통과 확인 + 끝내기 검사 + 서버 번들 스모크 + 플러그인 빌드.**
- [ ] **Step 7: 커밋** — `feat(server): keep runs, relays and notices inside their session`, `feat(plugin): refuse sends outside the session conversation`, `feat(runner): name the session in the turn header`.

---

### Task 5: 웹 — 세션 경로·캐시·보내기

**Files:**
- Modify: `apps/web/src/app/router.tsx`·`features/channels/HomeRedirect.tsx`·`api/queries.ts`·`realtime/{subscriptions,handlers,timelineCache}.ts`·`realtime/WireProvider.tsx`·`features/messages/{ChannelPage,MessageList,timeline,useTimeline,useOlderPages,useNewerPages,useJump}.ts(x)`·`features/threads/*`·`features/composer/{useSendMessage,Composer,useTyping,TypingIndicator}.ts(x)`·`features/runs/useChannelBubbles.ts`·`features/approvals/*`·`pwa/persist.ts`
- Modify(서버 — 다리 걷기): `packages/shared/src/wire/index.ts`(`MessageSend` refine 「정확히 하나」·`ChannelSubscribeResult`·`Typing`·`PresenceUpdate`), `apps/server/src/realtime/socket.ts`·`modules/conversations/service.ts`(다리), `modules/messages/routes.ts`(채널 경로 목록 걷기)
- Test: `apps/web/src/realtime/{subscriptions,handlers}.test.ts`, `features/messages/{ChannelPage,timeline}.test.ts(x)`, `features/composer/useSendMessage.test.ts`, `pwa/persist.test.ts`, `app/router.test.tsx`, `apps/server/test/{realtime*,conversations.service}.test.ts`

**Interfaces:**
- Consumes: 태스크 3 의 REST·wire·이벤트.
- Produces(웹): 경로 `/c/$channelId`(→ 열린 세션 가운데 최근 활동으로 `replace` 넘김, 없으면 `/c/$channelId/s/new`) · `/c/$channelId/s/$conversationId`(`new` 는 빈 새 세션 창 — 첫 보내기가 `newConversation` 을 싣고 ack 의 대화로 `replace` 넘김) · 그 아래 `settings`·`activity`·`t/$rootId`. `qk.timeline(conversationId)`·`qk.thread(conversationId, rootId)`·`qk.threads(conversationId)`·`qk.channelSeq(channelId)`·`qk.conversations(channelId, status)`. `useSendMessage(channelId, conversationId | "new")`. `PendingFailReason` 에 `"conversation_closed"`.
- Produces(서버): 처음 `channel.subscribe` 는 `messages: []`(PS5). `MessageSend` 는 `conversationId` 와 `newConversation` 가운데 정확히 하나. `Typing`·`PresenceUpdate` 에 `conversationId`(서버 중계·푸시 거름이 대화 단위 — 거름 자체는 태스크 7).

- [ ] **Step 1: 실패하는 테스트.**
  - `router.test.tsx`: `/c/<ch>` 가 최근 열린 세션으로, 세션이 없으면 `/s/new` 로 넘긴다 · `/c/<ch>/s/<conv>/t/<root>` 새로고침이 그 세션과 스레드를 연다.
  - `subscriptions.test.ts`: 처음 구독은 메시지를 넣지 않고 대화 REST 로 첫 페이지 · `message.created`(대화 B)는 B 타임라인 캐시가 있을 때만 넣고 `channelSeq` 는 올린다 · 재동기화 응답의 메시지를 대화별 캐시로 나눈다 · **Review Focus 5**: 재동기화 `hasMore: true` → 그 채널의 대화 타임라인·스레드 캐시가 모두 사라지고 지금 세션만 다시 받는다.
  - `useSendMessage.test.ts`: `/s/new` 에서 보내면 `newConversation` 을 싣고 ack 의 대화로 넘기며 보내는 중 항목이 새 세션 타임라인으로 옮겨 간다 · ack `CONVERSATION_CLOSED` → 실패 사유 `conversation_closed`(다시 보내기 없음 — `channel_archived` 와 같은 처리).
  - 스트리밍 버블·승인 카드·입력 중 표시는 같은 세션에서만(`RunState.conversationId`·`Approval.conversationId`·`Typing.conversationId`).
  - `persist.test.ts`: 최근 채널 5개마다 마지막으로 본 세션 하나의 타임라인(+ 그 세션에서 연 스레드 하나)만 남긴다.
  - 서버: `MessageSend` 가 둘 다 없음·둘 다 있음을 `VALIDATION`, 채널 경로 메시지 REST 가 404.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.** PS6 대로 캐시를 대화 단위로 옮긴다. 채널 머리·설정·활동 패널은 채널 그대로. 「새 메시지」 구분선·떨어진 창·「최신 메시지로」는 대화 타임라인 위에서 지금 규칙 그대로(읽음 단위는 태스크 7). 서버 다리(PS4)와 채널 경로 목록(PS5)을 걷는다.
- [ ] **Step 4: 통과 확인 + 끝내기 검사 + 웹 빌드 + 서버 번들 스모크.**
- [ ] **Step 5: 커밋** — `feat(web): route and cache timelines per session`, `refactor(server): require an explicit conversation on send`.

---

### Task 6: 웹 — 세션 목록·머리·닫기·설정

**Files:**
- Create: `apps/web/src/features/conversations/{ConversationList.tsx,ConversationTitle.tsx,ClosedNotice.tsx,queries.ts,mutations.ts}`·테스트
- Modify: `apps/web/src/app/layout/ChannelHeader.tsx`·`features/messages/ChannelPage.tsx`·`features/composer/Composer.tsx`·`features/settings/{ChannelSettingsPanel.tsx,SessionSection.tsx(새)}`·`realtime/handlers.ts`(`conversation.created`·`conversation.updated`)
- Test: `apps/web/src/features/conversations/conversations.test.tsx`(새), `features/settings/settings.test.tsx`

**Interfaces:**
- Consumes: 태스크 3 의 REST·이벤트, 태스크 5 의 경로·`qk.conversations`.
- Produces: 세션 목록(넓은 화면 타임라인 왼쪽 접히는 칸, 좁은 화면 시트 — 배치는 빌더 판단, 스펙 6장): 제목·마지막 활동·(태스크 7 이 채울) 읽지 않음 점·멘션 배지 자리, 「열림/닫힘」 필터, 제목 검색, 「새 세션」(정책·역할로 숨김). 머리의 지금 세션 제목(권한이 있으면 눌러 이름 바꾸기). 닫힌 세션은 작성기 자리에 「닫힌 세션입니다」와 (권한이 있으면) 「다시 열기」. 채널 설정 「세션」 칸: 정책(누구나 / 세션 관리자만)·세션 관리자 목록(admin 이상만 바꿈).

- [ ] **Step 1: 실패하는 테스트.** 목록이 최근 활동순·필터·검색으로 바뀐다 · `conversation.created`(다른 탭이 만든 세션)가 목록 맨 위에 든다 · `conversation.updated`(닫힘)를 받으면 그 세션을 보고 있던 화면의 작성기가 「닫힌 세션입니다」로 바뀌고 보내는 중 항목은 Review Focus 2 대로 · 정책 `managers` 의 member 에게 「새 세션」이 없다 · member 는 남의 세션 제목을 못 바꾼다(제목이 버튼이 아니다) · 설정 「세션」 칸은 admin 이상만 바꾼다(member 는 읽기) · 390px 에서 시트로 열리고 닫으면 초점이 여는 버튼으로 돌아온다.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.** 기존 공용 UI(`@/ui/*`·설정의 `Section`)를 쓴다. 채널 설정 프롬프트 칸의 저장 안내(`PROMPT_SAVED_NOTICE` — 앞 문장 `RUNNER_RENEW_NOTICE`)와 서버 info 메시지(`notifyRenewed`)가 러너가 세션을 새로 여는 것을 「새 대화」라고 부른다 — 한 문장 안에 「새 대화」와 「새 세션」이 섞이므로, 이 기능의 「세션」(dodok 대화)과 헷갈리지 않는 말로 맞춘다(태스크 2 리뷰 7-4). 「새 세션」 단축키는 빌더 판단(있으면 `docs/manual/user-guide.md` 에 적는 것은 태스크 9).
- [ ] **Step 4: 통과 확인 + 끝내기 검사 + 웹 빌드.**
- [ ] **Step 5: 커밋** — `feat(web): list, rename and close sessions in a channel`.

---

### Task 7: 읽음·검색·푸시·제어 도구를 세션 단위로

**Files:**
- Modify(서버): `db/schema.sqlite.ts`(+ 마이그레이션 — `channel_reads` → `conversation_reads`, 시드는 `channel_reads` 값을 그 채널의 「이전 대화」로 옮기고, 그 밖의 대화는 membership(비활성 포함) × 대화를 그 대화의 `last_seq` 까지 읽음으로 — 읽지 않음 스펙의 시드와 같은 까닭)·`modules/reads/{store,routes}.ts`·`realtime/{socket,events,bus}.ts`·`modules/search/{service,routes}.ts`·`modules/push/{triggers,presence}.ts`·`modules/control/handlers.ts`·`packages/shared/src/{reads,search,control/tools}.ts`
- Modify(웹): `features/reads/*`·`features/channels/ChannelList.tsx`·`features/conversations/ConversationList.tsx`(점·배지)·`features/search/*`·`pwa/sw-logic.ts`(`SAFE_URL`)
- Test: `apps/server/test/{reads.store,push.triggers,push.presence,search.service,control.service}.test.ts`, `apps/web/src/features/{reads,search}/*.test.ts(x)`, `realtime/handlers.unread.test.ts`, `pwa/sw-logic.test.ts`

**Interfaces:**
- Consumes: 태스크 5·6.
- Produces(shared): `ConversationUnread = { conversationId, channelId, lastReadSeq, latestSeq, unread, mentions }`(규칙은 지금 `ChannelUnread` 그대로, 단위만 대화), `UnreadSnapshot = { conversations: ConversationUnread[] }`(보관 안 한 채널의 열린·닫힌 대화 모두), wire 클라이언트 → 서버 `conversation.read: (p: { conversationId; seq }, ack: Ack<{ lastReadSeq: number }>)`, 서버 → 클라이언트 `conversation.read: (p: { conversationId; channelId; lastReadSeq })`(user 룸), `ChannelActivity` 에 `conversationId`. `SearchHit` 에 `conversationId`·`conversationTitle`, `SearchQuery` 에 `conversationId?`. 제어 도구 `read_messages` 는 `{ conversationId, … }` 를 받고, `search_messages` 결과에 `conversationId`.
- Produces(서버): `markRead(db, workspaceId, userId, conversationId, seq, now): number`(그 대화의 `last_seq` 로 깎는다) · `unreadFor(db, workspaceId, userId): ConversationUnread[]`. 푸시 URL `/c/<channelId>/s/<conversationId>[/t/<rootId>]`, 멘션 tag `mention:<conversationId>`·`mention:t:<rootId>`(80자 안), 거름은 대화 단위(PS7).
- Produces(웹): 사이드바 굵게 = 그 채널 대화 가운데 하나라도 `unread`, 배지 = 대화 배지 합(99 에서 자름). 세션 목록의 점·배지는 대화 값. 검색 결과로 가기 = `/c/<ch>/s/<conv>?around=<seq>`.

- [ ] **Step 1: 실패하는 테스트.** 서버: 대화 A·B 의 읽음이 따로 오르고 `last_seq` 로 깎인다 · 스냅숏이 대화별 · 시드가 옛 채널 읽음을 「이전 대화」로 옮긴다 · 같은 채널의 세션 A 를 보고 있는 사람에게 세션 B 의 멘션 푸시가 간다(A 의 멘션은 거른다) · 푸시 URL 꼴 · 검색 결과가 세션을 싣고 `conversationId` 로 거른다 · `read_messages` 가 다른 대화의 글을 섞지 않는다. 웹: 두 세션의 배지 합 · 다른 세션의 글이 사이드바를 굵게 · 검색 결과를 누르면 그 세션의 그 메시지로 · 서비스 워커가 `/c/<id>/s/<id>/t/<id>` 를 안전한 URL 로 받는다.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.** 읽지 않음 스펙(`docs/superpowers/specs/2026-10-05-unread-design.md`)의 규칙·판정 PU1~PU7 은 단위만 바꿔 그대로 둔다(작성자 읽음은 새 최상위 메시지의 대화).
- [ ] **Step 4: 통과 확인 + 끝내기 검사 + 웹 빌드 + 서버 번들 스모크.**
- [ ] **Step 5: 커밋** — `feat(server): track reads, search and push per session`, `feat(web): show unread and search results per session`.

---

### Task 8: dev:fake·통합 시나리오·브라우저 검증

**Files:**
- Modify: `apps/server/scripts/dev-fake.ts`(가짜 Gateway·플러그인·러너 대본이 대화 id 키를 쓴다, 시작 때 채널마다 세션 둘 — 「이전 대화」 하나 + 새 세션 하나)·`apps/server/test/integration/*`
- Create: `.superpowers/sdd/2026-10-25-channel-sessions-browser/report.md`(검증 기록 — 실행 기록 자리 관례)

- [ ] **Step 1: 통합 시나리오.** `integration/conversations.test.ts` 에 완료 기준 1~4(스펙 9장)를 한 흐름씩 — 두 세션·두 맥락, 닫기·다시 열기·검색으로 찾기, 정책 `managers`, 읽음·검색·푸시 링크가 세션을 가리킴.
- [ ] **Step 2: 브라우저 검증.** `docs/guides/browser-verification.md` 를 따른다(독립 Chromium, owner·mia 두 계정, 1280·390px, 브리프가 주는 포트). 항목: 세션 목록·전환·새 세션(첫 보내기 뒤 URL 이 바뀜)·제목 바꾸기·닫기(다른 탭의 작성기가 바뀜)·다시 열기·URL 새로고침·푸시 링크(`/__devfake` 훅 없이 알림 URL 을 직접 연다)·검색 결과로 가기·읽지 않음(세션 점·사이드바 합)·정책 `managers` 의 member 화면·`/new` 가 보통 글로 감. 콘솔 오류 0 을 확인한다. 결함은 고치고 그 항목을 다시 본다.
- [ ] **Step 3: 끝내기 검사 + 웹 빌드 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `test(server): cover channel sessions end to end`, `chore(server): give dev:fake two sessions per channel`.

---

### Task 9: 실연·문서

**Files:**
- Modify: `docs/guides/live-smoke.md`(새 절 「채널 세션 실연」), `.ruler/AGENTS.md`(불변 규칙의 세션 키 줄 — 소스를 고치고 `pnpm exec ruler apply`), `docs/guides/agent-guide.md`(헤더 `세션:` 줄·대화 밖 전송 거절·「새 대화」 없음), `docs/manual/user-guide.md`(「세션」 절·「새 대화」 걷기·권한 표), `docs/guides/project-structure.md`(`conversations`·대화 id 열·FTS 다시 넣은 마이그레이션 번호), 팀 스펙 「역할과 권한」 표, 스펙 「구현과 맞춘 것」 장(PS1~PS10 + 구현 중 판정), `docs/guides/plan.md` 8장 이월, `.ruler/AGENTS.md` 「현재 단계」

- [ ] **Step 1: 런 0회 실연.** `docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」와 dev Gateway 가짜 claude CLI 절차로, 실물 dev Gateway(2026.9.5)에서 대화 id 키의 세션 둘이 따로 맥락을 갖는지 본다 — OpenClaw 가 대화 id 를 피어로 받는다는 것이 이 기능의 유일한 가정이다(스펙 8장). 같은 것을 러너 하네스로. 모델 런의 message 툴 호출(`handleAction`)에 세션 키가 늘 실리는지도 tool-send 로그 줄로 본다 — 세션 키가 없는 호출은 플러그인이 대상 대화로 키를 만들어 대화 밖 전송 거절 밖에 남는다(태스크 4 보고 3장 「남은 경로」 1). 마이그레이션 뒤 「이전 대화」에서 기존 OpenClaw 세션이 이어지는지(같은 키)도 본다. 모델 런 0.
- [ ] **Step 2: 문서.** 위 파일들. 사본(`docs/guideline/`·`.ruler/<스택>/`)은 고치지 않는다. 함께 넣을 것:
  - 스펙 「구현과 맞춘 것」에 태스크 3 판단: 제어 도구 `update_channel` 은 `name`·`topic` 만 받아 세션 정책에 닿지 않는다 · 자동 제목은 만들 때 한 번 짓는다(평문 본문 + 핸들 조회) · 닫힌 세션의 제목은 바꿀 수 있다 · `channel_members.role` 은 기본값 없는 nullable(사람 행은 서버가 `member` 를 쓰고 null 은 member 로 읽는다) · 목록 `q` 는 SQLite `LIKE`(ASCII 만 대소문자 무시) · PS11·PS12.
  - 스펙 「에이전트가 받는 것」 절의 「에이전트의 글은 세션 키의 대화에만 저장한다」 문단 끝에: 세션 키가 없는 툴 호출(에이전트 세션 문맥 없음)은 플러그인이 대상 대화로 키를 만들어 이 규칙 밖에 남는다 — Step 1 에서 확인한 대로 「가정」 또는 「확인한 사실」로 적는다. 태스크 4 판단: 보관 채널의 대화 밖 정본은 `CHANNEL_ARCHIVED` 가 아니라 `FORBIDDEN` · dodok 모양이 아닌 세션 키에서 dodok 으로 보내는 것도 거절 · 상호작용 트리거 메시지 조회도 대화 단위 · 자동화 세션 제목은 `⚙ <이름>` 을 80 코드 포인트로 자른다 · `InboundDeliver.conversationTitle` 필수(옛 서버 + 새 플러그인 롤백은 지키지 않는다 — 사용자 결정 「기존 버전 호환 고려 안 함」).
  - 에이전트 가이드 `docs/guides/agent-guide.md` 의 보관 채널 문장(「다른 채널 세션에서 `message` 툴로 보관한 채널에 보내면 … `CHANNEL_ARCHIVED`」)을 「다른 세션·다른 채널·dodok 밖 세션(다른 채널 플러그인·서브에이전트·크론)에서 보내면 툴 오류 「이 대화에만 보낼 수 있습니다」」로 바꾸고, 채널 보관 스펙 「구현과 맞춘 것」에도 한 줄(태스크 4 리뷰 낮음 2). 서버는 런 없는 정본을 서버가 만든 에이전트 세션 행이 있는 키일 때만 받는다(태스크 4 리뷰 중간 B 판정) — 스펙 「구현과 맞춘 것」에 적는다.
  - 에이전트 가이드 헤더 절: 헤더 꼴 예시의 `[dodok context] …` 줄 다음에 `세션: <제목>` 줄과 「제목은 사람이 쓴 글이다 — 한 줄로 접혀 실린다」. 러너 쪽은 턴 사실(UserPromptSubmit 의 additionalContext) 둘째 줄.
  - `docs/guides/plan.md` 8장 「이월」 — `packages/openclaw-adapter/src/gateway/client.ts` `DEFAULT_GATEWAY_SCOPES` 의 `operator.admin`: 「새 대화」(`sessions.reset`)를 걷어 어댑터가 부르는 메서드(`chat.abort`·`agents.list`·`sessions.messages.subscribe`·`approval.resolve`) 가운데 admin 이 필요한 것이 확인되지 않는다. 빼면 페어링된 디바이스의 스코프가 달라져 다시 승인이 필요할 수 있고, Gateway 는 없는 메서드도 `MISSING_SCOPE operator.admin` 으로 답하므로(ADR 0001) 빼기 전에 실물 Gateway 에서 다시 잰다. 태스크 2 보고·리뷰.
  - `docs/guides/docker-deploy.md` 「업데이트」 — 이 판부터 플러그인·`dodok-runner` 를 다시 설치해야 한다(나가는 글의 `conversationId`·첨부 헤더 `x-dodok-conversation-id` — 옛 것은 에이전트 답·첨부가 서버 Zod 에서 거절돼 저장되지 않는다). 태스크 1 리뷰 N-a.
  - `docs/guides/project-structure.md` DB 절에 두 줄. ① 마이그레이터는 트랜잭션 안에서 돌고 서버는 `foreign_keys = ON` 으로 열어 생성 SQL 의 `PRAGMA foreign_keys=OFF` 가 듣지 않는다 — 자식 행이 있는 표를 다시 만들면 ON DELETE no action 자식은 `FOREIGN KEY constraint failed` 로 마이그레이션이 죽고 cascade 자식(`message_reactions`)은 조용히 지워지므로, 자식 행을 TEMP 표로 옮겨 두고 다시 만든 뒤 되돌린다(0025 — `defer_foreign_keys`·`legacy_alter_table` 은 실측에서 커밋이 실패했다, 가드 `test/db.test.ts` 「conversations 마이그레이션」). ② 기존 표에 NOT NULL FK 열을 더하면 drizzle-kit 은 `ALTER TABLE … ADD … NOT NULL REFERENCES …` 를 내고 SQLite 가 받지 않으니 SQL 본문을 손으로 쓴다(0010·0025, 스냅숏은 생성기 출력 그대로).
- [ ] **Step 3: `pnpm exec ruler apply` 뒤 `git status` — 추적 파일은 소스만 바뀐다.**
- [ ] **Step 4: 끝내기 검사(문서만이면 `pnpm fmt:check`).**
- [ ] **Step 5: 커밋** — `docs: record channel sessions and their live smoke`.

---

## Self-Review 기록

- 스펙 대응: 결정 1·4(태스크 1)·2(채널 설정 그대로 — 바꾸는 태스크 없음)·3(1·4)·5(3)·6(2)·7(3·5) · 범위 「한다」 전부(1·3·4·5·6·7·9) · 데이터 2장(1·3·4·7) · 권한 3장(3) · 동작 4.1(3)·4.2(4)·4.3(1·4)·4.4(4) · wire·REST 5장(3·5·7) · 웹 6장(5·6·7) · 오류 7장(3·4) · 검증 8장(각 태스크·8·9) · 완료 기준(8·9).
- 이름 대조: `conversationId` 를 shared·DB·서버·웹이 같이 쓴다 · `latestOpenConversation`(1·3·4) · `assertConversationWritable`(3·4) · `CONVERSATION_CLOSED`(3·5·6) · `qk.timeline(conversationId)`(5·7).
- Review Focus 다섯 줄 모두 소유 태스크에 테스트가 있다(1→3, 2→3·6, 3→3, 4→4, 5→5).
