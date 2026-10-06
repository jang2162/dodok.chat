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
