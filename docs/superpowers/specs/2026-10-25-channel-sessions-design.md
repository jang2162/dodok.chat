# 채널 세션 설계 (하위 프로젝트 A)

**상태**: 확정(2026-10-25, 사용자 승인).
**범위**: 한 채널 안에서 대화를 주제마다 「세션」으로 나눈다. 세션마다 채팅창(메시지 목록)이 따로이고 에이전트 맥락도 따로다. 채널마다 누가 세션을 만들고 닫을지 정한다. DM(스펙 B)이 같은 모델을 쓴다.

**앞선 근거**:
- 로드맵 `docs/superpowers/specs/2026-10-25-sessions-dm-runner-roadmap.md` 결정 1·3·4·5
- 스레드(하위 세션·seq 공유·구독 한 룸·around): `docs/superpowers/specs/2026-09-25-threads-search-design.md` 와 그 「구현과 맞춘 것」
- 읽지 않음: `docs/superpowers/specs/2026-10-05-unread-design.md`
- 채널 규칙 리비전·러너 세션 새로 열기: 러너 스펙 「구현과 맞춘 것」 장 끝(`renewSessionOnPromptChange`)

---

## 0. 결정

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **채널의 모든 메시지는 세션 하나에 속한다** — `messages.conversation_id` NOT NULL. 스레드는 세션 안에 있다(답글은 루트의 세션) | 「채널 전체 타임라인」과 「세션」이 따로 있으면 어디에 쓰는지가 두 갈래가 된다. 스레드는 세션 안의 곁가지로 지금 그대로 쓸모가 있다. |
| 2 | **세션 메타는 채널에 남는다** — 에이전트 멤버·자동 응답·채널 프롬프트·릴레이 정책·일일 한도는 채널 것이고 모든 세션에 같다 | 세션은 「주제별 창」이지 설정 단위가 아니다. 세션마다 설정이 갈리면 관리할 것이 세션 수만큼 는다. |
| 3 | **에이전트 세션은 (대화, 에이전트[, 스레드])마다 하나**, 키의 `channel:` 자리에 대화 id | 로드맵 결정 4. |
| 4 | **seq 는 채널 하나의 연속 번호를 모든 세션이 같이 쓴다** | 스레드와 같은 이유 — wire 재구독(`lastSeq`)·오프라인 사본·`around` 가 그대로 돈다. |
| 5 | **세션은 지우지 않고 닫는다** — 닫힌 세션은 읽기 전용, 다시 열 수 있다 | 채널·에이전트 보관과 같은 원칙. 과거 대화를 찾는 것이 이 기능의 목적이다. |
| 6 | **「새 대화」(에이전트 세션 리셋)를 없앤다** | 로드맵 결정 5. 채널·스레드의 리셋 버튼·`/new`·REST `POST …/agents/:agentId/reset` 를 걷는다. |
| 7 | **빈 세션은 만들지 않는다** — 「새 세션」을 누르면 빈 창이 열리고, 첫 메시지를 보낼 때 세션 행이 생긴다 | 눌렀다 떠난 빈 세션이 목록을 채우지 않게. |

## 1. 범위

**한다**
- 표 `conversations`, `messages`·`agent_sessions`·`runs`·`attachments`(필요하면)·읽음에 대화 id
- 채널 화면의 세션 목록·전환·새 세션·제목 바꾸기·닫기·다시 열기·세션 안 검색(제목)
- 채널별 세션 정책과 「세션 관리자」(채널 멤버의 역할)
- 에이전트 헤더에 세션 제목, 최근 대화는 그 세션 것만
- 읽지 않음을 세션 단위로, 푸시·검색 결과·URL 이 세션을 가리킴
- 자동화가 게시할 세션
- `AGENTS.md`(소스 `.ruler/AGENTS.md`) 불변 규칙의 세션 키 줄, `docs/guides/agent-guide.md`·`docs/manual/user-guide.md` 갱신

**하지 않는다**
- 세션마다 다른 에이전트·프롬프트·한도(결정 2)
- 세션 삭제, 세션을 다른 채널로 옮기기, 세션 합치기·쪼개기, 메시지를 다른 세션으로 옮기기
- 에이전트가 세션을 스스로 열기, 에이전트가 세션 제목 짓기(로드맵 후보)
- 세션 포크(로드맵 후보)

## 2. 데이터

### 2.1 `conversations` (새 표)

| 열 | 뜻 |
| --- | --- |
| `id` | UUID |
| `channel_id` | FK channels |
| `title` | 1~80자. 만든 사람이 안 주면 첫 메시지 본문의 앞 40자(멘션은 `@핸들` 로 푼 읽는 글, 줄바꿈은 공백) |
| `title_source` | `user` · `auto` — `auto` 인 동안만 첫 메시지로 다시 지을 수 있다(만들 때 한 번) |
| `created_by_type`·`created_by_id` | `user` · `automation` |
| `created_at`·`last_message_at`·`last_seq` | 목록 정렬(최근 활동순)과 읽지 않음 |
| `closed_at`·`closed_by` | null 이면 열림 |

