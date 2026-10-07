# 읽지 않음 — 사용자별 읽음 위치·굵은 채널·멘션 배지·새 메시지 구분선 설계

**상태**: 설계 확정(2026-10-05), 구현 전.
**범위**:
- 사이드바에서 안 읽은 채널을 굵게, 나를 멘션한 수를 배지로 보인다
- 채널에 들어가면 「여기부터 새 메시지」 구분선을 긋고, 끝까지 보면 읽음이 된다
- 읽음 위치는 서버에 사용자별로 두어 기기 사이에 맞춘다

**앞선 근거**:
- Slack·Buzz 참고 후보 조사(이 대화의 결론): 읽지 않음은 「메신저 기본기」 가운데 매일 체감이 가장 큰 빈자리다. 같은 조사의 리액션·예약/웹훅은 각자 스펙으로 간다
- 구독 구조: 웹은 보고 있는 채널 하나만 구독한다(`apps/web/src/realtime/subscriptions.ts` 의 `enter`·`leave`) — 다른 채널의 `message.created` 는 브라우저에 오지 않는다
- 메시지 seq: 채널마다 하나의 카운터(`channels.last_seq`)를 최상위·스레드 답글·시스템 메시지가 함께 쓴다
- 결과로 가기(`?around=<seq>`): 스레드·검색 스펙 `docs/superpowers/specs/2026-09-25-threads-search-design.md`, 웹 `features/messages/jump.ts`·`useJump.ts`
- 보관·비활성화: 채널 보관·멤버 비활성화 스펙 `docs/superpowers/specs/2026-10-06-channel-archive-member-deactivate-design.md` — 보관한 채널은 사이드바에서 빠지고 읽기만 된다, 멤버는 지워지지 않고 비활성화된다
- 역할: 팀 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」

---

## 0. 결정 (브레인스토밍 2026-10-05)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **기본형만 한다** — 굵은 채널·멘션 배지·구분선·읽음 동기화 | 사용자 결정. 활동 인박스(멘션·스레드 답글·승인 모아 보기)는 범위 밖이다. |
| 2 | **「놓친 것 요약」은 넣지 않는다** | 사용자 결정. 브레인스토밍에서 나온 형태는 11장에 남긴다. |
| 3 | **읽음 위치는 서버에 사용자 × 채널로 둔다**(`channel_reads`) | 기기(PWA·데스크톱 탭) 사이에 맞아야 한다. 브라우저 저장은 기기마다 따로 놀고, 모든 채널 구독은 지금 구조(보는 채널만 구독)를 뒤집는다. |
| 4 | **다른 채널의 새 글은 워크스페이스 룸의 가벼운 신호**(`channel.activity` — 본문 없음)로 알린다 | 웹은 처음·재연결 때 현황을 받고, 그 뒤는 신호로 더해 간다. |
| 5 | **굵게는 남이 쓴 최상위 보통 메시지만, 배지는 스레드 답글 속 멘션도 센다** | 스레드 답글이 채널을 굵게 만들면 스레드가 활발한 채널은 늘 굵다. 멘션은 놓치면 안 되는 것이라 어디서 왔든 센다. |
| 6 | **스레드마다 읽음 위치를 두지 않는다** — 채널을 보면 그 seq 까지의 스레드 멘션도 읽음이 된다 | 스레드별 읽음은 인박스의 몫이다. 스레드 멘션은 지금도 푸시로 가고 스레드 칩이 남는다. |
| 7 | **읽음 위치는 커지기만 한다** | 늦게 온 요청·여러 기기가 섞여도 뒤로 가지 않는다. 「안 읽음으로 표시」는 범위 밖이다. |
| 8 | **기존 사용자는 마이그레이션 때 모든 채널을 지금 `last_seq` 까지 읽음으로 채운다**, 행이 없으면 0 | 배포 직후 모든 채널이 굵어지지 않는다. 뒤에 가입한 멤버는 기록이 있는 채널을 안 읽음으로 본다(Slack 과 같다). |
| 9 | **틀린 배지보다 없는 배지** — 현황을 못 받았거나 오프라인이면 굵게·배지를 끈다 | 낡은 숫자는 사람을 헛걸음시킨다. |

## 1. 범위

**한다**
- `channel_reads` 표와 시드 마이그레이션
- `GET /api/v1/me/unread`, wire `channel.read`(양방향)·`channel.activity`
- 서버 `modules/reads/`
- 웹 `features/reads/`(현황 스토어·읽음 전송), 사이드바 굵게·배지, 타임라인 구분선, 구분선이 불러온 페이지 밖이면 `around` 로 가기
- 역할 매트릭스·문서(`docs/guides/user-guide.md`·`docs/project-structure.md`)

**하지 않는다** — 11장.

## 2. 무엇이 「안 읽음」인가

사용자 U, 채널 C, U 의 읽음 위치를 `R`(행이 없으면 0)이라 한다.

