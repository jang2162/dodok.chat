# 에이전트 DM 설계 (하위 프로젝트 B)

**상태**: 확정(2026-10-25, 사용자 승인).
**범위**: 등록된 에이전트를 채널에 넣지 않고 1:1 로 대화한다. DM 은 한 창에서 끝없이 이어지지 않고 세션 단위로 새로 시작하며, 세션마다 기록이 남아 과거 대화를 찾기 쉽다. 주인 말고는 아무도(owner·admin 포함) 화면·API 로 볼 수 없다.

**앞선 근거**:
- 로드맵 `docs/superpowers/specs/2026-10-25-sessions-dm-runner-roadmap.md` 결정 3
- 채널 세션(대화 모델) `docs/superpowers/specs/2026-10-25-channel-sessions-design.md` — 이 스펙은 그 위에 선다
- 역할·승인 결정자: 팀 스펙 「역할과 권한」, 제어 MCP 스펙의 확인 카드(시킨 사람 본인만)

---

## 0. 결정

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **DM 은 `kind = "dm"` 인 채널이다** — 주인 사람 하나 + 에이전트 하나, (주인, 에이전트)마다 하나. 세션은 그 안에 쌓인다 | 메시지·세션·스레드·첨부·카드·런·검색·읽지 않음·푸시를 다시 만들지 않는다. 「에이전트마다 DM 하나 + 세션 여럿」이 ChatGPT 의 「대화 목록」과 같은 모양이다. |
| 2 | **접근 판정은 한 함수 `canReadChannel(user, channel)`** — 채널을 읽거나 쓰는 모든 경로가 이것을 지난다 | 지금 채널은 전원이 보므로 판정이 없다. DM 이 첫 비공개라 빠진 경로 하나가 곧 남의 DM 이 새는 구멍이다. 비공개 채널(로드맵 후보)도 이 함수에 규칙을 더해 선다. |
| 3 | **DM 은 주인만 본다 — owner·admin 도 화면·API 로 못 본다** | 1:1 의 기대치. 서버 운영자는 DB 로 볼 수 있다 — 매뉴얼에 그대로 적는다. 운영 화면은 DM 런을 세되 내용·주인을 보이지 않는다. |
| 4 | **에이전트마다 DM 허용 범위 `dmAccess`: `off` · `admins` · `everyone`, 기본 `admins`** (설계자 판단) | 러너 에이전트는 누군가의 머신에서 도구를 돌린다. 기본을 넓게 두면 등록하자마자 모든 member 가 그 머신에 일을 시킬 수 있다. 바꾸는 것은 admin 이상. |
| 5 | **DM 안 승인은 DM 주인이 결정한다** | 볼 수 있는 사람이 주인뿐이다. 그래서 결정 4 의 `everyone` 은 「member 도 이 에이전트의 도구 승인을 스스로 한다」는 뜻이고, 설정 화면이 그 문장을 그대로 보인다. |
| 6 | **DM 에서는 그 에이전트만 답한다** — 멘션 없이 모든 사람 메시지에 답하고, 다른 에이전트 멘션은 런을 만들지 않고 릴레이도 없다 | 다른 에이전트를 부르면 그 에이전트가 남의 1:1 을 읽게 된다. 여럿이 필요하면 채널이다. |
| 7 | **DM 에는 스레드가 없다** (설계자 판단) | 세션이 이미 주제를 가른다. 스레드까지 있으면 1:1 화면이 두 겹으로 갈린다. |

## 1. 범위

**한다**
- `channels.kind`·DM 주인·DM 에이전트, DM 만들기(처음 보낼 때)·목록
- `canReadChannel` 을 모든 읽기·쓰기 경로에(5장 목록)
- 에이전트 `dmAccess` 와 그 설정 화면
- DM 화면 — 세션 목록이 중심인 1:1 화면, 「이 DM 의 지시」
- DM 의 런: 자동 응답·헤더·승인 결정자·푸시·읽지 않음·한도
- 매뉴얼·에이전트 가이드 갱신

**하지 않는다**
- 사람 간 DM·그룹 DM, 비공개 채널, DM 결과를 채널로 공유(로드맵 후보 — 이 스펙의 함수 위에 선다)
- DM 에 다른 에이전트·사람 들이기, DM 스레드, 자동화가 DM 에 게시
- owner 가 남의 DM 을 감사(監査)하는 화면

## 2. 데이터

