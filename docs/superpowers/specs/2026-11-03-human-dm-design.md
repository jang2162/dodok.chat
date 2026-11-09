# 사람 간 DM 설계 (기본 메신저 하위 프로젝트 C)

**상태**: 확정(2026-11-09, 사용자 승인).
**범위**: 사람끼리 1:1 DM 과 그룹 DM(사람 여럿, 에이전트를 넣을 수 있다). 지금의 에이전트 DM(주인 사람 1 + 에이전트 1)은 그대로 둔다.

**앞선 근거**:
- 로드맵 `docs/superpowers/specs/2026-11-02-messenger-basics-roadmap.md` — 순서 B → **C** → A → D. A(메시지 수정·삭제)·D(파일함)는 이 문서의 「접근 규칙」 절 위에서 시작한다.
- 에이전트 DM `docs/superpowers/specs/2026-10-25-agent-dm-design.md` — 0장 결정 2(접근 판정 한 함수)와 9장 「구현과 맞춘 것」(접근 판정이 지나는 자리, DM 런·푸시·읽지 않음의 지금 동작). 이 문서는 그 위에 선다.
- 채널 세션 `docs/superpowers/specs/2026-10-25-channel-sessions-design.md` — 그룹 DM 의 세션.
- 프로필·접속 상태 `docs/superpowers/specs/2026-11-02-profiles-presence-design.md` — 사이드바·머리의 아바타와 접속 점.
- 결정 과정: 2026-11-03 ~ 11-09 사람과의 대화(앞 워커 세션이 질문을 마쳤고 이 문서가 그 결정을 옮긴다). 아래 「사람이 정함」은 사람의 결정, 「내 판단」은 설계자가 정했고 사람이 반박하지 않은 것 또는 이 문서에서 처음 정한 것이다.

---

## 0. 왜

지금 dodok 의 DM 은 「나 + 에이전트」뿐이라 사람끼리 따로 이야기할 자리가 없다. 사람 1:1 DM 은 에이전트와 무관한 **메신저의 기본 기능**으로 넣는다. 에이전트를 함께 부르고 싶으면 Slack 처럼 그 에이전트를 참여자로 넣은 **그룹 DM** 을 쓴다.

**성공**: 활성 멤버 누구나 다른 멤버와 1:1·그룹 DM 을 열고, 참여자가 아닌 사람(owner·admin 포함)은 그 대화가 있다는 것조차 어느 화면·API·검색·알림에서도 모른다.

**실패(동작해도 실패인 것)**: 사람 DM 이 다른 사람의 검색·읽지 않음·알림·운영 표·제어 도구 어디로든 새는 것. 그룹 DM 에 넣은 에이전트가 참여자가 아닌 사람의 일로 도구를 돌리는 것.

## 1. 결정

| # | 결정 | 누가 | 까닭 |
| --- | --- | --- | --- |
| 1 | **사람 1:1 DM 은 에이전트 없는 기본 메신저 DM.** 에이전트를 부르려면 그 에이전트를 참여자로 넣은 그룹 DM 을 쓴다. 지금의 「나 + 에이전트」 DM 은 그대로 | 사람이 정함 | 「사람 끼리의 DM 은 메신저 기본 기능으로 추가하려는게 의도, 에이전트를 부르는 경우 그룹 DM 으로(슬랙처럼)」 |
| 2 | **그룹 DM 의 참여자는 고정(Slack 방식)** — 같은 참여자 묶음이면 같은 대화, 누구를 더하면 새 그룹 DM | 사람이 정함 | 참여자가 바뀌면 「누가 이 기록을 읽나」가 바뀐다. 고정이면 접근 규칙이 만들 때 한 번에 정해진다 |
| 3 | **그룹 DM 의 에이전트는 @멘션받을 때만 답한다** — 릴레이·턴 한도도 채널 규칙 | 사람이 정함 | 사람이 여럿인 자리에서 모든 글에 답하면 시끄럽다. 채널과 같은 기대 |
| 4 | **1:1 DM 과 사람만 있는 그룹 DM 은 세션 없이 한 줄기, 에이전트가 있는 그룹 DM 은 채널처럼 세션으로 나눈다** | 사람이 정함(사람만 있는 그룹의 한 줄기는 앞 워커의 해석 — 반박 없음) | 세션은 에이전트 문맥(세션 키)을 가르는 장치다. 에이전트가 없으면 나눌 까닭이 없고 메신저의 기대는 한 줄기다 |
| 5 | **누가 여나** — 활성 멤버끼리는 역할과 상관없이 연다. 비활성 멤버와는 새 DM 을 못 연다. 기존 1:1 은 읽기 전용, 그룹은 남은 사람끼리 계속. 그룹 DM 에 에이전트를 넣으려면 **사람 참여자 전원이 그 에이전트의 「DM 허용」(`dmAccess`)을 통과**해야 한다 | 사람이 정함 | 러너 에이전트는 누군가의 머신에서 도구를 돌린다 — 그룹 DM 이 `dmAccess` 를 우회하는 길이 되면 안 된다 |
| 6 | **사람 DM·그룹 DM 은 참여자만 본다.** owner·admin 도 참여자가 아니면 화면·API·검색·알림 어디에서도 못 본다 | 사람이 정함 | 에이전트 DM 결정 3 과 같은 기대. 서버 운영자는 DB 로 볼 수 있다 — 매뉴얼에 그대로 적는다 |
| 7 | **그룹 DM 의 도구 승인은 그 일을 시킨 사람(`requestedBy`)만 결정한다** — 릴레이로 이어져도 처음 멘션한 사람 | 사람이 정함 | 일반 채널의 「admin 이상」을 그대로 쓰면 참여자가 아닌 admin 이 결정자가 된다. 볼 수 있는 사람 가운데 그 일을 시킨 사람이 결정한다 |
| 8 | **저장은 새 채널 종류 `direct`**(1:1·그룹 공통) + 「참여자만 읽는다」 판정. 에이전트 DM(`kind = 'dm'`) 코드는 그대로 둔다. 비공개 채널(K)이 같은 판정을 가져다 쓸 수 있게 한다 | 사람이 정함(접근 A) | 2장 「접근」 |
| 9 | **사이드바 「다이렉트 메시지」 는 에이전트 DM 과 사람 DM 을 한 목록에 섞어 최근 활동순**(Slack 방식). 1:1 은 아바타·접속 점, 그룹은 겹친 아바타와 이름 나열, 에이전트 DM 은 지금처럼 | 사람이 정함 | |
| 10 | **스레드는 사람 DM·그룹 DM 에서 허용** — 채널 스레드를 그대로 | 사람이 정함 | 에이전트 DM 의 「스레드 없음」(그 스펙 결정 7)은 그대로 |
| 11 | **사이드바에서 DM 「닫기」(숨기기)는 이번에 넣지 않는다** — `docs/guides/plan.md` 8장 「이월」 에 한 줄 | 사람이 정함 | |