- **굵게(`unread`)**: C 에 `seq > R` 이고 `kind = "normal"` 이고 `thread_root_id IS NULL` 이고 U 가 쓰지 않은(`author_type = "user" AND author_id = U` 가 아닌) 메시지가 하나라도 있다. 에이전트가 쓴 메시지도 센다. 시스템 메시지는 세지 않는다.
- **배지(`mentions`)**: C 에 `seq > R` 이고 `kind = "normal"` 이고 `mentions_json` 의 `users` 에 U 가 들고 U 가 쓰지 않은 메시지 수. 스레드 답글도 센다. 응답은 99 에서 자른다(웹은 「99+」).
- **읽음이 되는 때**: 그 채널 타임라인의 맨 끝 메시지가 화면에 들어와 있고 탭이 보일 때(`document.visibilityState === "visible"`) 웹이 가진 가장 큰 seq 를 보낸다. 같은 채널은 1초 디바운스한다. 스레드 패널을 보는 것만으로는 채널 읽음이 오르지 않는다.
- **내가 최상위 메시지를 보내면** 서버가 그 seq 까지 읽음으로 올린다. 스레드 답글을 보내는 것은 올리지 않는다(채널 끝을 보지 않고도 답글을 쓸 수 있다).

## 3. 데이터 모델

### 3.1 `channel_reads` (새 표·새 마이그레이션)

| 열 | 꼴 | 비고 |
| --- | --- | --- |
| `user_id` | text, FK `users.id` `ON DELETE CASCADE` | |
| `channel_id` | text, FK `channels.id` `ON DELETE CASCADE` | |
| `last_read_seq` | integer not null | 커지기만 한다 |
| `updated_at` | ts not null | |

기본 키 `(user_id, channel_id)`. 같은 마이그레이션 끝에 시드를 붙인다 — membership 이 있는 모든 사용자(비활성 멤버 포함 — 다시 활성화하면 돌아온다) × 그 워크스페이스의 모든 채널을 `last_read_seq = channels.last_seq` 로 넣는다. 스키마는 `apps/server/src/db/schema.sqlite.ts` 에 더하고 drizzle 로 생성한 뒤 시드 SQL 을 손으로 덧붙인다(FTS 마이그레이션 `0007_search_fts.sql` 과 같은 방식).

행은 처음 읽을 때(`markRead`) 생긴다. 새 채널·새 멤버는 행이 없으므로 `R = 0` 이다.

**비활성화는 읽음 행을 건드리지 않는다** — 사용자·채널 참여가 남고, 다시 활성화하면 읽음 위치도 그대로 돌아온다. 사용자·채널 행은 지워지지 않으므로(채널은 보관만) 두 FK 의 cascade 는 정합성용이다.

## 4. 계약

### 4.1 REST

`GET /api/v1/me/unread` — 로그인한 사용자 누구나, 자기 것만. **보관하지 않은 채널만** 싣는다(`channels.archived_at IS NULL` — 사이드바 목록과 같은 기준).

```ts
// packages/shared/src/reads/index.ts (새 파일)
export const ChannelUnread = z.object({
  channelId: Id,
  lastReadSeq: z.int().min(0),
  unread: z.boolean(),
  mentions: z.int().min(0).max(99),
});
export const UnreadSnapshot = z.object({ channels: z.array(ChannelUnread) });
```

보관하지 않은 모든 채널을 싣는다(행이 없는 채널은 `lastReadSeq: 0`). 공용 `Channel` 타입에는 넣지 않는다 — `channel.updated` 는 워크스페이스 전원에게 가므로 사람마다 다른 값을 실을 수 없다.

### 4.2 wire (`packages/shared/src/wire/index.ts`)

| 방향 | 이름 | 페이로드 | 룸·제약 |
| --- | --- | --- | --- |
| 클라이언트 → 서버 | `channel.read` | `{ channelId: Id, seq: int ≥ 0 }`, ack `{ lastReadSeq }` | 버킷 `wire.chatter`(`typing`·`presence.update` 와 같은 분류) |
| 서버 → 클라이언트 | `channel.read` | `{ channelId: Id, lastReadSeq: int }` | 그 사용자의 user 룸 — 같은 사용자의 다른 기기·탭이 맞춘다 |
| 서버 → 클라이언트 | `channel.activity` | `{ channelId, seq, threadRootId?, authorType: "user" \| "agent", authorId, mentionedUserIds: Id[] }` | workspace 룸. `kind = "normal"` 메시지가 생길 때마다. 본문 없음 |

## 5. 서버 (`apps/server/src/modules/reads/`)

- **`store.ts`**
  - `markRead(userId, channelId, seq)`: `seq` 를 `channels.last_seq` 로 깎은 뒤 upsert 하고 `last_read_seq = max(old, new)` 를 돌려준다. 채널이 없거나 다른 워크스페이스면 `NOT_FOUND`.
  - `unreadFor(userId, workspaceId)`: 2장의 정의를 채널마다 질의 한 번으로 계산한다. 멘션은 `json_each(mentions_json, '$.users')` 로 센다. 범위 스캔은 기존 인덱스 `messages_channel_seq` 를 탄다.
- **`service.ts`**
  - 버스의 `message.created` 를 받아 `kind = "normal"` 이면 `channel.activity` 를 workspace 룸에 낸다(`apps/server/src/realtime/events.ts` 의 팬아웃 자리에 둔다).
  - 사람이 최상위 메시지를 보내 저장에 성공하면(`realtime/socket.ts` 의 `message.send` 처리기, 멱등 재전송은 빼고) 작성자의 `markRead` 를 부르고 user 룸에 `channel.read` 를 낸다.