- `channels.kind`: `channel` · `dm`(기본 `channel`). DM 이면 `dm_owner_id`(users)·`dm_agent_id`(agents) NOT NULL, 유일 `(dm_owner_id, dm_agent_id) WHERE kind = 'dm'`. `name` 은 내부용(`dm-<에이전트 핸들>`) — 화면은 에이전트 이름을 쓴다.
- DM 채널의 `channel_members` 는 주인 사람 행 + 에이전트 행(`autoRespond: true`). 이 둘 말고는 넣을 수 없다.
- **DM 에서는 멘션을 토큰으로 바꾸지 않는다** (설계자 판단) — 주인이나 에이전트가 쓴 `@mia`·`@다른에이전트` 는 평문으로 남는다. 지금은 사람 멘션이 자동 참여(`joinChannelIfAbsent`)와 멘션 푸시를 부르므로, 토큰이 되면 mia 가 DM 멤버가 되고 알림을 받는다.
- DM 의 `relay_policy` 는 쓰지 않는다(결정 6), `prompt` 는 「이 DM 의 지시」(주인이 쓴다), 세션 정책은 늘 「주인만」.
- `agents.dm_access`: `off` · `admins` · `everyone`, 기본 `admins`.

## 3. 동작

### 3.1 DM 열기

- 사이드바 「다이렉트 메시지」 절: 내 DM 목록(에이전트 이름·아바타·읽지 않음, 최근 활동순)과 「+」 — 지금 내 역할로 DM 할 수 있는 에이전트(`dmAccess` 를 통과하고 보관·꺼짐이 아닌 것) 고르기.
- 고르면 `/dm/$agentHandle` → DM 채널이 없으면 빈 새 세션 창. 첫 `message.send { dm: { agentId }, newConversation }` 이 DM 채널·세션·메시지를 한 트랜잭션에 만든다.
- 에이전트 설정·카드에서 「DM 보내기」로도 연다.

### 3.2 DM 화면

- 왼쪽(좁은 화면은 시트) 세션 목록이 중심: 제목·날짜 묶음(오늘·어제·이번 주·이전)·읽지 않음, 제목·본문 검색(그 DM 안으로 거른 검색), 「새 세션」. 채널 세션 목록(스펙 A 6장)과 같은 컴포넌트에 표시만 다르게.
- 머리: 에이전트 이름·제공자·(러너면) 프로젝트 라벨, 「이 DM 의 지시」 편집, 세션 제목 바꾸기·닫기.
- DM 에서는 「세션 관리자」·채널 설정의 다른 칸이 없다.

### 3.3 런

- 주인의 모든 normal 메시지가 그 에이전트의 런이 된다(결정 6). 다른 `@에이전트` 토큰은 글로만 남는다.
- 헤더: 채널 자리에 `다이렉트 메시지: @<주인 핸들> 와 1:1`, `세션: <제목>`. 참여자는 주인 하나. 「이 DM 의 지시」는 채널 프롬프트 자리로 간다.
- 승인(도구 승인·OpenClaw exec 승인·제어 확인 카드)은 주인이 결정하고 알림·푸시도 주인에게만(결정 5). 주인이 member 여도 같다.
- 제어 도구의 주체는 지금처럼 시킨 사람(= 주인). DM 은 `list_channels`·`search_messages`·`read_messages` 에서 그 주인에게만 보인다.
- 한도: 워크스페이스 일일 상한에 센다. DM 에는 채널 `dailyRunLimit` 이 없다. 막히면 그 세션에 시스템 메시지.
- 에이전트가 보관·꺼짐이 되거나 `dmAccess` 가 주인을 더 이상 허용하지 않으면 DM 은 읽기 전용(작성기 자리에 사유 한 줄). 되돌리면 그대로 이어 쓴다.
- 주인이 비활성화되면 DM 은 그대로 남고 아무도 못 본다. 다시 활성화하면 돌아온다.

### 3.4 알림·읽지 않음

- DM 의 에이전트 최종 답(정본)과 run_error 는 주인에게 푸시(「@<에이전트> 가 답했습니다」, 누가·어디만 — 본문 없음, 보고 있으면 거름은 지금 규칙). tag 는 DM·세션 단위로 묶는다(빌더 판단).
- 읽지 않음: DM 의 에이전트 메시지는 모두 「멘션」 배지로 센다(Slack 의 DM 배지와 같은 기대).

## 4. 접근 판정 — `canReadChannel`

```
canReadChannel(user, channel):
  kind = dm      → user.id == channel.dm_owner_id 이고 user 가 비활성이 아님
  kind = channel → 지금 규칙(워크스페이스 멤버)
canWriteChannel = canReadChannel ∧ assertChannelWritable ∧ (DM 이면 3.3 의 읽기 전용 사유 없음)
```