## 2. 접근(어떻게 저장하나) — 사람이 고른 것

| 접근 | 무엇 | 얻는 것 | 잃는 것 |
| --- | --- | --- | --- |
| **A. 새 종류 `direct`** (고름) | `channels.kind` 에 `direct` 를 더한다. 참여자는 `channel_members` 행, 참여자 묶음 열쇠로 유일. 읽기 판정은 「사람 참여자 행이 있다」 | 에이전트 DM 코드를 건드리지 않는다. 판정 「멤버만 읽는다」가 K(비공개 채널)에 그대로 쓰인다 | `kind` 갈래가 셋이 된다 — `kind !== "dm"` 꼴의 판정이 모두 다시 보아야 할 자리가 된다(3.1 「기본이 닫힘」) |
| B. `dm` 을 넓힌다 | `kind = 'dm'` 에 사람 여럿·에이전트 0~n 을 허용 | 종류가 늘지 않는다 | `dm_owner_id`·`dm_agent_id`·`channels_dm_pair`·자동 응답·「주인만 승인」 이 모두 「주인 1 + 에이전트 1」 전제다. 지금 DM 을 통째로 다시 짓는다 |
| C. 비공개 채널(`visibility = 'private'`) 위에 | 그룹 DM 을 이름 없는 비공개 채널로 | K 와 한 번에 | K 의 「참여·나가기·초대」가 먼저 정해져야 한다. 고정 참여자·한 줄기·1:1 의 기대와 어긋난다 |

## 3. 데이터

### 3.1 채널 행

- `ChannelKind`(shared `domain`): `channel` · `dm` · **`direct`**.
- `direct` 채널 행: `name` 은 `direct`(내부용 — 화면은 참여자 이름으로 그린다, 에이전트 DM PD 의 `name = 'dm'` 과 같은 까닭), `visibility` `private`, `topic`·`prompt` 없음, `dm_owner_id`·`dm_agent_id` 는 NULL, `created_by` 는 연 사람(권한 없음 — 기록일 뿐).
- **참여자 묶음 열쇠 `direct_key`**(새 열, nullable) — 참여자(연 사람 포함)를 `u:<userId>`·`a:<agentId>` 꼴로 적어 정렬해 이은 문자열. 유일 색인 `channels_direct_key (workspace_id, direct_key) WHERE kind = 'direct'`. 같은 묶음으로 다시 열면 같은 채널이 나온다(결정 2). (내 판단 — 열쇠 꼴은 빌더가 바꿔도 된다. 정렬·유일만 지킨다.)
- **참여자는 `channel_members` 행**이다 — 만들 때 한 트랜잭션에 넣고 그 뒤로 더하거나 빼지 않는다. 에이전트 행은 `autoRespond: false`(결정 3)이고 바꿀 수 없다.
- **한 줄기인지 세션인지는 참여자 묶음이 정한다** — 에이전트 참여자가 있으면 세션, 없으면 한 줄기(결정 4). 묶음이 고정이라 채널 행의 일생 동안 바뀌지 않는다. 따로 열을 두지 않는다(내 판단 — 빌더가 읽기 편하게 열로 두어도 된다).
- 한 줄기 `direct` 는 **채널을 만들 때 대화(세션) 하나를 함께 만들고** 그 뒤로 새 세션을 만들지 않는다. 세션 `direct` 는 에이전트 DM 처럼 첫 보내기(`newConversation`)가 세션을 만든다.
- 마이그레이션 하나(`direct_key` 열·색인). SQL·스냅숏은 생성기 출력 그대로.

### 3.2 크기

- **참여자는 나를 포함해 2 ~ 9 명(사람 + 에이전트)** (내 판단).
- 모양별로 무엇이 열리나(내 판단 — 같은 모양의 대화가 두 종류로 생기지 않게):

| 고른 상대(나 말고) | 열리는 것 |
| --- | --- |
| 사람 1 | 사람 1:1 DM(`direct`, 한 줄기) |
| 에이전트 1 | **지금의 에이전트 DM**(`dm`) — `direct` 를 만들지 않는다 |
| 사람 2 이상, 에이전트 0 | 사람 그룹 DM(`direct`, 한 줄기) |
| 에이전트가 하나라도 있고 모두 합쳐 2 이상 | 에이전트가 있는 그룹 DM(`direct`, 세션) — 사람이 나 혼자이고 에이전트가 둘인 묶음도 여기다 |
| 아무도 없음(나 혼자) | 열지 않는다(`VALIDATION`) — 「나에게 메모」는 이번 범위가 아니다(내 판단) |

## 4. 접근 규칙

**이 절이 「누가 어떤 대화를 읽나」의 정본이다.** A(메시지 수정·삭제)·D(파일함)·K(비공개 채널)는 이 절을 가리키고, 판정을 따로 짓지 않고 아래 함수를 부른다.

### 4.1 누가 읽나

| 대화의 종류 | 읽는 사람 | owner·admin 예외 |
| --- | --- | --- |
| 일반 채널 `channel` | 워크스페이스의 활성 멤버 전원 | — |
| 에이전트 DM `dm` | 그 DM 의 주인 사람 | 없음 |
| 사람 DM·그룹 DM `direct` | **사람 참여자**(`channel_members` 의 user 행) 가운데 활성 멤버 | 없음 |