- **`routes.ts`**: `GET /api/v1/me/unread`.
- wire `channel.read` 처리기는 `realtime/socket.ts` 에 더하고, 페이로드를 Zod 로 파싱한 뒤 `markRead` → ack → user 룸에 `channel.read` 를 낸다(보낸 소켓도 받는다 — 같은 값이라 해가 없다).

## 6. 웹

- **`features/reads/useUnread.ts`(zustand)**
  - 로그인 직후와 소켓이 다시 붙을 때마다 `/me/unread` 를 받아 통째로 갈아 끼운다. 받기 전·실패·오프라인이면 `ready = false` 이고, 그동안 굵게·배지를 그리지 않는다.
  - `channel.activity` 를 받으면: 내가 쓴 것이면 무시한다. 지금 보고 있는 채널이고 끝이 보이고 탭이 보이면 읽음 전송에 맡긴다. 그 밖이면 최상위면 `unread = true`, `mentionedUserIds` 에 내가 있으면 `mentions + 1`(99 에서 멈춤).
  - 서버의 `channel.read` 를 받으면 그 채널의 `lastReadSeq` 를 올리고 `unread = false`·`mentions = 0` 으로 둔다.
- **읽음 전송**: 채널 페이지가 타임라인의 「끝이 보임」 상태와 `visibilitychange` 를 보고 2장의 조건이 서면 1초 디바운스로 `channel.read` 를 보낸다. 실패(레이트 초과 포함)는 버리고 다음 조건 성립 때 다시 보낸다.
- **사이드바(`features/channels/ChannelList.tsx`)**: `unread` 면 채널 이름을 굵게, `mentions > 0` 이면 배지(「99+」). 보고 있는 채널은 굵게 하지 않는다. 좁은 화면 사이드바 시트(`app/layout/sidebarSheet.tsx`)도 같은 목록을 쓴다.
- **구분선**: 채널에 들어갈 때(`enter`) 그 채널의 `lastReadSeq` 를 `entryReadSeq` 로 잡아 채널을 떠날 때까지 둔다. 타임라인 행 묶기(`features/messages/groupRows.ts`)에 행 종류 「새 메시지 구분선」을 더해, `seq > entryReadSeq` 인 첫 남의 최상위 보통 메시지 앞에 둔다. 읽음이 올라도 구분선은 떠날 때까지 그대로다.
- **페이지 밖 구분선**: `entryReadSeq` 가 불러온 가장 오래된 seq 보다 앞이면 타임라인 위에 「안 읽은 메시지가 더 있어요 · 처음 안 읽은 곳으로」를 띄우고, 누르면 결과로 가기와 같은 길(`around = entryReadSeq + 1`)로 그 자리 창을 받는다. 그 창에서는 「최신 메시지로」가 이미 있다.
- **PWA 오프라인 사본**: 읽음 상태는 IndexedDB 사본에 넣지 않는다. 사본으로 띄운 동안은 `ready = false` 다.

## 7. 권한

`GET /api/v1/me/unread`·wire `channel.read` 는 owner·admin·member 모두 허용, 자기 행만 읽고 쓴다(사용자 id 는 세션에서만 온다 — 페이로드에 사용자 id 가 없다). `channel.activity` 는 workspace 룸이라 모두 받는다 — 채널은 지금 워크스페이스 전원이 보므로 새로 드러나는 것이 없다(비공개 채널이 생기면 다시 본다 — 11장). 팀 스펙 「역할과 권한」 표에 두 줄을 더하고 `apps/server/test/roles.matrix.test.ts` 에 넣는다.

## 8. 오류 처리

| 상황 | 동작 |
| --- | --- |
| `channel.read` 의 `seq` 가 `last_seq` 보다 큼 | `last_seq` 로 깎아 저장한다 |
| 채널 없음·다른 워크스페이스 | `NOT_FOUND` |
| 페이로드 형식 틀림 | `VALIDATION` |
| 레이트 초과 | `RATE_LIMITED`. 웹은 버리고 다음 조건 성립 때 다시 보낸다 — 서버 값은 커지기만 하므로 늦게 와도 안전하다 |
| `/me/unread` 실패 | `ready = false` 로 굵게·배지를 끄고, 다음 재연결 때 다시 받는다 |
| 끊긴 사이 놓친 `channel.activity` | 재연결 때 `/me/unread` 로 통째로 갈아 끼우므로 오차가 쌓이지 않는다 |
| 멤버 비활성화·다시 활성화 | 행을 건드리지 않는다(3.1) |
| 채널 보관 | 스냅숏에서 빠진다(사이드바에도 없다). 보관 해제하면 읽음 위치 그대로 다시 실린다. 보관한 채널을 열어 읽는 것은 막지 않으므로 `channel.read` 도 받는다 |

## 9. 테스트·검증