**이 함수를 지나야 하는 자리 — 구현 계획이 하나씩 테스트로 덮는다.** 채널 목록·채널 하나·대화 목록·메시지 REST(around 포함)·스레드 REST·`channel.subscribe`·wire 팬아웃 대상(DM 은 채널 룸에 주인 소켓만 들인다)·`message.send`·`component.interact`·`reaction.set`·`approval.resolve`·`run.abort`·`run.events.replay`·`typing`·`presence.update` 의 채널·`conversation.read`·`GET /me/unread`·검색(SQL 단계에서 거른다 — 결과를 뽑은 뒤 거르면 페이지·커서가 샌다)·첨부 GET(그 메시지의 채널로)·활동 탭·런 REST·승인 목록·푸시 대상·`channel.activity`·제어 도구 전부·운영 화면 런 표(DM 은 「DM」 한 줄로 합침, 채널 이름·주인 없음).

- **에이전트 아웃바운드도 경계다.** DM 의 에이전트가 채널로, 채널의 에이전트가 DM 대화 id 로 쓰는 길은 스펙 A 4.3 「에이전트의 글은 세션 키의 대화에만 저장한다」가 막는다 — 그 규칙의 테스트에 DM → 채널·채널 → DM 두 꼴을 넣는다.
- **막지 못하는 것**: 에이전트 자신의 기억(OpenClaw 워크스페이스 메모리·`AGENTS.md`, 러너 작업 디렉터리의 파일·Claude Code 메모리)을 거쳐 DM 에서 들은 것이 그 에이전트의 채널 답에 나올 수 있다. dodok 이 막을 수 없으므로 매뉴얼 DM 절과 DM 화면 첫 안내에 적는다.
- 역할 매트릭스 테스트(`roles.matrix`)에 「남의 DM」 열을 더해 위 모든 경로가 404 인지 본다(403 이 아니라 404 — 있는지조차 드러내지 않게).

## 5. 오류 처리

| 상황 | 결과 |
| --- | --- |
| 남의 DM 에 어떤 요청이든 | 404 `NOT_FOUND`(wire 는 같은 코드의 ack) |
| `dmAccess` 밖인데 DM 만들기 | 403 `FORBIDDEN`, 웹은 목록에서 뺀다 |
| DM 에 사람·에이전트 넣기, 스레드 열기, 자동화 대상 | `VALIDATION` |
| 에이전트 보관·꺼짐·허용 철회 뒤 쓰기 | 409 `DM_READ_ONLY` |

## 6. 테스트·검증

- 서버: `canReadChannel` 경로 표 전부(4장 — 경로마다 남의 DM 404), DM 만들기 트랜잭션·유일성, 멘션 없는 자동 응답·다른 에이전트 멘션 무시, 승인 결정자 = 주인(member 주인 포함), 푸시는 주인만, 검색 커서가 남의 DM 을 건너뛰어도 페이지가 맞음, 운영 표에 DM 내용 없음.
- 웹 단위·`dev:fake` 브라우저(owner·mia 두 계정, 1280·390px): mia 의 DM 이 owner 화면·검색·알림 어디에도 없음, 세션 목록·날짜 묶음·검색·지시·읽기 전용 사유.
- 실연: 런 0회 하네스로 OpenClaw·러너 에이전트 각각의 DM 한 세션. 모델 런 0.

## 7. 완료 기준

1. member 가 허용된 에이전트와 DM 을 열고, 세션을 여럿 만들어 과거 세션을 목록·검색으로 다시 연다.
2. 다른 사람(owner 포함)은 그 DM 을 어느 화면·API·검색·알림·운영 표에서도 볼 수 없다.
3. DM 의 도구 승인을 주인이 결정한다.
4. `dmAccess` 를 끄면 DM 이 읽기 전용이 되고 되돌리면 이어진다.
5. 전체 테스트·typecheck·lint·fmt·웹 빌드·서버 번들 스모크 통과.

## 8. 빌더에게 맡긴 것

DM URL 에 핸들을 쓸지 id 를 쓸지, 날짜 묶음 경계(워크스페이스 시간대 기준), 푸시 tag 꼴, DM 세션 목록 검색을 제목만으로 시작할지.

## 9. 구현과 맞춘 것