- **비활성 멤버는 어떤 대화도 못 읽는다** — 지금처럼 `roleOf`·워크스페이스로 거른 조회가 접근 판정 앞에서 막는다. 다시 활성화하면 그 사람의 DM 이 그대로 돌아온다.
- **에이전트는 「읽는 사람」이 아니다.** 에이전트가 대화를 보는 길은 둘뿐이다: ① 자기 런에 실려 오는 것(그 대화의 참여자일 때만 런이 생긴다) ② 제어 도구(4.4).
- **「읽는다」가 덮는 것**: 채널·대화·메시지(스레드 답글 포함)·첨부·반응·카드·런·승인·활동 탭·검색 결과·읽지 않음·푸시·실시간 이벤트. 이 가운데 하나라도 읽을 수 없는 사람에게 나가면 새는 것이다.
- **못 읽는 사람에게는 「없음」과 같다** — 404 `NOT_FOUND`(wire 는 같은 코드의 ack), 문구도 없는 채널과 같다. 역할 판정(403)·`VALIDATION`·보관(409)보다 먼저 부른다(에이전트 DM 9장 「접근 판정」의 순서를 그대로).

### 4.2 함수

정본은 `apps/server/src/auth/channel-access.ts` 하나다. 이 프로젝트가 고치는 것:

```
membersOnly(channel)          = channel.kind === "direct"          // K 가 여기에 「또는 visibility = private」 을 더한다
canReadChannel(viewer, channel):
  kind = channel  → true
  kind = dm       → viewer == dm_owner_id
  membersOnly     → viewer 가 그 채널의 사람 참여자
  그 밖(모르는 종류) → false
readableChannelSql(userId)    = kind = 'channel'
                              ∨ dm_owner_id = userId
                              ∨ (membersOnly ∧ EXISTS channel_members(user, userId))
```

- **기본이 닫힘** — 지금 코드에는 `kind !== "dm"` 이면 일반 채널로 보는 판정이 여럿 있다(`canReadChannel` 의 첫 줄, `realtime/events.ts channelAudience`, 운영 요약 등 30여 자리 — 계획이 하나씩 목록으로 덮는다). 그대로 두면 `direct` 가 **일반 채널로 읽혀 전원에게 샌다.** 그래서 모든 갈래를 「`kind === "channel"` 만 열림, 나머지는 닫힘」으로 뒤집는다. 새 종류가 생겨도 빠뜨린 자리는 새지 않고 막힌다.
- `canReadChannel` 은 참여 여부를 알아야 하므로 지금의 「채널 사실만 받는 순수 함수」가 아니게 된다 — 참여 여부를 미리 읽어 넘기든 db 를 받든 꼴은 빌더 몫. 목록·검색은 결과를 뽑은 뒤 거르지 않고 SQL 단계(`readableChannelSql`)에서 거른다(페이지·커서·개수가 남의 DM 을 세지 않게).

### 4.3 누가 쓰나

- **쓰기 = 읽기 ∧ 쓸 수 있음.** 쓸 수 있음은 그 자리마다 이 순서로 본다: 접근(404) → 보관(409, `direct` 는 보관할 수 없으니 지나간다) → DM 읽기 전용(409 `DM_READ_ONLY`).
- **`direct` 의 읽기 전용 사유는 하나** — 1:1 의 상대가 비활성(`details.reason: "peer_deactivated"`, `DmReadOnlyReason` 에 새 값). 그룹은 읽기 전용이 되지 않는다(남은 사람끼리 계속 — 결정 5). (내 판단 — 에러 코드는 `DM_READ_ONLY` 를 그대로 쓴다.)
- **그룹 DM 의 에이전트 권한이 나중에 바뀌어도 대화는 읽기 전용이 되지 않는다** — 그 에이전트의 런만 막는다(6.3).
- 채널 관리(이름·주제·지시·멤버 더하기·빼기·나가기·보관·세션 관리자·세션 정책·`dailyRunLimit`·에이전트 `autoRespond`·`promptOverride`)는 `direct` 에서 모두 `VALIDATION`(내 판단 — 그룹 DM 에 이름·주제·「지시」·나가기가 없다). 에이전트 DM 의 `assertNotDm` 을 `direct` 에도 건다.
- **A 가 정할 것의 바닥**: 고치고 지우는 사람은 적어도 그 대화를 지금 읽을 수 있어야 하고(위 판정), 읽기 전용 대화에서는 쓰기와 같이 막힌다. 「작성자만인가, 채널 관리자도인가」는 A 가 정한다 — `direct` 에는 관리자가 없다.
- **D 가 정할 것의 바닥**: 파일함의 목록은 그 사람이 읽을 수 있는 채널의 첨부만이고, SQL 단계에서 `readableChannelSql` 로 거른다. 첨부 하나의 GET 은 지금처럼 그 메시지의 채널로 판정한다.

### 4.4 제어 도구의 읽기 범위

`readableChannelSqlFor`(주체마다):

| 주체 | 읽을 수 있는 채널 |
| --- | --- |
| 바깥 MCP(개인 토큰) | 사람과 같다 — 일반 채널 + 내 에이전트 DM + 내가 참여한 `direct` |
| 채널 안 에이전트, 런이 일반 채널 | 일반 채널만 |
| 채널 안 에이전트, 런이 에이전트 DM | 일반 채널 + 그 DM 하나(지금 그대로) |
| 채널 안 에이전트, 런이 `direct` | 일반 채널 + **그 `direct` 하나**(시킨 사람이 그 대화의 참여자일 때 — 시킨 사람이 없으면 일반 채널만) |
| 런 없는 에이전트 주체 | 일반 채널만 |

- 시킨 사람의 다른 DM·다른 그룹 DM 은 없는 채널과 같다 — 프롬프트 주입·모델 오판으로 DM 이 다른 자리에 옮겨지는 길을 dodok 이 막는다(에이전트 DM PD3 과 같은 까닭).
- 제어 쓰기 도구(채널 관리 전부)는 `direct` 에서 `VALIDATION`. `post_message` 류가 있으면 그 런의 대화에만(지금 규칙 그대로).
- **막지 못하는 것** — 에이전트 자신의 기억(OpenClaw 워크스페이스 메모리, 러너 작업 디렉터리·Claude Code 메모리)을 거쳐 그룹 DM 에서 들은 것이 그 에이전트의 다른 자리 답에 나올 수 있다. 매뉴얼과 그룹 DM 화면의 첫 안내에 적는다(에이전트 DM 과 같은 문장).