- **shared**: `ChannelUnread`·`UnreadSnapshot`·wire 페이로드 파싱.
- **서버 단위(`modules/reads`)**: `markRead` 가 커지기만 함·`last_seq` 로 깎기·없는 채널 · `unreadFor` 가 시스템 메시지 제외·스레드 답글은 굵게에서 빼고 멘션은 셈·내 메시지 제외·행 없음은 0·멘션 99 자름 · 마이그레이션 시드(membership 있는 사용자(비활성 포함) × 채널이 `last_seq`, membership 없는 사용자 없음) · 보관한 채널은 결과에 없음.
- **서버 통합**: 두 사용자·소켓 셋(사용자 A 두 기기) — B 가 쓰면 A 의 두 소켓이 `channel.activity` 를 받음 · A 가 `channel.read` 를 보내면 A 의 다른 소켓이 `channel.read` 를 받음 · 최상위를 보내면 작성자 읽음이 오르고 답글은 안 오름 · 비활성화해도 행이 남고 다시 활성화하면 현황이 그대로 · 보관한 채널은 스냅숏에 없음.
- **역할 매트릭스**: 두 경로 × 세 역할 허용, membership 없는 세션 401.
- **웹 단위**: 스토어(스냅숏 교체·activity 더하기·내 글 무시·서버 `channel.read` 반영·`ready = false` 면 안 그림) · 읽음 전송(끝이 보이고 탭이 보일 때만, 디바운스, 스크롤이 위거나 탭이 가려지면 안 보냄) · 구분선 위치(첫 남의 최상위 앞, 떠날 때까지 유지) · 페이지 밖 배너와 `around` 가기 · 사이드바 굵게·「99+」.
- **브라우저(dev:fake, 모델 런 0회)**: owner 창과 member(mia) 창 — mia 가 쓰면 owner 사이드바가 굵어짐 → owner 가 열고 끝을 보면 지워짐 → owner 의 둘째 탭도 지워짐 · mia 가 owner 를 멘션하면 배지 1 · 스레드 답글은 굵게 안 함·답글 속 멘션은 배지 · 200개 넘게 쌓인 채널에서 배너 → 처음 안 읽은 곳 · 390px 사이드바 시트.

## 10. 완료 기준

- 9장의 자동 테스트가 모두 통과하고, 실행 개수를 보고에 적는다.
- dev:fake 브라우저 항목이 모두 통과한다(결함은 고치고 다시 본다).
- `docs/guides/user-guide.md` 에 읽지 않음 절(굵게·배지·구분선·스레드 멘션이 채널을 보면 읽음이 되는 것), `docs/project-structure.md` 에 `modules/reads/`·`features/reads/` 가 있다.
- 팀 스펙 「역할과 권한」 표와 매트릭스 테스트가 두 경로를 싣는다.

## 11. 열린 문제 (범위 밖 기록)

- **놓친 것 요약** — 브레인스토밍에서 나온 형태: 구분선의 「요약」 버튼 → 누를 때 채널 에이전트를 고름 → 시스템 루트 메시지(`SystemKind "summary"`, `systemMeta` 에 범위)를 만들고 그 **스레드 하위 세션**에서 런(새 `triggerKind`, RunGate 를 미리 봄) → 인바운드 본문은 범위를 DB 에서 다시 읽어 만들고(최상위만, 상한 200개·40,000자) 보낸 사람은 요청자 → `decide.ts` 의 스레드 응답자를 그 루트의 에이전트로. 플러그인·러너는 바뀌지 않는다. 사용자가 이번 범위에서 뺐다.
- **활동 인박스**(멘션·참여한 스레드의 새 답글·승인 요청 모아 보기)와 **스레드별 읽음 위치**.
- **「안 읽음으로 표시」** — 결정 7 을 깨므로 따로 설계한다.
- **앱 아이콘 배지**(Badging API `navigator.setAppBadge`).
- **비공개 채널** — 생기면 `channel.activity` 를 workspace 룸이 아니라 채널 멤버의 user 룸으로 보내야 한다.

## 12. 구현과 맞춘 것

구현(계획 `docs/superpowers/plans/2026-10-05-unread.md` 태스크 1~4)·리뷰·수정·브라우저 검증(태스크 5)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다.
근거는 실행 폴더 `.superpowers/sdd/2026-10-06-unread/`(git 제외)의 보고서·리뷰(`t1`~`t5` — 줄 끝 괄호가 출처)다. 본문(0~11장)은 설계를 확정한 때의 기록이라 고치지 않았다 — **본문과 이 장이 다르면 이 장이 구현이다.**
화면 쓰는 법은 `docs/guides/user-guide.md` 「읽지 않음」 절, 레이트리밋 표는 `docs/guides/deploy.md` 「운영 화면」 절, 파일 자리는 `docs/project-structure.md`(서버 `modules/reads/`·웹 `features/reads/`)다.

**계획 판정 PU1~PU7**

