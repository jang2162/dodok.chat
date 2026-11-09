# 파일함 설계 (기본 메신저 하위 프로젝트 D)

**상태**: 확정(2026-11-09, 사용자 승인). C 가 main 에 들어간 꼴(`70086ab7`)과 맞췄다 — 맞춘 자리는 13장.
**범위**: 채널·에이전트 DM·사람 DM(그룹 포함)마다 오간 사진·파일을 모아 보는 「파일」 패널 탭과, 내가 볼 수 있는 모든 대화의 것을 모은 「파일」 전체 화면. 그리고 사람이 이미지가 아닌 파일을 올리는 것.

**앞선 근거**:
- 로드맵 `docs/superpowers/specs/2026-11-02-messenger-basics-roadmap.md` — 순서 B → C → A → **D**. D 는 「채널·DM 마다 사진·파일 모아 보기·검색·필터」.
- 사람 간 DM `docs/superpowers/specs/2026-11-03-human-dm-design.md`(main 에 병합 — 지금 코드는 그 13장 「구현과 맞춘 것」) — **4장 「접근 규칙」이 「누가 어떤 대화를 읽나」의 정본**이다. 4.3 「D 가 정할 것의 바닥」: 목록은 그 사람이 읽을 수 있는 채널의 첨부만이고 SQL 단계에서 `readableChannelSql` 로 거른다. 첨부 하나의 GET 은 지금처럼 그 메시지의 채널로 판정한다.
- 첨부 `docs/superpowers/specs/2026-09-23-attachments-design.md` — 저장(4.1 — `attachments` 표 + sha256 블롭), 정리(4.7), 웹(6장). **이 문서가 그 스펙의 결정 1(「사람 → 에이전트는 이미지만」)을 바꾼다**(아래 결정 2).
- 결정 과정: 2026-11-09 사람과의 대화(코디네이터를 거쳐 한 번에 묻고 답을 받았다 — 사람의 답 「나머지는 추천대로」, 설계 승인 「D 파일함 설계 구현계획 작성해줘」). 아래 「사람이 정함」은 사람의 결정, 「내 판단」은 설계자가 정해 사람에게 보였고 반박이 없었던 것 또는 이 문서에서 처음 정한 것이다.

---

## 0. 왜

지금은 대화에서 오간 사진·파일을 다시 찾으려면 메시지를 거슬러 올라가거나 ⌘K 에 이름을 기억해 넣어야 한다. 다른 메신저(Slack 「파일」, 카카오톡 「사진·동영상 / 파일」 서랍)처럼 **대화마다, 그리고 한곳에 모아** 둘러보고 좁혀 찾는 자리가 필요하다. 그리고 사람은 지금 이미지만 올릴 수 있어서, 처음 요청의 「파일관리」 — 사람끼리 문서를 주고받는 것 — 가 아예 안 된다. 사람 DM(C)이 들어오면 이 빈자리가 더 커진다.

**성공**: 누구나 대화 머리에서 「파일」을 열어 그 대화의 사진·파일을 최신순으로 보고, 종류·이름·올린 사람으로 좁히고, 누르면 크게 보기·내려받기·원래 메시지로 간다. 사이드바 「파일」에서 모든 대화의 것을 같은 방식으로 본다. 사람이 PDF·zip 같은 파일을 작성기로 보낸다.

**실패(동작해도 실패인 것)**: 읽을 수 없는 대화(남의 에이전트 DM, 참여하지 않은 사람 DM)의 첨부가 목록·개수·커서·거름 후보 어디로든 보이는 것. 사람이 올린 일반 파일이 브라우저에서 실행되거나(HTML·SVG) 서버 경로를 드러내는 것.

## 1. 결정

| # | 결정 | 누가 | 까닭 |
| --- | --- | --- | --- |
| 1 | **어디서 보나 — 둘 다.** 대화마다 오른쪽 패널의 「파일」 탭(채널·에이전트 DM·사람 DM), 그리고 사이드바 「파일」 → 전체 화면(내가 볼 수 있는 모든 대화, 대화 거름 포함) | 사람이 정함(추천대로) | 서버 API 는 하나(채널을 주면 그 대화, 안 주면 전부)라 전체 화면은 웹 한 화면 몫이다. 「그 PDF 어느 채널이었지」는 전체 화면이 아니면 안 풀린다 |
| 2 | **사람도 이미지가 아닌 파일을 올린다** — 20 MiB, 형식 제한 없음. 에이전트에게는 지금처럼 이미지만 내용으로 가고 일반 파일은 이름 한 줄로만 알린다(내용 전달은 이월). **첨부 스펙 결정 1 을 바꾼다** | 사람이 정함(추천대로) | 처음 요청의 「파일관리」는 사람끼리 파일을 주고받는 것이 바탕이다. 그게 없으면 사람 DM 의 파일함은 늘 「파일」 칸이 빈다 |
| 3 | **링크 모아 보기는 뺀다** — 이월(J 링크 미리보기와 함께) | 사람이 정함(추천대로) | 본문에서 URL 을 뽑아 따로 색인하는 다른 일이고, 미리보기 없는 링크 목록은 쓸모가 작다 |
| 4 | **짓는 법은 전용 목록 API**(2장 접근 A) | 사람이 정함(추천대로) | 2장 |
| 5 | **파일함에는 삭제 단추가 없다.** 지우기는 메시지 삭제(하위 프로젝트 A)를 따른다 — A 는 지금 보류다(9장 「A 가 들어올 때」) | 내 판단(반박 없음) | 첨부는 메시지의 일부다. 파일만 따로 지우면 메시지 본문의 카드(`artifact://`)·에이전트가 이미 받은 사실과 어긋난다 |
| 6 | **보기·내려받기 권한은 그 대화를 읽을 수 있는 사람 모두**(지금 첨부 GET 그대로) — 읽기 전용 DM·보관한 채널도 본다 | 내 판단(반박 없음) | C 4.1 「읽는다가 덮는 것」에 첨부가 이미 들어 있다 |
| 7 | **썸네일을 만들지 않는다** — 격자는 원본을 화면에 든 것만 불러온다(`loading="lazy"`). 썸네일 생성·보관 기간·용량 할당은 이월 | 내 판단(반박 없음) | 썸네일은 네이티브 이미지 의존(sharp 류)을 Docker 이미지에 들이는 일이다. 사람 이미지는 5 MB 상한이라 지금 규모에서는 lazy 로 견딘다 |