## 5. 동작 — 열기·목록

### 5.1 열기

- **`POST /api/v1/directs { userIds, agentIds }`** — 나를 뺀 상대. 서버가 나를 더해 묶음 열쇠를 만들고 **찾거나 만든다**(에이전트 DM PD1 처럼 열 때 만든다 — 빈 DM 은 사이드바에 안 보인다, 5.2). 반환 `{ channel, created }`. (내 판단 — 경로·본문 꼴은 빌더가 바꿔도 된다.)
- 검사 순서(내 판단):
  1. 꼴 — 상대 0명, 9명 초과, 중복, 나 자신, 에이전트 하나만(그건 `POST /dms`) → `VALIDATION`.
  2. 이미 있는 묶음 → 허용 검사 없이 그 채널(읽기 전용이어도 — 기록은 계속 읽는다. 에이전트 DM PD1 과 같다).
  3. 새로 만들 때: 사람 상대가 이 워크스페이스의 활성 멤버가 아니면 404 `NOT_FOUND`(비활성 멤버와는 새 DM 불가 — 결정 5). 에이전트가 없거나 보관됐으면 404. 에이전트가 꺼졌거나, **사람 참여자 가운데 누구라도** 그 에이전트의 `dmAccess` 를 지금 역할로 통과하지 못하면 403 `FORBIDDEN`(어느 에이전트인지 `details.agentId`, 누가 막혔는지는 싣지 않는다 — 남의 역할이 드러나지 않게).
- 동시에 같은 묶음을 두 번 열어도 행은 하나다(유일 색인 + `onConflictDoNothing` 뒤 다시 읽기 — `findOrCreateDm` 과 같은 꼴).
- 웹에서 여는 자리:
  - 사이드바 「다이렉트 메시지」 의 「+」 → **「새 메시지」 대화상자**: 사람·에이전트를 한 목록에서 여럿 고른다(최대 8). 사람은 활성 멤버, 에이전트는 지금 내 역할로 DM 할 수 있는 것(`canOpenDm` — 다른 참여자의 역할은 웹이 모를 수 있으므로 서버 403 문구를 그대로 보인다). 에이전트 하나만 고르면 `/dm/<에이전트 id>`(지금 흐름), 그 밖은 `POST /directs` 뒤 `/c/<채널 id>`.
  - 사람 프로필 패널(B)의 「메시지 보내기」 → 그 사람과 1:1.
- **URL 은 채널 경로 그대로** — `/c/<direct 채널 id>`, 채널 레이아웃이 `channel.kind === "direct"` 면 DM 꼴로 그린다(에이전트 DM PD2 와 같다). 한 줄기면 세션 경로(`s/<id>`)를 쓰지 않거나 늘 그 하나로 넘긴다 — 빌더 몫.

### 5.2 목록 — 사이드바 「다이렉트 메시지」

- REST `GET /api/v1/channels` 는 지금처럼 `kind = 'channel'` 만 싣는다(`direct` 는 싣지 않는다). 채널 하나(`GET /channels/:id`)·멤버·대화·메시지 경로는 참여자에게 그대로 열린다.
- **`GET /api/v1/directs`** — 내가 참여한 `direct` 전부(글 없는 것도), 최근 활동순. 줄마다 채널, 참여자(사람은 프로필 요약 — 이름·핸들·아바타, 에이전트는 `agentForRole` 을 지난 `Agent`), `lastMessageAt`, `readOnlyReason`. 에이전트 DM 의 `GET /dms` 는 그대로 둔다(내 판단 — 결정 8 「에이전트 DM 코드는 그대로」).
- 웹은 두 목록을 합쳐 `lastMessageAt`(없으면 연 시각) 내림차순으로 한 목록에 그린다(결정 9). 거름은 지금처럼 「글이 있는 것 + 지금 연 것」.
- 줄 꼴:
  - **사람 1:1** — 상대 아바타 + 접속 점(B 의 `WithPresence`) + 상대 이름. 비활성 상대면 흐리게 + 「(비활성)」.
  - **그룹** — 겹친 아바타 둘 + 참여자 이름 나열(나를 빼고, 넘치면 말줄임 — 「mia, jun, @dev 외 2」 꼴은 빌더 몫).
  - **에이전트 DM** — 지금 그대로.
- 굵게·배지는 채널 줄과 같은 읽지 않음 값(7.2).
- 목록 쿼리는 에이전트 DM 목록과 같은 무효화를 받는다(`staleTime: Infinity` + 이벤트 — 다시 붙기, `people.changed`·`agents.changed`, `direct` 의 `channel.created`·`channel.activity` 의 모르는 채널, `DM_READ_ONLY`, `POST /directs` 뒤). 셸이 늘 들고 있다(좁은 화면에서 실시간 처리기가 이 캐시로 읽지 않음·승인 알림을 정한다 — 에이전트 DM 9장 「웹」).

## 6. 동작 — 대화 화면과 런

### 6.1 화면

```
┌ 1:1 ───────────────────────────────┐   ┌ 그룹(에이전트 있음) ──────────────────────┐
│ (●mia) mia · 다른 용무 중 · 상태메시지 │   │ (mia)(jun)(@dev)  mia, jun, @dev   [활동] │
├────────────────────────────────────┤   ├──────────┬──────────────────────────────┤
│ 한 줄기 메시지 목록 (스레드 열림)      │   │ 세션 목록 │ 세션 메시지 목록 (스레드 열림)   │
│                                    │   │ + 새 세션 │                              │
│ [작성기 — @후보는 참여자만]          │   │          │ [작성기 — @후보는 참여자만]      │
└────────────────────────────────────┘   └──────────┴──────────────────────────────┘
```