- **PU1 — `ChannelUnread` 에 `latestSeq`(그 채널의 `channels.last_seq`)가 있다.** 「계약」 장 REST 절의 스키마에 이 필드를 더한다. 스냅숏을 받으면 웹은 항목의 `seenSeq` 를 `latestSeq` 로 두고, 스냅숏 요청이 나가 있는 동안 버퍼에 모은 `channel.activity` 가운데 `seq <= latestSeq` 인 것을 버린다 — 스냅숏에 이미 든 메시지를 두 번 세지 않는다(계획, t3).
- **PU2 — 서버 → 클라이언트 `channel.read` 는 버스를 거친다.** `BusEvents["channel.read"]` 는 wire 페이로드에 `userId` 를 더한 꼴이고, `realtime/events.ts` 가 `userRoom(userId)` 로 `{ channelId, lastReadSeq }` 만 낸다. 모듈은 Socket.IO 를 만지지 않는다(계획, t2).
- **PU3 — `channel.activity` 는 `realtime/events.ts` 의 `message.created` 처리기 옆에서 낸다.** 조건은 `kind = "normal"` 이고 `authorType` 이 `user`·`agent`(허용 목록 — 새 작성자 종류는 넣을 때까지 막힌다)이며 `authorId` 가 있을 때다. `silent` 메시지(연결을 닫은 런·보관한 에이전트·채널에 늦게 온 정본)도 낸다 — 저장된 메시지라 안 읽은 것이다. 「서버」 장의 `service.ts` 는 만들지 않았다 — activity 는 `events.ts`, 작성자 읽음은 `socket.ts`(PU4), 저장소와 REST 는 `modules/reads/store.ts`·`routes.ts` 다(계획, t2, t2 리뷰 F1).
- **PU4 — 작성자 읽음은 `realtime/socket.ts` 의 `message.send` 처리기가 올린다** — 저장에 성공했고(`created`, 같은 `clientMsgId` 재전송이 아님) 최상위 메시지일 때 ack 뒤에 `markRead` 와 버스 `channel.read` 를 낸다. 실패는 warn 만 남기고 라우팅을 막지 않는다. 같은 사용자의 다른 소켓은 자기 글의 activity 를 read 보다 먼저 받으므로 마지막 상태가 「읽음」이다(계획, t2, t2 리뷰).
- **PU5 — 보관·비활성화.** `unreadFor` 는 보관하지 않은 채널만 돌려준다. 보관한 채널의 `channel.read` 는 받는다(`assertChannelWritable` 을 쓰지 않는다). 비활성화는 읽음 행을 건드리지 않는다 — 다시 활성화한 뒤 `/me/unread` 가 비활성화 전과 같다(`apps/server/test/members.deactivate.test.ts`)(계획, t1, t2).
- **PU6 — 「끝이 보임」은 `stuck && !hasNewer && !jump.pending` 이고, 좁은 화면 패널 시트가 덮고 있으면 끝이 보이지 않는 것으로 본다.** 계획은 `MessageList.tsx` 의 `stuck` 하나였다.
  - `stuck` 의 처음 값(true)은 스크롤 전 값이라, 캐시에 남은 떨어진 창을 다시 열거나 결과로 가기 목표를 안고 열면 끝을 보지 않고도 읽음이 나갔다. 떨어진 창의 `lastSeq` 는 창이 아니라 채널의 끝이라 받지 않은 메시지까지 읽음이 된다(t3 판단 5, t3 리뷰).
  - 좁은 화면에서 오른쪽 패널(스레드·활동·설정)이 시트로 타임라인을 덮고 있으면(`ChannelPage` 의 `covered = useIsNarrow() && tab !== undefined`) 채널 읽음을 보내지 않고 activity 도 「끝 보임」으로 보지 않는다 — 스레드 멘션 푸시(`/c/<id>/t/<rootId>`)로 연 스레드가 채널 전체를 읽음으로 만들지 않게. 시트를 닫으면 끝에 있을 때 그때 보낸다. 넓은 화면의 옆 패널은 타임라인이 보이므로 그대로다(t3 리뷰 I1, t3 수정 보고).
  - 좁은 화면 **사이드바** 시트(`AppShell` 의 시트)는 덮어도 막지 않는다 — 창이 짧고 곧 채널을 옮기는 자리라 조율자가 이월로 정했다(`docs/plan.md` 「로드맵」 장 「이월」 「읽지 않음」 묶음).
- **PU7 — 보내는 seq 는 채널 타임라인 캐시의 `lastSeq` 다** — 스레드 답글 seq 도 들어간다(채널을 보면 그 seq 까지의 스레드 멘션도 읽음이다 — 결정 6)(계획, t3).

**서버 (태스크 1·2)**