구현(계획 `docs/superpowers/plans/2026-10-26-agent-dm.md` 태스크 1~6)·리뷰·수정·브라우저 검증·실연(태스크 7)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다.
근거는 실행 폴더 `.superpowers/sdd/2026-10-26-agent-dm/`(git 제외)의 보고서·리뷰(`t1`~`t7` — 줄 끝 괄호가 출처)와 브라우저 기록 `.superpowers/sdd/2026-10-26-agent-dm-browser/report.md` 다. 본문(0~8장)은 설계를 확정한 때의 기록이라 고치지 않았다 — **본문과 이 장이 다르면 이 장이 구현이다.**
화면 쓰는 법은 `docs/manual/user-guide.md` 「다이렉트 메시지」 절, 에이전트 쪽은 `docs/guides/agent-guide.md` 「DM — 주인과 1:1」 절, 실물 확인은 `docs/guides/live-smoke.md` 「DM 실연」 절이다.

**계획 판정 PD1~PD13** (계획 「계획 판정」 절 — 줄마다 요지만)

- **PD1** — DM 채널은 **열 때** 만든다(3.1 의 「첫 보내기가 만든다」가 아니다). `POST /api/v1/dms { agentId }` 가 (주인, 에이전트) 채널을 찾거나 만들고 대화는 만들지 않는다 — 첫 보내기는 `message.send { channelId, newConversation }` 그대로다(`MessageSend` 계약 불변). 이미 있는 DM 은 허용 검사 없이 돌려준다(읽기 전용이어도 — 403 은 새로 만들 때만). `findOrCreateDm` 의 `onConflictDoNothing` + 다시 읽기는 여러 프로세스가 같은 DB 를 쓸 때의 방어선이다(t3 판단 1).
- **PD2** — DM 화면은 채널 경로를 쓴다: `/dm/<에이전트 id>` 가 `POST /dms` 로 채널 id 를 받아 `/c/<DM 채널 id>` 로 넘기고, 채널 레이아웃이 `channel.kind === "dm"` 이면 DM 꼴로 그린다.
- **PD3** — REST `GET /api/v1/channels` 는 `kind = 'channel'` 만, 내 DM 은 `GET /api/v1/dms`. 제어 도구의 「읽을 수 있는 채널」은 주체마다 다르다(아래 「접근 판정」 — 3.3 의 제어 도구 문장을 좁힌다).
- **PD4** — DM 의 `channel.created`·`channel.updated`·`channel.activity`·`approval.requested`·`approval.resolved`·`system.notice` 는 주인의 user 룸으로만.
- **PD5** — 운영 런 표는 DM 런을 이름·주인 없이 「DM」 한 줄로 합친다. 자동화 대상이 DM 이면 `VALIDATION`.
- **PD6** — DM 에서는 그 에이전트가 사람의 모든 normal 최상위 메시지에 답하고, 멘션 토큰화·보낸 사람 말고의 자동 참여·릴레이가 없다. `threadRootId` 는 `VALIDATION`. 채널 `dailyRunLimit` 은 걸지 않는다(워크스페이스 상한만).
- **PD7** — DM 의 모든 승인(도구 승인·exec 승인·제어 확인 카드)은 주인만 결정하고(역할 무관) 승인 푸시도 주인에게만.
- **PD8** — `InboundDeliver.dm?: { ownerHandle }`, 헤더 줄 `다이렉트 메시지: @<주인> 님과 1:1`(shared `formatDmLine` — 3.3 의 「와 1:1」이 아니라 조사를 「님과」로 고정해 받침 판정이 없다). 「이 DM 의 지시」는 채널 프롬프트 자리로 간다.
- **PD9** — DM 의 `PATCH /api/v1/channels/:id` 는 `prompt` 만 받고 주인만(역할 무관). 그 밖의 채널 관리(이름·주제·멤버·보관·세션 관리자·세션 정책·`dailyRunLimit`·제어 쓰기 도구 전부)는 `VALIDATION`.
- **PD10** — DM 의 에이전트 normal 메시지는 모두 「나를 멘션한 글」로 센다(스냅숏·실시간 같은 규칙).
- **PD11** — DM 의 에이전트 normal 최상위 정본과 `run_error` 는 주인에게 푸시, tag `dm:<conversationId>`(8장 빌더 몫).
- **PD12** — 세션 목록 날짜 묶음은 **브라우저 시간대**다(8장의 「워크스페이스 시간대 기준」이 아니다). 오늘·어제·이번 주(오늘 포함 7일)·이전, `lastMessageAt`(없으면 `createdAt`).
- **PD13** — `dmAccess` 는 제어 도구로 바꾸지 않는다(`update_agent` 스키마 밖) — REST `PATCH /api/v1/agents/:id { dmAccess }`(admin 이상)만.