인덱스 `(channel_id, closed_at, last_message_at)`.

### 2.2 기존 표

- `messages.conversation_id` NOT NULL, 인덱스 `(conversation_id, thread_root_id, seq)`. 답글의 대화는 루트와 같아야 한다(저장 경로가 검사).
- `agent_sessions` — 단위가 (대화, 에이전트, 스레드). 유일 인덱스 둘(스레드 행·대화 행 `WHERE thread_root_id IS NULL`)을 `conversation_id` 로 바꾼다. `channel_id` 는 질의용으로 남긴다.
- `runs.conversation_id` NOT NULL.
- `channel_reads` → **`conversation_reads(user_id, conversation_id, last_read_seq, updated_at)`**. 커지기만 하고 그 대화의 `last_seq` 로 깎는 규칙은 지금과 같다(`modules/reads/`).
- `channel_members` 의 사람 행에 `role`(`member` · `manager`, 기본 `member`). 에이전트 행은 null.
- `channels.session_policy_json` — `{ create: "members" | "managers" }`, 기본 `members`.
- 마이그레이션(결정 1 — 로드맵): 채널마다 대화 하나(「이전 대화」, **id 는 그 채널 id 와 같게** — 저장된 `agent_sessions.session_key`·`runs.session_key` 와 OpenClaw 쪽 이력이 새로 계산한 키와 그대로 맞는다, `title_source: user`, 만든 사람 = 채널 만든 사람)를 만들고 그 채널의 메시지·런·에이전트 세션·읽음을 모두 거기로 옮긴다. FTS 트리거·백필 규칙(`messages` 를 재생성하는 마이그레이션은 트리거·백필을 다시 넣는다 — `docs/guides/project-structure.md`)을 지킨다.

## 3. 권한

| 하는 일 | 누가 |
| --- | --- |
| 세션 읽기·쓰기(열린 세션), 목록 보기 | 채널을 볼 수 있는 사람(지금은 워크스페이스 전원 — 스펙 B 의 `canReadChannel`) |
| 새 세션 만들기 | 정책 `members` 면 누구나, `managers` 면 그 채널의 세션 관리자와 admin 이상 |
| 자기가 만든 세션의 제목 바꾸기·닫기·다시 열기 | 만든 사람, 세션 관리자, admin 이상 (설계자 판단 — 자기 세션은 자기가 정리한다) |
| 남의 세션 제목 바꾸기·닫기·다시 열기 | 세션 관리자, admin 이상 |
| 세션 관리자 지정·해제, 세션 정책 | admin 이상 |

- 서버가 요청마다 판정한다(`auth/policies.ts` 에 함수로 — 팀 스펙 규칙). 웹이 숨기는 것은 편의다.
- 세션 관리자는 채널 멤버여야 한다 — 지정하면 그 사람을 채널에 참여시킨다. 비활성 멤버는 판정에서 빠진다(`roleOf` 가 이미 막는다).
- 보관한 채널은 세션도 모두 읽기 전용(`assertChannelWritable` 이 먼저 막는다).

## 4. 동작

### 4.1 세션 만들기·닫기

- 웹 「새 세션」 → 빈 창(제목 칸은 선택). 첫 `message.send` 가 `conversationId` 없이 `newConversation: { title? }` 를 실으면 서버가 권한을 보고 대화 행과 메시지를 한 트랜잭션에 만든다. 응답·팬아웃에 대화가 함께 실린다.
- 닫기: 그 대화의 열린 런을 멈추고(`run.abort` 경로), 열린 승인은 `cancelled`, 카드 상호작용·보내기·리액션·첨부 묶기는 409 `CONVERSATION_CLOSED`. 대화에 시스템 메시지 「@mia 가 이 세션을 닫았습니다」. 다시 열면 그 반대 시스템 메시지. 쓰기 막기는 `assertChannelWritable` 옆 `assertConversationWritable` 한 함수.
- 닫힌 세션도 검색·읽기·URL 로 연다.

### 4.2 누가 답하나

- 라우터 규칙(멘션·자동 응답·릴레이·스레드)은 지금 그대로, 단위만 대화. 릴레이 사슬은 같은 대화 안에서만 이어진다.
- 일일 한도·런 관문은 채널 단위 그대로. **run_limit 「하루 한 번」 알림은 대화마다 하루 한 번**으로 바꾼다(설계자 판단) — 지금(`budget.ts` 의 `announcedToday`)은 채널당 한 번이라 처음 막힌 세션에만 남고 다른 세션은 말없이 막힌다. 알림은 막힌 그 대화(스레드면 스레드)에 남는다.
- **대화가 정해지지 않은 시스템 메시지**(제어 MCP 의 `control_change` — 바깥 `/mcp` 호출이거나 다른 채널을 바꾼 호출): 그 런의 대화가 같은 채널이면 그 대화, 아니면 그 채널에서 최근 활동한 열린 대화, 열린 대화가 없으면 남기지 않는다(운영 사건 `control_change` 는 그대로 남는다). 설계자 판단.
- 이어가기·다시 실행 버튼이 있는 시스템 메시지의 새 런도 그 대화.