- `markRead`·`unreadFor` 의 첫 인자는 `Db` 가 아니라 `DbOrTx` 다 — 저장소의 다른 모듈과 같은 관례이고 `Db` 도 그대로 넘어간다(t1 판단 1).
- 마이그레이션은 `0018_channel_reads`(생성기 `--name channel_reads`)다. 생성 SQL 은 `CREATE TABLE channel_reads` 하나이고, 끝에 손으로 붙인 시드(머리 주석 셋 — 왜 손으로 붙였나·비활성 포함·뒤에 생긴 것은 0)는 그 워크스페이스의 보관한 채널까지 채운다 — 보관 해제하면 읽음 위치가 그대로 돌아온다. 시드를 붙인 뒤 다시 generate 하면 「No schema changes」다(t1 판단 2·3, t1 리뷰 「마이그레이션」).
- `unreadFor` 결과의 순서는 정하지 않는다 — 웹은 `channelId` 로 찾는다(t1 판단 4).
- `unreadFor` 의 굵게 하위 질의는 `thread_root_id IS NULL` 덕에 `messages_channel_thread_seq (channel_id, thread_root_id, seq)`, 배지 하위 질의는 `messages_channel_seq (channel_id, seq)` 를 범위로 탄다(「서버」 장은 둘 다 `messages_channel_seq` 라 했다). 다시 재는 법은 그 함수 머리 주석이다(t1 리뷰 F2, t1 수정 보고).
- wire `channel.read` 는 `typing`·`presence.update` 와 소켓마다 같은 `chatter` 버킷을 쓰지만 넘으면 조용히 버리지 않고 ack `RATE_LIMITED` 로 답한다. 운영 정본 `docs/guides/deploy.md` 「운영 화면」 레이트리밋 표에 그 줄이 있다(t2 리뷰 F4). 타이핑은 3초 스로틀(분당 최대 20)이고 읽음은 채널당 1초 묶음이라 사람 손으로는 버킷(분당 120·버스트 30)에 닿지 않는다 — 브라우저에서 22초 동안 계속 치면서 0.5초마다 새 글을 받아도 타이핑 7·읽음 19, `RATE_LIMITED` 0이었다(t2 리뷰 N3, t5 부가 확인 N3).
- 역할 매트릭스(`apps/server/test/roles.matrix.test.ts`)는 `GET /api/v1/me/unread` × 세 역할·membership 없는 세션 401·비활성 401 을 싣는다. wire `channel.read` 는 통합 테스트가 member 소켓으로만 보낸다 — 처리기에 역할 분기가 없어 「테스트·검증」 장의 「두 경로 × 세 역할」 가운데 wire 쪽 owner·admin 두 칸은 비어 있다(t2 리뷰 N2). 팀 스펙 「역할과 권한」 표에 두 줄이 있다(t2).

**웹 — 현황 스토어·사이드바·읽음 전송 (태스크 3)**

- **항목을 새로 만드는 것은 사이드바 목록(`qk.channels`, 보관 아님)에 있는 채널만이다** — `channel.activity` 와 서버 `channel.read` 모두. 「웹」 장의 「스토어에 그 채널 항목이 없어도 `lastReadSeq 0` 으로 만든다」(계획 Review Focus 4)를 그대로 하면 보관한 채널에 0 항목이 생기고, 보관 해제 뒤 그 값이 `entryReadSeq` 로 쓰여 구분선이 채널 맨 앞에 그어진다. 보관·보관 해제의 `channel.updated` 가 보관 상태와 현황을 어긋나게 하면(보관했는데 항목이 있음·보관하지 않았는데 항목이 없음·요청이 나가 있음 — `needsResync`) 스냅숏을 다시 받는다. 캐시 전후가 아니라 현황과 견주는 것은 이 탭의 보관 응답이 wire 보다 먼저 캐시를 옮기는 경우를 놓치지 않으려는 것이다(t2 리뷰 「태스크 3 에 넘길 것」, t3 판단 1·「짚어 둘 것」).
- 스냅숏 요청이 나가 있는 동안 버퍼에 모으는 것은 activity 만이 아니라 **서버 `channel.read` 도**다(받은 때의 문맥과 함께) — 스냅숏이 그 읽음보다 앞선 것이면 굵게가 되살아나기 때문이다. `seenSeq` 는 늘 `lastReadSeq` 이상이다(서버 read 가 올린다) — 읽은 범위의 activity 가 늦게 와도 다시 세지 않는다(t3 판단 1·2).
- **서버 `channel.read` 는 굵게·배지를 통째로 지운다** — 그 위치보다 뒤의 activity 가 이미 와 있어도 그렇다(「웹」 장 그대로). 다른 기기가 N 까지 읽은 사이 N+1 이 왔으면 이 탭은 N+1 을 놓치고, 다음 스냅숏(재연결)에서 바로잡힌다 — 결정 9 쪽 오차다(t3 「알고 남긴 것」).
- 스냅숏은 연결마다 받고, 끊기면 끄며 나가 있던 응답을 버린다. `/me/unread` 가 401 이면 앱의 401 처리로 간다(Query 밖 REST 라 전역 처리를 타지 않는다), 그 밖의 실패는 토스트 없이 끈다(t3 판단 9).
- **읽음 전송은 채널마다 첫 요청부터 1초 동안 모아 가장 큰 seq 하나로 보낸다** — 「무엇이 「안 읽음」인가」 장·「웹」 장의 「1초 디바운스」를 대신한다. 요청이 이어져도 보내기가 밀리지 않는다(1초보다 촘촘히 글이 오는 채널에서 영영 안 나가는 것을 막는다). 서버가 저장했다고 답한 위치(ack 의 `lastReadSeq` 포함) 이하는 보내지 않고, 끊겨 있으면 보내지 않으며(조건에 「연결됨」), 다시 붙으면 다시 요청한다. 실패(레이트 초과 포함)는 버리고 스스로 다시 보내지 않는다 — 다음 조건 성립(끝으로 돌아옴·탭이 보이게 됨·`lastSeq` 증가·다시 붙음)이 다시 보낸다(t3 판단 3·4, t3 리뷰 「전송기」).
- 전송 훅(`useReadAtEnd`)은 `MessageList` 안에서 부르고 스레드 패널은 끈다. 전송기는 소켓마다 `WireProvider` 가 만들어 `ReadSenderContext` 로 내린다(계획의 `ChannelPage.tsx` 변경은 필요 없었다)(t3 판단 6).
- 사이드바 굵게는 이름 span 의 `font-semibold` 와 숨긴 글 「(안 읽음)」이다. 배지는 보이는 수를 `aria-hidden` 으로 두고 링크 이름에 숨긴 글 「(멘션 N개)」·「(멘션 99개 이상)」을 싣는다 — 일반 span 의 `aria-label` 은 ARIA 가 이름으로 받지 않는다(운영 배지와 같은 꼴). 상한 99 는 `features/reads/useUnread.ts` 의 `MENTIONS_MAX` 한곳이다(t3 판단 7, t3 리뷰 m3).

