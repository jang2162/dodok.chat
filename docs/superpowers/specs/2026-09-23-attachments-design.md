# Phase 2 ③ 첨부·이미지 설계

**상태**: 설계 확정(2026-09-23), 구현 완료(2026-09-23, 실연 남음) — 구현이 이 설계와 달라진 것은 11장
**범위**: 사람 → 에이전트 이미지, 에이전트 → 사람 이미지·파일, components `artifact://` 해석, 이미지 크게 보기, 에이전트의 미디어 전용 응답이 호스트 경로를 드러내는 결함
**앞선 근거**:
- 첨부 스파이크 `.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md`(2026.9.5 실물, 모델 런 2회). 이 문서에서 「스파이크 1-7」처럼 부르는 번호는 그 보고서의 명제 번호다.
- ADR 0001 4.2(`hello-ok.policy.attachments`) · ADR 0002 5절(`deliver`·`handleAction` 미디어 인자) · ADR 0004(플러그인 이중 평가 — 모듈 상태 금지)
- components v1 스펙 `2026-09-21-components-v1-design.md` 결정 1·8, 11장 Ruling 4(`artifact://` 자리표시)

---

## 0. 결정 (브레인스토밍 2026-09-23)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **범위: 사람 → 에이전트는 이미지만, 에이전트 → 사람은 이미지와 일반 파일** | 모델에게 의미 있는 것은 이미지다(F-9). 에이전트 쪽은 components `media`·`file` 블록이 둘 다 있어 파일을 빼면 `artifact://` 해석이 반쪽이 된다. |
| 2 | **스펙 전에 실물 스파이크**(모델 런 3회 상한, 2회 사용) | 인바운드 미디어가 claude-cli 에 어떻게 닿는지, 에이전트 파일이 어떤 꼴로 오는지는 문서만으로 알 수 없었다. 답: 경로 fact 여야 하고(url 은 안 가져온다), 에이전트 파일은 **Gateway 호스트 경로**로 온다. |
| 3 | **바이트는 브리지 오리진의 HTTP 로 옮긴다** — `GET`·`POST /bridge/attachments` | 플러그인은 지금처럼 서버로 나가는 연결만 쓴다(Gateway 쪽 포트 0). WS 프레임이 작게 유지되고, 끊긴 동안 브리지 큐가 수 MB 버퍼를 쥐지 않는다. 대가는 새 HTTP 인증 면 하나(브리지 토큰 재사용). |
| 4 | **식별자는 서버 첨부 id 하나, 경계를 넘는 꼴은 `artifact://<id>`** | 계약 `Attachment.url` 이 이미 `https://`·`artifact://` 만 받는다. 호스트 경로·내부 URL 은 어느 경계도 넘지 않는다. |
| 5 | **components 의 `artifact://<ref>` 는 같은 메시지 첨부를 가리킨다** — `ref` 는 첨부 `name`(또는 `id`) | 모델은 id 를 알 길이 없다. `message` 툴 한 번에 `media` 와 `components` 를 같이 보내고 카드에서는 파일 이름으로 가리킨다. 다른 메시지의 첨부는 가리키지 못한다 — 채널 간 접근 검사가 필요 없다. |
| 6 | **Gateway 호스트 사본 정리는 운영 설정에 맡긴다** | 플러그인이 저장한 원본은 기본값으로 아무도 안 지운다(스파이크 Q1 끝). 너무 빨리 지우면 이력 재생에서 이미지가 빠진다. 그 판단은 OpenClaw `attachments.ttlHours` 에 두고 설치 가이드에 적는다. 플러그인은 지우지 않는다. |
| 7 | **이월 「이미지를 크게 볼 수 없다」를 넣는다** | 이번에 이미지를 그리는 곳을 다 만진다. 따로 하면 같은 컴포넌트를 두 번 연다. |
| 8 | **MIME 은 매직 바이트로 정한다** | 클라이언트·플러그인이 준 `Content-Type` 은 힌트일 뿐이다. `image` 는 PNG·JPEG·GIF·WebP 넷만이고, SVG 는 `file` 이다(인라인 SVG 는 스크립트 면이다). |
| 9 | **서버는 외부 URL 을 가져오지 않는다** | 에이전트가 `https://` 를 주면 플러그인이 Gateway 쪽 로더(자체 SSRF 가드)로 받아 같은 업로드 길로 올린다. 서버에는 SSRF 면이 생기지 않는다. |
| 10 | **의존성은 서버 `image-size` 하나** | 이미지 가로·세로를 저장해 가상 목록에서 줄 높이가 튀지 않게 한다. 순수 JS 이고 네 형식을 다 읽는다. 웹은 기존 `ui/dialog.tsx` 로 크게 보기를 만든다. |

---

## 1. 범위

**한다**
- 웹 작성기에서 이미지 올리기(버튼·붙여넣기·끌어다 놓기), 미리보기 칩, 진행 표시, 글 없는 이미지 메시지
- 서버 첨부 저장·판별·서빙·정리, 브리지 HTTP 두 경로
- 플러그인 인바운드: 이미지를 받아 Gateway 미디어 저장소에 두고 `media` fact 로 넘긴다
- 플러그인 아웃바운드: `message` 툴 `media`/`mediaUrls` 와 최종 응답 `mediaUrls` 를 읽어 올린다
- 웹 메시지 첨부(이미지 격자·파일 카드), components `media`·`file`·링크 버튼의 `artifact://` 해석, 크게 보기
- 결함: 미디어만 있는 최종 응답을 플러그인이 버리고, 서버 Gateway 폴백이 `MEDIA:/호스트/경로` 를 채널에 저장한다(스파이크 2-10)
- 이월 둘: 「이미지를 크게 볼 수 없다」, 「`media`·`file` 문구 비대칭」(같은 해석기로 닫힌다)

**하지 않는다**
- 사람이 이미지가 아닌 파일을 올리는 것(결정 1)
- 썸네일 생성·이미지 재압축. 사람 이미지는 5 MB 이하라 원본을 `lazy` 로 그린다. `Attachment.thumbUrl` 은 비워 둔다.
- 음성·영상 재생, PDF 미리보기(파일 카드로 내려받기만)
- 오브젝트 스토리지(S3 등). 로컬 디스크만.
- 메시지·첨부 삭제 기능(아직 메시지 삭제가 없다)
- 아웃바운드 `sendMedia` 훅(스파이크 2-13 — 이번 경로 어디서도 안 불렸다). 결함 2(`sendText` 의 `agent not found`)와 같은 자리라 이월 그대로.
- 9.4 런타임 실측. SDK 함수가 9.4 타입에 있는지만 계획 태스크 0 에서 확인한다.

---

## 2. 구조

### 2.1 흐름

```
사람 → 에이전트
  웹 ──POST /api/attachments──▶ 서버(저장, 미묶음) ──id──▶ 웹
  웹 ──wire message.send { attachments:[id] }──▶ 서버(메시지에 묶음)
  서버 ──bridge inbound.deliver { message.attachments:[{url:"artifact://<id>",…}] }──▶ 플러그인
  플러그인 ──GET <브리지 오리진>/bridge/attachments/<id>──▶ 바이트
  플러그인: saveMediaBuffer(바이트, mime, "inbound", maxBytes, name) → toInboundMediaFacts([{ path, contentType, fileName }])
          → buildContext({ media }) → 에이전트 런(claude-cli 는 @복사본 경로로 받는다, 스파이크 1-7)

에이전트 → 사람
  모델 ──message 툴 { media / mediaUrls }──▶ handleAction ┐
  모델 ──최종 응답 MEDIA: 줄──▶ 코어 ──deliver { mediaUrls }──▶ ┤
                                                          ▼
  플러그인: loadWebMediaRaw(src, mediaAccess) → 바이트·이름·MIME
  플러그인 ──POST /bridge/attachments (파일마다)──▶ 서버(저장, 미묶음) ──id──▶ 플러그인
  플러그인 ──bridge outbound.message { attachmentIds:[id…] }──▶ 서버(검사 뒤 메시지에 묶음) ──wire──▶ 웹
```