## 2. 접근 — 사람이 고른 것

| 접근 | 무엇 | 얻는 것 | 잃는 것 |
| --- | --- | --- | --- |
| **A. 전용 목록 API** (고름) | `attachments ⋈ messages ⋈ channels` 를 바로 조회하는 `GET /api/v1/attachments`(채널 선택·종류·이름·올린 사람·커서) | 검색어 없는 둘러보기·거름·커서가 자연스럽다. 새 표가 없다 | 조회 하나와 색인 하나가 는다 |
| B. ⌘K 검색에 「파일만」 거름 | 검색 결과를 파일 꼴로 그린다 | 검색 코드를 다시 쓴다 | 검색어(2글자 이상) 없이는 둘러보기가 안 되고, 결과가 메시지 단위다 |
| C. 파일함 전용 색인 표 | 첨부·작성자·대화를 펼친 표를 따로 둔다 | 조회가 단순하다 | SQLite 한 프로세스 규모에 이득이 없고, 메시지·첨부와 맞추는 동기화 비용만 든다 |

## 3. 무엇을 싣나

- **메시지에 묶인 첨부 전부**(`attachments.message_id IS NOT NULL`) — 사람이 올린 것, 에이전트가 올린 것, 카드(components `media`·`file`)가 가리킨 것(같은 메시지의 첨부다), 스레드 답글의 것, 채널의 모든 세션의 것(내 판단).
- **싣지 않는 것**: 묶이지 않은 업로드(보내기 전의 칩 — 24시간 뒤 정리된다), 아바타(`<DATA_DIR>/avatars` — 첨부와 다른 저장소), 메시지 본문의 링크(결정 3), components `media` 의 바깥 `https://` 이미지(첨부 행이 없다).
- **메시지 종류**는 거르지 않는다 — 첨부는 사람·에이전트·자동화의 normal 글에만 붙는다. 시스템 메시지에 첨부가 붙는 길은 없다(빌더가 확인하고, 있으면 `m.kind = 'normal'` 로 거른다).
- **보관한 채널**의 첨부도 싣는다 — 줄에 「보관됨」(검색 결과와 같은 꼴, 내 판단). 보관한 에이전트의 DM 도 같다(그 DM 을 읽을 수 있는 동안).
- **비활성 멤버가 올린 것**도 남는다 — 올린 사람 이름은 지금 메시지 작성자 표시 규칙(`useAuthors`)대로.

## 4. 서버

### 4.1 목록 API

```
GET /api/v1/attachments?channelId&kind&q&authorType&authorId&cursor&limit
```