**웹 — 「새 메시지」 구분선·페이지 밖 배너 (태스크 4)**

- **`entryReadSeq` 는 현황이 없으면 0 이 아니라 `undefined`(구분선 없음)다** — 스냅숏 전·실패, 그 채널 항목이 없음(보관한 채널·보관 해제 직후 다시 받기 전·스냅숏에 없는 채널)이 그렇다. 0 이면 구분선이 채널 맨 앞에 그어진다. 계획의 「항목이 없으면 0」을 대신한다(`features/reads/entryRead.ts` `captureEntryRead`)(t3 「지침이 틀렸거나 빈 곳」 4, t4 판단 1).
- 잡는 자리는 `enter`(구독)가 아니라 `ChannelPage` 다 — 채널 id 가 바뀔 때마다 렌더 중에 한 번 잡는다. 채널을 옮겨도 이 페이지는 다시 마운트되지 않기 때문이다(t4 판단 2, t4 리뷰 T1).
- 구분선은 `seq > entryReadSeq`·`kind = "normal"`·최상위·사람 글이면 내 것이 아닌 첫 메시지 앞에 한 번 선다(같은 자리의 날짜 구분선 뒤, 그 메시지는 머리줄을 다시 그린다). 에이전트 글은 id 가 같아도 남의 글로 센다. 모양은 `role="separator"`·이름 「새 메시지」, 색은 날짜 구분선과 가르는 `text-primary` 다(t4, t4 리뷰).
- **구분선은 자리가 확정됐을 때만 둔다** — 불러온 목록이 일부(`hasOlder`)이고 그 맨 앞이 이미 `entryReadSeq + 1` 보다 뒤면 구분선을 두지 않는다(배너가 맡는다). 맨 위 구분선은 과거 페이지를 붙일 때 스크롤 기준 행이 되어 위치가 튀고, 위에 아직 안 불러온 안 읽은 글이 있어 진짜 처음도 아니다. 이 조건은 배너 조건의 정확한 반대라 둘이 함께 뜨지 않는다. 과거 페이지가 R 까지 닿으면 구분선이 목록 가운데에 생긴다(앞에 행이 있어 기준 행이 되지 않는다)(t4 리뷰 I2, t4 수정 보고).
  - 맨 앞이 첫 안 읽은 루트여도 그 앞 seq 가 답글뿐이면 같은 판정이 된다(seq 만으로는 사이에 루트가 있는지 모른다) — 한 쪽 경계에 맞을 때만이라 드물고, 배너가 그 루트로 데려간다(t4 재리뷰 r2).
- **배너 목표는 `entryReadSeq` 뒤 첫 루트다** — 「페이지 밖 구분선」 문단의 「`around = entryReadSeq + 1`」을 대신한다. `restFetchPage(channelId, { afterSeq: entryReadSeq, limit: 1 })` 로 첫 루트를 찾아 그 seq 를 `around` 로 받는다(`features/messages/jump.ts` `jumpToFirstRootAfter`). 채널 타임라인의 `around` 는 답글 seq 를 그 루트로 바꾸므로, `entryReadSeq + 1` 이 옛 스레드의 늦은 답글이면(스레드 답글은 채널 읽음을 올리지 않아 흔하다) 읽은 창으로 간다. 뒤에 루트가 없으면 최신 페이지로 끝에 간다(t4 리뷰 I1, t4 수정 보고).
- 배너를 누르면 받은 창에서 구분선 행으로 **한 번** 이동하고, 받은 창에 구분선이 없으면 이동을 거둔다 — 남은 이동이 뒤에 이어 받은 쪽에서 화면을 끌고 가지 않게. 실패면 기존 페이지 오류 보고(`reportPageError`)이고 배너는 남아 다시 누를 수 있다. 한 번 누른 배너는 「최신 메시지로」로 돌아와 조건이 다시 서도 그 채널을 떠날 때까지 뜨지 않는다(t4 판단 3, t4 리뷰 T2·T4).
- 배너는 구독 응답 뒤(타임라인 `lastSeq > 0`)에만 띄운다 — 오프라인 사본에서 복원한 채널은 뒤이은 `fresh` 응답이 받은 창을 최신 쪽으로 덮기 때문이다(`useJump` 의 `ready` 와 같은 규칙). 「이전 메시지를 불러오는 중」 알림이 떠 있으면 그 아래에 놓는다(t4 리뷰 n1, t4 판단 4).