### 2.2 서버 — 새 모듈 `apps/server/src/modules/attachments/`

| 파일 | 책임 |
| --- | --- |
| `sniff.ts` | 순수. 앞 바이트로 형식 판별 → `{ kind, mime }`. 이미지면 `image-size` 로 가로·세로 |
| `store.ts` | 디스크 블롭(`<ATTACHMENTS_DIR>/<sha256 앞 2자>/<sha256>`, 같은 내용은 한 번) + DB 행 |
| `service.ts` | 올리기(사람·브리지)·묶기·읽기 권한·정리 |
| `routes.ts` | `POST /api/attachments` · `GET /api/attachments/:id` · `POST /bridge/attachments` · `GET /bridge/attachments/:id` |
| `sweep.ts` | 묶이지 않은 채 24시간 지난 행과 아무도 안 가리키는 블롭 정리 |

### 2.3 플러그인

| 파일 | 책임 |
| --- | --- |
| `src/media-http.ts` | 순수에 가깝게. 브리지 URL → HTTP 오리진, 첨부 받기·올리기(`fetch` 주입). 상태 없음(ADR 0004) |
| `src/inbound.ts` | 이미지 첨부 → 받기 → `saveMediaBuffer` → facts. 이미지가 아닌 첨부와 실패는 본문 끝 줄로 |
| `src/outbound.ts` | 미디어 원천 모으기(툴 인자·`deliver` payload) → 로드 → 올리기 → `attachmentIds` |
| `src/channel.ts` | 위 셋을 `dispatchInbound`·`handleAction`·`deliver` 에 잇는다. SDK import 는 여기에만 |
| `src/config.ts` | 계정 `mediaMaxMb`(선택, 기본 20) |
| `src/components-schema.ts` | 모델용 설명에 `artifact://<파일 이름>` 관례 |

### 2.4 웹

| 자리 | 책임 |
| --- | --- |
| `features/attachments/` (새) | `upload.ts`(XHR 업로드·진행), `url.ts`(`artifact://<id>` → API 경로), `AttachmentGrid.tsx`, `FileCard.tsx`, `ImageViewer.tsx`(크게 보기), `resolve.ts`(카드의 `artifact://<ref>` → 첨부) |
| `features/composer/` | 첨부 버튼·붙여넣기·끌어다 놓기, `PendingAttachments.tsx` 칩 |
| `features/messages/MessageItem.tsx` | 본문 아래 첨부, 카드가 가리킨 첨부는 빼고 |
| `features/components/blocks/` | `MediaBlock`·`FileBlock`·링크 버튼이 `resolve.ts` 를 쓴다. `artifact.tsx` 자리표시는 「첨부를 찾을 수 없습니다」로 |

---

## 3. 계약 변경 (shared)