- **머리** — 1:1 은 상대 아바타·접속 점·이름·상태 메시지, 누르면 상대 프로필(B). 그룹은 겹친 아바타와 이름 나열, 누르면 참여자 목록(각 줄에서 프로필). 이름 바꾸기·주제·「지시」·나가기 없음(내 판단).
- **한 줄기(1:1·사람만 그룹)** — 세션 목록·「새 세션」·세션 제목 없음. 스레드 패널은 연다(결정 10).
- **세션(에이전트 있는 그룹)** — 채널 세션 목록과 같은 컴포넌트. 새 세션·제목 바꾸기·닫기는 **참여자 누구나**(내 판단 — 세션 관리자가 없다). 활동 탭이 있다.
- **작성기** — @ 후보는 참여자만. 읽기 전용(1:1 상대 비활성)이면 작성기 자리에 사유 한 줄, 반응 잠금(에이전트 DM 의 읽기 전용과 같은 꼴).
- **첫 안내**(에이전트가 있는 그룹만) — 에이전트 DM 의 「에이전트의 기억」 안내와 같은 문장(4.4 「막지 못하는 것」).
- 좁은 화면(390px)은 세션 목록이 시트 — 채널과 같다.

### 6.2 멘션

- **@멘션은 참여자에게만 토큰이 된다.** 참여자가 아닌 사람·에이전트를 @ 로 써도(토큰 꼴을 손으로 적어 와도) 글자로만 남고 끌려 들어오지 않는다 — `joinChannelIfAbsent` 를 부르지 않고 그 토큰은 `neutralizeMentionTokens` 로 중화한다(내 판단 — 에이전트 DM 의 `plainInDm` 과 같은 방어, 다만 참여자 토큰은 살린다).
- 사람 멘션은 강조·「나를 멘션한 글」로 남는다(DM 의 모든 글이 배지를 받으므로 셈은 같다 — 7.2).

### 6.3 런(에이전트가 있는 그룹)

- **멘션받은 참여 에이전트만 런이 된다**(결정 3). 릴레이는 채널 규칙 — 에이전트 글의 @참여 에이전트가 다음 런, 턴 한도는 채널 기본 `relayPolicy`(`maxRelayTurns: 4`, `allowPairs: "all"`). 그룹 DM 에는 릴레이 설정 화면이 없다(채널 관리 `VALIDATION`).
- **세션 키는 불변 규칙 그대로** — 대화마다 에이전트별 하나 `agent:<agentId>:dodok:channel:<conversationId>`, 스레드는 그 아래. shared `dodokSessionKey` 로만 만든다.
- **시킨 사람(`requestedBy`)** 은 지금 규칙(`runs/orchestrator.ts requesterOf`) — 사람 글은 작성자, 카드는 누른 사람, 릴레이는 앞 런의 값, 늦은 정본·자동화 사슬은 null.
- **런을 막는 때**(내 판단 — 사람의 「그 런만 막고 시스템 메시지, 대화는 계속」을 이렇게 푼다):
  - 그 에이전트가 보관·꺼짐 → 지금 채널과 같다(보관이면 런 없음, 꺼짐이면 지금 꺼짐 규칙).
  - **시킨 사람이 그 에이전트의 `dmAccess` 를 지금 역할로 통과하지 못함, 또는 시킨 사람이 없음(null)** → 런을 만들지 않고 그 세션에 시스템 메시지(「@dev 는 이 요청에 답하지 않았습니다 — DM 허용 범위 밖」 꼴, 문구 빌더 몫). 줄 선 뒤 철회되면 차례가 왔을 때 보내지 않고 `aborted`(에이전트 DM 의 `dmClosedTarget` 과 같은 꼴). 이미 어댑터로 간 런은 끝까지 돈다.
  - 시킨 사람이 비활성이 되면 위와 같다(역할이 없으니 통과하지 못한다).
- **헤더**(에이전트가 받는 것) — 채널 자리에 그룹 DM 줄(「그룹 DM: 참여자만 보는 대화」 꼴), 참여자는 그 그룹의 활성 참여자 전부, 세션 제목, 릴레이 규칙은 채널과 같은 문구. 그룹 DM 에는 채널 프롬프트(「지시」)가 없다. 러너는 채널 틀을 받되 자리 문구를 「a group direct message in dodok」 꼴로. `InboundDeliver` 에 그룹 DM 표시 필드를 더한다(꼴·이름은 빌더 몫 — 옛 플러그인은 버리고 받으므로 그 줄은 플러그인을 다시 깔아야 생긴다, 에이전트 DM 과 같다). `docs/guides/agent-guide.md` 에 「그룹 DM」 절.
- **한도** — 워크스페이스 일일 상한에 센다. 채널 `dailyRunLimit` 은 없다(에이전트 DM 과 같다).
- **승인**(도구 승인·OpenClaw exec 승인·제어 확인 카드) — 결정자는 그 런의 `requestedBy` 하나(결정 7). null 이면 결정할 사람이 없다 — 위 규칙으로 그런 런은 애초에 돌지 않는다. 웹 `canDecideApproval` 도 같은 판정. 다른 참여자에게 카드는 보이되 결정 단추는 잠긴다(「@mia 님이 결정합니다」 꼴).
- **자동화** — 대상이 `direct` 면 만들기·바꾸기·게시 모두 `VALIDATION`(남의 것은 먼저 404).
- **에이전트 아웃바운드 경계** — 에이전트의 글은 세션 키의 대화에만 저장한다(`assertCanonicalConversation`) — 그 테스트에 `direct` ↔ 일반 채널·`direct` ↔ 에이전트 DM 꼴을 더한다.

## 7. 알림·읽지 않음·검색·운영

### 7.1 푸시

- **`direct` 의 모든 글을 다른 사람 참여자 전원에게 푸시한다** — 사람의 normal 글, 에이전트의 최종 답(정본). 스트리밍 중간은 아니다(내 판단).
- `run_error`·승인 요청 푸시는 시킨 사람에게만(내 판단 — 에이전트 DM 의 「주인에게」를 「시킨 사람에게」로).
- 지금 규칙 그대로: 본문 없음(누가·어디만 — 「@mia 님의 메시지」·「DM」 꼴), 방해 금지, 「지금 보고 있으면 안 보냄」, B 의 「도구 승인 요청은 계속 받기」.
- 발송 직전 거름(`push/service.ts attachPushTriggers`)은 `direct` 를 겨눈 알림을 사람 참여자 말고 모두 걷는다 — 트리거 갈래가 틀려도 새지 않는 두 번째 겹.
- tag 는 `direct:<conversationId>` 꼴(빌더 몫).

### 7.2 읽지 않음