**웹 — 안 읽은 채널의 처음 위치 (사용자 결정)**

- 안 읽은 글이 있는 채널은 끝이 아니라 첫 안 읽은 곳에서 연다(Slack 방식) — 「새 메시지」 행이 받은 행 안에 있으면 그 행이 뷰포트 위에서 128px(앞 메시지 한두 줄) 아래에 서게 처음 한 번 붙이고, 그때는 끝에 붙지 않았으므로 읽음을 보내지 않으며(끝까지 내리거나 「새 메시지 N개」를 누르면 간다) 행이 받은 행 밖이면(배너)·구분선이 없으면 끝에서 연다. 읽은 자리가 0 인 채널(새 멤버가 처음 여는 채널 등)도 끝에서 연다(사용자 결정) — 첫 구독은 루트 200개(서버 `MESSAGE_PAGE_MAX`)까지 한 쪽이라 그 안에 드는 채널은 구분선이 맨 위라 채널의 첫 글에서 열리기 때문이다. 사이드바 굵게·배지는 그대로다. 캐시가 낡은 채 다시 연 채널은 — 구분선 행이 캐시에 이미 있어도 — 이어 받기가 서버가 아는 최신 seq(스냅숏 `seenSeq`)에 닿을 때까지 읽음을 붙잡고 끝 보임으로 치지 않으며 받는 글을 따라가지 않는다(`followOnAppend` 끔). 구분선 행이 생기면 그리로 내려앉고, 다 받으면 다시 겨눠 그때의 끝 보임으로 판정한다. 그 사이 손을 대면 겨누지 않고 다 받은 뒤 그 자리에서 판정하고, 5초가 지나면 가진 것으로 판정한다. 이 기다림은 마운트 때 캐시가 있었을 때만 건다 — 첫 구독의 `lastSeq` 는 루트만의 최대라 채널의 끝이 답글이면 최신에 닿지 못한다(open 리뷰 F1·작은 것 1). 결과로 가기·배너로 가기에는 끼어들지 않는다(`MessageList.tsx` 첫 붙임).

**검증 (태스크 5 — `dev:fake`, 모델 런 0회)**

- 독립 Chromium(Playwright) 하나에 owner·mia 두 컨텍스트, owner 는 둘째 탭까지(1280·390px). 둘째 클라이언트가 다른 계정이라 BrowserOS neo 가 아니라 독립 브라우저로 했다. headless 는 같은 컨텍스트의 두 탭이 모두 `visible` 이라 둘째 탭은 `document.visibilityState`·`hidden` 을 `hidden` 으로 덮고 `visibilitychange` 를 내 가렸다. 200개 넘는 채널은 mia 의 Socket.IO 소켓 18개로 채웠다. 항목 11개 모두 통과, 결함 0(t5 보고).
- 관찰(결함 아님, 이 설계대로):
  - 이 탭에서 연 뒤 5분(Query 기본 `gcTime`) 안에 다시 들어간 채널은 타임라인 캐시가 있어, 다시 들어가면 재구독(`lastSeq` 이후 ≤200 + 이어 받기)이 안 읽은 220개를 모두 받는다 — 불러온 목록 안이라 배너가 없고, 화면은 끝에서 열려 곧바로 읽음이 오르며 구분선은 화면 밖 위에 있었다(t5 관찰 1 — 위 「안 읽은 채널의 처음 위치」 줄이 바꿨다). 캐시가 빠진 채널과, 이어 받기가 구독 응답 + REST 4쪽(200개씩)을 넘는 채널은 처음 여는 것과 같아 배너가 뜬다.
  - 처음 여는 채널은 안 읽은 것이 많아도 끝에서 열려 곧바로 그 끝까지 읽음이 올랐다 — 배너는 남아 처음 안 읽은 곳으로 데려간다(t5 관찰 3 — 받은 행 안이면 위 「안 읽은 채널의 처음 위치」 줄이 바꿨다, 배너가 뜨는 채널은 지금도 끝에서 연다).
  - 결과로 가기로 들어간 채널에서 「최신 메시지로」를 누르면, 최신 창이 `entryReadSeq` 를 담지 못할 때 배너가 뜬다(누른 적이 없으므로)(t5 관찰 2).
  - 좁은 화면 스레드 시트가 덮은 동안 온 최상위 글은 스토어·다른 탭에서 굵게다. 그 페이지 자신의 사이드바에서는 그 채널이 「보고 있는 채널」이라 굵게 그리지 않는다(t5 항목 10).
  - 새로고침으로 곧장 안 읽은 채널에 들어갔을 때 이 머신에서는 스냅숏이 채널 페이지보다 먼저 와 구분선이 섰다 — 「스냅숏 전 진입은 구분선 없음」은 스냅숏이 늦을 때만 보인다(t4 리뷰 n4, t5 「부가 확인」 콜드 스타트).
