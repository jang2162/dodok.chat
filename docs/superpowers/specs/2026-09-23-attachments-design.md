# Phase 2 ③ 첨부·이미지 설계

**상태**: 설계 확정(2026-09-23), 구현 전
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