- `direct` 에서 남이 쓴 normal 글은 모두 「나를 멘션한 글」 배지로 센다(내 판단 — 에이전트 DM PD10 과 같은 기대). 스냅숏(`reads/store.ts`)과 실시간(`channel.activity` 의 `mentionedUserIds` — 다른 사람 참여자 전원)이 같은 규칙.

### 7.3 실시간

- `direct` 의 채널 사실(`channel.created`·`channel.updated`·`channel.activity`·`approval.requested`·`approval.resolved`·`system.notice`)은 **사람 참여자들의 user 룸으로만**(`channelAudience` 가 룸 목록을 돌려준다). 채널 룸 참가는 `channel.subscribe` 의 접근 판정을 지난다 — 그래서 `typing`·채널 룸 이벤트는 참여자 소켓에만 간다.
- 승인 이벤트는 참여자 모두가 받는다(카드가 보이므로). 결정 단추만 시킨 사람.

### 7.4 검색

- ⌘K 검색은 SQL 단계에서 `readableChannelSql` 로 거른다 — 참여한 `direct` 만. 결과 줄은 「DM · <참여자 이름>」. 검색 대화상자의 채널 거름에는 DM 이 없다(지금 그대로).

### 7.5 운영

- 운영 런 표는 `direct` 런도 지금의 「DM」 한 줄에 합친다(이름·참여자 없음). 운영 사건 `control_change` 는 `direct` 면 `detail.channelId` 를 null 로.

## 8. 오류

| 상황 | 결과 |
| --- | --- |
| 참여자가 아닌 사람이 `direct` 에 어떤 요청이든 | 404 `NOT_FOUND`(wire 는 같은 코드의 ack) |
| `POST /directs` 꼴 오류(0명·9명 초과·중복·나 자신·에이전트 하나만) | 400 `VALIDATION` |
| 새로 열 때 상대가 비활성·없는 사람, 없는·보관된 에이전트 | 404 `NOT_FOUND` |
| 새로 열 때 에이전트가 꺼짐, 또는 사람 참여자 누구라도 그 에이전트의 `dmAccess` 밖 | 403 `FORBIDDEN`(`details.agentId`) |
| `direct` 에 채널 관리·자동화 대상·한 줄기에서 새 세션 | 400 `VALIDATION` |
| 1:1 상대 비활성 뒤 쓰기 | 409 `DM_READ_ONLY`(`reason: peer_deactivated`) |
| 그룹 DM 에서 시킨 사람이 `dmAccess` 밖·없음 | 런 없음 + 시스템 메시지(오류 응답 아님 — 글은 저장된다) |

## 9. 범위

**한다**
- `kind = 'direct'`·`direct_key`·참여자 행, `POST`·`GET /api/v1/directs`.
- 4장 판정 — 「기본이 닫힘」으로 뒤집기, `membersOnly`, 경로 표 전부(에이전트 DM 4장 목록 + 그 뒤 생긴 자리: 반응·프로필의 「메시지 보내기」·접속 점 등).
- 한 줄기·세션 두 꼴의 대화 화면, 「새 메시지」 대화상자, 사이드바 합친 목록, 프로필 「메시지 보내기」.
- 그룹 DM 의 런(멘션·릴레이·시킨 사람 판정·승인 결정자·헤더·러너 틀).
- 푸시·읽지 않음·실시간·검색·운영.
- `dev:fake` 씨앗(새 DB 에서 owner ↔ mia 1:1 하나, owner·mia·dev 그룹 하나 — 빌더 몫), 매뉴얼 「다이렉트 메시지」 절, 에이전트 가이드 「그룹 DM」 절.

**하지 않는다**
- 사이드바 DM 닫기(숨기기) — 이월(결정 11).
- 그룹 DM 의 참여자 바꾸기·나가기·이름·주제·지시.
- 「나에게 메모」(나 혼자 DM).
- 에이전트 DM 의 동작 변경(자동 응답·스레드 없음·세션 등 지금 그대로).
- 비공개 채널(K) — `membersOnly` 자리만 남긴다.
- 사람 입력 중 표시(H), 메시지 수정·삭제(A), 파일함(D).
- owner 가 남의 DM 을 감사하는 화면.

## 10. 테스트·검증

- **서버**: 역할 매트릭스(`apps/server/test/roles.matrix.test.ts`)에 「참여하지 않은 `direct`」 열 — 에이전트 DM 4장 경로 전부 404(owner·admin·member 모두). 「기본이 닫힘」 실증: 모르는 `kind` 값의 채널이 어떤 목록·이벤트에도 실리지 않는다. `POST /directs` 의 꼴·유일·동시 열기·403 판정(참여자 한 명이 `dmAccess` 밖), 한 줄기에서 새 세션 `VALIDATION`, 비참여 멘션 중화·자동 참여 없음, 그룹 DM 의 멘션 런·릴레이·턴 한도, 시킨 사람 `dmAccess` 밖·null 이면 런 없음 + 시스템 메시지, 승인 결정자 = `requestedBy`(참여한 admin 도 시킨 사람이 아니면 거절), 푸시 수신자 = 다른 사람 참여자, 검색 커서가 남의 `direct` 를 건너뛰어도 페이지가 맞음, `readableChannelSqlFor` 표(4.4) 전부.
- **웹 단위**: 합친 목록 순서·줄 꼴, 「새 메시지」 대화상자 갈래(에이전트 하나 → `/dm`), 한 줄기·세션 화면, 읽기 전용 사유, 결정 단추 잠금.
- **`dev:fake` 브라우저**(owner·mia 두 계정, 1280·390px — 접속 점은 보이는 탭을 보므로 독립 Chromium): mia 의 1:1·그룹이 참여하지 않은 owner 화면·검색·알림·운영 표 어디에도 없음, 1:1 상대 비활성화 → 읽기 전용, 그룹 DM 에서 dev 멘션 → 시킨 사람만 승인.
- **실연**: 런 0회 하네스로 그룹 DM 의 OpenClaw·러너 에이전트 각 한 런 — 헤더 그룹 DM 줄·참여자·세션 키. 모델 런 0.

## 11. 완료 기준