**데이터 (태스크 1)**

- DM 채널 행의 `name` 은 `dm` 하나다(2장의 `dm-<에이전트 핸들>` 이 아니다 — 핸들이 바뀌어도 행을 고치지 않게). `visibility` `private`, `session_policy` `{ create: "members" }`, `created_by` 는 주인.
- `dm_owner_id`·`dm_agent_id` 는 nullable FK(cascade 없음 — 사람·에이전트는 지우지 않고 비활성화·보관한다)이고 「DM 이면 NOT NULL」은 DB 제약이 아니라 DM 을 만드는 한 함수(`modules/dms/service.ts findOrCreateDm`)가 지킨다. 유일 `channels_dm_pair (dm_owner_id, dm_agent_id) WHERE kind = 'dm'`.
- 마이그레이션 `0029_agent_dms` — SQL·스냅숏은 생성기 출력 그대로, 이름만 관례에 맞춰 바꿨다(t1 판단 8).

**접근 판정 (태스크 1·2)** — 정본 `apps/server/src/auth/channel-access.ts`

- 4장의 `canWriteChannel` 은 함수 하나가 아니다: 접근(`canReadChannel`·`assertChannelReadable`)·보관(`assertChannelWritable`)·DM 읽기 전용(`modules/dms/service.ts assertDmWritable`)을 그 자리마다 이 순서로 부른다.
- 채널 행을 얻는 자리는 얻은 직후 `assertChannelReadable`, **대화·런 id 로 닿는 자리는 조회 WHERE 에 `readableChannelSql` 를 붙인 도우미**(`conversations/store.ts getReadableConversation`·`runs/store.ts getRunInWorkspace` 의 `readerId`)로 없는 대화·런과 같은 404 를 낸다(t1 판단 1).
- **역할 정책이 `requirePolicy` preHandler 에 있던 경로**(`DELETE members`·`archive`·`unarchive`·`session-managers`)는 preHandler 를 `requireSession` 으로 바꾸고 핸들러에서 「접근 → 역할 → 보관」 순으로 부른다 — preHandler 는 핸들러보다 먼저 돌아 남의 DM 에 403 을 냈다. 그래서 이 넷에서 member 가 없는 채널 id 를 치면 403 대신 404 다(t1 판단 2).
- id 로 무언가를 찾는 경로는 「없음」과 「남의 DM 의 것」이 같은 코드·같은 문구다 — 역할 갈래·`VALIDATION` 갈래보다 먼저(`approval.resolve` 의 없는 승인, `message.send` 의 읽을 수 있는 채널 + 남의 DM 대화 id 도 `NOT_FOUND`, t1 리뷰 L1·L2).
- `listChannels` 의 기본은 일반 채널만이다(빠뜨려도 새지 않는 쪽). `GET /api/v1/me/unread` 의 `channels` 에는 주인의 DM id 가 든다(t1 판단 4·5).
- **제어 도구의 읽기 범위는 주체마다 다르다**(3.3 의 「DM 은 … 그 주인에게만 보인다」를 좁힌다): 주체는 지금처럼 시킨 사람(= 주인)이고, 읽을 수 있는 채널은 `readableChannelSqlFor` 가 정한다 — **바깥 MCP(개인 토큰)는 일반 채널 + 주인의 DM 전부, 채널 안 에이전트는 일반 채널 + 그 런의 채널이 주인의 DM 이면 그 DM 하나**다. 일반 채널에서 시킨 런의 에이전트에게는 주인의 DM 도 없는 채널과 같다(`NOT_FOUND`). 프롬프트 주입·모델 오판으로 DM 이 채널 답에 옮겨지는 길을 dodok 이 막는다. 저장소·검색 함수는 사람 id 또는 이 SQL 을 `ChannelReader` 로 받는다(t1 수정 보고 5장 1·3).
- 그래서 4장 「막지 못하는 것」은 이만큼이다: **에이전트가 제어 도구로 다른 DM 을 읽어 채널에 옮기는 길은 막는다 — 막지 못하는 것은 에이전트 자신의 기억(같은 에이전트가 DM 에서 들은 것을 다른 세션에서 떠올리는 것)뿐이다**(t1 수정 보고 5장 2).
- 제어 도구는 `ControlHandler.access?(ctx, input, principal)` 를 `authorize` 전에 부른다. 입력 파싱(`VALIDATION`)은 그보다 앞이고(꼴 오류는 존재를 드러내지 않는다), 확인 카드 뒤 재검사에서는 `access` 를 다시 부르지 않는다(DM 주인은 바뀌지 않는다)(t1 판단 3).
- **4장의 `typing`·`presence.update` 는 따로 판정하지 않는다** — `typing` 은 그 채널 룸에 든 소켓에만 중계하고 룸 참가가 `channel.subscribe` 의 판정을 지나므로 룸 참가가 대신한다. `presence.update` 는 자기 소켓의 푸시 거름에만 쓰인다(t1 보고 2장, t1 리뷰).
- 채널 사실을 workspace 룸으로 내는 이벤트는 `realtime/events.ts channelAudience` 를 거친다(DM 이면 주인의 user 룸) — 페이로드에 채널 행이 없으면 채널을 읽어 고르고, 없는 채널이면 보내지 않는다. 버스 `system.notice` 페이로드의 `userId?` 가 있으면 그 사람의 user 룸이다. `channel.member.changed` 는 채널 룸이라 그대로 둔다(DM 채널 룸에는 주인 소켓만 있다)(t2 보고 2장·7장).
- 운영: 「DM」 줄은 `OpsRunsRow { id: OPS_DM_ROW_ID, kind: "dm" }`(nil uuid)이고 웹은 링크로 만들지 않는다. 제어 쓰기의 운영 사건 `control_change` 는 DM 이면 `detail.channelId` 를 null 로 싣는다 — PD9 로 DM 의 채널 쓰기 도구가 모두 `VALIDATION` 이라 지금은 그 사건이 생기지 않는다. PD6 으로 DM 에 채널 한도가 없어 `run_limit` 의 `channel:<DM id>` key 도 생기지 않는다(t2 보고 2장).
- 자동화 만들기·바꾸기는 남의 DM 404 → 내 DM `VALIDATION` → 보관 409 순, 게시(지금 실행·웹훅·예약)도 DM 이면 `VALIDATION` 으로 아무것도 남기지 않는다(웹훅은 400, 사건 `automation_failed { code: VALIDATION }`)(t2 보고 2장 6).
- 푸시는 두 겹이다: 트리거 갈래(승인 → 주인) 말고도 발송 직전 거름(`push/service.ts attachPushTriggers`)이 DM 을 겨눈 알림을 주인 말고 모두 걷는다. 본문의 자리 이름은 「DM」(t2 보고 2장 5).
- 리뷰가 남긴 테스트 빈칸 둘은 뒤 태스크가 닫았다 — `readableChannelSqlFor` 의 「시킨 사람 = DM 주인」 조건은 태스크 2 가 매트릭스 사례(DM 런을 가리키되 시킨 사람이 admin·null)로 덮었고(t1 재리뷰 N1), 보관한 남의 DM 으로 자동화를 만들 때의 판정 순서는 태스크 3 이 테스트로 고정했다 — PD9 로 DM 은 보관할 수 없게 됐다(t2 리뷰 L1).