- 세션 쿠키(사람). 바깥 MCP·제어 도구에는 이번에 열지 않는다(내 판단 — 9장 범위).
- **채널 거름 `channelId`(선택)** — 주면 그 대화 하나. 먼저 `loadReadableChannel(db, channelId, workspaceId, userId)`(`modules/channels/service.ts` — 못 읽는·없는·모르는 kind·다른 워크스페이스 채널은 **404 `NOT_FOUND`**, C 4.1 「못 읽는 사람에게는 없음과 같다」 — 빈 목록이 아니다)를 부른다. 보관한 채널도 읽을 수 있으면 지난다. 안 주면 내가 읽을 수 있는 모든 대화.
- **거르는 자리는 SQL 단계 `readableChannelSql(userId)`**(C 4.3 바닥, `auth/channel-access.ts`) — 결과를 뽑은 뒤 거르지 않는다. 커서·페이지가 남의 DM 을 세지 않는다. 이 식은 `channels` 표의 열을 그대로 가리키므로(별칭 없이) 검색의 `readableChannels`(`search/service.ts`)와 같은 꼴 — `a.channel_id IN (SELECT channels.id FROM channels WHERE channels.workspace_id = ? AND <readableChannelSql>)` — 로 붙인다(워크스페이스 거름도 같은 자리). 판정을 따로 짓지 않는다.
- **`kind`**(선택) — `image` | `file`. 없으면 둘 다. SVG 는 저장 때 이미 `file` 이다(첨부 스펙 결정 8).
- **`q`**(선택, 1~100 코드 포인트) — 첨부 이름 부분 일치. NFC 로 바꾼 뒤(`search/service.ts` 와 같은 까닭 — 저장은 NFC) `attachments.name LIKE %q% ESCAPE '\'`, `%`·`_`·`\` 는 이스케이프. ASCII 는 대소문자를 가리지 않는다(SQLite LIKE 기본). NUL 은 `VALIDATION`. 1글자부터 받는다 — 파일함은 한 대화(또는 내가 읽는 범위)의 첨부 표만 훑으므로 ⌘K 의 2글자 문턱이 필요 없다(내 판단).
- **`authorType`·`authorId`**(선택) — 그 첨부가 묶인 **메시지의 작성자**로 거른다(`messages.author_type`·`author_id`). 올린 쪽 열(`attachments.uploader_*`)은 쓰지 않는다 — 에이전트가 올린 행은 `uploader_id` 가 러너 토큰이거나 null 이라 「어느 에이전트」가 메시지에만 있다.
- **정렬은 최신순 하나** — `messages.created_at DESC, messages.id DESC, attachments.id ASC`(한 메시지 안은 첨부 순서 — `attachments_json` 순서와 같게, 꼴은 빌더 몫). 날짜 거름은 없다(내 판단).
- **페이지** — `limit` 기본 50, 최대 100. 불투명 커서(`nextCursor` 가 있으면 다음 쪽). 커서 꼴은 검색 커서처럼 zod 로 파싱해 틀리면 `VALIDATION`.
- **응답**:

```ts
FileListItem = {
  attachment: Attachment;          // 지금 계약 그대로(url = artifact://<id>)
  messageId: Id;
  channelId: Id;
  conversationId: Id;
  conversationTitle: ConversationTitle; // 줄의 「#채널 · 세션」
  seq: number;                     // 「메시지로 가기」의 ?around=<seq>
  threadRootId?: Id;               // 답글이면 — 가기가 스레드를 연다(검색 결과 가기와 같다)
  authorType: "user" | "agent" | "automation";
  authorId?: Id;
  createdAt: IsoDateTime;          // 메시지 시각
  channelArchived: boolean;
}
FileList = { items: FileListItem[]; nextCursor?: string }
```

  (내 판단 — 필드 이름은 빌더가 바꿔도 된다. `SearchHit` 와 겹치는 필드는 같은 이름을 쓴다.) 채널 이름·DM 상대는 싣지 않는다 — 웹은 이미 채널 목록·DM 목록(C 의 `GET /directs` 포함) 캐시를 들고 있다.
- **색인** — `attachments (channel_id, message_id)` 하나(내 판단 — 꼴은 빌더가 쿼리 계획을 보고 정한다). 마이그레이션 SQL·스냅숏은 생성기 출력 그대로.
- **레이트리밋** — 지금 REST 상한(사용자)을 그대로 지난다.

### 4.2 사람의 일반 파일 올리기

- `POST /api/v1/attachments?channelId` 의 사람 판정을 바꾼다:
  - 판별(`sniff`)이 `image` 면 지금 그대로 **5 MB** 상한(`userImageMaxBytes`) — 이미지는 모델에게 내용으로 가므로 상한을 올리지 않는다(내 판단). 넘으면 지금 문구.
  - 판별이 `file` 이면 **20 MiB**(`agentFileMaxBytes` 와 같은 값 — shared 에 사람 파일 상한 이름을 따로 두든 같은 상수를 쓰든 빌더 몫). 형식은 막지 않는다.
  - 라우트 `bodyLimit` 은 큰 쪽(20 MiB)으로 올리고, 이미지 5 MB 는 서비스 검사가 막는다(413 과 400 의 문구·`maxBytes` 를 지금 규칙대로 맞춘다 — 이미지가 5 MB 를 넘으면 `maxBytes` 는 5 MB).
  - 「이미지만 올릴 수 있습니다」 거절은 없어진다. 빈 파일은 지금처럼 `VALIDATION`.
- 접근·보관·DM 읽기 전용·디스크 507·업로드 상한 순서는 지금 그대로(C 가 `readableBy`·`assertDmWritable` 을 `direct` 로 넓힌다).
- **서빙은 지금 그대로 안전하다** — 블롭 응답은 이미 `content-type` = 판별 MIME(이미지가 아니면 PDF 는 `application/pdf`, 힌트가 `text/plain`·`application/json`·`text/csv`·`application/zip` 이면 그 값, 그 밖은 `application/octet-stream` — `sniff.ts`), `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, 이미지가 아니면 `content-disposition: attachment`. 사람이 올린 HTML·SVG 가 같은 출처에서 실행되지 않는 것을 시험으로 못 박는다(10장).
- **에이전트에게 가는 것은 바뀌지 않는다** — 지금도 일반 파일은 이름 한 줄이다: 플러그인 `inbound-media.ts` 의 `[첨부 파일: <이름>]`, 러너 `shared/runner/prompt.ts` 의 「첨부 파일 N개: …」, 문맥 줄 `runs/context.ts attachmentPlaceholder` 의 `[파일: <이름>]`. 사람 파일도 같은 길을 탄다 — 코드 변경 없이 시험만 더한다(사람이 올린 PDF 가 실린 deliver 에서 그 줄이 나오고 내용 받기를 부르지 않는다).
- 정리(4.7)·sha256 한 번 쓰기·NFC 이름은 그대로.

### 4.3 기존 경로와의 관계

- 첨부 하나의 GET(`/api/v1/attachments/:id`)은 그대로 — C 4.3 「첨부 하나의 GET 은 그 메시지의 채널로 판정」. 목록이 준 id 만 쓴다.
- ⌘K 검색은 그대로(첨부 이름으로 메시지를 찾는다). 파일함과 경쟁하지 않는다 — 검색은 「메시지」, 파일함은 「파일」.

## 5. 웹 — 파일 탭과 전체 화면

### 5.1 어디서 여나

- **패널 탭 「파일」** — `PanelTabs`(`app/layout/PanelTabs.tsx`)의 `PanelTab`·`TABS` 에 `files` 를 더한다. 경로는 `/c/$channelId/s/$conversationId/files` 하나다 — 에이전트 DM 도 채널 경로로 그린다(`/dm/$agentId` 는 그 DM 채널로 넘기는 리다이렉트, `app/router.tsx dmRoute`), 사람 DM 도 채널 경로(`/c/<direct id>`, 한 줄기여도 `s/<id>` 로 오면 그린다 — C 13.1 PH4)를 쓴다. 머리에 「파일」 단추(설정·활동 단추 옆 — 자리는 빌더 몫). 탭 순서는 설정 · 활동 · **파일** · 스레드 · 프로필(내 판단).
- **세 종류 모두에서 연다** — `ChannelPage.tsx` 가 종류마다 `PanelTabs` 의 `only` 와 「그 주소로 와도 패널을 그리지 않는」 거름을 따로 둔다(지금: 에이전트 DM `["activity", "profile"]`, 세션 `direct` `["activity", "thread", "profile"]`, 한 줄기 `direct` `["thread", "profile"]`, 일반 채널 전부). 셋 모두에 `files` 를 더하고, 에이전트 DM·`direct` 의 거름이 `files` 를 막지 않게 한다.
- **사이드바 「파일」** — 검색 칸 아래에 한 줄(내 판단 — 자리는 빌더 몫). 경로 `/files`. 좁은 화면(390px)은 시트를 닫고 전체 화면으로.