1. 활성 멤버가 다른 멤버와 1:1 DM 을 열고, 사람 여럿(+ 에이전트)으로 그룹 DM 을 열며, 같은 묶음으로 다시 열면 같은 대화다.
2. 참여자가 아닌 사람(owner 포함)은 그 대화를 어느 화면·API·검색·알림·운영 표·제어 도구에서도 볼 수 없다.
3. 그룹 DM 의 에이전트는 멘션받을 때만 답하고, 그 도구 승인은 시킨 사람만 결정한다. 시킨 사람이 `dmAccess` 밖이면 런 없이 시스템 메시지.
4. 1:1 상대가 비활성이 되면 읽기 전용, 다시 활성화하면 이어 쓴다.
5. 에이전트 DM 의 지금 동작이 바뀌지 않는다(기존 시험 그대로 통과).
6. 전체 테스트·typecheck·lint·fmt·웹 빌드·서버 번들 스모크 통과.

## 12. 빌더에게 맡긴 것

`direct_key` 의 꼴, 한 줄기 여부를 열로 둘지, `canReadChannel` 에 참여 여부를 넘기는 꼴, `POST /directs` 의 경로·본문 이름, 한 줄기 대화의 URL(`s/<id>` 를 쓰나), 그룹 이름 나열의 말줄임, 시스템 메시지·푸시 제목 문구, `InboundDeliver` 의 그룹 DM 필드 이름, `dev:fake` 씨앗의 꼴, 「새 메시지」 대화상자의 검색·정렬.

## 13. 구현과 맞춘 것

12장 「빌더에게 맡긴 것」과 구현 중 이 스펙과 달라진 것. 본문(0~12장)은 사람이 승인한 판 그대로 두고, 지금 코드는 이 장이 말한다. 계획(`docs/superpowers/plans/2026-11-03-human-dm.md`)의 「계획 판정」 PH1~PH14 를 옮기고, 태스크마다 계획과 달라진 것을 그 아래에 적는다.

### 13.1 계획 판정(PH1~PH14)

- **PH1 — 읽기 판정은 db 를 받는다.** `canReadChannel(db, viewer, channel)`·`assertChannelReadable(db, channel, userId)`(`apps/server/src/auth/channel-access.ts`) — `direct` 면 `channel_members` 의 (채널, user, viewer) 행을 읽는다. 부르는 자리(채널·카드·소켓·반응·첨부)를 모두 이 꼴로 바꿨다.
- **PH2 — `membersOnly(channel)` 은 `kind === "direct"` 하나.** `readableChannelSql(userId)` 은 「`kind = 'channel'` ∨ 에이전트 DM 주인 ∨ (`kind = 'direct'` ∧ 사람 참여자 행)」. 비공개 채널(K)은 `membersOnly` 와 이 EXISTS 갈래에 `visibility = 'private'` 를 더하면 된다.
- **PH3 — 한 줄기인지는 저장하지 않는다.** 서버 `directHasAgents(db, channelId)`(`apps/server/src/modules/directs/service.ts` — 에이전트 참여자 행 존재). 웹이 가르는 값은 아래 태스크 5 줄.
- **PH4 — 한 줄기 `direct` 의 대화 규칙.** `message.send { newConversation }`·`PATCH /conversations/:id`(제목·닫기) → `VALIDATION`. 웹 URL 은 `/c/<채널 id>` 하나 — 채널 레이아웃이 그 대화를 바로 그리고 `s/<id>` 로 와도 그린다.
- **PH5 — 세션 `direct` 의 세션 권한은 참여자 누구나**(`conversations/service.ts`·웹 `features/conversations/permissions.ts`). 세션 관리자·세션 정책은 쓰지 않는다.
- **PH6 — 멘션.** `direct` 의 사람 글은 `channelParticipants` 로만 토큰을 만들고, 사람·에이전트 글 모두 그 뒤 참여자가 아닌 id 의 토큰 꼴을 `directMentions(text, participants)` 로 중화한다. `joinChannelIfAbsent` 는 부르지 않는다.
- **PH7 — 그룹 DM 의 승인 결정자는 `approvals.requested_by`.** 채널이 `direct` 면 모든 승인 종류에 그 런의 `runs.requested_by` 를 채운다. `approval.resolve`·`approvals/service.ts`·웹 `canDecideApproval` 은 `direct` 면 `userId === approval.requestedBy`(null 이면 `FORBIDDEN`) — 역할은 보지 않는다.
- **PH8 — 시킨 사람 관문 `directRunBlock(db, { channelId, agentId, requestedBy })`** → `"no_requester" | "dm_not_allowed" | null`(`direct` 가 아니면 늘 null, 시킨 사람의 지금 역할로 `dmAccessAllows`). 라우터는 런을 만들기 전에 불러 막히면 런 없이 그 대화(스레드면 그 스레드)에 `system` 글(`systemMeta.kind: "info"`) 「@<핸들> 는 이 요청에 답하지 않았습니다 — 시킨 사람이 이 에이전트의 DM 허용 범위 밖입니다」(시킨 사람이 없으면 「— 시킨 사람이 없습니다」)를 남긴다. 디스패치도 같은 함수로 막아 `abort_requested`(시스템 글 없음).
- **PH9 — REST.** `POST /api/v1/directs { userIds, agentIds }`(나 제외) → `{ channel, created }`, `GET /api/v1/directs` → `{ directs: DirectSummary[] }`. `users` 는 나를 뺀 사람 참여자(비활성 포함), `agents` 는 `agentForRole` 을 지난 참여 에이전트(보관 제외). 403 의 `details.agentId` 는 막은 에이전트 하나.
- **PH10 — `DmReadOnlyReason` 에 `"peer_deactivated"`.** `directReadOnlyReason(db, channel)` — 1:1(사람 둘, 에이전트 없음)이고 상대가 비활성이면 그 값. 쓰기 경로(메시지·카드·반응·첨부)의 `assertDmWritable` 이 본다.
- **PH11 — 실시간 대상 `channelAudience(db, channel)`**(`realtime/events.ts`) — `channel` 은 워크스페이스 룸, `dm` 은 주인의 user 룸, `direct` 는 사람 참여자(비활성 제외) 각자의 user 룸, 그 밖은 없음. `direct` 의 normal 글이면 `channel.activity` 의 `mentionedUserIds` 가 작성자를 뺀 사람 참여자 전원. 글·런 이벤트는 그 채널을 구독한 소켓에만 간다(user 룸으로 가는 것은 `channel.created`·`channel.activity`·승인).
- **PH12 — 에이전트가 받는 것.** `InboundDeliver.groupDm?: true`. 플러그인 헤더·러너 턴 사실은 `[dodok context]` 다음 줄에 `formatGroupDmLine()`(「그룹 DM: 참여자만 보는 대화」), 참여자는 `channelParticipants`. 러너는 채널 틀을 받되 자리 문구가 「a group direct message in dodok」. 그룹 DM 은 채널 프롬프트가 늘 없다. 옛 플러그인은 `groupDm` 을 버리고 받는다.
- **PH13 — 푸시.** `direct` 의 사람 normal 최상위·스레드 글과 에이전트 normal 정본은 작성자를 뺀 사람 참여자 전원에게(payload `kind: "mention"`, tag `direct:<conversationId>`, 본문 「DM」), `run_error`·승인 요청은 그 런의 `requestedBy` 에게만. 발송 직전 거름이 `directParticipants` 로 참여자가 아닌 사람을 걷는다.
- **PH14 — 읽지 않음.** `reads/store.ts` 의 멘션 셈에 「`kind = 'direct'` ∧ normal 글」(작성자 본인은 지금 조건이 뺀다).