**DM 만들기·런 (태스크 3)**

- `GET /api/v1/dms` 는 글 없는 DM 도 싣고(`lastMessageAt: null`) 최근 활동순(`coalesce(max(conversations.last_message_at), channels.created_at) desc`)이다 — 사이드바에서 거르는 것은 웹 몫(t3 판단 4).
- DM 본문은 토큰 꼴(`<@u:…>`)도 `neutralizeMentionTokens` 로 중화하고 `mentions` 는 늘 비운다(`messages/service.ts plainInDm`) — 자동 참여·멘션 푸시·릴레이가 따로 갈래 없이 꺼진다. 사람 글·에이전트 글 둘 다다(t3 판단 2).
- DM `PATCH` 의 순서: 접근(404) → 보관(409) → 본문 키(`VALIDATION`) → 파싱 → `assertDmWritable`(409 `DM_READ_ONLY`). 역할 정책은 부르지 않는다(t3 판단 5).
- **`dmAccess` 철회·끄기·보관은 새 쓰기를 막고, 철회 전에 줄 선 런도 차례가 오면 보내지 않고 `aborted`(시스템 메시지 없음)로 닫는다**(`runs/orchestrator.ts dmClosedTarget` — 보관한 에이전트·닫힌 세션과 같은 꼴). 이미 어댑터로 간 런은 끝까지 돌고, 주인이 그 승인을 결정하며, 그 답은 저장·푸시된다(일반 채널의 끄기와 같다)(t3 리뷰 L1 → (b), t3 수정 보고 5장 2).
- 실시간 배지도 PD10 그대로다 — `channel.activity` 는 DM 에이전트의 보통 메시지면 `mentionedUserIds` 를 `[dmOwnerId]` 로 싣는다(`realtime/events.ts`). 웹은 DM 을 따로 가르지 않는다(t3 수정 보고 5장 1).
- DM 푸시의 payload `kind` 는 `"mention"`(새 값 없음), 제목 `@<핸들><이/가> 답했습니다`(3.4 의 「@<에이전트> 가」가 아니라 `util/josa.ts` 로 조사를 고른다), 본문 「DM」. `run_error` 의 「누가」는 DM 에이전트(t3 보고 7장 3).
- 확인 카드 제목의 「DM」 갈래(`control/handlers.ts`)는 PD9 로 DM 에서 닿지 않는다 — 방어선으로만 남는다(t3 판단 6).