### 5.2 꼴

```
┌ 파일 ─────────────────────────────── × ┐   ┌ 파일 (전체 화면) ────────────────────────────────────┐
│ [전체|사진|파일]  [🔍 이름]  [올린 사람 ▾] │   │ [전체|사진|파일] [🔍 이름] [대화 ▾] [올린 사람 ▾]          │
├────────────────────────────────────────┤   ├──────────────────────────────────────────────────────┤
│ 사진 ─────────────────────────          │   │ ▣▣▣▣▣▣  (사진 격자 — 넓으면 6열)                        │
│ ▣ ▣ ▣                                   │   │ 📄 report.pdf  1.2 MB · mia · #기획 · 세션 · 11월 8일   │
│ ▣ ▣ ▣   (격자, 누르면 크게 보기)          │   │ 📦 logs.zip    3.4 MB · @dev · DM · mia, jun · 11월 7일 │
│ 파일 ─────────────────────────          │   │ …                                     [더 보기]        │
│ 📄 report.pdf   1.2 MB                  │   └──────────────────────────────────────────────────────┘
│    mia · 세션 제목 · 11월 8일   ⤓  ↗     │
│ …                          [더 보기]     │
└────────────────────────────────────────┘
```

- **「전체」** 는 사진 격자와 파일 목록을 위아래로(사진 먼저 — 내 판단). **「사진」** 은 격자만, **「파일」** 은 목록만. 「전체」에서 한 쪽(50개)이 둘로 갈려 보이는 것은 받는 순서가 최신순 하나이기 때문이다 — 「더 보기」가 두 칸을 함께 늘린다. (빌더가 「전체」를 시간순 한 줄기 섞임 목록으로 바꿔도 된다 — 사람은 「사진 칸·파일 칸」을 봤다.)
- **사진 격자** — 정사각 자르기(`object-cover`), `loading="lazy"`, 누르면 지금 `ImageViewer`(←/→ 는 지금 받은 사진들 사이, 원본 내려받기). 자기 서버 경로로 풀리지 않는 이미지는 없다(첨부 행만 싣는다).
- **파일 줄** — 지금 `FileCard` 의 아이콘·이름·크기에 더해 올린 사람·대화(패널 탭에서는 세션 제목만 — 한 줄기 `direct` 는 세션이 없으니 빼고, 전체 화면에서는 「#채널 · 세션」 또는 「DM · 이름」)·날짜, 「보관됨」. 대화 이름은 ⌘K 결과 줄과 같은 규칙(`features/search/SearchResults.tsx` 의 `nameOf` — 채널 `#이름`, 에이전트 DM `DM · <에이전트>`, `direct` `DM · <directTitle>` + 외톨이 그룹 「(그룹)」)이고, 두 화면이 같은 함수를 쓰게 꺼내 나눈다. 단추 둘: **내려받기**(`?download=1`), **메시지로 가기**.
- **메시지로 가기** — ⌘K 결과로 가기와 같은 길(`features/search/SearchDialog.tsx pick` — `requestJump(hit, { focus: true })`(`features/messages/jumpTarget.ts`) 뒤 `/c/<channelId>/s/<conversationId>`, 답글이면 `…/t/<rootId>`, 강조 2초 — 세 종류 모두 채널 경로). `FileListItem` 이 `requestJump` 가 받는 필드(`conversationId`·`messageId`·`seq`·`threadRootId`)를 그대로 가지므로 같은 함수를 부른다. 좁은 화면에서는 패널 시트를 닫고 간다. 사진은 크게 보기 안에 「메시지로 가기」 하나를 더한다(내 판단 — 지금 뷰어에 단추 하나).
- **거름 줄** — 종류 세그먼트, 이름 칸(입력 멈춘 뒤 300ms 쯤에 다시 받기 — 빌더 몫), 올린 사람 고르기(패널 탭은 그 대화의 참여자 — 일반 채널은 채널 멤버 목록, 에이전트 DM 은 나와 그 에이전트, `direct` 는 나 + `DirectSummary.users`·`agents` / 전체 화면은 워크스페이스의 사람·에이전트), 전체 화면만 대화 고르기(내가 읽는 채널·DM 목록 — 웹 캐시에서). 거름은 주소에 싣지 않는다(내 판단 — 패널 탭을 옮기면 초기화).
- **빈 상태** — 「아직 주고받은 파일이 없습니다」 / 거름 결과 없음은 「조건에 맞는 파일이 없습니다」 + 거름 지우기.
- **좁은 화면** — 패널 탭은 지금 패널처럼 전체 화면 시트, 격자는 3열.

### 5.3 데이터·실시간

- TanStack Query 무한 쿼리, 키는 `['files', {channelId?, kind, q, author}]`.
- **패널 탭이 열려 있을 때** 그 대화의 `channel.activity`(새 글)가 오면 그 키를 무효화한다. 전체 화면은 실시간을 받지 않고 화면에 들어올 때·창이 초점을 받을 때 다시 받는다(내 판단 — 모든 대화의 새 글마다 다시 받지 않게).
- 첨부 이벤트가 따로 없으므로 위 둘로 충분하다. 메시지 삭제가 생기면(A) 그 이벤트도 무효화에 더한다(9장).

## 6. 웹 — 작성기의 일반 파일

- **첨부 단추·붙여넣기·끌어다 놓기가 모든 파일을 받는다.** 파일 고르기의 `accept`(`Composer.tsx` 의 `IMAGE_ACCEPT`)를 없앤다.
- **칩** — 이미지는 지금처럼 미리보기, 이미지가 아니면 파일 아이콘 + 이름 + 크기(미리보기 object URL 을 만들지 않는다). 진행·오류·빼기는 지금 그대로.
- **웹 검사(`checkImageFile` → 파일 검사)** — 이미지 MIME 이면 5 MB, 그 밖은 20 MiB. 넘으면 칩에 이유(「5 MB 를 넘습니다」·「20 MB 를 넘습니다」 — 문구는 빌더 몫). 서버가 매직 바이트로 다시 판별하므로 웹의 MIME 은 힌트다 — 확장자가 `.png` 인데 내용이 아니면 서버가 `file` 로 받고 20 MiB 상한이 걸린다.
- **메시지당 10개**는 그대로(사진·파일 합쳐).
- 문구 갈이: 「이미지는 한 번에 10장까지」 → 「첨부는 한 번에 10개까지」, 작성기 밖에 놓기(`app/fileDrop.ts DROP_ON_COMPOSER`) 「이미지는 입력 칸에 놓아 주세요」 → 「파일은 입력 칸에 놓아 주세요」, 칩 목록 라벨 「첨부할 이미지」 → 「첨부할 파일」, 업로드 함수 이름(`uploadImage`)은 빌더 몫.
- 메시지 본문 아래 그리기(`MessageAttachments`)는 이미 이미지 격자 + 파일 카드라 바꾸지 않는다.

## 7. 오류

| 상황 | 결과 |
| --- | --- |
| `GET /attachments?channelId=` 가 읽을 수 없는·없는·다른 워크스페이스 채널 | 404 `NOT_FOUND` |
| `kind`·`q`(0자·100 초과·NUL)·`limit`·`cursor` 꼴 오류 | 400 `VALIDATION` |
| 사람이 이미지 5 MB 초과 / 파일 20 MiB 초과 | 지금 규칙(서비스 400, 본문 상한 413 — 같은 문구·`maxBytes`) |
| 첨부 하나 GET 이 못 읽는 채널의 것 | 지금 그대로 404 |

## 8. 문서

- `docs/manual/user-guide.md` — 「파일함」 절(탭·전체 화면·거름·메시지로 가기·삭제는 메시지에서), 첨부 절의 「사람은 이미지만」을 「사람도 파일(20 MB)」로.
- `docs/guides/agent-guide.md` 「파일·이미지」 — 사람이 보낸 일반 파일은 이름 한 줄로만 온다는 것.
- 첨부 스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md` 결정 1 줄에 「2026-11-09 파일함 스펙 결정 2 로 바뀜 — 사람도 일반 파일」 한 줄(그 스펙의 「구현과 맞춘 것」 장 끝에 더하는 꼴이 기존 관례면 그쪽으로 — 빌더 몫).
- `docs/guides/plan.md` 8장 — 완료 줄과 「이월」(9장 「하지 않는다」의 이월 몫).

## 9. 범위

**한다**
- `GET /api/v1/attachments` 목록(4.1)과 색인 하나.
- 사람의 일반 파일 올리기(4.2·6장).
- 웹 패널 「파일」 탭(채널·에이전트 DM·사람 DM), 사이드바 「파일」 전체 화면, 크게 보기의 「메시지로 가기」.
- 문서(8장), `dev:fake` 씨앗에 사진 몇 장과 파일 하나(새 DB — 꼴은 빌더 몫).

**하지 않는다(이월 — `docs/guides/plan.md` 8장 「이월」 「파일함」 묶음)**
- 링크 모아 보기(결정 3, J 와 함께).
- 파일함에서 지우기·메시지에서 첨부 하나만 빼기(결정 5 — A 와 함께).
- 썸네일 생성, 보관 기간·워크스페이스 용량 할당·「큰 파일 정리」 화면(결정 7).
- 에이전트에게 사람이 보낸 일반 파일의 내용 전달(결정 2 — 지금은 이름 한 줄).
- 5 MB 넘는 사람 이미지(폰 원본 사진) — 지금은 거절. 「파일로 받기」·서버 축소는 이월.
- 바깥 MCP·제어 도구의 파일 목록 도구.
- 날짜 거름·정렬 바꾸기·주소에 거름 싣기.

**A 가 들어올 때(지금 구현에는 A 를 기다리는 부분이 없다)**
- A(메시지 수정·삭제)는 사람이 보류했다. 그래서 지금 파일함 조회에는 「지운 메시지」 거름이 없고, 그 열도 만들지 않는다.
- A 가 들어오면 A 가 정한다: ① 지운 메시지의 첨부를 파일함 조회에서 빼는 조건(A 가 고르는 소프트 삭제 열이든 행 삭제든 — `GET /attachments` 의 WHERE 한 줄) ② 지운 메시지의 블롭을 언제 디스크에서 지우나(정리 4.7 이 「어느 첨부 행도 안 가리키는 블롭」을 지우므로 행을 지우면 따라온다) ③ 「메시지에서 첨부 하나만 빼기」를 넣는지 ④ 파일 탭 무효화에 삭제 이벤트를 더하기. 파일함 쪽에서 바꿀 자리는 `GET /attachments` 의 조회와 5.3 의 무효화 둘이다.
- 메시지 **수정**은 첨부를 바꾸지 않는 한 파일함과 무관하다(줄의 정보는 첨부·작성자·시각뿐이다).

**C 위에서 짓는다** — C(사람 간 DM)는 main 에 들어갔다(`70086ab7`). D 가 C 의 것을 고치지 않고 부르는 자리:
- `apps/server/src/auth/channel-access.ts` 의 `readableChannelSql`(목록)·`modules/channels/service.ts loadReadableChannel`(채널 거름 404) — 고치지 않는다.
- `apps/server/src/modules/attachments/service.ts findReadable`·`readableBy`(C 가 `canReadChannel(db, …)` 로 바꿨다) — 첨부 하나 GET 은 그대로.
- 업로드 라우트(`modules/attachments/routes.ts`)의 접근·`assertDmWritable`(C 가 `direct` 의 `peer_deactivated` 를 더했다) 순서는 그대로 두고 상한만 바꾼다.
- 웹 `features/directs/queries.ts` 의 `useDirects`·`useDirect`·`directTitle`·`isLoneGroup`·`isOneStream`, `ChannelPage.tsx` 의 종류별 패널 거름.

## 10. 테스트·검증

- **서버 — 목록**: 읽을 수 있는 대화만(일반 채널·내 에이전트 DM·참여한 `direct`, 남의 `dm`·참여하지 않은 `direct`·`kind = 'zzz'` 는 없음 — owner·admin 포함), `channelId` 가 못 읽는 채널이면 404, 묶이지 않은 업로드 없음, 종류 거름, 이름 거름(부분 일치·ASCII 대소문자·NFD 검색어·`%`·`_`·`\` 이스케이프·NUL 400), 올린 사람 거름(메시지 작성자 — 러너가 올린 첨부가 그 에이전트로 걸린다), 최신순·한 메시지 안 첨부 순서, 커서가 남의 DM 을 건너뛰어도 페이지가 맞음(읽을 수 없는 첨부를 사이에 끼워 넣고 두 쪽의 합 = 읽을 수 있는 것 전부, 겹침·빠짐 없음), 보관 채널 `channelArchived`, 스레드 답글 `threadRootId`. 역할 매트릭스(`apps/server/test/roles.matrix.test.ts`)에 목록 API 줄(남의 DM·참여하지 않은 `direct` 의 `channelId` → 404).
- **서버 — 올리기**: 사람이 PDF·zip·빈 파일·20 MiB 경계(±1 바이트)·이미지 5 MB 경계, 413 과 400 의 같은 문구·`maxBytes`, 사람이 올린 HTML·SVG(힌트 `text/html`·`image/svg+xml`)의 GET 응답 헤더 — `content-type: application/octet-stream`·`content-disposition: attachment`·sandbox CSP·`nosniff`.
- **에이전트에게 가는 것**: 플러그인 `inbound-media` — 사람 PDF 가 실린 deliver 에서 `[첨부 파일: …]` 줄, 받기를 부르지 않음. 러너 — 같은 꼴에서 「첨부 파일 1개: …」, `download` 를 부르지 않음.
- **웹 단위**: 파일 탭(세 갈래 꼴·거름·빈 상태·더 보기·메시지로 가기 주소·좁은 화면 시트), 전체 화면(대화 거름·「DM · 이름」 줄·보관됨), 작성기(일반 파일 칩·상한 문구·10개 상한·붙여넣기·끌어다 놓기·작성기 밖 놓기 문구), 무효화(열린 탭의 `channel.activity`).
- **`dev:fake` 브라우저**(owner·mia, 1280·390px — 화면 확인은 지침대로 neo, 두 계정은 독립 브라우저): mia 가 PDF 를 보내고 owner 가 채널 파일 탭에서 받기 → 메시지로 가기, mia 의 에이전트 DM(`dev`)의 파일이 owner 의 전체 화면에 없음, C 가 있으면 owner·mia 1:1 의 파일이 참여하지 않은 admin 에게 없음.
- **실연**: 모델 런 없음 — 에이전트 쪽 변경이 없다(이름 한 줄은 단위 시험이 본다).

## 11. 완료 기준

1. 채널·에이전트 DM·사람 DM 의 패널 「파일」 탭과 사이드바 「파일」 전체 화면이 그 사람이 읽을 수 있는 대화의 사진·파일만 최신순으로 보이고, 종류·이름·올린 사람(전체 화면은 대화도)으로 좁혀진다.
2. 항목에서 크게 보기·내려받기·메시지로 가기가 된다.
3. 사람이 이미지가 아닌 파일(20 MiB 까지)을 보내고, 에이전트는 그 이름 한 줄을 받는다.
4. 읽을 수 없는 대화의 첨부는 목록·커서·404 어디로도 드러나지 않는다.
5. 전체 테스트·typecheck·lint·fmt·웹 빌드·서버 번들 스모크 통과.

## 12. 빌더에게 맡긴 것

API 응답 필드 이름(겹치는 것은 `SearchHit` 이름), 커서 꼴, 색인 꼴, 사람 파일 상한의 shared 이름, 「전체」 칸을 두 칸으로 둘지 섞인 한 줄로 둘지, 사이드바·머리 단추 자리, 이름 칸 입력 멈춤 시간, 올린 사람 고르기의 후보 꼴, 빈 상태·상한 문구, `dev:fake` 씨앗의 꼴, 업로드 함수 이름.

## 13. C 의 구현과 맞춘 자리(2026-11-09, 승인 뒤)

설계를 승인받은 뒤 C 가 main 에 들어가(`70086ab7`) 그 꼴과 대조했다. 결정은 바꾸지 않았고 본문의 「어떻게 부르나」만 지금 코드에 맞췄다.

- **4.1 채널 거름** — 「그 채널을 읽을 수 없으면 404」를 `loadReadableChannel(db, channelId, workspaceId, userId)` 로 부르는 것으로 못 박았다(C 13.2 — SQL 로 먼저 걸러 모르는 kind 도 404).
- **4.1 거르는 자리** — `readableChannelSql` 이 별칭 없는 `channels` 열을 가리키므로 검색 `readableChannels` 와 같은 `IN (SELECT channels.id …)` 꼴로 붙인다고 적었다.
- **5.1 패널 탭** — C 가 `ChannelPage.tsx` 에 종류별 탭 거름(`only`·「그 주소로 와도 그리지 않음」)을 두었으므로 세 종류 모두에 `files` 를 더하는 자리를 적었다. 「C 계획 PH4」 참조를 C 스펙 13.1 PH4 로.
- **5.2 대화 이름·메시지로 가기·올린 사람 후보** — ⌘K 결과 줄의 `nameOf`(C 가 `direct` 의 「DM · 이름」·「(그룹)」 을 더했다)를 꺼내 함께 쓰고, `requestJump` 를 그대로 부르며, `direct` 의 후보는 `DirectSummary.users`·`agents` 에서 고른다고 적었다. 한 줄기 `direct` 의 파일 줄에는 세션 제목을 싣지 않는다.
- **9장** — 「C 와 겹치는 자리」(병합 전 기준)를 「C 위에서 짓는다」(고치지 않고 부르는 자리)로 바꿨다. `docs/guides/plan.md` 8장 「이월」 의 글자 충돌 걱정은 없어졌다 — C 묶음과 A 보류 묶음 뒤에 「파일함」 묶음을 더한다.

## 14. 구현과 맞춘 것(2026-11-09)

구현 계획 `docs/superpowers/plans/2026-11-09-files-hub.md`(태스크 1~5)·리뷰·브라우저 검증에서 이 설계와 달라지거나 빈칸을 채운 것만 모았다. 결정(1장)은 바뀌지 않았다. 남은 문제는 `docs/guides/plan.md` 8장 「이월」 의 「파일함」 묶음 한곳에 있다.

**계획이 정한 것(PF1~PF8 — 12장 「빌더에게 맡긴 것」)**

- **PF1 — shared 계약은 `packages/shared/src/files/index.ts`**: `FILE_PAGE_SIZE` 50·`FILE_PAGE_MAX` 100·`FileListQuery`(`q` 는 trim 뒤 1~100)·`FileListItem`(4.1 의 응답 그대로 — 겹치는 이름은 `SearchHit` 과 같다)·`FileList`. 사람 파일 상한 이름은 `ATTACHMENT_LIMITS.userFileMaxBytes`(20 MiB, `agentFileMaxBytes` 와 같은 값의 따로 둔 이름).
- **PF2 — 서버 조회는 `apps/server/src/modules/attachments/list.ts` 의 `listFiles`**, 라우트는 `routes.ts` 의 세션 스코프 `GET /api/v1/attachments`(`:id` 와 나란히). `m.kind = 'normal'`·`a.message_id IS NOT NULL` 도 건다 — 뒤의 것은 방어용이다(메시지 JOIN 이 이미 거른다).
- **PF3 — 색인** `attachments_channel_message (channel_id, message_id)`, 마이그레이션 `0036_attachments_channel_message`(생성기 출력 그대로).
- **PF4 — 커서**는 `{ createdAt, messageId, pos }` 의 base64url JSON, 틀리면 `VALIDATION`.
- **PF5 — 웹 쿼리 키**(5.3 의 `['files', {channelId?, …}]` 정정): 패널 탭 `qk.files(channelId)` = `["files", channelId]`, 전체 화면 `qk.filesAll` = `["files", "all"]`, 거름은 그 뒤 원소. `channel.activity` 는 그 채널 키만 무효화한다(전체 화면 키는 건드리지 않는다).
- **PF6 — 대화 이름**은 `features/search/SearchResults.tsx` 의 `nameOf` 를 `apps/web/src/features/search/conversationNames.ts` 의 `useConversationNames` 로 꺼내 ⌘K 결과와 파일함이 같이 쓴다.
- **PF7 — 메시지로 가기**는 `features/files/goToFile.ts` 의 `useGoToFile`.
- **PF8 — 크게 보기의 「메시지로 가기」**는 `ImageViewer` 의 `onGoToMessage` 가 있을 때만 그린다 — 파일함 격자만 주고 메시지 본문의 격자는 주지 않는다.

**서버(태스크 1·2)**

- **한 메시지 안의 순서는 `attachments.id ASC` 가 아니라 `attachments_json` 안 자리 `pos`**(4.1 정렬 정정) — `json_each` 의 key. 4.1 이 「`attachments_json` 순서와 같게」 라 한 뜻을 따른 것이다. 정렬은 `messages.created_at DESC, messages.id DESC, pos ASC`.
- **항목의 `attachment` 는 `attachments` 행에서 짓는다**(메시지의 `attachments_json` 이 아니라) — 둘은 NFC 백필이 함께 맞춘다.
- **새로 올리는 첨부 이름에서 양방향 제어 문자를 뺀다**(4.2 보탬) — `invoice<U+202E>fdp.exe` 가 `invoiceexe.pdf` 로 보이는 위장을 막는다. 빼는 집합(U+202A–202E·U+2066–2069·U+200E·U+200F·U+061C)은 shared `domain/` 의 `BIDI_CONTROLS_RE` 한 벌이고, 저장 `sanitizeAttachmentName` 과 표시 `displayAttachmentName` 이 같이 쓴다. 이미 저장된 이름은 다시 쓰지 않는다(이월).
- **역할 매트릭스의 목록 줄은 `DM_CASES` 에만 둔다** — `DIRECT_CASES` 가 `DM_CASES` 를 다시 돌리므로 `direct` 도 덮인다.
- **413 과 400 의 문구·`maxBytes`** — 라우트 `bodyLimit` 은 `userFileMaxBytes` 라 20 MiB 를 넘으면 Fastify 413 이 먼저 나고, `routes.ts` 가 그것을 서비스와 같은 문구·`maxBytes` 로 다시 씌운다(`sizeLimitError`). 사진 5 MB 는 서비스 400.

**웹 — 작성기(태스크 3)**

- **칩 문구** — 413 은 늘 「20 MB 를 넘습니다」, `maxBytes` 가 실린 400 은 그 값이 사진 상한 이하면 「5 MB 를 넘습니다」 아니면 「20 MB 를 넘습니다」.
- **`type` 이 빈 파일은 `application/octet-stream` 으로 보낸다.** 업로드 함수 이름은 `uploadAttachment`, 검사는 `checkAttachmentFile`.
- **웹·서버 판별이 갈리는 두 꼴은 남긴다** — PNG 내용 + 비이미지 확장자 5~20 MB 는 웹이 지나보내고 서버가 400 「5 MB」, HTML 내용 + `.png` 이름 5~20 MB 는 웹이 사진 상한으로 먼저 막는다. 6장 「웹의 MIME 은 힌트」 그대로다.
- **빈 파일과 폴더를 웹이 먼저 막는다**(6장 보탬) — 빈 파일은 칩에 「빈 파일은 보낼 수 없습니다」(서버의 해라체 원문을 칩에 쓰지 않게), 놓은 폴더는 `dataTransfer.items` 의 `webkitGetAsEntry().isDirectory` 로 걸러 토스트 「폴더는 보낼 수 없습니다」.
- **사진 칩의 미리보기는 서버 판별을 따른다**(태스크 5 브라우저 결함) — 브라우저가 `image/png` 라 한 `.png` 이름의 HTML 이 깨진 썸네일로 보였다. 서버 응답의 `attachment.kind` 가 `file` 이거나 `<img>` 가 `onError` 면 파일 칩(아이콘·크기)으로 그린다.

**웹 — 파일 탭과 전체 화면(태스크 4)**

- **PF7 보탬 — 시트를 따로 닫지 않는다.** 세션 주소로 옮기면 패널이 내려간다 — **넓은 화면에서도 파일 패널이 닫힌다**(5.2 는 좁은 화면만 적었다, ⌘K 와 같은 길). 답글이면 스레드 탭이 열린다. 패널을 남길지는 설계 판단으로 이월했다.
- **파일 줄은 `FileCard` 를 다시 썼다** — 메타(올린 사람·대화·날짜·「보관됨」)·단추 칸을 더했다. 머리의 「파일」 단추는 `app/layout/PanelTabs.tsx` 의 `FilesTabLink` 하나를 세 머리(채널·에이전트 DM·사람 DM)가 쓴다.
- **사진 격자는 `AttachmentGrid` 가 아니라 `AttachmentImage`** 를 3열(전체 화면이 넓으면 6열)로.
- **설계자가 정한 문구**: 「불러오는 중…」, 「파일을 불러오지 못했습니다」(오류 원문이 있으면 「파일을 불러오지 못했습니다 — …」), 대화 고르기 「모든 대화」, 올린 사람 「모두」, 크게 보기 단추 「메시지로 가기」, 빈 파일·폴더 문구(위).
- **전체 화면 「대화」 고르기는 보관하지 않은 채널·DM 만 싣는다** — 보관 채널의 줄은 「모든 대화」에서 보이고 「보관됨」이 붙는다.
- **이름은 `displayAttachmentName` + `<bdi>`** 로 그린다(리뷰 수정) — `<bdi>` 는 둘레만 격리하고 이름 안의 U+202E 는 남아 위장이 그대로 보였다. 파일 줄 이름·`title`·`aria-label`, 크게 보기 제목·`alt`, 격자 `label`, 작성기 칩, 첨부로 풀리지 않는 `file` 블록(`FileBlock.tsx`)까지.
- **다시 붙으면 `["files"]` 를 모두 무효화한다**(5.3 보탬, 리뷰 수정) — 끊긴 사이 온 첨부가 열린 탭에 안 보이던 것.

**검증(태스크 5)**

- **`dev:fake` 씨앗은 새 글이 아니라 기존 씨앗 글에 묶었다** — 씨앗 채널 「세션」 의 「dev:fake 새 세션」 owner 글에 사진 둘·PDF 하나(`DEV_FAKE_CHANNEL_FILES`), mia ↔ dev DM 의 mia 첫 글에 사진 하나(`DEV_FAKE_DM_FILE` — owner 의 파일함에 없어야 하는 것). 기존 세션·글 수 단언을 바꾸지 않으려고. 서비스 `uploadAttachment` + 메시지 묶기로, 채널 첨부는 씨앗 채널과 같은 조건, DM 사진은 DM 씨앗과 같은 조건·같은 건너뛰기.
- **플러그인 `[첨부 파일: …]` 줄은 실제 플러그인 `prepareInboundMedia` 로 단언한다** — 가짜 플러그인은 본문을 만들지 않으므로 통합 시험이 가짜 플러그인이 받은 deliver 의 첨부를 실제 함수에 넣는다.
- **「메시지로 가기」 뒤 초점**(브라우저 결함) — 누른 단추가 활성인 채 목록이 초점을 포기했고, 시트·크게 보기의 초점 가둠이 초점을 머리 단추로 돌려줬다. `goToFile.ts` 가 누른 단추의 초점을 내려놓고(입력 칸은 제외), 대화상자가 열려 있었으면 초점 목표 없이 먼저 건 뒤 대화상자가 다 내려가면(상한 1.5초) 초점 목표로 다시 건다. jsdom 이 못 잡는 갈래라 실제 Chromium 으로 확인했다.
- **브라우저 검증은 전부 독립 Chromium 으로 했다**(10장 「화면은 neo」 대신) — owner·mia 두 계정이 필요했다. https `file` 블록 카드는 `dev:fake` 대본에 없어 단위 시험으로만, 20 MiB 넘는 파일의 413 은 웹이 먼저 막아 단위·서버 시험으로만 본다.