### 13.2 태스크마다 계획·스펙과 달라진 것

- **접근 판정(태스크 1).** `readableChannelSql` 의 에이전트 DM 갈래를 「`kind = 'dm'` ∧ `dm_owner_id` = 나」로 좁혔다(`dm_owner_id` 만 보면 다른 kind 의 행이 그 열로 열릴 수 있다). `loadReadableChannel` 이 SQL 로 먼저 걸러, 모르는 kind 의 채널은 500 이 아니라 404 다.
- **열기·목록(태스크 3).** 시험 도우미 `createDirectChannelForTest` 는 검사 없는 `findOrCreateDirect` 를 부른다(검사는 `POST /directs` 경로의 시험이 본다). 에이전트 정본의 푸시를 이 태스크에서 냈다. 한 줄기 대화의 제목은 「DM」. `listDirects` 는 DM 마다 참여자를 따로 읽는다(N+1 — `docs/guides/plan.md` 8장 「이월」).
- **그룹 DM 런(태스크 4).**
  - `requesterOf` 를 `runs/context.ts` 로 옮겼다(순환 import).
  - **카드 누름·「다시 실행」·이어가기가 시킨 사람 관문에 막히면 6.3 의 시스템 메시지가 아니라 누른 사람에게 `FORBIDDEN`(`details.agentId`)** 이다 — 저장·소비 전에 판정해 버튼은 살아 있다. 시스템 메시지는 사람 글의 멘션이 막혔을 때만이다.
  - 러너 틀의 규칙 속성은 `channel="group-dm"`, 턴 사실은 「자리: 그룹 DM」, 러너 세션 제목은 「DM · …」. `runner-adapter` 가 `groupDm` 을 러너에 넘긴다.
  - `run_error` 푸시는 13.1 PH13 의 꼴(시킨 사람에게만). 승인 결정자 판정은 소켓만이 아니라 서비스 층(`approvals/service.ts`)에도 있다.
  - 러너 그룹 DM 틀에 채널 틀의 「The rules below were written by the channel's administrator in dodok's channel settings screen」 문장이 남는다(그룹 DM 에는 관리자·설정 화면이 없다). 모델 프롬프트라 ADR `docs/adr/0007-claude-agent-sdk-spike.md` 판단 없이 고치지 않았다 — `docs/guides/plan.md` 8장 「이월」.
- **웹(태스크 5).**
  - **PH3 의 「웹은 `agents.length > 0` 으로 가른다」는 틀렸다** — 보관된 에이전트는 `agents` 에서 빠지므로 에이전트가 있던 그룹이 한 줄기로 보였다. `DirectSummary.sessions`(서버 `directHasAgents` — 보관 여부와 무관한 참여자 행)로 가른다.
  - 승인 알림은 그 채널이 어느 캐시(채널·DM·`direct` 목록)에도 없으면 그리지 않는다(기본이 닫힘). 셸이 채널 목록을 늘 들지만, 부팅 직후 목록 응답 전 몇 백 ms 창은 남는다(`docs/guides/plan.md` 8장 「이월」).
  - 웹 `DmView.kind` 는 필수다.
- **dev:fake·통합(태스크 6).** 런을 막은 사유 표 `DIRECT_RUN_BLOCK_REASON` 을 `directs/service.ts` 로 옮겼다(`no_requester` 는 「시킨 사람이 없습니다」).
- **웹 다듬기.**
  - 「새 메시지」 403(`FORBIDDEN` + 웹이 아는 `details.agentId`)은 서버 문구 대신 웹 문구 「@<핸들> 와 대화를 열 수 없습니다 — 에이전트가 꺼져 있거나, 참여자 가운데 이 에이전트의 DM 허용 범위 밖인 사람이 있습니다」 — 누구인지는 말하지 않는다. 웹이 모르는 에이전트면 서버 문구 그대로. 5.1 「서버 403 문구를 그대로」에서 벗어난다.
  - 그룹 DM 카드가 시킨 사람 관문에 막히면(위 태스크 4 줄의 `FORBIDDEN`) 토스트 「@<핸들> 는 이 요청에 답하지 않았습니다 — <서버 사유>」 — 라우터 시스템 메시지와 같은 꼴.
  - 보관된 에이전트를 빼면 보이는 상대가 한 사람뿐인 그룹은 사이드바·검색·대화 머리 모두 이름 뒤에 「(그룹)」 을 붙여 1:1 과 가른다(검색 줄은 「DM · <이름> (그룹)」). 사람 상대도 없으면 이름 없이 「(그룹)」 만 보인다(`docs/guides/plan.md` 8장 「이월」).
- **실연(태스크 7).** 런 0회 하네스로 OpenClaw·러너 각 한 세션 — 결과는 `docs/superpowers/reports/2026-11-09-human-dm-live-smoke-report.md`. 스펙과 다른 것은 없었다.