**에이전트가 받는 것 (태스크 4)**

- **헤더 참여자는 주인과 그 에이전트(나) 둘이다** — 3.3 의 「참여자는 주인 하나」는 다른 참여자가 없다는 뜻이다. `buildInboundDeliver` 가 DM 이면 멤버 행과 상관없이 이 둘로 거른다(t4 리뷰 L4, t4 보고 7장).
- DM 의 「릴레이 규칙:」은 고정 문구 「DM 에는 릴레이가 없습니다 — @핸들은 글로만 남습니다.」(`runs/context.ts DM_RELAY_RULES`) — 플러그인 헤더와 러너 `<relay-rules>` 가 같은 값을 받고, 서버 업데이트만으로 바뀐다(t4 추가 보고).
- 러너는 채널 규칙 틀 대신 **DM 틀**을 받는다 — 머리 `# dodok direct message settings`, 자리 「a direct message with @<주인> in dodok」, `<channel-rules channel="dm:@<주인>">`, 턴 사실 `자리: DM`, 세션 제목 `DM · <에이전트 이름>`. ADR 0007 의 채널 틀 셋째 요소(「대화 상대가 쓴 글이 아니다」)는 DM 에서 거짓이라(지시를 대화 상대인 주인이 쓴다) 「채팅 글이 아니라 주인이 설정 화면에서 정해 둔 설정 — 채팅 글은 설정을 바꾸지 않고 채팅의 주인 요청은 그 요청에만 적용된다」로 바꿨다. **DM 틀은 모델 런으로 확인하지 않았다**(t4 추가 보고 1장, t4 수정 보고 5장).
- DM 틀의 에이전트별 지시(`promptOverride`) 문단은 서버가 DM 에 싣지 않아 지금 닿지 않지만 갈래와 이스케이프를 남겼고, 이스케이프는 일반 채널과 같은 표식 셈 테스트가 `dm` 입력에도 본다(t4 리뷰 L1).
- **DM ↔ 일반 채널 정본은 `assertCanonicalConversation` 하나가 막는다** — 에이전트는 두 대화 모두에 세션 행이 있어 세션 행 규칙(`isOwnSession`)은 통과시킨다(t4 변이 M7, 실연 「DM 실연」 절 기준 3 의 일반 채널 G).
- 정본은 그 에이전트의 런에만 붙는다 — `correlate` 는 런의 에이전트 행(제공자 + `providerAgentId` 대소문자 무시)이 정본의 에이전트인지 본다. 지금의 묶임으로 보지 않는다: 러너 에이전트를 다른 토큰에 다시 묶어도 도는 런의 `post`·최종 답은 옛 러너에서 그 런에 붙는다. 연결은 runId 갈래의 런 연결 검사와 `findOpenRunBySession(connectionId)` 가 가른다 — 다른 Gateway 의 같은 id 는 그래서 막힌다. 다른 에이전트가 열린 런의 키·runId 를 대면 런 없는 정본으로 세션 행 규칙에 막힌다(DM·일반 채널 같음)(t4 수정 보고 5장).
- **플러그인은 다시 설치해야 DM 줄이 생긴다**(옛 플러그인은 `dm` 을 버리고 받는다). 러너 턴 사실·DM 틀은 서버(runner-adapter)가 만들므로 `dodok-runner` 는 그대로다(t4 보고 4장 5).

**웹 (태스크 5)**