### 4.3 에이전트가 받는 것

- 세션 키 `agent:<agentId>:dodok:channel:<conversationId>[:thread:<rootId>]`. shared `dodokSessionKey(providerAgentId, conversationId, threadRootId?)`·`parseDodokSessionKey` 의 두 번째 값 이름을 `conversationId` 로 바꾼다 — 키 모양·정규식은 그대로.
- 브리지·러너 계약: `InboundDeliver` 에 `conversationId`(+ 헤더용 `conversationTitle`). 플러그인은 OpenClaw 쪽 피어 id(`to: channel:<…>`·route)로 **대화 id** 를 쓴다. `OutboundMessage` 는 `conversationId` 를 싣고 서버가 채널을 찾는다.
- **에이전트의 글은 세션 키의 대화에만 저장한다** (설계자 판단 — 지금 동작을 바꾼다). 지금은 런과 짝지어지지 않는 정본(「런 없는 정본」 — `orchestrator.ts` `onCanonical`, 러너는 `runner-adapter.ts` 의 같은 경로)이 `msg.channelId` 의 채널에 저장돼 OpenClaw·러너 에이전트가 message 툴로 다른 채널에 쓸 수 있다. 이제는 런이 있든 없든 정본의 대화가 그 세션 키의 대화와 같아야 하고, 다르면 저장을 거절한다(플러그인·러너 어댑터는 고정 사유 「이 대화에만 보낼 수 있습니다」로 툴 호출을 거절). 까닭: 대화마다 맥락을 가르는 것이 이 기능이고, DM(스펙 B)의 「주인만 본다」가 이 규칙 없이는 에이전트를 통해 깨진다. 다른 곳에 올리는 길은 로드맵 후보 「세션 결과 공유」가 사람 손으로 연다.
- 인바운드 헤더에 `세션: <제목>` 줄. 채널 런의 `recentMessages` 는 그 대화의 최상위 메시지만.
- 채널 프롬프트: OpenClaw 는 새 키에서 반영되므로 새 세션이 곧 새 규칙이다. 러너의 `renewSessionOnPromptChange` 는 대화 단위 세션 행에 그대로 선다.
- 리액션 커서(`reactions_seen_at`)·세션 큐·병렬성은 세션 행 단위 그대로 — 채널의 두 세션은 병렬로 돈다.

### 4.4 자동화

- 자동화마다 자기 세션 하나에 게시한다(`automations.conversation_id`, 처음 게시할 때 「⚙ <자동화 이름>」 제목으로 만든다). 그 세션이 닫혀 있으면 새 세션을 만들어 바꿔 단다. 세션 정책은 자동화에 걸지 않는다(자동화를 만든 것이 이미 admin 이상).

## 5. wire·REST

- REST `GET /api/v1/channels/:id/conversations?status=open|closed|all&q=&cursor=`(최근 활동순, 20개, `q` 는 제목 부분 일치), `PATCH /api/v1/conversations/:id { title?, closed? }`. 만들기 REST 는 없다 — 웹은 `message.send` 로, 자동화는 서버 안에서 만든다(결정 7).
- 메시지 목록 REST·스레드 REST·`around` 는 경로에 대화를 넣는다: `GET /api/v1/conversations/:id/messages`. 채널 경로의 목록은 걷는다.
- `message.send` 에 `conversationId` 또는 `newConversation`(둘 중 하나). 스레드 답글이면 루트의 대화와 같아야 한다.
- `channel.subscribe` 는 채널 룸 하나로 모든 세션의 이벤트를 받는다(스레드와 같다). 응답은 지금 보는 대화의 첫 페이지가 아니라 **이벤트만** — 첫 페이지는 대화 REST 로. `lastSeq` 재동기화는 채널 전체(모든 대화) ≤200 그대로, 웹이 `conversationId` 로 나눈다.
- 새 이벤트 `conversation.created`·`conversation.updated`(제목·닫힘·`last_message_at`) — 채널 룸.
- 읽음: wire `channel.read` → `conversation.read { conversationId, seq }`. `GET /api/v1/me/unread` 는 대화별 `{ conversationId, channelId, unread, mentions, latestSeq }` — 채널 굵게·배지는 웹이 합친다.
- 검색 결과에 `conversationId`·`conversationTitle`, 필터에 `conversationId?`.
- 푸시 URL `/c/<channelId>/s/<conversationId>[/t/<rootId>]`. tag 길이 상한(80)은 지금 규칙대로 대화 id 를 쓰는 짧은 꼴로(빌더 판단).
- 제어 도구 `read_messages`·`search_messages` 는 대화 id 를 받고 돌려준다. 리셋 도구가 있으면 걷는다.