1. **`MessageSend.bodyMd`**: `min(1)` 을 풀고 **「본문이 공백뿐이면 첨부가 1개 이상」** refine 을 둔다. 글 없는 이미지 메시지를 위해서다.
2. **`OutboundMessage.attachments: Attachment[]` → `attachmentIds: z.array(Id).max(10).default([])`**. 플러그인이 준 메타데이터(이름·크기·MIME)는 믿지 않고 서버 기록에서 채운다. 옛 필드는 지운다. 버전이 어긋나도 깨지지 않는다 — zod 객체는 모르는 키를 버리므로, 옛 플러그인의 `attachments: []` 는 새 서버에서, 새 플러그인의 `attachmentIds` 는 옛 서버에서 조용히 빠진다.
3. **`Attachment`** 는 그대로 쓴다. 서버가 만드는 `url` 은 늘 `artifact://<id>` 이고 `thumbUrl` 은 넣지 않는다. `name` 은 표시·`artifact://` 해석용이며 경로 구분자(`/`·`\`)와 제어 문자를 뺀 값이다.
4. **새 `ATTACHMENT_LIMITS`** 상수: `userImageMaxBytes = 5 * 1024 * 1024`, `agentFileMaxBytes = 20 * 1024 * 1024`, `perMessage = 10`, `imageMimes = ["image/png","image/jpeg","image/gif","image/webp"]`. 웹·서버·플러그인이 같은 값을 읽는다.
5. **새 `BRIDGE_ATTACHMENT_HEADERS`** 상수: 파일 이름 `x-dodok-file-name`(퍼센트 인코딩 UTF-8), 채널 `x-dodok-channel-id`.
6. `InboundDeliver.message.attachments` 는 그대로(이미 `Attachment[]`). 서버가 트리거 메시지의 첨부를 싣는다.

---

## 4. 서버

### 4.1 저장

`attachments` 테이블: `id`, `channel_id`, `uploader_type`(`user`|`bridge`), `uploader_id`(사용자 id, 브리지면 null), `kind`(`image`|`file`), `name`, `mime`, `size`, `width`, `height`, `sha256`, `message_id`(null 이면 미묶음), `created_at`. 인덱스 `(message_id)`, `(sha256)`, `(message_id IS NULL, created_at)`.

블롭은 `ATTACHMENTS_DIR`(기본 `data/attachments`, 새 설정 키)에 `sha256` 이름으로 한 번만 쓴다. 임시 파일에 쓰고 `rename` 해서 반쯤 쓴 블롭이 보이지 않게 한다.

`messages.attachments_json` 은 이미 있다. 묶을 때 서버가 `Attachment` 배열을 여기 쓴다(읽기 경로 변경 0 — `rowToMessage` 가 이미 싣는다).

### 4.2 판별 (`sniff.ts`)

| 앞 바이트 | 결과 |
| --- | --- |
| PNG `89 50 4E 47 0D 0A 1A 0A` | `image`, `image/png` |
| JPEG `FF D8 FF` | `image`, `image/jpeg` |
| GIF `GIF87a`/`GIF89a` | `image`, `image/gif` |
| WebP `RIFF????WEBP` | `image`, `image/webp` |
| PDF `%PDF-` | `file`, `application/pdf` |
| 그 밖 | `file`. MIME 은 힌트가 `text/plain`·`application/json`·`text/csv`·`application/zip` 중 하나면 그 값, 아니면 `application/octet-stream`. **힌트가 `image/*`·`text/html`·`image/svg+xml` 이어도 이 줄로 온다** |

이미지인데 `image-size` 가 가로·세로를 못 읽으면 `file` 로 내린다(망가진 이미지를 `<img>` 로 그리지 않는다).

### 4.3 경로

| 경로 | 인증 | 동작 |
| --- | --- | --- |
| `POST /api/attachments?channelId=` | 세션 쿠키, 채널 멤버 | 본문은 원시 바이트(`bodyLimit` = `userImageMaxBytes`). 판별 결과가 `image` 가 아니면 `VALIDATION`("이미지만 올릴 수 있습니다"). 넘치면 413. 응답 `Attachment`(미묶음) |
| `GET /api/attachments/:id` | 세션 쿠키 | 묶인 첨부는 그 채널 멤버만, 미묶음은 올린 사람만. 없거나 권한이 없으면 모두 404(있는지 드러내지 않는다) |
| `POST /bridge/attachments` | `Authorization: Bearer <BRIDGE_TOKEN>` | 본문은 원시 바이트(`bodyLimit` = `agentFileMaxBytes`), `x-dodok-channel-id` 필수(존재 확인), 이름 헤더. 응답 `Attachment`(미묶음, `uploader_type=bridge`) |
| `GET /bridge/attachments/:id` | 브리지 토큰 | **묶인** 첨부만. 미묶음(사람이 올리고 아직 안 보낸 것)은 404 |

토큰은 `/bridge` WS 와 같은 비교 함수(상수 시간)를 쓴다. 브리지 HTTP 요청도 로그에 `authorization` 을 싣지 않는다(기존 로거 가림 목록).

**응답 헤더** (`GET` 둘): `Content-Type` = 저장된 MIME, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`(id 는 내용이 바뀌지 않는다). `Content-Disposition` 은 `image` 면 `inline`, 그 밖이면 `attachment; filename*=UTF-8''<이름>`. `?download=1` 이면 이미지도 `attachment`(크게 보기의 「원본 내려받기」).

### 4.4 묶기

- **사람 메시지** (`createUserMessage`): 지금의 「첨부는 아직 지원하지 않는다」 거부를 지운다. 같은 트랜잭션에서 id 마다 **올린 사람 = 보내는 사람, 같은 채널, 미묶음**을 확인하고 묶는다. 하나라도 틀리면 메시지 전체를 `VALIDATION` 으로 거부한다(사람은 고쳐서 다시 보낼 수 있다). `clientMsgId` 재전송은 기존 메시지를 돌려주므로 두 번 묶이지 않는다.
- **에이전트 메시지** (`storeAgentMessage`): id 마다 **`uploader_type=bridge`, 같은 채널, 미묶음**을 확인한다. 틀린 id 는 **빼고 경고 로그**를 남긴다. 메시지 전체를 버리면 에이전트 응답 본문까지 잃기 때문이다. 같은 `outboundId` 재전송(dedupe)은 기존 메시지를 돌려준다.
- 묶인 순서가 `Message.attachments` 의 순서다.

### 4.5 인바운드에 싣기 (`runs/context.ts`)

- 트리거 메시지의 첨부를 `message.attachments` 에 그대로 싣는다(사람·에이전트 모두 — 릴레이된 에이전트 이미지도 다음 에이전트가 본다). 상호작용 트리거는 지금처럼 `[]`.
- 채널 문맥의 이전 메시지 줄에는 첨부를 **자리표시로만** 쓴다: `[이미지 2장]`, `[파일: report.pdf]`. **경로·URL 은 어느 텍스트에도 쓰지 않는다** — Gateway 는 프롬프트 속 절대 이미지 경로를 찾아 자동으로 첨부한다(스파이크 1-16).

### 4.6 결함 — Gateway 폴백의 `MEDIA:` 줄

finalizing 상한 뒤 WS 스냅샷을 에이전트 메시지로 저장하는 곳(`orchestrator.ts` 「gateway snapshot」)은 저장 전에 **단독 줄 `MEDIA:…`** 을 모두 걷어 낸다. 걷고 나서 비면 저장하지 않는다. 플러그인 쪽 수정(5.2)이 1차 방어이고 이것이 2차다. 이 경로로 온 미디어는 채널에 붙지 않는다(바이트가 호스트에만 있다) — 로그에 `mediaLinesDropped` 수를 남긴다.

### 4.7 정리 (`sweep.ts`)

서버 시작 때 한 번, 그 뒤 한 시간마다 돈다.
- 미묶음이고 24시간 지난 행을 지운다.
- 어느 행도 가리키지 않는 블롭 파일을 지운다(같은 `sha256` 을 다른 행이 쓰면 남긴다).
- 채널을 지우면 그 채널 첨부 행도 지운다(FK cascade). 블롭은 다음 정리에서 지워진다.

### 4.8 검증 표

| 명제 | 재는 곳 |
| --- | --- |
| 매직 바이트가 힌트를 이긴다(`image/png` 라고 한 HTML → `file`, `text/html` 이 아닌 `application/octet-stream`) | `sniff` 단위 |
| SVG 는 어떤 힌트로도 `image` 가 되지 않는다 | `sniff` 단위 |
| 남의 미묶음 첨부로 메시지를 보내면 거부 | 통합 11b |
| 브리지 토큰으로 사람의 미묶음 첨부를 못 받는다 | 통합 11c |
| 에이전트가 다른 채널의 첨부 id 를 주면 그 id 만 빠지고 본문은 저장된다 | 통합 11e |
| 폴백 최종본의 `MEDIA:` 줄이 저장되지 않는다 | 통합 11g |

---

## 5. 플러그인

### 5.1 인바운드 (`dispatchInbound`)

1. `message.attachments` 중 `kind === "image"` 를 순서대로 받는다: `GET <오리진>/bridge/attachments/<id>`(브리지 토큰, 30초 제한시간). 브리지 오리진은 계정 `bridgeUrl` 의 `ws:`→`http:`, `wss:`→`https:`, 경로 제거.
2. 받은 바이트를 `runtime.channel.media.saveMediaBuffer(buf, mime, "inbound", maxBytes, name)` 로 저장한다. **`maxBytes` 를 반드시 준다** — 기본값 5 MB(5,242,880)는 우리 상한 5 MiB(5,242,880)와 같지만 기본값에 기대지 않는다(스파이크 1-11).
3. `toInboundMediaFacts([{ path: saved.path, contentType, fileName: name, kind: "image" }])` 를 `buildContext({ …, media })` 에 넘긴다. **fact 에 `url` 을 넣지 않는다**(전사에 남는다). 옛 `MediaPath*` 필드는 쓰지 않는다(2026-10-01 제거 예정).
4. 이미지가 아닌 첨부는 본문 끝에 `[첨부 파일: report.pdf]` 줄로만 알린다.
5. 한 장이라도 받기·저장에 실패하면 그 장은 빼고 본문 끝에 `[이미지를 불러오지 못했습니다: word.png]` 를 붙인다. **런은 막지 않는다.**
6. SDK 에 `saveMediaBuffer` 가 없으면(9.4 확인 결과에 따라) 5 와 같은 문구로 떨어진다.

### 5.2 아웃바운드

**원천 모으기**
- `handleAction`: `params.mediaUrls` 가 비어 있지 않으면 그것, 아니면 `[params.media]`. 비고 중복은 뺀다. 코어가 `filePath` 도 `media` 로 정규화한다(스파이크 2-1·C6). 표시 이름은 `params.filename` 이 있으면 첫 파일에 쓴다.
- `deliver`(final): `payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : [])`. 이름은 `payload.attachments[i].name`.

**읽기**: `loadWebMediaRaw(src, { maxBytes, localRoots: ctx.mediaAccess.localRoots, readFile: ctx.mediaAccess.readFile, workspaceDir: ctx.mediaAccess.workspaceDir })`. `deliver` 에는 `mediaAccess` 가 없으므로 옵션 없이 부른다(스테이징 경로는 기본 루트 안이다, 스파이크 2-9). **`fs.readFile` 을 직접 쓰지 않는다** — 호스트 정책 우회다. `maxBytes` = 계정 `mediaMaxMb`(기본 20) MiB 와 `agentFileMaxBytes` 중 작은 쪽.

**이름**: 로더 `fileName` → 원천의 basename → `file`. 경로 구분자·제어 문자를 빼고, 한 메시지 안에서 겹치면 확장자 앞에 ` (2)`, ` (3)` 을 붙인다.

**올리기**: 파일마다 `POST /bridge/attachments`. 네트워크 오류면 한 번 다시 시도한다. 받은 id 를 `attachmentIds` 로 모은다.

**실패하면**
- `handleAction`: 하나라도 실패하면 **툴 호출을 실패로 돌려준다** — `dodok: 첨부를 보내지 못했습니다 — report.pdf: 20 MiB 를 넘습니다`. 모델이 보고 고칠 수 있다. 이미 올린 것은 미묶음으로 남아 정리가 지운다.
- `deliver`: 모델에게 돌려줄 길이 없다. 성공한 첨부로 보내고 본문 끝에 `_첨부 1개를 보내지 못했습니다: report.pdf (20 MiB 초과)_` 줄을 붙인다.

**결함 — 미디어 전용 응답**: `deliver` 는 지금 `!text.trim()` 이면 돌아간다(`channel.ts:200`). **텍스트도 미디어도 없을 때만** 돌아가게 바꾼다. 텍스트가 비고 첨부만 있는 `outbound.message` 를 보낸다.

**`message` 툴 텍스트**: 툴 호출의 `message` 가 비고 첨부만 있어도 보낸다(스파이크가 쓴 `[spike: media only]` 같은 채움 글은 넣지 않는다).

### 5.3 설정·안내

- 계정 스키마에 `mediaMaxMb`(선택, 1~20). upstream 관례(스파이크 5-4)를 따르되, 값을 `resolveChannelMediaMaxBytes` 로 풀지는 계획 태스크 0 이 9.4 타입을 보고 정한다.
- 설치 가이드(원격 Gateway): ① `attachments.ttlHours` 를 설정하지 않으면 사람 이미지 원본이 호스트에 영구히 남는다 ② `tools.fs.workspaceOnly` 가 `false`(기본)면 모델이 호스트에서 읽을 수 있는 아무 파일이나 채널로 보낼 수 있다(스파이크 2-3).

---

## 6. 웹

### 6.1 작성기

- 첨부 버튼(파일 선택, `accept="image/png,image/jpeg,image/gif,image/webp"`), 붙여넣기(클립보드 이미지), 작성기 위로 끌어다 놓기.
- 넣는 즉시 올린다(XHR — `fetch` 는 업로드 진행을 못 준다). 칩마다 미리보기(로컬 object URL)·진행 막대·빼기 버튼. 빼면 요청을 취소한다(이미 올라간 것은 정리가 지운다).
- **보내기는 올리기가 모두 끝나야 켜진다.** 비활성 사유는 버튼 옆 보이는 글로(components 결정과 같은 규칙).
- 형식·크기가 틀리면 올리지 않고 칩에 이유를 쓴다(`5 MB 를 넘습니다`, `이미지만 올릴 수 있습니다`). 서버 거절도 같은 자리. 11개째부터는 넣지 않고 한 번 알린다.
- 글 없이 이미지만 보낼 수 있다.
- 보낸 뒤 칩을 비운다. 보내기가 실패해 재시도하면 같은 id 로 다시 보낸다(`clientMsgId` 재사용).
- 낙관적 메시지(`PendingItem`)는 로컬 미리보기로 이미지를 그린다.

### 6.2 메시지

- 첨부는 본문 아래. **이미지**는 격자(1장이면 원본 비율로 최대 너비 360px·높이 320px, 2장 이상이면 2열). 자리는 저장된 가로·세로로 미리 잡는다. `loading="lazy"`, `alt` 는 이름.
- **파일**은 카드: 아이콘·이름·크기·종류, 누르면 내려받기(`<a download>` 가 아니라 서버의 `Content-Disposition` 에 맡긴다).
- 이미지를 못 불러오면 그 칸이 파일 카드 꼴로 물러난다(이름·「이미지를 불러오지 못했습니다」·내려받기).

### 6.3 components 해석 (`resolve.ts`, 순수)

`artifact://<ref>` 를 **그 메시지의** `attachments` 에서 찾는다: `ref` 와 `name` 이 같은 첫 첨부, 없으면 `id` 가 같은 첨부. `https://` 는 지금처럼(스펙 결정 8).

| 자리 | 찾았을 때 | 못 찾았을 때 |
| --- | --- | --- |
| `media` 항목 | 찾은 첨부가 `image` 면 이미지(크게 보기 됨), `file` 이면 파일 카드 | 「첨부를 찾을 수 없습니다」 |
| `file` 블록 | 파일 카드(블록의 `name` 이 표시 이름) | 같은 문구 |
| 링크 버튼 | 새 탭으로 연다(`/api/attachments/<id>`) | 비활성 + 같은 문구 |

**카드가 가리킨 첨부는 카드 아래에 다시 그리지 않는다.** `artifact://` 도 `https://` 도 아닌 값은 모든 자리에서 「열 수 없는 링크입니다」다 — 이월 「`media`·`file` 문구 비대칭」이 닫힌다. `ARTIFACT_PENDING`(「첨부는 곧 지원합니다」)은 지운다.

### 6.4 크게 보기 (`ImageViewer.tsx`)

- 메시지 첨부 이미지·`media` 블록 이미지(자기 서버 것과 `https://` 모두)를 누르면 열린다. `ui/dialog.tsx` 위에 만든다.
- 화면에 맞춰 원본 비율로, 어두운 배경. 이름, 「원본 내려받기」(자기 서버 첨부만 — `?download=1`), 닫기 버튼.
- 여러 장이면 좌우 화살표와 ←/→ 키로 넘긴다(같은 메시지 안에서만). `n / 전체` 를 보인다.
- Esc·바깥 누르기로 닫고, 닫은 뒤 초점은 연 이미지로 돌아간다. 이미지 버튼의 이름은 「<이름> 크게 보기」.

---

## 7. 오류 처리

| 상황 | 사람이 보는 것 | 에이전트가 보는 것 |
| --- | --- | --- |
| 형식·크기 위반(웹) | 칩에 이유, 보내기 비활성 | — |
| 업로드 중 연결 끊김 | 칩에 「올리지 못했습니다」·다시 시도 | — |
| 인바운드 이미지 받기·저장 실패 | — | 본문 끝 `[이미지를 불러오지 못했습니다: 이름]`, 런은 돈다 |
| 툴 첨부 실패 | 메시지가 안 온다 | 툴 오류 문구(고칠 수 있다) |
| 최종 응답 첨부 실패 | 본문 끝 「첨부 N개를 보내지 못했습니다」 줄 | — |
| 에이전트가 준 id 가 틀림 | 그 첨부만 빠진다 | — (서버 경고 로그) |
| 카드가 없는 첨부를 가리킴 | 「첨부를 찾을 수 없습니다」 | — |
| 첨부 GET 권한 없음·없음 | 이미지 칸이 파일 카드로 물러남 | — |

---

## 8. 검증

### 8.1 서버 통합 시나리오 (가짜 Gateway·플러그인, `apps/server/test/integration/attachments.test.ts`)

- **11a** 사람이 이미지를 올리고 보낸다 → `message.created` 에 `artifact://<id>` 첨부, 인바운드 `message.attachments` 에 같은 것, 가짜 플러그인이 `GET /bridge/attachments/<id>` 로 **같은 바이트**를 받는다
- **11b** 권한: 남의 미묶음 id·다른 채널 id·없는 id 로 보내기 → 거부, 채널 멤버가 아닌 사람의 `GET /api/attachments/:id` → 404
- **11c** 브리지로 사람의 미묶음 첨부를 받으려 하면 404, 토큰이 틀리면 401
- **11d** 판별: `image/png` 라고 한 HTML·SVG → `file`, 사람 업로드면 거부. 5 MB 넘는 이미지 → 413
- **11e** 에이전트: 가짜 플러그인이 파일 둘을 올리고 `attachmentIds` 로 보낸다 → 메시지에 순서대로 묶임. 다른 채널 id 가 섞이면 그것만 빠진다
- **11f** 텍스트 없이 첨부만 있는 `outbound.message` 가 저장된다
- **11g** 폴백: 정본 없이 WS 스냅샷 `"결과\n\nMEDIA:/Users/x/a.png"` → 저장 본문은 `"결과"`. 스냅샷이 `MEDIA:` 줄뿐이면 메시지를 만들지 않는다
- **11h** 정리: 25시간 지난 미묶음 행과 블롭이 지워지고, 같은 `sha256` 을 묶인 행이 쓰면 블롭은 남는다
- **11i** 문맥: 이전 메시지 줄에 `[이미지 1장]` 이 있고 경로·URL 이 없다

### 8.2 플러그인 단위

`media-http`(오리진 변환·헤더·재시도), `inbound`(이미지만 facts·실패 줄·`url` 없음), `outbound`(원천 모으기·이름 겹침·실패 문구·미디어 전용 응답). SDK 는 주입해서 가짜로 쓴다 — `channel.ts` 배선은 실연 하네스가 잰다(ADR 0004 고침 때 c2-t15 리뷰 L6 과 같은 방침).

### 8.3 웹 테스트

업로드 칩(진행·취소·실패·상한), 보내기 활성 규칙, 첨부 격자·파일 카드, `resolve.ts`(이름·id·못 찾음·가리킨 첨부 빼기), 크게 보기(열기·넘기기·Esc·초점 복귀), components 블록 셋의 문구가 같은 것.

### 8.4 `dev:fake` 대본과 브라우저 검증

가짜 플러그인이 첨부를 흉내 낸다: 키워드 「이미지 보여줘」(PNG 1장), 「보고서 줘」(PDF 파일), 「카드에 이미지」(`media`·`file` 블록이 `artifact://<이름>` 으로 가리킴), 「미디어만」(텍스트 없는 응답). 사람 이미지 업로드는 대본이 받은 첨부 수와 첫 이미지 크기를 되말한다. 그 위에서 브라우저 검증 → 수정 → 재검증(앞선 하위 프로젝트와 같은 규율).

### 8.5 실연 (마지막, 사용자 승인)

1. **런 0회 하네스**(live-smoke 11절)로: 인바운드 fact·`@경로` 복사본, 툴 `media` 업로드, 최종 응답 `MEDIA:` 업로드, 미디어 전용 응답이 호스트 경로 없이 채널에 오는지.
2. **모델 런 2회 예상**: ① 사람이 올린 이미지에 대해 묻고 맞히는가 ② 「파일을 만들어 보내 줘」 → 채널에 파일 카드. 상한은 실연 때 사용자에게 받는다.

---

## 9. 완료 기준

- 사람이 이미지를 붙여 에이전트에게 물으면 에이전트가 그 이미지를 보고 답한다(실물).
- 에이전트가 만든 이미지·파일이 채널에 보이고 내려받아진다. 채널 어디에도 호스트 경로가 나타나지 않는다(실물).
- components `media`·`file`·링크 버튼의 `artifact://<파일 이름>` 이 그 메시지 첨부로 풀린다.
- 이미지를 누르면 크게 보이고 키보드로 넘기고 닫을 수 있다.
- 통합 11a~11i, 플러그인·웹 단위, 브라우저 재검증 결함 0, 검사 4종 통과.

---

## 10. 열린 문제 (범위 밖 기록)

- **사람이 채팅에 쓴 호스트 경로.** Gateway 는 프롬프트 속 절대 이미지 경로를 자동 첨부한다(스파이크 1-16). 우리는 우리 쪽 텍스트에 경로를 쓰지 않지만, 사람이 `/Users/…/x.png` 를 타이핑하면 그 호스트 이미지가 모델 문맥에 들어갈 수 있다. 본문을 고쳐 막을지는 정하지 않았다 — 이월.
- **5 MiB 가까운 이미지가 Anthropic 이미지 상한에 걸리는지**는 재지 않았다(스파이크 걱정 4). 우리 상한 5 MB 가 방어선이다.
- **9.4 런타임**에서 `media` fact·`@경로` 경로가 같은지는 모른다. 원격 Gateway 버전(서버 로그 `gatewayVersion`)을 본 뒤 하네스로 한 번 돈다.
- **Gateway 호스트의 사본 셋**(저장소·스테이징·CLI 복사) — 결정 6 에 따라 운영 설정.

---

## 11. 구현과 맞춘 것 (2026-09-23)

구현(계획 태스크 1~8)·리뷰·브라우저 검증(태스크 9)과 그 수정 라운드에서 이 설계와 달라진 것만 모았다. main `f3379b8` 기준이다. Ruling 6 은 실연 뒤의 고침(`635fe76`)이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-23-attachments/ledger.md`(git 제외)의 판정과, 원장이 가리키는 보고서·리뷰(`a3-t*`·`a3-c*`)다. 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 실연(8.5, 계획 태스크 11)은 a3-t11 이 돌렸다(`docs/guides/live-smoke.md` 13절). 거기서 찾은 결함 A 의 판정이 Ruling 6 이다.

**계획이 정한 여섯**(계획 Self-Review 「스펙과 다르게 정한 것」)

- **REST 경로는 `/api/v1/attachments` 다**(2.1·4.3·6.3 정정). 기존 REST 관례를 따랐다. 웹 `attachmentHref` 가 `/api/v1/attachments/<id>[?download=1]` 을 만든다.
- **「채널 멤버」는 「세션 사용자의 워크스페이스에 속한 채널」이다**(4.3·4.4 정정). 지금 코드의 접근 규칙(`getChannel(db, id, workspaceId)`)이고, 메시지 목록·wire 구독도 같은 규칙이다. 통합 11b 는 「다른 워크스페이스 채널」로 잰다.
- **FK cascade 가 없다**(4.1·4.7 정정). 채널·메시지를 지우는 기능이 아직 없다. 마이그레이션 `0003_wandering_vargas.sql` 의 두 FK 는 `ON DELETE no action` 이다. 삭제가 생길 때 첨부 행 처리도 함께 정한다.
- **인바운드 `saveMediaBuffer` 의 `maxBytes` 는 5 MB 가 아니라 `agentFileMaxBytes`(20 MiB)다**(5.1 의 2 정정). 트리거가 릴레이된 에이전트 메시지면 에이전트가 올린 20 MiB 이하 이미지도 인바운드로 온다. 그래도 기본값에 기대지 않고 늘 준다. 순수 함수 `inboundSaveArgs` 가 잠근다. 그래서 10장의 「우리 상한 5 MB 가 방어선」은 사람이 올린 이미지에만 맞다 — 릴레이된 5~6 MiB 이미지는 그대로 간다(6 MiB 넘는 것은 Gateway 가 재압축, 스파이크 1-12).
- **채널을 옮기면 첨부 칩을 비운다**(6.1 보탬). 올리는 중인 요청은 끊는다. 초안 글은 남는다. `useComposerAttachments(channelId)` 가 채널이 바뀌거나 언마운트될 때 모두 끊고 object URL 을 푼다.
- **두 POST 의 인증은 `onRequest` 다**(4.3 보탬). 본문을 받기 전에 거절한다. 로그인 없이 5 MiB 넘게 보내면 413 이 아니라 401 이다. GET 둘도 같은 자리에 둔다.

**판정 여섯(Ruling 1~6)**

- **Ruling 1 — 인바운드 ack 상한을 이미지 수에 비례해 늘린다**(5.1 보탬). 플러그인은 이미지를 받아 저장한 뒤에야 런을 시작하고 ack 를 보낸다. 장당 받기 제한은 30초인데 어댑터 `inbound.deliver` 의 ack 제한은 10초였다. 넘으면 다시 보내 **디스패치가 두 번 될 수 있었다**(a3-t5 걱정 1 — 플러그인에 `deliveryId` dedupe 가 없다).
  지금은 `10초 + 트리거의 이미지 첨부 수 × 30초` 다(`packages/openclaw-adapter/src/openclaw-adapter.ts` 의 `DELIVER_ACK_PER_IMAGE_MS`). 재시도도 같은 값을 쓴다. 파일 첨부는 플러그인이 받지 않으므로 세지 않는다.
  **틀리면 남는 것**: 한 장 받기가 30초를 넘는 느린 링크에서는 여전히 이중 디스패치가 난다. 상한은 이미지 **수**만 보고 크기는 보지 않는다. 태스크 11 실연에서 잰다.
- **Ruling 2 — WS 스냅샷에 `MEDIA:` 줄이 있으면 finalizing 을 늘린다**(4.6 보탬). 최종 응답의 첨부 업로드가 서버 finalizing 10초와 경쟁했다. 업로드가 늦으면 폴백이 걷은 스냅샷을 저장하고, 늦게 온 정본이 **같은 답을 한 번 더** 저장한다(a3-t5 리뷰 M1).
  지금은 `finalizingMs + MEDIA 줄 수 × 30초`, 최대 120초다(`RunTimeouts.finalizingMediaLineMs`·`finalizingMaxMs`, 오케스트레이터 `extendFinalizingForMedia`). 스냅샷은 `gateway_final` 에서만 오고, 중복 final 은 상한을 다시 늘리지 않는다. 통합 11g 가 실제 시계로 잰다.
  **틀리면 남는 것**: 120초를 넘는 업로드는 여전히 두 번 저장된다(두 번째에만 첨부). 정본이 아예 안 오는 런(플러그인 끊김)도 `MEDIA:` 줄이 있으면 최대 120초 「마무리 중」으로 보인다. 실제 Gateway final 이 `MEDIA:` 줄을 남기는지는 태스크 11 에서 본다.
- **Ruling 3 — 플러그인 실패 사유는 오류 코드별 고정 문구다**(5.2 「실패하면」 정정). 로더·HTTP 원문은 채널 본문·툴 오류에 싣지 않는다. 호스트 경로 가림(`maskHostPaths`)을 넓히는 대신 원문을 아예 빼는 쪽을 골랐다.
  로더(`loadWebMediaRaw`): `not-found` → 「파일을 찾을 수 없음」, `path-not-allowed`·`network-path-not-allowed` → 「허용되지 않은 경로」, 코드 없이 `cause.code === "too-large"` → 「20 MiB 초과」, 그 밖 → 「파일을 읽지 못함」. 업로드: 413 → 「서버 상한 초과」, 다른 HTTP → 「서버가 거절함 (N)」, 네트워크 → 「서버에 올리지 못함」. 메시지당 상한 → 「메시지당 10개 초과」.
  그래서 5.2 예시 `report.pdf: 20 MiB 를 넘습니다` 는 실제로 `report.pdf: 20 MiB 초과` 다. 원문은 가려서 120자로 자른 `detail` 로 `deliver-media`·`tool-send-media` 로그에만 남는다. `maskHostPaths` 는 이 로그의 방어로만 남았다.
  **틀리면 남는 것**: 모델이 고칠 단서를 덜 받는다. `invalid-root`·`unsafe-bypass` 같은 설정 문제도 「파일을 읽지 못함」으로 뭉친다 — 원인은 로그 `detail` 로 본다.
- **Ruling 4 — components 의 `artifact://` 값 안 공백류는 플러그인이 검증 전에 퍼센트 인코딩한다**(6.3 보탬). 계약 `SafeUrl` 은 `^(https://|artifact://)\S+$` 라 `artifact://월간 보고서.pdf` 가 카드째 거절됐다(a3-t8).
  `coerceComponents` 가 사본을 만들어 `url` 키의 `artifact://` 값에서만 `\s`(스페이스·탭·줄바꿈)를 바꾼다(`packages/openclaw-plugin/src/outbound.ts` 의 `encodeArtifactWhitespace`). 계약은 그대로다. 모델용 설명(`ARTIFACT_URL_DESCRIPTION`)에 「이름에 공백이 있어도 그대로 쓴다」를 붙였다.
  **틀리면 남는 것**: 판정 때 걱정한 「다른 공백류」가 카드째 거절되는 것은 `\s` 로 함께 닫혔다. 그러나 그 이름이 풀리지는 않았다 — 서버가 저장할 때 제어 문자를 빼고 끝 공백을 다듬어, 탭·줄바꿈·끝 공백이 든 url 은 「첨부를 찾을 수 없습니다」가 됐다(a3-c1 리뷰 D1·D4). 원래 `%` 가 든 이름도 풀리지 않았다. 이 몫을 Ruling 5 가 맡는다.
- **Ruling 5 — 웹 `resolveRef` 는 이름 후보를 우선순위로 맞춘다(대안 B)**(6.3 「ref 와 name 이 같은 첫 첨부」 정정). 서버는 저장할 때 `sanitizeAttachmentName` 으로 제어 문자를 빼고 끝 공백을 다듬는다. 그래서 Ruling 4 의 인코딩을 왕복하면 현행 해석으로 **missing 이 여섯** 났다(탭·줄바꿈이 든 원래 이름, `%` 든 이름 둘, 끝 공백, `%20` 문자열과 공백이 함께 든 이름 — a3-c1 리뷰 2절).
  후보 순서: ref 그대로 → `decodeURIComponent` → 관대한 디코드(뒤에 16진 두 자리가 없는 `%` 를 `%25` 로 본다) → 셋 각각을 `sanitizeAttachmentName` 으로 다듬은 것. 다듬어 빈 후보(`%09` 처럼 폴백 `file` 이 되는 것)는 건너뛴다. 후보마다 **첨부 전체**를 보고, 후보가 다 빗나가면 id 로 찾는다(`apps/web/src/features/attachments/resolve.ts`).
  조율자 안(공백 `%XX` 만 되돌려 한 번 더 찾기)은 실측으로 기각했다 — 한 건만 닫고 새 오해석을 하나 만들었다. 다듬어 빈 후보를 거르는 가드도 조율자 예시 대신 리뷰어의 정밀 가드를 썼다(예시는 `file%20`·`fi%09le`·`.file` 을 missing 으로 만들었다).
  **남는 것**: 여섯 중 다섯과 모호 ①(`[a b.pdf, a%20b.pdf]` 에서 뒤를 뜻함)이 닫혔다. `a%20b c.pdf` 는 missing, 모호 ②(`[a%20b.pdf, a b.pdf]` 에서 뒤를 뜻함)는 앞 첨부로 풀린다 — 인코딩된 문자열만으로는 원래 이름을 가를 수 없는 본질적 모호다. 모호 ③(`[50% a b.pdf, 50% a%20b.pdf]` 에서 뒤를 뜻함)은 전에 missing 이던 것이 앞 첨부로 풀린다. 셋 다 테스트가 지금 결과를 단언한다.
- **Ruling 6 — 스트리밍 델타의 `MEDIA:` 줄은 서버가 런마다 줄 단위로 걷는다**(4.6 보탬 — 폴백만 걷던 것을 델타까지). 실연에서 결함 A 가 나왔다(a3-t11, `docs/guides/live-smoke.md` 13.4 A). 최종 응답의 `MEDIA:` 줄이 **스트리밍 델타**로 흘러 호스트 경로가 채널 버블에 ~0.5초 보이고 `run_events` 에 영구히 남았다. 폴백 `stripMediaLines` 와 플러그인 정본은 그 줄을 걷지만 델타 경로는 걷지 않았다. 경로는 `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/workspace/…` 처럼 델타 여럿으로 쪼개져 오므로 델타 하나씩 거르는 것으로는 못 막는다.
  판정(원장): **서버에서 런마다 줄 단위 필터를 건다.** 마지막 줄바꿈 뒤 조각이 (앞 공백 뒤) `MEDIA:` 로 시작하거나 그 접두일 수 있으면 붙잡는다. 줄이 끝나면 `MEDIA:` 줄은 버린다. 웹 표시만 숨기는 안은 DB 에 남아 기각했다.
  구현(`apps/server/src/modules/runs/media-lines.ts`·`orchestrator.ts`): 필터는 `TEXT_MESSAGE_CONTENT` 가 코얼레싱에 들어가기 **전**에 선다. 코얼레싱 버퍼가 곧 `run_events` 저장과 wire 팬아웃의 입구라, 여기 앞이면 둘이 한 번에 막히고 재접속 재생(DB 만 읽는다)에도 경로가 없다.
  붙잡은 조각은 `TEXT_MESSAGE_END` 직전, END 없이 끝나는 종료 전이 직전, `stop()` 에서 판정한다. `MEDIA:` 줄이면 버리고 접두일 뿐이면 내보낸다. 필터 상태는 런이 끝나면 지운다.
  `TEXT_MESSAGE_REPLACE`(Gateway `replace` 델타 → 웹이 본문을 통째로 바꾼다)도 같은 누출 경로라 새 필터로 걸러 쓴다. 이것은 브리프 밖 확장이었고 수용했다. `TOOL_CALL_ARGS` 는 그대로다(아래 「틀리면 남는 것」의 관찰 C). 걷은 수는 로그 `stream media lines dropped`(`mediaLinesDropped`)로 남긴다.
  **대소문자는 가리지 않는다**(a3-t12 리뷰 Minor 1, `635fe76`). 코어는 줄 머리 여섯 글자를 `toUpperCase` 로 `MEDIA:` 와 비교하고 `/\bMEDIA:\s*…/gi` 로 뽑는다(9.4 `dist/parse-DrPJQjPs.mjs:90`·`:311-312`, 9.5 `dist/parse-output-DGOcuzU4.mjs:9`·`:230-231` — 같은 세 줄). 그래서 `media:`·`Media: ` 줄도 첨부로 뽑히고, 대문자만 보던 필터로는 결함 A 와 같은 모양으로 샜다.
  지금 줄 정의는 `/^[ \t]*MEDIA:/i` 하나다. 폴백 `stripMediaLines`(플래그 `gim`)와 스트리밍 필터가 이 정의를 함께 쓴다. `MEDIA` 와 콜론 사이 공백(`MEDIA :`)은 코어도 보통 줄로 두므로 우리도 걷지 않는다(테스트로 잠갔다).
  보통 글은 늦어지지 않는다. 붙잡는 것은 줄 처음 조각이 `MEDIA:` 의 접두일 때뿐이고, 접두에서 벗어나는 첫 글자에서 풀린다(최악 `MEDIA` 다섯 글자 + 다음 글자). 실물에서 보통 줄 델타는 Gateway 프레임 뒤 53~58ms(코얼레싱 창 50ms)에 나갔다(a3-t13, `docs/guides/live-smoke.md` 13.7).
  **틀리면 남는 것**(원장): 줄 앞에 다른 글자가 붙은 경로(코어 관례 밖)는 샌다. 또 이 필터는 줄 머리 `MEDIA:` 만 본다. 모델이 본문에 경로를 옮겨 쓰는 것(코어가 프롬프트에 붙이는 스테이징 경로 — 실연 관찰 B)과 활동 탭 툴 인자·결과의 경로(관찰 C)는 그대로다.
  반대 방향 오류도 있다. 코어는 페이로드가 유효한 미디어일 때만 줄을 뽑고 아니면 남기는데, 필터·폴백은 `Media: …` 로 시작하는 보통 글 줄도 걷는다(a3-t12 재리뷰 N-1, 안전 쪽 오류). 셋 다 `docs/plan.md` 8장 이월이다. 이미 개발 DB 에 남은 실연 행(런 ② seq 26~28)은 이 고침이 지우지 않는다.
  **실물 확인**: 런 0회 하네스로 실제 Gateway 가 세 델타로 쪼갠 `MEDIA:`·`media:`·`Media: ` 줄이 wire·`run_events` 에 0건, 첨부는 정본으로 도착(a3-t13, 13.7). Gateway 가 `replace` 를 내지 않아 REPLACE 경로는 단위 테스트로만 잠겨 있다.

**서버에서 달라진 것**(a3-t2·t3·t4)

- **판별이 두 가지를 더 본다**(4.2 보탬). ① JPEG EXIF `orientation` 5~8 이면 가로·세로를 바꿔 저장한다 — 세로로 찍은 사진의 자리가 옆으로 잡히지 않게. ② `Uint8Array` 뷰가 바탕 버퍼 전체가 아니면 복사해 `image-size` 에 넘긴다. 그러지 않으면 `image-size` 가 뷰 밖(Buffer 풀)을 읽어 잘린 WebP 가 가짜 치수로 `image` 가 됐다 — 고치지 않은 코드에서 기존 테스트가 리뷰 실행 8회 중 1회, 구현자의 반복 실행 30회 중 29회 실패했다(a3-t2 리뷰 1·보고서 수정 라운드 1). 의존성은 `image-size` 2.0.4 정확 핀.
- **블롭 쓰기와 정리를 sha 별 잠금으로 묶는다**(4.1·4.7 보탬). 정리가 같은 sha 의 마지막 미묶음 행을 지우고 블롭을 지우는 사이에 같은 바이트가 올라오면, 새 행이 없는 블롭을 가리켰다(영구 404, 5/5 재현). 「블롭 쓰기 + 행 넣기」와 「행 수 세기 + 블롭 지우기」가 같은 잠금(`BlobLocks`)을 지난다. 잠금은 앱마다 하나이고 한 프로세스 안에서만 맞다.
- **정리가 고아 블롭과 낡은 임시 파일도 지운다**(4.7 보탬). 오래된 미묶음 행을 지운 뒤 `ATTACHMENTS_DIR` 을 훑어, 어느 행도 가리키지 않는 블롭과 1시간 넘은 `.tmp` 를 지운다. `startAttachmentSweeper` 가 겹침을 막고, 닫을 때 진행 중인 정리를 기다리고, 던져도 다음 주기에 돈다. 로그는 행이나 블롭을 하나라도 지웠을 때 남는다.
  2.2 표의 `sweep.ts` 는 없다 — 정리 함수 `sweepAttachments` 는 `service.ts` 에, 주기 실행 `startAttachmentSweeper` 는 `app.ts` 에 있다.
- **GET 은 블롭을 먼저 연다**(4.3 보탬). 행은 있는데 블롭이 없으면 500 이 아니라 404 다. 연 핸들의 크기가 저장값과 다르면 500 `INTERNAL` 이고, 로그의 `cause` 에 경로는 없다. 헤더 값은 열기 전에 계산·검사하고 **설정은 연 뒤에** 한다 — 404·500 응답에 `immutable` 캐시 헤더가 남지 않게. `filename*` 는 RFC 5987 로 인코딩한다(`encodeURIComponent` 가 남기는 `' ( ) *` 도 퍼센트). 브리지 GET 은 이미지도 `attachment` 다.
- **미묶음 인덱스는 식 인덱스가 아니다**(4.1 정정). 마이그레이션이 만든 `attachments_unbound` 는 `(message_id, created_at)` 이다 — drizzle 스키마가 만든 그대로다.
- **빈 본문 POST 는 `VALIDATION` 「빈 파일이다」**, 5 MiB 초과는 Fastify 기본 413 이다. 웹은 상태 413 을 보고 「5 MB 를 넘습니다」를 고른다.
- **묶기의 순서**(4.4 보탬). 사람 메시지는 `clientMsgId` 로 기존 메시지를 먼저 찾고 그다음에 첨부를 잡는다 — 재전송이 「이미 묶인 첨부」 오류가 아니라 처음 메시지를 받는다(Review Focus 4). 에이전트 재전송(`outboundId` dedupe)은 빠진 id 를 비워 돌려주고, 빠진 id 경고(`outbound attachments dropped`)는 트랜잭션 뒤에 남긴다.
- **폴백 로그**(4.6 보탬): `gateway snapshot media lines dropped`(`mediaLinesDropped`). 연장은 위 Ruling 2.

**플러그인에서 달라진 것**(a3-t5)

- **새 모듈 둘**(2.3 정정). 스펙은 인바운드·아웃바운드 처리를 `src/inbound.ts`·`src/outbound.ts` 에 넣는다고 했다. 구현은 SDK 를 import 하지 않는 순수 모듈 `src/inbound-media.ts`·`src/outbound-media.ts` 로 뺐다(`src/media-http.ts` 는 스펙대로). `channel.ts` 의 배선은 순수 함수 `shouldDeliverFinal`·`inboundSaveArgs`·`loaderOptions` 를 부르는 한 줄씩이다. 그 호출을 **우회하는** 변이는 테스트가 못 잡는다(8.2 방침 그대로 — 실연이 잰다).
- **인바운드 이미지는 병렬로 받는다**(5.1 의 1 「순서대로」 정정). `Promise.allSettled` 로 받고, fact·알림 줄은 첨부 순서로 모은다. 지연이 쌓이는 것을 줄이지만 대역폭이 모자란 경우는 줄지 않는다. 8초 전체 예산은 Ruling 1 과 부딪혀 넣지 않았다. 로그 `inbound-media` 에 실패 사유 `reasons`(`단계:종류`, 예 `download:http-404`)를 싣는다 — 경로는 없다.
- **이름 우선순위**(5.2 「이름」 정정): 모델이 준 이름(툴 `filename`·`deliver` 의 `attachments[i].name`) → 로더 `fileName` → 원천 basename(쿼리를 먼저 뗀 뒤) → `file`. 스펙은 로더 `fileName` 이 먼저였다. 계획 코드가 모델 이름을 먼저 두었고 구현이 코드를 따랐다(a3-t5 판단 5).
- **메시지당 10개를 넘는 원천은 읽지 않고 실패로 넣는다**(5.2 보탬). 넘긴 채 보내면 `OutboundMessage` 파싱이 `attachmentIds.max(10)` 에서 던져, 최종 응답은 텍스트까지 통째로 사라진다.
- **올리기 재시도는 네트워크 오류만 한 번이다**(5.2 보탬). 서버 응답이 계약을 어기면 다시 올리지 않는다 — 미묶음 행이 하나 더 생기지 않게.
- **`mediaMaxMb` 는 플러그인이 직접 푼다**(5.3 정정). `min(mediaMaxMb MiB, agentFileMaxBytes)`, 기본 20. `resolveChannelMediaMaxBytes` 는 쓰지 않는다.

**웹에서 달라진 것**(a3-t6·t7·c2·t9f)

- **보내는 중 항목은 로컬 미리보기가 아니라 서버 경로로 그린다**(6.1 「낙관적 메시지는 로컬 미리보기」 정정). 올린 사람은 미묶음 첨부도 읽을 수 있어서다. 보낸 뒤 곧바로 object URL 을 풀 수 있다. 보내는 중 격자에는 크게 보기가 없다.
- **업로드 실패 칩에 「다시 시도」가 없다**(7장 정정). 빼고 다시 넣는다. 11장째부터는 토스트 「이미지는 한 번에 10장까지 보낼 수 있습니다」다.
- **끌어다 놓기는 작성기 상자 전체가 받는다**(6.1 보탬). 창 전역 `dragover` 가 `dropEffect = "none"` 을 걸어 편집기 안에서는 `drop` 이 오지 않는다. 작성기가 먼저 막고 `copy` 를 건다. 작성기 밖에 놓으면 「이미지는 입력 칸에 놓아 주세요」. 붙여넣기에 이미지가 아닌 파일이 섞이면 「이미지만 올릴 수 있습니다」 토스트가 뜨고 글은 그대로 들어간다.
- **칩을 빼면 초점을 옮긴다**(6.1 보탬 — 브라우저 검증 결함 1, 고침 `f3379b8`). 다음 칩의 빼기 → 없으면 이전 칩 → 칩이 다 빠지면 「이미지 첨부」. 보낸 뒤 비우기와 채널 전환은 초점을 건드리지 않는다.
- **크게 보기**(6.4 보탬). 끝에 닿은 넘기기 버튼은 `disabled` 가 아니라 `aria-disabled` 다 — `disabled` 면 초점이 `body` 로 빠져 ←/→ 가 죽을 수 있다. `n / 전체` 는 여러 장일 때만 보이고 한 장이면 스크린 리더에만 있다. 메시지 격자와 `media` 블록이 `useImageViewer` 훅 하나를 같이 쓴다.
- **한 장 상자는 계산한 px 너비를 인라인으로 준다**(6.2 보탬). CSS Grid 칸 안에서는 `aspect-ratio` 만으로 상자가 안 잡힌다. 360×320 안에 비율대로 줄인 너비 + `maxWidth: 100%` 다(키우지는 않는다).
- **file 블록의 크기는 첨부의 값**(6.3 보탬) — 에이전트가 적은 `size` 보다 서버가 잰 값이 맞다. 첨부로 풀렸지만 자기 서버 경로를 못 만들면(`https://` 첨부 — 서버는 만들지 않는다) 「열 수 없는 링크입니다」다.

**dev:fake 대본**(a3-t8, 8.4 보탬)

- 「카드에 이미지」의 글은 「첨부를 가리킨 안내입니다」다. 계획의 「카드입니다」는 「카드」 키워드를 담아 대본이 대본을 부를 수 있었다. `DEV_FAKE_KEYWORDS` 전수 테스트가 대본 글·라벨·파일 이름에 키워드가 없음을 본다.
- 이 카드의 `file`·링크 버튼 URL 은 `artifact://월간%20보고서.pdf` 다(Ruling 4 이전에 쓴 값 — 인코딩된 채로도 풀린다).
- 되말하기 줄은 `받은 첨부 N개, 첫 이미지 W×H` 뒤 빈 줄 하나다. 이미지가 없으면 `첫 이미지 없음`, 사람이 쓴 메시지에만 붙는다.
- 웹을 다른 포트로 띄우려고 `APP_ORIGIN` 환경변수를 받는다(기본 `http://localhost:5173`).

**검증이 확인한 것**

- 통합 11a~11i(11a′·11g 둘 포함 11건) 통과. 플러그인·웹 단위와 검사 4종 통과, 테스트 1973(shared 101·plugin 108·adapter 206·server 562·web 996).
- 브라우저 검증(a3-t9, `dev:fake` 위 1280·390px): 계획 시나리오 10 + 리뷰가 넘긴 7 = **17/17 통과**, 결함 1(칩을 키보드로 빼면 초점이 `body`). 고친 뒤 실제 앱(Chromium)에서 초점 이동을 다시 쟀다(a3-t9f 리뷰 — 가운데·마지막·전부·오류 칩·올리는 중 칩). 이것으로 결함 1 범위 재검증을 갈음했다.
- 자동화가 못 잰 것(실제 OS 클립보드·끌어다 놓기)은 `docs/guides/live-smoke.md` 9.3 에 사람 몫으로 적었다.