- 사이드바 「다이렉트 메시지」 절은 `lastMessageAt !== null` 인 DM 과 지금 연 DM 만 보인다(`DmSummary` 에 `lastSeq` 가 없다 — 빈 세션을 만들지 않으므로 같은 뜻).
- DM URL 은 에이전트 id(`/dm/<에이전트 id>` — 8장 빌더 몫, 3.1 의 핸들이 아니다). 만들기는 POST 라 라우트 `beforeLoad` 가 아니라 화면(`DmRedirect`)이 한다 — 403 「이 에이전트와 DM 을 열 수 없습니다」, 404 「에이전트를 찾을 수 없습니다」.
- DM 목록 쿼리는 `staleTime: Infinity` + 이벤트 무효화(다시 붙기·`agents.changed`·내 역할 바뀜 `people.changed`·DM 의 `channel.created`·`channel.updated`·모르는 채널의 `channel.activity`·쓰기의 `DM_READ_ONLY`·`POST /dms` 뒤)이고, 셸(`app/layout/AppShell.tsx`)이 늘 들고 있다 — 좁은 화면은 사이드바를 시트를 열 때만 그리는데 실시간 처리기가 이 캐시로 DM 의 승인 알림·읽지 않음 항목을 정한다(t5 리뷰 M1).
- DM 작성기는 @ 후보를 띄우지 않는다 — 고른 멘션 토큰을 서버가 중화해 원문 `<⁠@a:…>` 가 글로 남기 때문이다. 손으로 친 `@핸들` 은 글.
- 읽지 않음 항목을 새로 만드는 채널 목록에 DM 도 넣는다. 승인 결정자의 웹 판정도 DM 이면 주인만(`canDecideApproval`).
- 읽기 전용 DM 은 반응도 잠근다(피커 숨김·칩 읽기만). 카드(components)에는 잠금 사유를 두지 않았다 — 누르면 서버 문구로 거절되고 DM 목록을 다시 받는다(이월).
- DM 패널은 활동 탭만이다 — 머리에 「활동」 링크, `/settings`·`/t/<루트>` 주소로 와도 패널을 그리지 않는다.
- 머리의 「(러너면) 프로젝트 라벨」은 `Agent` 에 프로젝트 라벨이 없어 맡은 러너 라벨(`agent.runner.label`)로 대신했다.
- 세션 목록 검색은 채널 세션 목록과 같은 제목 검색이다(3.2 의 「본문 검색」은 ⌘K 검색 — 결과 줄은 「DM · <에이전트 이름>」, 검색 대화상자의 채널 거름에는 DM 이 없다 — 이월).
- 날짜 묶음 머리는 `aria-hidden` 글자 + 묶음 `role="group" aria-label`. 목록 순서가 실시간으로 어긋나면 줄을 옮기지 않고 그 자리에서 새 묶음을 연다 — 같은 머리가 두 번 보일 수 있다. 날짜는 렌더 시각으로만 정한다(자정을 넘겨도 다시 그리기 전까지 「오늘」 — 이월).
- 초점: 쓸 수 있던 DM 이 읽기 전용이 되면 초점이 숨은 작성기 안이나 body 일 때만 사유 줄로, 다시 쓸 수 있게 되어 사유 줄이 사라지고 초점이 body 면 작성기로(닫힌 세션 안내와 같은 규칙)(t5 보고 2장 1~11).

**dev:fake·검증 (태스크 6)**

- `dev:fake` 는 새 DB(dev 를 처음 등록할 때)에서 사무실 `dev` 의 `dmAccess` 를 `everyone` 으로 두고 mia ↔ dev DM 에 세션 하나(mia 글 + 대본 답)를 만든다 — `--keep`·사무실 플러그인이 못 붙음·dev 보관·꺼짐이면 경고만 남기고 건너뛴다(t6 리뷰 낮음 2·3).
- 브라우저 검증이 고친 결함 하나 — 390px DM 머리에서 제공자 라벨이 이름을 한 글자로 밀어냈다(라벨이 먼저 줄어든다). 고치지 않은 관찰 O1·O2 는 이월(t6 보고 3장).

**실연 (태스크 7)** — `docs/guides/live-smoke.md` 「DM 실연」 절

- 「이 DM 의 지시」는 OpenClaw 에이전트에게 일반 채널의 채널 프롬프트와 같은 두 길로 간다 — 새 세션은 Gateway 채널 설정 `systemPrompt`, 세션이 시작된 뒤 바꾸면 `채널 프롬프트:` 항목(`ChannelPromptContext`).
- OpenClaw(9.5)는 DM 을 그룹 채널로 모델에게 소개한다(`is_group_chat: true`, 「Activation: trigger-only …」) — DM 이라는 사실은 dodok 헤더의 DM 줄로만 간다. 모델이 어떻게 읽는지는 보지 않았다(이월).