## 6. 웹

- URL `/c/$channelId`(→ 열린 세션 중 최근 활동 세션으로 넘김, 없으면 빈 새 세션 창) · `/c/$channelId/s/$conversationId` · 스레드는 그 아래 `/t/$rootId`.
- 채널 머리에 지금 세션 제목(누르면 이름 바꾸기 — 권한이 있으면)과 「세션 목록」·「새 세션」. 세션 목록은 넓은 화면에서 타임라인 왼쪽 접히는 칸, 좁은 화면에서 시트 — 제목·마지막 활동·읽지 않음 점·멘션 배지, 「열림/닫힘」 필터, 제목 검색. 시각 배치는 빌더 판단.
- 사이드바의 채널 항목은 지금처럼 하나(굵게·배지는 모든 세션 합). 채널을 펼쳐 세션을 보이는 것은 하지 않는다.
- 닫힌 세션은 작성기 자리에 「닫힌 세션입니다」와 (권한이 있으면) 「다시 열기」.
- 채널 설정에 「세션」 칸: 정책(누구나 / 세션 관리자만), 세션 관리자 목록(admin 이상만 바꿈).
- 「새 대화」 버튼·`/new` 를 걷는다. 「새 세션」 단축키는 빌더 판단.
- 오프라인 사본: 최근 채널 5개마다 마지막으로 본 세션 하나(+ 그 세션에서 연 스레드 하나).
- 「새 메시지」 구분선·배너·읽음 전송 규칙은 대화 단위로 그대로 옮긴다.

## 7. 오류 처리

| 상황 | 결과 |
| --- | --- |
| 정책 `managers` 인데 member 가 새 세션 | 403 `FORBIDDEN`, 웹은 「새 세션」을 숨긴다 |
| 닫힌 세션에 쓰기·카드·리액션 | 409 `CONVERSATION_CLOSED` |
| 답글의 대화가 루트와 다름, 다른 채널의 대화 | `VALIDATION` |
| 에이전트가 다른 대화·다른 채널로 전송(런 없는 정본 포함) | 서버가 저장 거절, 플러그인·러너 어댑터가 고정 사유로 툴 호출 거절 |
| 닫기 순간 도는 런 | 중지, 늦게 온 정본은 저장만(릴레이·푸시 없음 — 보관 채널과 같은 규칙) |

## 8. 테스트·검증

- shared: 세션 키 두 함수의 대화 id, 새 계약 Zod.
- 서버 단위·통합(가짜 Gateway·플러그인·가짜 러너): 한 채널 두 세션에서 같은 에이전트가 서로 다른 세션 키로 돌고 맥락이 섞이지 않음(인바운드 `recentMessages`) · 두 세션 병렬 · 스레드는 세션 안 · 닫기 → 런 중지·쓰기 409 · 정책·세션 관리자·역할 매트릭스(`roles.matrix` 에 새 경로) · 읽음이 세션마다 · 자동화가 자기 세션에 · 마이그레이션이 기존 메시지를 「이전 대화」로 옮기고 FTS 가 그대로 찾음.
- 웹 단위·`dev:fake` 브라우저(1280·390px): 세션 목록·전환·새 세션·제목·닫기·다시 열기·URL 새로고침·푸시 링크·검색 결과로 가기·읽지 않음.
- 실연: 런 0회 하네스로 실물 dev Gateway 에서 대화 id 키의 세션 둘이 따로 맥락을 갖는지(OpenClaw 가 대화 id 를 피어로 받는지가 결정 3 의 유일한 가정이다) · 러너 하네스로 같은 것. 모델 런 0.

## 9. 완료 기준

1. 한 채널에서 세션을 여럿 만들고, 세션마다 메시지가 따로 쌓이며, 같은 에이전트가 세션마다 다른 맥락으로 답한다.
2. 닫힌 세션은 읽기만 되고 다시 열 수 있다. 목록에서 제목으로 찾는다.
3. 정책이 「세션 관리자만」인 채널에서 member 는 새 세션을 못 만들고, 세션 관리자는 만들고 닫는다.
4. 읽지 않음·검색·푸시 링크가 세션을 정확히 가리킨다.
5. 전체 테스트·typecheck·lint·fmt·웹 빌드·서버 번들 스모크 통과.

## 10. 빌더에게 맡긴 것

세션 목록의 시각 배치·단축키, 푸시 tag 꼴, 자동 제목의 자르기 세부(코드 포인트 경계 등).
