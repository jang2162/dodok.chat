# Phase 2 ③ 첨부·이미지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** 사람이 올린 이미지를 에이전트가 보고, 에이전트가 만든 이미지·파일이 채널에 보이며, components 의 `artifact://` 가 실제 첨부로 풀린다.

**Architecture:** 서버가 첨부의 정본이다(로컬 디스크 블롭 + `attachments` 테이블, 경계를 넘는 꼴은 `artifact://<id>`). 원격 플러그인은 브리지 오리진의 HTTP(`GET`·`POST /bridge/attachments`, 브리지 토큰)로 바이트를 주고받고, Gateway 쪽에서는 SDK(`saveMediaBuffer`·`toInboundMediaFacts`·`loadWebMediaRaw`)만 쓴다. 웹은 쿠키 인증 `GET /api/v1/attachments/:id` 로 그린다.

**Tech Stack:** Fastify 5.12 · better-sqlite3 + drizzle 0.45 · zod 4.6 · socket.io 4.8 · OpenClaw plugin SDK 2026.9.4 · React 19.3 · Tiptap · Radix(`radix-ui` 1.6.7) · vitest 4.1 · 새 의존성 `image-size`(서버)

**Spec:** `docs/superpowers/specs/2026-09-23-attachments-design.md` — 결정 0장, 계약 3장, 서버 4장, 플러그인 5장, 웹 6장, 검증 8장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.** 근거 스파이크: `.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md`.

## Global Constraints

- 상한(shared `ATTACHMENT_LIMITS`, 스펙 3장 4): 사람 이미지 `5 * 1024 * 1024` 바이트, 에이전트 파일 `20 * 1024 * 1024` 바이트, 메시지당 `10`, 이미지 MIME `image/png`·`image/jpeg`·`image/gif`·`image/webp`. 세 패키지가 같은 상수를 import 한다 — 숫자를 다시 쓰지 않는다.
- MIME 은 **매직 바이트**로 정한다. 클라이언트·플러그인이 준 `Content-Type` 은 힌트다. **SVG 는 어떤 경우에도 `image` 가 아니다**(스펙 결정 8).
- 경계를 넘는 첨부 URL 은 `artifact://<id>` 뿐이다. **호스트 경로·내부 URL 은 어떤 텍스트(메시지 본문·에이전트 문맥·로그 메시지 본문)에도 쓰지 않는다**(스펙 4.5, 스파이크 1-16).
- 서버는 외부 URL 을 가져오지 않는다(스펙 결정 9).
- 플러그인: **모듈 스코프 상태 금지**(ADR 0004). 공유 표면인 `BridgeClient` 의 모양을 바꾸지 않는다(바꾸면 레지스트리 키 `v1` 을 올려야 한다). 바이트는 `loadWebMediaRaw` 로만 읽는다 — `fs.readFile` 직접 금지. 옛 `MediaPath*` 필드 금지(2026-10-01 제거 예정).
- REST 경로는 기존 관례대로 `/api/v1/...` 이다. 스펙의 `/api/attachments` 는 `/api/v1/attachments` 로 읽는다.
- 접근 규칙: 스펙의 「채널 멤버」는 지금 코드의 규칙(**세션 사용자의 워크스페이스에 속한 채널** — `getChannel(db, id, workspaceId)`)으로 읽는다. 메시지 목록·wire 구독이 같은 규칙이다.
- 문구(웹): 「이미지만 올릴 수 있습니다」 · 「5 MB 를 넘습니다」 · 「첨부를 찾을 수 없습니다」 · 「열 수 없는 링크입니다」(기존) · 「이미지를 불러오지 못했습니다」 · 「이미지를 올리는 중입니다」 · 「올리지 못한 이미지를 빼 주세요」 · 「<이름> 크게 보기」 · 「원본 내려받기」. 옛 문구 「첨부는 곧 지원합니다」·「이미지는 Phase 2 에서 지원합니다」는 코드·테스트에서 사라진다.
- 문구(에이전트 쪽): `[첨부 파일: <이름>]` · `[이미지를 불러오지 못했습니다: <이름>]` · `[이미지 N장]` · `[파일: <이름>]` · 툴 오류 `dodok: 첨부를 보내지 못했습니다 — <이름>: <사유>` · 최종 응답 꼬리 `_첨부 N개를 보내지 못했습니다: <이름> (<사유>)_`.
- 의존성 추가는 서버 `image-size` 하나, **정확 버전 핀**(`pnpm -F @dodok/server add -E image-size@<최신 2.x>`). 웹은 추가 0.
- OpenClaw SDK 9.4 타입에 쓰는 것이 모두 있음을 계획 작성 때 확인했다: `openclaw/plugin-sdk/channel-inbound` 의 `toInboundMediaFacts`, `buildContext` 파라미터 `media?: InboundMediaFacts[]`, 런타임 `channel.media.saveMediaBuffer(buffer, contentType?, subdir?, maxBytes?, originalFilename?)` → `{ id, path, size, contentType? }`, `openclaw/plugin-sdk/web-media` 의 `loadWebMediaRaw(url, { maxBytes, localRoots, readFile, workspaceDir })` → `{ buffer, contentType?, kind, fileName? }`, `ChannelMessageActionContext.cfg`·`.mediaAccess`.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 패키지 스코프(`feat(server):`, `feat(plugin):`, `feat(web):`, `feat(shared):`). 워커 트레일러는 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code. 테스트 수는 **자기 실행 출력에서** 패키지별로 옮긴다.

## Review Focus

1. **한국어·공백·따옴표·이모지가 든 파일 이름**(`보고서 "최종" 😀.pdf`)이 브리지 헤더 → 저장 → `Content-Disposition` 을 지나 **내려받을 때 같은 이름**이어야 한다. 헤더 주입(`\r\n`)도 막혀야 한다. → 태스크 3 테스트.
2. **같은 바이트를 두 번 올리면**(두 사람, 또는 한 메시지 안에 두 번) 행은 둘, 블롭은 하나다. 한 행이 정리돼도 다른 행의 이미지는 계속 열린다. → 태스크 2 테스트.
3. **글 없는 이미지 메시지**가 작성기 → 서버 → 에이전트 인바운드까지 간다. 에이전트 문맥 본문이 빈 문자열이어도 이미지 fact 는 실린다. → 태스크 4(11a′)·태스크 5 테스트.
4. **ack 를 잃고 다시 보내기**: 첫 `message.send` 가 서버에 저장됐는데 ack 가 안 와 같은 `clientMsgId`·같은 첨부 id 로 다시 보내면, 「이미 묶인 첨부」 오류가 아니라 **처음 메시지를 그대로** 돌려받아야 한다. → 태스크 4 테스트.
5. **아주 긴 이미지**(300×6000)·**아주 넓은 이미지**(6000×300)가 목록 줄을 망가뜨리지 않는다 — 한 장이면 최대 360×320 상자 안에 비율대로, 자리는 저장된 가로·세로로 미리 잡힌다. → 태스크 6 테스트.

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/domain/index.ts` | 1 | `ATTACHMENT_LIMITS`·`isImageMime`·`sanitizeAttachmentName`·`artifactUrl`·`parseArtifactUrl` |
| `packages/shared/src/wire/index.ts` | 1 | `MessageSend` refine |
| `packages/shared/src/bridge/index.ts` | 1 | `OutboundMessage.attachmentIds`, `BRIDGE_ATTACHMENTS_PATH`·`BRIDGE_ATTACHMENT_HEADERS` |
| `apps/server/src/db/schema.sqlite.ts` + `apps/server/drizzle/0003_*.sql` | 2 | `attachments` 테이블 |
| `apps/server/src/modules/attachments/sniff.ts` | 2 | 매직 바이트 판별(순수) |
| `apps/server/src/modules/attachments/store.ts` | 2 | 블롭 쓰기·경로·지우기 |
| `apps/server/src/modules/attachments/service.ts` | 2 | 올리기·잡기(claim)·묶기·읽기 권한·정리 |
| `apps/server/src/modules/attachments/routes.ts` | 3 | REST 둘 + 브리지 HTTP 둘 |
| `apps/server/src/config.ts`·`app.ts` | 3 | `ATTACHMENTS_DIR`, 라우트·정리 타이머 배선 |
| `packages/openclaw-adapter/src/index.ts` | 3 | `verifyBridgeToken` export |
| `apps/server/src/modules/messages/service.ts`·`realtime/socket.ts` | 4 | 사람·에이전트 메시지에 첨부 묶기 |
| `apps/server/src/modules/runs/context.ts`·`orchestrator.ts` | 4 | 인바운드 첨부·문맥 자리표시, 폴백 `MEDIA:` 걷기 |
| `apps/server/test/helpers/png.ts` | 4 | 테스트용 PNG 생성기 |
| `apps/server/test/fakes/fake-plugin.ts`·`scenario.ts` | 4 | 가짜 플러그인 받기·올리기, 대본 `attachments` |
| `apps/server/test/integration/attachments.test.ts` | 4 | 시나리오 11a~11i |
| `packages/openclaw-plugin/src/media-http.ts` | 5 | 브리지 HTTP 받기·올리기(순수, `fetch` 주입) |
| `packages/openclaw-plugin/src/inbound-media.ts` | 5 | 인바운드 첨부 → facts + 알림 줄(순수) |
| `packages/openclaw-plugin/src/outbound-media.ts` | 5 | 원천 모으기·이름·올리기·실패 문구(순수) |
| `packages/openclaw-plugin/src/outbound.ts`·`config.ts`·`components-schema.ts`·`channel.ts`·`openclaw.plugin.json` | 5 | 배선·설정·모델 설명 |
| `apps/web/src/features/attachments/{url,resolve,format}.ts` | 6 | 경로·해석·크기 문구(순수) |
| `apps/web/src/features/attachments/{AttachmentGrid,FileCard,ImageViewer,MessageAttachments}.tsx` | 6 | 그리기·크게 보기 |
| `apps/web/src/features/components/blocks/*`·`features/messages/MessageItem.tsx` | 6 | 해석기 연결 |
| `apps/web/src/features/attachments/upload.ts`·`useComposerAttachments.ts` | 7 | XHR 업로드·작성기 상태 |
| `apps/web/src/features/composer/{Composer,PendingAttachments,useSendMessage}.tsx` 등 | 7 | 작성기 UI·전송 |
| `apps/server/scripts/dev-fake.ts`·`apps/server/test/fakes/scenario.ts` | 8 | dev:fake 대본 키워드 |
| 문서 | 10 | 구성·계획서·실연 가이드 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 shared 계약 | — |
| B | 2 서버 저장소 ‖ 5 플러그인 ‖ 6 웹 표시 | 1 |
| C | 3 서버 경로 | 2 |
| D | 4 서버 묶기·통합 ‖ 7 웹 작성기 | 3 (4) · 6 (7) |
| E | 8 dev:fake 대본 | 4·5·7 |
| F | 9 브라우저 검증 → 수정 → 재검증 | 8 |
| G | 10 문서 | 9 |
| H | 11 실연(사용자 승인) | 10 |

병렬 태스크끼리 같은 파일을 만지지 않는다: 2(서버 `modules/attachments`·스키마) · 5(`packages/openclaw-plugin`) · 6(웹 `features/attachments`·`components`·`messages`). 7 은 6 이 만든 `features/attachments/` 에 파일을 **더하기만** 한다.

---

### Task 1: shared 계약

**Files:**
- Modify: `packages/shared/src/domain/index.ts`(`Attachment` 곁)
- Modify: `packages/shared/src/wire/index.ts:26-32`(`MessageSend`)
- Modify: `packages/shared/src/bridge/index.ts:82-96`(`OutboundMessage`)
- Modify: `packages/openclaw-plugin/src/outbound.ts`(`attachments: []` → `attachmentIds: []` — 타입 검사를 지키는 최소 변경)
- Modify: 가짜·테스트에서 `OutboundMessage.attachments` 를 쓰는 곳(`grep -rn "attachments" apps/server/test packages/openclaw-plugin/test packages/openclaw-adapter`로 찾는다)
- Test: `packages/shared/test/attachments.test.ts`(새), `packages/shared/test/*` 의 기존 wire·bridge 테스트

**Interfaces:**
- Produces:
  - `ATTACHMENT_LIMITS: { readonly userImageMaxBytes: 5242880; readonly agentFileMaxBytes: 20971520; readonly perMessage: 10; readonly imageMimes: readonly ["image/png","image/jpeg","image/gif","image/webp"] }`
  - `isImageMime(mime: string): boolean`
  - `sanitizeAttachmentName(raw: string): string`
  - `artifactUrl(id: string): string` · `parseArtifactUrl(url: string): string | null`
  - `MessageSend` — `bodyMd: string(max 100000)`, refine 「본문이 공백뿐이면 첨부 ≥1」
  - `OutboundMessage.attachmentIds: string[]`(Id, max 10, default `[]`). `attachments` 필드는 없다.
  - `BRIDGE_ATTACHMENTS_PATH = "/bridge/attachments"` · `BRIDGE_ATTACHMENT_HEADERS = { fileName: "x-dodok-file-name", channelId: "x-dodok-channel-id" }`

- [ ] **Step 1: 실패하는 테스트**

```ts
// packages/shared/test/attachments.test.ts
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  artifactUrl,
  isImageMime,
  MessageSend,
  OutboundMessage,
  parseArtifactUrl,
  sanitizeAttachmentName,
} from "../src";

const ID = "01a0cc16-22ee-7018-826c-e4783d25fa14";

describe("첨부 계약", () => {
  it("상한 값", () => {
    expect(ATTACHMENT_LIMITS.userImageMaxBytes).toBe(5 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.agentFileMaxBytes).toBe(20 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.perMessage).toBe(10);
  });

  it("이미지 MIME 은 넷뿐이고 SVG 는 아니다", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(isImageMime(m)).toBe(true);
    for (const m of ["image/svg+xml", "image/bmp", "text/html", "IMAGE/PNG", ""]) expect(isImageMime(m)).toBe(false);
  });

  it("이름에서 경로 구분자·제어 문자를 빼고, 비면 file", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeAttachmentName("a\\b/c.png")).toBe("abc.png");
    expect(sanitizeAttachmentName("보고서\r\n최종.pdf")).toBe("보고서최종.pdf");
    expect(sanitizeAttachmentName("  ...숨김.txt ")).toBe("숨김.txt");
    expect(sanitizeAttachmentName("///")).toBe("file");
    expect(sanitizeAttachmentName("가".repeat(300))).toHaveLength(255);
    expect(sanitizeAttachmentName('보고서 "최종" 😀.pdf')).toBe('보고서 "최종" 😀.pdf');
  });

  it("artifact URL 왕복", () => {
    expect(artifactUrl(ID)).toBe(`artifact://${ID}`);
    expect(parseArtifactUrl(`artifact://${ID}`)).toBe(ID);
    expect(parseArtifactUrl("artifact://report.pdf")).toBeNull(); // id 가 아니면 null — 이름 해석은 웹 몫
    expect(parseArtifactUrl(`https://x/${ID}`)).toBeNull();
    expect(parseArtifactUrl(` artifact://${ID}`)).toBeNull();
  });

  it("MessageSend: 본문이 비면 첨부가 있어야 한다", () => {
    const base = { channelId: ID, clientMsgId: "c1" };
    expect(MessageSend.safeParse({ ...base, bodyMd: "안녕" }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, bodyMd: "", attachments: [ID] }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, bodyMd: "  \n", attachments: [ID] }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, bodyMd: "" }).success).toBe(false);
    expect(MessageSend.safeParse({ ...base, bodyMd: " ", attachments: [] }).success).toBe(false);
    expect(MessageSend.safeParse({ ...base, bodyMd: "x", attachments: Array(11).fill(ID) }).success).toBe(false);
  });

  it("OutboundMessage 는 attachmentIds 를 받고 옛 attachments 는 버린다", () => {
    const m = OutboundMessage.parse({
      outboundId: "o1",
      channelId: ID,
      agentId: "dev",
      sessionKey: `agent:dev:dodok:channel:${ID}`,
      text: "",
      attachments: [{ id: ID }],
      ts: "2026-09-23T00:00:00.000Z",
    });
    expect(m.attachmentIds).toEqual([]);
    expect("attachments" in m).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/shared test -- attachments` → import 오류로 FAIL.

- [ ] **Step 3: 구현**

```ts
// packages/shared/src/domain/index.ts — Attachment 정의 바로 뒤
/** 첨부 상한(스펙 3장 4). 웹·서버·플러그인이 같은 값을 읽는다 */
export const ATTACHMENT_LIMITS = {
  userImageMaxBytes: 5 * 1024 * 1024,
  agentFileMaxBytes: 20 * 1024 * 1024,
  perMessage: 10,
  imageMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
} as const;

/** 그려도 되는 이미지 MIME 인가 — SVG 는 스크립트 면이라 아니다(스펙 결정 8). 대소문자를 맞춰 주지 않는다 */
export function isImageMime(mime: string): boolean {
  return (ATTACHMENT_LIMITS.imageMimes as readonly string[]).includes(mime);
}

/** 표시·`artifact://` 해석용 이름. 경로 구분자·제어 문자를 빼고 앞뒤 공백과 앞쪽 점을 걷는다. 비면 "file", 최대 255자 */
export function sanitizeAttachmentName(raw: string): string {
  const cleaned = Array.from(raw.replace(/[\p{Cc}/\\]/gu, "").trim().replace(/^\.+/, "").trim())
    .slice(0, 255)
    .join("");
  return cleaned || "file";
}

const ARTIFACT_ID_RE = /^artifact:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const artifactUrl = (id: string): string => `artifact://${id}`;
/** 서버 첨부 id 를 가리키는 `artifact://<uuid>` 면 id, 아니면 null */
export function parseArtifactUrl(url: string): string | null {
  return ARTIFACT_ID_RE.exec(url)?.[1]?.toLowerCase() ?? null;
}
```

`"가".repeat(300)` 이 255 가 되도록 `Array.from` 으로 코드 포인트 단위로 자른다(이모지를 반으로 가르지 않는다). 테스트가 `toHaveLength(255)` 로 문자열 길이를 보므로 BMP 글자로 쟀다.

```ts
// packages/shared/src/wire/index.ts
export const MessageSend = z
  .object({
    channelId: Id,
    clientMsgId: z.string().min(1).max(64),
    bodyMd: z.string().max(100_000), // 토큰 본문. 첨부가 있으면 비어도 된다
    attachments: z.array(Id).max(10).optional(), // 업로드 API로 먼저 올린 첨부 id
    replyTo: Id.optional(),
  })
  .refine((v) => v.bodyMd.trim() !== "" || (v.attachments?.length ?? 0) > 0, {
    message: "본문이나 첨부 중 하나는 있어야 한다",
    path: ["bodyMd"],
  });
```

```ts
// packages/shared/src/bridge/index.ts — OutboundMessage 의 attachments 줄을 바꾼다
  /** 브리지 HTTP 로 먼저 올린 첨부 id(스펙 3장 2). 이름·크기·MIME 은 서버 기록이 정본이다 */
  attachmentIds: z.array(Id).max(10).default([]),

// 파일 끝
/** 브리지 HTTP 첨부 경로와 헤더(스펙 3장 5). 인증은 `Authorization: Bearer <브리지 토큰>` */
export const BRIDGE_ATTACHMENTS_PATH = "/bridge/attachments";
export const BRIDGE_ATTACHMENT_HEADERS = { fileName: "x-dodok-file-name", channelId: "x-dodok-channel-id" } as const;
```

`import { Attachment } from "../domain"` 이 bridge 에서 더 안 쓰이면 `InboundDeliver` 가 여전히 쓰므로 남는다.

플러그인 `buildOutboundMessage` 의 `attachments: []` 두 곳을 `attachmentIds: []` 로 바꾸고, 반환 객체의 `attachments: message.attachments` 를 `attachmentIds: message.attachmentIds` 로 바꾼다. 가짜 플러그인·테스트의 기대값도 같이.

- [ ] **Step 4: 통과 확인** — `pnpm -F @dodok/shared test` PASS, 루트 `pnpm typecheck` exit 0(다른 패키지의 `attachments` 참조가 모두 바뀌었는지).

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src packages/shared/test/attachments.test.ts packages/openclaw-plugin/src/outbound.ts <바꾼 테스트 경로>
git commit -m "feat(shared): 첨부 상한·이름·artifact URL 계약과 attachmentIds"
```

---

### Task 2: 서버 저장소 (판별·블롭·서비스·정리)

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(새 테이블), Create: `apps/server/drizzle/0003_*.sql`(`pnpm -F @dodok/server db:generate`)
- Create: `apps/server/src/modules/attachments/{sniff,store,service}.ts`
- Modify: `apps/server/package.json`(`image-size` 정확 핀)
- Test: `apps/server/test/attachments.sniff.test.ts`, `apps/server/test/attachments.service.test.ts`, `apps/server/test/helpers/png.ts`(새 — 태스크 4·8 도 쓴다)

**Interfaces:**
- Consumes: 태스크 1 `ATTACHMENT_LIMITS`·`sanitizeAttachmentName`·`artifactUrl`·`Attachment`
- Produces:
  - `sniff(bytes: Uint8Array, hint?: string): { kind: "image" | "file"; mime: string; width?: number; height?: number }`
  - `writeBlob(dir: string, bytes: Uint8Array): Promise<string /* sha256 hex */>` · `blobPath(dir: string, sha: string): string`
  - `type Uploader = { type: "user"; userId: string } | { type: "bridge" }`
  - `uploadAttachment(deps: AttachmentDeps, input: { channelId: string; uploader: Uploader; bytes: Uint8Array; nameHint?: string; mimeHint?: string }): Promise<Attachment>`
  - `claimUserAttachments(tx: DbOrTx, input: { ids: string[]; channelId: string; userId: string }): Attachment[]` — 틀리면 `apiError("VALIDATION", …)`
  - `claimBridgeAttachments(tx: DbOrTx, input: { ids: string[]; channelId: string }): { accepted: Attachment[]; dropped: string[] }`
  - `markBound(tx: DbOrTx, ids: string[], messageId: string): void`
  - `findReadable(deps: AttachmentDeps, id: string, viewer: { type: "user"; userId: string; workspaceId: string } | { type: "bridge" }): { attachment: Attachment; path: string } | undefined`
  - `sweepAttachments(deps: AttachmentDeps, opts?: { unboundTtlMs?: number }): Promise<{ rows: number; blobs: number }>`
  - `type AttachmentDeps = { db: Db; dir: string; now?: () => Date }`
  - 테스트 헬퍼 `makePng(width: number, height: number): Buffer`

- [ ] **Step 1: 테스트 헬퍼 — 진짜 PNG 를 만든다**

```ts
// apps/server/test/helpers/png.ts
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 단색 RGB PNG. `image-size` 와 브라우저가 둘 다 읽는 실제 PNG 다 */
export function makePng(width: number, height: number, rgb: [number, number, number] = [30, 120, 200]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const HTML_BYTES = Buffer.from("<!doctype html><script>alert(1)</script>");
```

- [ ] **Step 2: 판별 테스트(실패)**

```ts
// apps/server/test/attachments.sniff.test.ts
import { describe, expect, it } from "vitest";
import { sniff } from "../src/modules/attachments/sniff";
import { HTML_BYTES, makePng, PDF_BYTES, SVG_BYTES } from "./helpers/png";

describe("sniff — 매직 바이트가 힌트를 이긴다", () => {
  it("PNG 는 image 이고 가로·세로를 읽는다", () => {
    expect(sniff(makePng(3, 2), "application/octet-stream")).toEqual({ kind: "image", mime: "image/png", width: 3, height: 2 });
  });
  it("JPEG·GIF·WebP 머리", () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    expect(sniff(gif)).toMatchObject({ kind: "image", mime: "image/gif", width: 1, height: 1 });
    // JPEG·WebP 는 image-size 가 읽는 실제 파일이 필요하다 — 작은 샘플을 base64 상수로 테스트 파일에 둔다
  });
  it("PDF 는 file/application/pdf", () => {
    expect(sniff(PDF_BYTES, "image/png")).toEqual({ kind: "file", mime: "application/pdf" });
  });
  it("SVG 는 어떤 힌트로도 image 가 아니고 image/svg+xml 로도 나가지 않는다", () => {
    for (const hint of [undefined, "image/svg+xml", "image/png", "text/html"])
      expect(sniff(SVG_BYTES, hint)).toEqual({ kind: "file", mime: "application/octet-stream" });
  });
  it("PNG 라고 한 HTML 은 file/octet-stream", () => {
    expect(sniff(HTML_BYTES, "image/png")).toEqual({ kind: "file", mime: "application/octet-stream" });
    expect(sniff(HTML_BYTES, "text/html; charset=utf-8")).toEqual({ kind: "file", mime: "application/octet-stream" });
  });
  it("허용된 텍스트 힌트는 살린다(매개변수는 뗀다)", () => {
    expect(sniff(Buffer.from("a,b\n1,2\n"), "text/csv; charset=utf-8")).toEqual({ kind: "file", mime: "text/csv" });
    expect(sniff(Buffer.from("hi"), "TEXT/PLAIN")).toEqual({ kind: "file", mime: "text/plain" });
  });
  it("PNG 머리만 있고 몸이 망가지면 file 로 내린다", () => {
    expect(sniff(makePng(3, 2).subarray(0, 12))).toEqual({ kind: "file", mime: "application/octet-stream" });
  });
});
```

JPEG·WebP 샘플은 `makePng(2, 2)` 로 만든 PNG 를 macOS `sips -s format jpeg|webp in.png --out out.<ext>` 로 바꿔 base64 상수로 테스트 파일 안에 둔다(만든 명령을 주석으로). `sips` 가 WebP 를 못 쓰면 WebP 는 `RIFF????WEBPVP8 ` 머리만 가진 바이트로 「머리는 맞고 몸이 망가짐 → file」 사례만 둔다 — 그 사실을 보고서에 적는다.

- [ ] **Step 3: 실패 확인** — `pnpm -F @dodok/server test -- attachments.sniff` FAIL(모듈 없음).

- [ ] **Step 4: `image-size` 를 추가하고 판별 구현**

```bash
pnpm -F @dodok/server add -E image-size@2
```

```ts
// apps/server/src/modules/attachments/sniff.ts
/**
 * 첨부 형식 판별(스펙 4.2). **매직 바이트만** 믿는다 — 힌트(클라이언트·플러그인 Content-Type)는 이미지 판정에 쓰지 않는다.
 * image 는 PNG·JPEG·GIF·WebP 넷뿐이고 가로·세로를 못 읽으면 file 로 내린다(망가진 이미지를 <img> 로 그리지 않는다)
 */
import { imageSize } from "image-size";

export type Sniffed = { kind: "image" | "file"; mime: string; width?: number; height?: number };

const TEXT_HINTS = new Set(["text/plain", "application/json", "text/csv", "application/zip"]);
const OCTET = "application/octet-stream";

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function imageMime(buf: Uint8Array): string | undefined {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, ascii("GIF87a")) || startsWith(buf, ascii("GIF89a"))) return "image/gif";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "image/webp";
  return undefined;
}

export function sniff(bytes: Uint8Array, hint?: string): Sniffed {
  const img = imageMime(bytes);
  if (img) {
    try {
      const { width, height } = imageSize(bytes);
      if (width && height) return { kind: "image", mime: img, width, height };
    } catch {
      // 머리만 맞고 몸이 망가졌다 — 아래로
    }
    return { kind: "file", mime: OCTET };
  }
  if (startsWith(bytes, ascii("%PDF-"))) return { kind: "file", mime: "application/pdf" };
  const h = hint?.split(";")[0]?.trim().toLowerCase();
  return { kind: "file", mime: h && TEXT_HINTS.has(h) ? h : OCTET };
}
```

- [ ] **Step 5: 판별 통과 확인** — `pnpm -F @dodok/server test -- attachments.sniff` PASS.

- [ ] **Step 6: 테이블과 마이그레이션**

```ts
// apps/server/src/db/schema.sqlite.ts — messages 정의 뒤
/** 첨부(스펙 4.1). message_id 가 null 이면 아직 묶이지 않은 업로드다. 블롭은 sha256 이름으로 디스크에 한 번만 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    uploaderType: text("uploader_type").notNull(), // "user" | "bridge"
    uploaderId: text("uploader_id"), // 사용자 id, 브리지면 null
    kind: text("kind").notNull(), // "image" | "file"
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    messageId: text("message_id").references(() => messages.id),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("attachments_message").on(t.messageId),
    index("attachments_sha256").on(t.sha256),
    index("attachments_unbound").on(t.messageId, t.createdAt),
  ],
);
```

`pnpm -F @dodok/server db:generate` 로 `drizzle/0003_*.sql` 을 만든다. 생성된 SQL 을 열어 테이블 하나·인덱스 셋만 있는지 본다. 채널·메시지 삭제 기능은 아직 없으므로 cascade 는 두지 않는다(스펙 4.7 의 cascade 는 삭제 기능이 생길 때 — 계획 판정).

- [ ] **Step 7: 서비스 테스트(실패)**

```ts
// apps/server/test/attachments.service.test.ts — 핵심 사례. 헬퍼는 기존 db 테스트(`test/helpers`)의 방식으로 메모리 DB·채널·사용자를 만든다
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  blobPath,
} from "../src/modules/attachments/store";
import {
  claimBridgeAttachments,
  claimUserAttachments,
  findReadable,
  markBound,
  sweepAttachments,
  uploadAttachment,
} from "../src/modules/attachments/service";
import { makePng, PDF_BYTES, SVG_BYTES } from "./helpers/png";
// 기존 헬퍼에서 db·workspace·channel·user·message 를 만드는 함수를 가져온다(없으면 이 파일 안에 작은 seed 함수를 둔다)
// sha256Of(bytes) = createHash("sha256").update(bytes).digest("hex") — 테스트 파일 안의 한 줄 헬퍼. attachments 는 db/schema.sqlite 에서

describe("attachments service", () => {
  // let db, dir, ws, chA, chB, alice, bob, msgInA  — beforeEach 에서 만든다

  it("사람 업로드: PNG → image, artifact URL, 가로·세로", async () => {
    const a = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(4, 3), nameHint: "shot.png" });
    expect(a).toMatchObject({ kind: "image", mime: "image/png", name: "shot.png", width: 4, height: 3, url: `artifact://${a.id}` });
    expect(a.thumbUrl).toBeUndefined();
  });

  it("사람은 이미지가 아니면 VALIDATION(이미지만 올릴 수 있습니다), SVG 도", async () => {
    for (const bytes of [PDF_BYTES, SVG_BYTES])
      await expect(uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes })).rejects.toMatchObject({ body: { code: "VALIDATION", message: "이미지만 올릴 수 있습니다" } });
  });

  it("상한을 넘으면 VALIDATION — 사람 5 MiB, 브리지 20 MiB", async () => {
    const big = Buffer.concat([makePng(1, 1), Buffer.alloc(ATTACHMENT_LIMITS.userImageMaxBytes)]);
    await expect(uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes: big })).rejects.toMatchObject({ body: { code: "VALIDATION" } });
    await expect(uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: big })).resolves.toMatchObject({ kind: "image" });
  });

  it("브리지 업로드: PDF 는 file, 이름이 없으면 file", async () => {
    const a = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: PDF_BYTES });
    expect(a).toMatchObject({ kind: "file", mime: "application/pdf", name: "file" });
  });

  it("[Review Focus 2] 같은 바이트 두 번 → 행 둘, 블롭 하나. 한 행이 정리돼도 다른 행은 열린다", async () => {
    const png = makePng(2, 2);
    const a = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes: png });
    const b = await uploadAttachment({ db, dir, now: () => new Date(Date.now() + 1) }, { channelId: chA, uploader: { type: "user", userId: bob }, bytes: png });
    expect(a.id).not.toBe(b.id);
    // b 를 메시지에 묶고, a 는 미묶음인 채 25시간 뒤 정리
    db.transaction((tx) => markBound(tx, [b.id], msgInA));
    const later = () => new Date(Date.now() + 25 * 3600_000);
    expect(await sweepAttachments({ db, dir, now: later })).toEqual({ rows: 1, blobs: 0 });
    const readable = findReadable({ db, dir }, b.id, { type: "user", userId: bob, workspaceId: ws });
    expect(readable && existsSync(readable.path)).toBe(true); // 같은 sha 를 b 가 쓰므로 블롭이 남는다
  });

  it("정리: 아무도 안 가리키는 블롭은 지우고, 24시간 안 된 미묶음은 남긴다", async () => {
    const old = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(5, 5) });
    const oldPath = blobPath(dir, sha256Of(makePng(5, 5)));
    expect(existsSync(oldPath)).toBe(true);
    const fresh = await uploadAttachment({ db, dir, now: () => new Date(Date.now() + 24 * 3600_000) }, { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(6, 6) });
    const res = await sweepAttachments({ db, dir, now: () => new Date(Date.now() + 25 * 3600_000) });
    expect(res).toEqual({ rows: 1, blobs: 1 });
    expect(existsSync(oldPath)).toBe(false);
    expect(findReadable({ db, dir }, old.id, { type: "user", userId: alice, workspaceId: ws })).toBeUndefined();
    expect(db.select().from(attachments).all().map((r) => r.id)).toEqual([fresh.id]);
  });

  it("claimUserAttachments: 올린 사람·같은 채널·미묶음만, 하나라도 틀리면 VALIDATION", async () => {
    const mine = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) });
    const bobs = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: bob }, bytes: makePng(1, 2) });
    const otherCh = await uploadAttachment({ db, dir }, { channelId: chB, uploader: { type: "user", userId: alice }, bytes: makePng(2, 1) });
    expect(db.transaction((tx) => claimUserAttachments(tx, { ids: [mine.id], channelId: chA, userId: alice }))).toEqual([mine]);
    for (const ids of [[bobs.id], [otherCh.id], [mine.id, "01a0cc16-0000-7000-8000-000000000000"]])
      expect(() => db.transaction((tx) => claimUserAttachments(tx, { ids, channelId: chA, userId: alice }))).toThrowError(expect.objectContaining({ body: expect.objectContaining({ code: "VALIDATION" }) }));
    db.transaction((tx) => markBound(tx, [mine.id], msgInA));
    expect(() => db.transaction((tx) => claimUserAttachments(tx, { ids: [mine.id], channelId: chA, userId: alice }))).toThrow();
  });

  it("claimBridgeAttachments: 틀린 것은 빼고 순서를 지킨다", async () => {
    const f1 = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: PDF_BYTES, nameHint: "a.pdf" });
    const f2 = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(1, 1), nameHint: "b.png" });
    const wrongCh = await uploadAttachment({ db, dir }, { channelId: chB, uploader: { type: "bridge" }, bytes: PDF_BYTES });
    const human = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) });
    const r = db.transaction((tx) => claimBridgeAttachments(tx, { ids: [f2.id, wrongCh.id, human.id, f1.id], channelId: chA }));
    expect(r.accepted.map((a) => a.name)).toEqual(["b.png", "a.pdf"]);
    expect(r.dropped).toEqual([wrongCh.id, human.id]);
  });

  it("findReadable: 묶인 것은 같은 워크스페이스 채널 사용자·브리지, 미묶음은 올린 사람만", async () => {
    const a = await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) });
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: alice, workspaceId: ws })).toBeDefined();
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: bob, workspaceId: ws })).toBeUndefined();
    expect(findReadable({ db, dir }, a.id, { type: "bridge" })).toBeUndefined();
    db.transaction((tx) => markBound(tx, [a.id], msgInA));
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: bob, workspaceId: ws })).toBeDefined();
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: bob, workspaceId: "other-ws" })).toBeUndefined();
    expect(findReadable({ db, dir }, a.id, { type: "bridge" })).toBeDefined();
  });
});
```

(`findReadable` 가 워크스페이스를 가르는 방법: 채널 행의 `workspaceId` 를 본다 — `getChannel(db, channelId, workspaceId)` 를 쓴다.)

- [ ] **Step 8: 실패 확인** — FAIL(모듈 없음).

- [ ] **Step 9: 블롭 저장소 구현**

```ts
// apps/server/src/modules/attachments/store.ts
/** 첨부 블롭(스펙 4.1). `<dir>/<sha 앞 2자>/<sha>` 에 한 번만 쓴다 — 임시 파일에 쓰고 rename 해서 반쯤 쓴 파일이 보이지 않게 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const blobPath = (dir: string, sha: string): string => join(dir, sha.slice(0, 2), sha);

export async function writeBlob(dir: string, bytes: Uint8Array): Promise<string> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = blobPath(dir, sha);
  if (existsSync(path)) return sha;
  await mkdir(join(dir, sha.slice(0, 2)), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path);
  return sha;
}

export async function removeBlob(dir: string, sha: string): Promise<void> {
  await rm(blobPath(dir, sha), { force: true });
}
```

- [ ] **Step 10: 서비스 구현**

```ts
// apps/server/src/modules/attachments/service.ts
/**
 * 첨부 올리기·잡기·묶기·읽기 권한·정리(스펙 4장). 묶기는 메시지 저장 트랜잭션 안에서 돈다 — claim 으로 검사하고
 * 메시지 행을 넣은 뒤 markBound 로 message_id 를 채운다(메시지 id 는 insert 때 정해진다)
 */
import { ATTACHMENT_LIMITS, type Attachment, artifactUrl, sanitizeAttachmentName } from "@dodok/shared";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { attachments } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { getChannel } from "../channels/service";
import { sniff } from "./sniff";
import { blobPath, removeBlob, writeBlob } from "./store";

export type AttachmentDeps = { db: Db; dir: string; now?: () => Date };
export type Uploader = { type: "user"; userId: string } | { type: "bridge" };
type Row = typeof attachments.$inferSelect;

export const UNBOUND_TTL_MS = 24 * 3600_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function toAttachment(row: Row): Attachment {
  return {
    id: row.id,
    kind: row.kind as Attachment["kind"],
    url: artifactUrl(row.id),
    name: row.name,
    mime: row.mime,
    size: row.size,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
  };
}

export async function uploadAttachment(
  deps: AttachmentDeps,
  input: { channelId: string; uploader: Uploader; bytes: Uint8Array; nameHint?: string; mimeHint?: string },
): Promise<Attachment> {
  const max = input.uploader.type === "user" ? ATTACHMENT_LIMITS.userImageMaxBytes : ATTACHMENT_LIMITS.agentFileMaxBytes;
  if (input.bytes.length > max) throw apiError("VALIDATION", "크기 상한을 넘는다", { maxBytes: max });
  if (input.bytes.length === 0) throw apiError("VALIDATION", "빈 파일이다");
  const s = sniff(input.bytes, input.mimeHint);
  if (input.uploader.type === "user" && s.kind !== "image") throw apiError("VALIDATION", "이미지만 올릴 수 있습니다");
  const sha = await writeBlob(deps.dir, input.bytes);
  const fallback = s.kind === "image" ? `image.${EXT[s.mime] ?? "bin"}` : "file";
  const row = deps.db
    .insert(attachments)
    .values({
      id: uuidv7(),
      channelId: input.channelId,
      uploaderType: input.uploader.type,
      uploaderId: input.uploader.type === "user" ? input.uploader.userId : null,
      kind: s.kind,
      name: sanitizeAttachmentName(input.nameHint ?? fallback),
      mime: s.mime,
      size: input.bytes.length,
      width: s.width ?? null,
      height: s.height ?? null,
      sha256: sha,
      messageId: null,
      createdAt: (deps.now ?? (() => new Date()))(),
    })
    .returning()
    .get();
  return toAttachment(row);
}

function rowsInOrder(tx: DbOrTx, ids: string[]): Map<string, Row> {
  if (ids.length === 0) return new Map();
  const rows = tx.select().from(attachments).where(inArray(attachments.id, ids)).all();
  return new Map(rows.map((r) => [r.id, r]));
}

export function claimUserAttachments(tx: DbOrTx, input: { ids: string[]; channelId: string; userId: string }): Attachment[] {
  if (new Set(input.ids).size !== input.ids.length) throw apiError("VALIDATION", "같은 첨부를 두 번 넣었다");
  const byId = rowsInOrder(tx, input.ids);
  return input.ids.map((id) => {
    const r = byId.get(id);
    if (!r || r.uploaderType !== "user" || r.uploaderId !== input.userId || r.channelId !== input.channelId || r.messageId !== null)
      throw apiError("VALIDATION", "쓸 수 없는 첨부다", { attachmentId: id });
    return toAttachment(r);
  });
}

export function claimBridgeAttachments(tx: DbOrTx, input: { ids: string[]; channelId: string }): { accepted: Attachment[]; dropped: string[] } {
  const byId = rowsInOrder(tx, input.ids);
  const accepted: Attachment[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const id of input.ids) {
    const r = byId.get(id);
    if (!r || seen.has(id) || r.uploaderType !== "bridge" || r.channelId !== input.channelId || r.messageId !== null) {
      dropped.push(id);
      continue;
    }
    seen.add(id);
    accepted.push(toAttachment(r));
  }
  return { accepted, dropped };
}

export function markBound(tx: DbOrTx, ids: string[], messageId: string): void {
  if (ids.length === 0) return;
  tx.update(attachments).set({ messageId }).where(inArray(attachments.id, ids)).run();
}

export function findReadable(
  deps: AttachmentDeps,
  id: string,
  viewer: { type: "user"; userId: string; workspaceId: string } | { type: "bridge" },
): { attachment: Attachment; path: string } | undefined {
  const row = deps.db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!row) return undefined;
  const ok =
    viewer.type === "bridge"
      ? row.messageId !== null // 브리지는 묶인 첨부만 — 사람이 올리고 아직 안 보낸 것은 못 본다
      : row.messageId === null
        ? row.uploaderType === "user" && row.uploaderId === viewer.userId
        : Boolean(getChannel(deps.db, row.channelId, viewer.workspaceId));
  return ok ? { attachment: toAttachment(row), path: blobPath(deps.dir, row.sha256) } : undefined;
}
```

`getChannel` 의 반환 꼴(없을 때 `undefined`/`null`)은 `channels/service.ts` 를 보고 맞춘다.

```ts
export async function sweepAttachments(deps: AttachmentDeps, opts: { unboundTtlMs?: number } = {}): Promise<{ rows: number; blobs: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (opts.unboundTtlMs ?? UNBOUND_TTL_MS));
  const stale = deps.db
    .delete(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .returning({ sha: attachments.sha256 })
    .all();
  let blobs = 0;
  for (const sha of new Set(stale.map((s) => s.sha))) {
    const still = deps.db.select({ n: sql<number>`count(*)` }).from(attachments).where(eq(attachments.sha256, sha)).get();
    if ((still?.n ?? 0) === 0) {
      await removeBlob(deps.dir, sha);
      blobs++;
    }
  }
  return { rows: stale.length, blobs };
}
```

`DbOrTx` 가 `db/client` 에 없으면 `messages/service.ts` 가 쓰는 타입을 옮겨 export 한다.

- [ ] **Step 11: 통과 확인** — `pnpm -F @dodok/server test -- attachments` PASS. 서버 전체 `pnpm -F @dodok/server test`·`typecheck` exit 0.

- [ ] **Step 12: 커밋**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/db/schema.sqlite.ts apps/server/drizzle apps/server/src/modules/attachments apps/server/test/attachments.sniff.test.ts apps/server/test/attachments.service.test.ts apps/server/test/helpers/png.ts
git commit -m "feat(server): 첨부 저장소 — 매직 바이트 판별·sha256 블롭·잡기·묶기·정리"
```

---

### Task 3: 서버 HTTP 경로

**Files:**
- Create: `apps/server/src/modules/attachments/routes.ts`
- Modify: `apps/server/src/config.ts`(`ATTACHMENTS_DIR`), `apps/server/src/app.ts`(라우트 등록·정리 타이머·close), `packages/openclaw-adapter/src/index.ts`(`verifyBridgeToken` export)
- Test: `apps/server/test/attachments.routes.test.ts`, `apps/server/test/config.test.ts`(기본값)

**Interfaces:**
- Consumes: 태스크 2 `uploadAttachment`·`findReadable`·`sweepAttachments`, 태스크 1 `BRIDGE_ATTACHMENTS_PATH`·`BRIDGE_ATTACHMENT_HEADERS`·`ATTACHMENT_LIMITS`
- Produces:
  - `POST /api/v1/attachments?channelId=<id>` — 세션. 본문 원시 바이트, 헤더 `content-type`(힌트)·`x-dodok-file-name`(퍼센트 인코딩). 200 `Attachment`
  - `GET /api/v1/attachments/:id[?download=1]` — 세션. 바이트
  - `POST /bridge/attachments` — `Authorization: Bearer <BRIDGE_TOKEN>`, 헤더 `x-dodok-channel-id`(필수)·`x-dodok-file-name`. 200 `Attachment`
  - `GET /bridge/attachments/:id` — 브리지 토큰. 묶인 첨부만
  - `registerAttachmentRoutes(fastify, ctx: { auth; db; workspaceId; dir: string; bridgeToken: string }): void`
  - `ServerConfig.attachmentsDir: string`(`ATTACHMENTS_DIR` ?? `join(DATA_DIR, "attachments")`)

- [ ] **Step 1: 실패하는 경로 테스트** — 기존 `rest.test.ts` 가 앱을 띄우는 방식(`createApp` + `FakeAdapter` + `inject`)을 따른다. 사례:

```ts
// apps/server/test/attachments.routes.test.ts — 핵심 단언만. 앱·로그인 헬퍼는 rest.test.ts 의 것을 쓴다
const NAME = '보고서 "최종" 😀.pdf';

it("사람: PNG 올리기 → 200 Attachment, 받기는 inline·nosniff·CSP·immutable", async () => {
  const up = await app.fastify.inject({
    method: "POST", url: `/api/v1/attachments?channelId=${ch}`, headers: { ...session, "content-type": "image/png", "x-dodok-file-name": encodeURIComponent("스샷.png") }, payload: makePng(4, 3),
  });
  expect(up.statusCode).toBe(200);
  const a = up.json();
  expect(a).toMatchObject({ kind: "image", name: "스샷.png", width: 4, height: 3 });
  const get = await app.fastify.inject({ method: "GET", url: `/api/v1/attachments/${a.id}`, headers: session });
  expect(get.statusCode).toBe(200);
  expect(get.headers["content-type"]).toBe("image/png");
  expect(get.headers["x-content-type-options"]).toBe("nosniff");
  expect(get.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(get.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect(get.headers["content-disposition"]).toBe("inline");
  expect(get.rawPayload.equals(makePng(4, 3))).toBe(true);
  const dl = await app.fastify.inject({ method: "GET", url: `/api/v1/attachments/${a.id}?download=1`, headers: session });
  expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''%EC%8A%A4%EC%83%B7\.png$/);
});

it("사람: 5 MiB 넘으면 413, 이미지 아니면 400 VALIDATION 「이미지만 올릴 수 있습니다」", async () => { /* bodyLimit 과 서비스 둘 다 */ });

it("사람: JSON content-type 으로 올려도 JSON 으로 파싱하지 않는다(바이트 그대로 판별)", async () => {
  const r = await app.fastify.inject({ method: "POST", url: `/api/v1/attachments?channelId=${ch}`, headers: { ...session, "content-type": "application/json" }, payload: '{"a":1}' });
  expect(r.statusCode).toBe(400);
  expect(r.json()).toMatchObject({ code: "VALIDATION", message: "이미지만 올릴 수 있습니다" });
});

it("사람: 없는 채널·다른 워크스페이스 채널 → 404, 로그인 없음 → 401", async () => {});
it("사람: 남의 미묶음 첨부 GET → 404", async () => {});

it("브리지: 토큰 없거나 틀리면 401, channel 헤더 없으면 400, 없는 채널 404", async () => {});

it("[Review Focus 1] 브리지: 한국어·따옴표·이모지 이름이 내려받기 이름으로 돌아온다", async () => {
  const up = await app.fastify.inject({
    method: "POST", url: "/bridge/attachments",
    headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, "x-dodok-channel-id": ch, "x-dodok-file-name": encodeURIComponent(NAME), "content-type": "application/pdf" },
    payload: PDF_BYTES,
  });
  expect(up.json()).toMatchObject({ kind: "file", mime: "application/pdf", name: NAME });
  // 묶은 뒤(테스트는 markBound 를 직접 부른다) 사람 GET
  const get = await app.fastify.inject({ method: "GET", url: `/api/v1/attachments/${up.json().id}`, headers: session });
  const cd = get.headers["content-disposition"] as string;
  expect(cd.startsWith('attachment; filename="')).toBe(true);
  expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? "")).toBe(NAME);
  expect(cd).not.toMatch(/[\r\n]/);
});

it("브리지: 이름 헤더의 %0d%0a 는 이름에서 빠진다(헤더 주입 없음)", async () => {
  // x-dodok-file-name: encodeURIComponent("a\r\nSet-Cookie: x=1.pdf") → name 은 "aSet-Cookie: x=1.pdf"
});

it("브리지: 잘못된 퍼센트 인코딩 이름은 400 이 아니라 기본 이름(file)", async () => {});

it("브리지 GET: 미묶음은 404, 묶인 것은 바이트", async () => {});

it("브리지 POST: 20 MiB 넘으면 413", async () => {});
```

- [ ] **Step 2: 실패 확인** — FAIL(404).

- [ ] **Step 3: 구현**

```ts
// apps/server/src/modules/attachments/routes.ts
/**
 * 첨부 HTTP(스펙 4.3). 이 스코프는 모든 content-type 을 **원시 버퍼**로 받는다 — 바깥 JSON 파서를 지우고 다시 단다.
 * 응답 헤더는 받은 파일이 무엇이든 브라우저가 문서로 실행하지 못하게 한다(nosniff·CSP sandbox·image 만 inline)
 */
import { createReadStream } from "node:fs";
import {
  ATTACHMENT_LIMITS,
  BRIDGE_ATTACHMENT_HEADERS as H,
  BRIDGE_ATTACHMENTS_PATH,
  Id,
} from "@dodok/shared";
import { verifyBridgeToken } from "@dodok/openclaw-adapter";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseParams, parseQuery } from "../../http/validate";
import { getChannel } from "../channels/service";
import { findReadable, uploadAttachment } from "./service";

export type AttachmentRouteContext = { auth: Auth; db: Db; workspaceId: string; dir: string; bridgeToken: string };

const IdParams = z.object({ id: Id });
const UploadQuery = z.object({ channelId: Id });
const DownloadQuery = z.object({ download: z.literal("1").optional() });

function fileNameHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[H.fileName];
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined; // 망가진 인코딩 — 서비스가 기본 이름을 쓴다
  }
}

function contentTypeHint(request: FastifyRequest): string | undefined {
  const v = request.headers["content-type"];
  return typeof v === "string" ? v : undefined;
}

function sendBlob(reply: FastifyReply, found: NonNullable<ReturnType<typeof findReadable>>, forceDownload: boolean) {
  const { attachment: a, path } = found;
  const inline = a.kind === "image" && !forceDownload;
  const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  reply
    .header("content-type", a.mime)
    .header("content-length", String(a.size))
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", "private, max-age=31536000, immutable")
    .header(
      "content-disposition",
      inline ? "inline" : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
  return reply.send(createReadStream(path));
}

function requireBridge(token: string) {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const provided = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : undefined;
    if (!verifyBridgeToken(token, provided)) throw apiError("UNAUTHORIZED", "브리지 토큰이 틀렸다");
  };
}

export function registerAttachmentRoutes(fastify: FastifyInstance, ctx: AttachmentRouteContext): void {
  void fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const deps = { db: ctx.db, dir: ctx.dir };

    scope.post(
      "/api/v1/attachments",
      { preHandler: requireSession(ctx), bodyLimit: ATTACHMENT_LIMITS.userImageMaxBytes },
      async (request) => {
        const { channelId } = parseQuery(UploadQuery, request.query);
        const user = sessionUser(request);
        if (!getChannel(ctx.db, channelId, user.workspaceId)) throw apiError("NOT_FOUND", "channel not found");
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes)) throw apiError("VALIDATION", "본문이 없다");
        return uploadAttachment(deps, {
          channelId,
          uploader: { type: "user", userId: user.id },
          bytes,
          nameHint: fileNameHeader(request),
          mimeHint: contentTypeHint(request),
        });
      },
    );

    scope.get("/api/v1/attachments/:id", { preHandler: requireSession(ctx) }, async (request, reply) => {
      const { id } = parseParams(IdParams, request.params);
      const { download } = parseQuery(DownloadQuery, request.query);
      const user = sessionUser(request);
      const found = findReadable(deps, id, { type: "user", userId: user.id, workspaceId: user.workspaceId });
      if (!found) throw apiError("NOT_FOUND", "attachment not found");
      return sendBlob(reply, found, download === "1");
    });

    scope.post(
      BRIDGE_ATTACHMENTS_PATH,
      { preHandler: requireBridge(ctx.bridgeToken), bodyLimit: ATTACHMENT_LIMITS.agentFileMaxBytes },
      async (request) => {
        const channelId = Id.safeParse(request.headers[H.channelId]);
        if (!channelId.success) throw apiError("VALIDATION", `${H.channelId} 헤더가 필요하다`);
        if (!getChannel(ctx.db, channelId.data, ctx.workspaceId)) throw apiError("NOT_FOUND", "channel not found");
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes)) throw apiError("VALIDATION", "본문이 없다");
        return uploadAttachment(deps, {
          channelId: channelId.data,
          uploader: { type: "bridge" },
          bytes,
          nameHint: fileNameHeader(request),
          mimeHint: contentTypeHint(request),
        });
      },
    );

    scope.get(`${BRIDGE_ATTACHMENTS_PATH}/:id`, { preHandler: requireBridge(ctx.bridgeToken) }, async (request, reply) => {
      const { id } = parseParams(IdParams, request.params);
      const found = findReadable(deps, id, { type: "bridge" });
      if (!found) throw apiError("NOT_FOUND", "attachment not found");
      return sendBlob(reply, found, true);
    });
  });
}
```

- 헤더 순서: 브리지 인증은 **본문 파싱 전에** 실패해야 한다. Fastify 는 `preHandler` 를 파싱 뒤에 부르므로 20 MiB 를 받은 뒤 401 이 된다 — `onRequest` 훅으로 바꿔 파싱 전에 막는다(`{ onRequest: requireBridge(...) }`). 세션 경로도 같은 이유로 `onRequest` 에 둘 수 있는지 `requireSession` 을 보고 정한다(쿠키 플러그인은 `onRequest` 에서 이미 파싱돼 있다). **두 POST 모두 인증을 `onRequest` 에 둔다.**
- `getChannel` 이 워크스페이스로 가르지 않거나 반환 꼴이 다르면 그 모듈에 맞춘다.
- `packages/openclaw-adapter/src/index.ts` 에 `export { verifyBridgeToken } from "./bridge/session";` 한 줄.
- 로그: 브리지 요청의 `authorization` 은 기존 로거 가림 목록(`logger.ts:11`)에 이미 있다 — 파일 이름·채널 id 는 남겨도 되고, **본문은 로그에 싣지 않는다**.

```ts
// apps/server/src/config.ts — Raw 에 한 줄
  ATTACHMENTS_DIR: z.string().optional(),
// ServerConfig 에 attachmentsDir: string, loadConfig 반환에
    attachmentsDir: c.ATTACHMENTS_DIR ?? join(c.DATA_DIR, "attachments"),
```

```ts
// apps/server/src/app.ts — registerAdapterRoutes 뒤
    mkdirSync(config.attachmentsDir, { recursive: true });
    registerAttachmentRoutes(fastify, {
      auth, db, workspaceId, dir: config.attachmentsDir, bridgeToken: config.BRIDGE_TOKEN,
    });
    // 정리(스펙 4.7): 시작 때 한 번, 그 뒤 한 시간마다. unref — 테스트·종료를 붙잡지 않는다
    const sweep = () =>
      void sweepAttachments({ db, dir: config.attachmentsDir }).then(
        (r) => (r.rows > 0 ? logger.info(r, "attachments swept") : undefined),
        (err: unknown) => logger.error({ err }, "attachments sweep failed"),
      );
    sweep();
    const sweepTimer = setInterval(sweep, 3600_000);
    sweepTimer.unref();
    undo.push({ step: "attachments-sweep", run: () => clearInterval(sweepTimer) });
```

`close()` 가 `undo` 를 역순으로 돌지 않고 따로 닫는다면, 그 경로에도 `clearInterval` 을 넣는다(app.ts 의 close 구현을 보고 맞춘다). 테스트 앱이 `dbPath: ":memory:"` 이면 `attachmentsDir` 은 테스트마다 임시 디렉터리로 준다(`test/helpers` 의 설정 함수에 `ATTACHMENTS_DIR: mkdtempSync(...)`).

- [ ] **Step 4: 통과 확인** — `pnpm -F @dodok/server test` PASS(기존 테스트 포함 — 새 스코프의 파서 교체가 다른 JSON 경로를 깨지 않았는지), `pnpm -F @dodok/openclaw-adapter test` PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/server/src/modules/attachments/routes.ts apps/server/src/config.ts apps/server/src/app.ts packages/openclaw-adapter/src/index.ts apps/server/test/attachments.routes.test.ts apps/server/test/config.test.ts apps/server/test/helpers
git commit -m "feat(server): 첨부 HTTP — 사람 올리기·받기, 브리지 올리기·받기, 정리 타이머"
```

---

### Task 4: 서버 — 메시지에 묶기, 인바운드, 폴백, 통합 11a~11i

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts`(`createUserMessage`·`createAgentMessage`)
- Modify: `apps/server/src/realtime/socket.ts:175-190`(`attachments` 를 넘긴다, 「ignored」 로그 삭제)
- Modify: `apps/server/src/modules/runs/orchestrator.ts`(`storeAgentMessage` 의 `attachmentIds`, `finalizeFromSnapshot` 의 `MEDIA:` 걷기)
- Modify: `apps/server/src/modules/runs/context.ts`(트리거 첨부·문맥 자리표시)
- Create: `apps/server/src/modules/runs/media-lines.ts`(순수 — `stripMediaLines`)
- Modify: `apps/server/test/fakes/fake-plugin.ts`(`uploadAttachment`·`downloadAttachment`), `apps/server/test/fakes/scenario.ts`(대본 `attachments`)
- Modify: `apps/server/test/helpers/scenario-steps.ts`(`uploadImage`·`sendMessage` 의 첨부 인자)
- Create: `apps/server/test/integration/attachments.test.ts`, `apps/server/test/runs.media-lines.test.ts`
- Modify: `apps/server/test/messages.service.test.ts`·`runs.context.test.ts`(단위 사례)

**Interfaces:**
- Consumes: 태스크 2 `claimUserAttachments`·`claimBridgeAttachments`·`markBound`, 태스크 3 경로, 태스크 1 계약
- Produces:
  - `CreateUserMessageInput.attachments?: string[]`(이미 있음 — 이제 받아들인다)
  - `CreateAgentMessageInput.attachmentIds?: string[]` · `createAgentMessage(db, bus, input, opts?: { onDroppedAttachments?: (ids: string[]) => void }): Message`
  - `stripMediaLines(text: string): { text: string; dropped: number }`
  - `attachmentPlaceholder(atts: readonly Attachment[]): string`(context.ts, 테스트용 export)
  - 가짜 플러그인 `uploadAttachment(input: { channelId: string; bytes: Uint8Array; name?: string; mime?: string }): Promise<Attachment>` · `downloadAttachment(id: string): Promise<{ status: number; bytes: Buffer; headers: Headers }>`
  - `ScenarioScript.attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>`
  - scenario-steps `uploadImage(live: LiveApp, channelId: string, bytes: Uint8Array, name: string): Promise<Attachment>` · `sendMessage(socket, channelId, bodyMd, opts?: { attachments?: string[]; clientMsgId?: string })`

- [ ] **Step 1: 순수 함수 테스트(실패)**

```ts
// apps/server/test/runs.media-lines.test.ts
import { describe, expect, it } from "vitest";
import { stripMediaLines } from "../src/modules/runs/media-lines";

describe("stripMediaLines — 호스트 경로가 채널에 새지 않게(스파이크 2-10)", () => {
  it("단독 줄 MEDIA: 를 걷는다", () => {
    expect(stripMediaLines("결과\n\nMEDIA:/Users/x/a.png")).toEqual({ text: "결과", dropped: 1 });
    expect(stripMediaLines("  MEDIA: https://e.com/a.png\n본문\nMEDIA:./b.pdf")).toEqual({ text: "본문", dropped: 2 });
  });
  it("줄 가운데의 MEDIA: 는 건드리지 않는다", () => {
    expect(stripMediaLines("이건 MEDIA: 라는 단어")).toEqual({ text: "이건 MEDIA: 라는 단어", dropped: 0 });
  });
  it("MEDIA 줄뿐이면 빈 문자열", () => {
    expect(stripMediaLines("MEDIA:/a.png\nMEDIA:/b.png\n")).toEqual({ text: "", dropped: 2 });
  });
  it("걷고 남은 빈 줄 셋 이상은 둘로", () => {
    expect(stripMediaLines("가\n\nMEDIA:/a\n\n나")).toEqual({ text: "가\n\n나", dropped: 1 });
  });
});
```

- [ ] **Step 2: 구현**

```ts
// apps/server/src/modules/runs/media-lines.ts
/** 코어의 레거시 첨부 관례(단독 줄 `MEDIA:<경로|URL>`)를 걷는다 — 폴백 최종본이 호스트 경로를 채널에 저장하지 않게(스펙 4.6) */
const MEDIA_LINE = /^[ \t]*MEDIA:[^\n]*(?:\n|$)/gm;

export function stripMediaLines(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const out = text.replace(MEDIA_LINE, () => {
    dropped++;
    return "";
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), dropped };
}
```

- [ ] **Step 3: 통과 확인**, 이어서 서비스·문맥 단위 테스트를 먼저 쓴다(실패):
  - `messages.service.test.ts`: 첨부 둘로 사람 메시지 → `message.attachments` 가 순서대로, 행의 `message_id` 가 채워짐 / 첨부만 있고 본문 `""` → 저장 / 남의 첨부 → VALIDATION, **메시지도 안 생김**(seq 증가 없음) / **[Review Focus 4]** 같은 `clientMsgId` 로 두 번(두 번째도 같은 첨부 id) → 같은 메시지, 오류 없음.
  - 에이전트: `attachmentIds` 둘 + 다른 채널 것 하나 → 둘만 묶이고 `onDroppedAttachments` 가 그 하나로 불림 / 같은 `externalId` 재전송 → 같은 메시지.
  - `runs.context.test.ts`: 트리거 메시지의 첨부가 `message.attachments` 에 그대로 / 이전 메시지(이미지 2 + PDF 1)의 문맥 줄이 `"본문\n[이미지 2장] [파일: a.pdf]"`, 본문이 비면 `"[이미지 2장] [파일: a.pdf]"` / 문맥·트리거 텍스트 어디에도 `artifact://`·`/`로 시작하는 경로가 없다.

- [ ] **Step 4: 구현**

`createUserMessage`: 첫 줄의 거부를 지우고, 트랜잭션 안 **기존 메시지 확인 뒤**에 잡는다(재전송은 잡기 전에 돌아간다 — Review Focus 4).

```ts
    if (existing) return { message: rowToMessage(existing), created: false };
    const claimed = claimUserAttachments(tx, {
      ids: input.attachments ?? [],
      channelId: input.channelId,
      userId: input.authorId,
    });
    const message = storeMessage(tx, input.channelId, () => {
      // … 기존 필드
      return { /* 기존 */, attachments: claimed };
    });
    markBound(tx, claimed.map((a) => a.id), message.id);
```

`createAgentMessage` 도 같은 모양 — `claimBridgeAttachments` 의 `accepted` 를 싣고 `dropped` 는 트랜잭션 **뒤에** `opts?.onDroppedAttachments?.(dropped)`(트랜잭션 안에서 로그 부르지 않는다). `MessageFields` 타입에 `attachments` 가 없으면 넣는다.

`orchestrator.storeAgentMessage`:

```ts
    return createAgentMessage(
      db, bus,
      { /* 기존 */, attachmentIds: msg.attachmentIds },
      { onDroppedAttachments: (ids) => logger.warn({ outboundId: msg.outboundId, dropped: ids }, "outbound attachments dropped") },
    );
```

`finalizeFromSnapshot`: `const raw = snapshots.get(runId) ?? ""; const { text, dropped } = stripMediaLines(raw); if (dropped > 0) logger.warn({ runId, mediaLinesDropped: dropped }, "gateway snapshot media lines dropped");` 그 뒤 기존 조건은 `text` 로.

`socket.ts`: `createUserMessage(..., { ..., attachments: input.attachments })` 로 넘기고 「message.send attachments ignored」 분기를 지운다.

`context.ts`:

```ts
/** 문맥 줄의 첨부 자리표시(스펙 4.5) — 경로·URL 은 쓰지 않는다(Gateway 가 프롬프트 속 이미지 경로를 자동 첨부한다) */
export function attachmentPlaceholder(atts: readonly Attachment[]): string {
  const images = atts.filter((a) => a.kind === "image").length;
  const parts = [
    ...(images > 0 ? [`[이미지 ${images}장]`] : []),
    ...atts.filter((a) => a.kind === "file").map((a) => `[파일: ${a.name}]`),
  ];
  return parts.join(" ");
}
const withPlaceholder = (text: string, atts: readonly Attachment[]) => {
  const p = attachmentPlaceholder(atts);
  return !p ? text : text ? `${text}\n${p}` : p;
};
```

트리거: `attachments: m.attachments`(텍스트는 그대로 — 트리거 첨부 알림 줄은 플러그인이 붙인다, 스펙 5.1-4). 문맥 select 에 `attachments: messages.attachments` 를 더하고 `text: withPlaceholder(renderForAgent(r.bodyMd, participants), r.attachments)`.

- [ ] **Step 5: 가짜 플러그인·대본 확장**

```ts
// apps/server/test/fakes/fake-plugin.ts — FakePlugin 에
    async uploadAttachment({ channelId, bytes, name, mime }) {
      const res = await fetch(`${opts.bridgeUrl}${BRIDGE_ATTACHMENTS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          [BRIDGE_ATTACHMENT_HEADERS.channelId]: channelId,
          ...(name === undefined ? {} : { [BRIDGE_ATTACHMENT_HEADERS.fileName]: encodeURIComponent(name) }),
          "content-type": mime ?? "application/octet-stream",
        },
        body: bytes,
      });
      if (!res.ok) throw new Error(`fake upload ${res.status}: ${await res.text()}`);
      return Attachment.parse(await res.json());
    },
    async downloadAttachment(id) {
      const res = await fetch(`${opts.bridgeUrl}${BRIDGE_ATTACHMENTS_PATH}/${id}`, { headers: { authorization: `Bearer ${opts.token}` } });
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    },
```

`scenario.ts` 의 `play` 는 `script.attachments` 가 있으면 먼저 올리고 `buildOutboundMessage(...)` 결과의 `message.attachmentIds` 에 넣는다. 스크립트에 `reply: ""` 도 허용(미디어만).

- [ ] **Step 6: 통합 시나리오 11a~11i(실패→통과)** — `integration/attachments.test.ts`. 스펙 8.1 의 아홉을 그대로 쓴다. 기준 꼴(11a):

```ts
it("11a 사람 이미지 → 메시지·인바운드·브리지 받기가 같은 바이트", async () => {
  live = await bootLiveApp();
  const setup = await setupRelayChannel(live, RELAY_POLICY);
  const log = await openChannelWire(live, setup.channel.id, sockets);
  createScenario({ gateway: live.gateway, plugin: live.plugin, agents: { dev: () => ({ reply: "봤어요" }) } });
  const png = makePng(8, 6);
  const att = await uploadImage(live, setup.channel.id, png, "스샷.png");
  await sendMessage(log.socket, setup.channel.id, "@dev 이거 봐", { attachments: [att.id] });
  const mine = await log.until(() => log.created.find((m) => m.authorType === "user"), "사람 메시지");
  expect(mine.attachments).toEqual([att]);
  const delivered = await vi.waitFor(() => { const d = live.plugin.received.at(-1); if (!d) throw new Error("no inbound"); return d; });
  expect(delivered.message.attachments).toEqual([att]);
  const got = await live.plugin.downloadAttachment(att.id);
  expect(got.status).toBe(200);
  expect(got.bytes.equals(png)).toBe(true);
});
```

- **11a′ [Review Focus 3]** 본문 `""` + 이미지 → 인바운드 `message.text === ""` 이고 `attachments` 한 개.
- 11b~11i 는 스펙 8.1 문장을 그대로 단언한다. 11g 는 `script.silentGateway` 없이 `holdFinal` 을 쓰지 않고, 정본을 보내지 않는 대본(기존 폴백 시나리오가 쓰는 방법 — `recovery.test.ts`·`relay.test.ts` 에서 찾는다)으로 WS 스냅샷만 흘린다. 11h 는 서비스의 `now` 를 주입할 수 없으면 DB 행의 `created_at` 을 25시간 전으로 고친 뒤 `sweepAttachments` 를 직접 부른다.

- [ ] **Step 7: 통과 확인** — `pnpm -F @dodok/server test` PASS(기존 시나리오 1~10 포함), `typecheck` exit 0.

- [ ] **Step 8: 커밋**(둘로 나눠도 된다: 서비스·문맥·폴백 / 가짜·통합)

```bash
git add apps/server/src/modules/messages/service.ts apps/server/src/realtime/socket.ts apps/server/src/modules/runs apps/server/test
git commit -m "feat(server): 메시지에 첨부 묶기·인바운드 첨부·문맥 자리표시·폴백 MEDIA 줄 걷기"
```

---

### Task 5: 플러그인 — 인바운드 이미지, 아웃바운드 미디어, 미디어 전용 응답

**Files:**
- Create: `packages/openclaw-plugin/src/{media-http,inbound-media,outbound-media}.ts`
- Modify: `packages/openclaw-plugin/src/outbound.ts`(`attachmentIds` 입력, `hasMedia`), `src/config.ts`(`mediaMaxMb`), `openclaw.plugin.json`(매니페스트 스키마), `src/components-schema.ts`(설명), `src/channel.ts`(배선)
- Test: `packages/openclaw-plugin/test/{media-http,inbound-media,outbound-media}.test.ts`, 기존 `outbound.test.ts`·`config.test.ts`·`manifest.test.ts`·`components-schema.test.ts`

**Interfaces:**
- Consumes: 태스크 1 `ATTACHMENT_LIMITS`·`BRIDGE_ATTACHMENTS_PATH`·`BRIDGE_ATTACHMENT_HEADERS`·`parseArtifactUrl`·`sanitizeAttachmentName`·`Attachment`, 태스크 3 경로(계약만 — 서버 코드는 import 하지 않는다)
- Produces:
  - `bridgeHttpOrigin(bridgeUrl: string): string`
  - `downloadAttachment(o: { origin: string; token: string; id: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<{ bytes: Buffer; mime: string }>`
  - `uploadAttachment(o: { origin; token; channelId; bytes: Uint8Array; name: string; mime?: string; fetch?; timeoutMs?; retries?: number }): Promise<Attachment>`
  - `class MediaHttpError extends Error { status?: number }`
  - `prepareInboundMedia(atts: readonly Attachment[], deps: { download(id: string): Promise<{ bytes: Buffer; mime: string }>; save(bytes: Buffer, mime: string, name: string): Promise<{ path: string; contentType?: string }> }): Promise<{ facts: Array<{ path: string; contentType: string; fileName: string; kind: "image" }>; notes: string[] }>`
  - `appendNotes(body: string, notes: readonly string[]): string`
  - `collectToolMediaSources(params: Record<string, unknown>): Array<{ src: string; name?: string }>`
  - `collectDeliverMediaSources(payload: { mediaUrls?: unknown; mediaUrl?: unknown; attachments?: unknown }): Array<{ src: string; name?: string }>`
  - `uniqueNames(names: readonly string[]): string[]`
  - `uploadOutboundMedia(items, deps: { load(src: string): Promise<{ bytes: Buffer; contentType?: string; fileName?: string }>; upload(bytes: Buffer, name: string, mime?: string): Promise<{ id: string }>; maxBytes: number }): Promise<{ ids: string[]; failures: Array<{ name: string; reason: string }> }>`
  - `toolFailureMessage(failures): string` · `deliverFailureLine(failures): string`
  - `ResolvedDodokAccount.mediaMaxBytes: number`
  - `BuildOutboundInput.attachmentIds?: string[]`, `MessageToolSendInput.hasMedia?: boolean`

- [ ] **Step 1: `media-http` 테스트(실패)**

```ts
// packages/openclaw-plugin/test/media-http.test.ts
import { describe, expect, it, vi } from "vitest";
import { bridgeHttpOrigin, downloadAttachment, MediaHttpError, uploadAttachment } from "../src/media-http";

const ID = "01a0cc16-22ee-7018-826c-e4783d25fa14";
const CH = "01a0cc14-f436-7002-8c10-bc7d4d032c2f";
const att = { id: ID, kind: "file", url: `artifact://${ID}`, name: "보고서.pdf", mime: "application/pdf", size: 3 };

describe("media-http", () => {
  it("브리지 URL → HTTP 오리진", () => {
    expect(bridgeHttpOrigin("ws://127.0.0.1:19100/bridge")).toBe("http://127.0.0.1:19100");
    expect(bridgeHttpOrigin("wss://dodok.example.com/bridge")).toBe("https://dodok.example.com");
    expect(bridgeHttpOrigin("https://dodok.example.com:8443/x")).toBe("https://dodok.example.com:8443");
  });

  it("받기: 토큰 헤더·경로, MIME 은 content-type", async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
    const r = await downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: f as never });
    expect(f).toHaveBeenCalledWith(`http://h/bridge/attachments/${ID}`, expect.objectContaining({ headers: { authorization: "Bearer t" } }));
    expect(r).toEqual({ bytes: Buffer.from([1, 2]), mime: "image/png" });
  });

  it("받기: 404 는 status 를 실은 MediaHttpError", async () => {
    const f = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: f as never })).rejects.toMatchObject({ name: "MediaHttpError", status: 404 });
  });

  it("올리기: 헤더(채널·퍼센트 인코딩 이름·content-type)와 응답 Attachment 파싱", async () => {
    const f = vi.fn(async () => Response.json(att));
    const r = await uploadAttachment({ origin: "http://h", token: "t", channelId: CH, bytes: new Uint8Array([1]), name: "보고서.pdf", mime: "application/pdf", fetch: f as never });
    expect(r).toEqual(att);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer t", "x-dodok-channel-id": CH, "x-dodok-file-name": encodeURIComponent("보고서.pdf"), "content-type": "application/pdf" });
  });

  it("올리기: 네트워크 오류는 한 번 다시, HTTP 오류는 다시 하지 않는다", async () => {
    const net = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(Response.json(att));
    await expect(uploadAttachment({ origin: "http://h", token: "t", channelId: CH, bytes: new Uint8Array([1]), name: "a", fetch: net as never })).resolves.toEqual(att);
    expect(net).toHaveBeenCalledTimes(2);
    const http = vi.fn(async () => new Response("big", { status: 413 }));
    await expect(uploadAttachment({ origin: "http://h", token: "t", channelId: CH, bytes: new Uint8Array([1]), name: "a", fetch: http as never })).rejects.toMatchObject({ status: 413 });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("응답이 계약을 어기면 던진다", async () => {
    const f = vi.fn(async () => Response.json({ id: "x" }));
    await expect(uploadAttachment({ origin: "http://h", token: "t", channelId: CH, bytes: new Uint8Array([1]), name: "a", fetch: f as never })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 구현**

```ts
// packages/openclaw-plugin/src/media-http.ts
/**
 * 브리지 오리진 HTTP 로 첨부 바이트를 주고받는다(스펙 결정 3). 모듈 상태 없음(ADR 0004), `fetch` 는 주입할 수 있다.
 * `openclaw` 를 import 하지 않는다 — 단위 테스트 대상
 */
import { Attachment, BRIDGE_ATTACHMENT_HEADERS as H, BRIDGE_ATTACHMENTS_PATH } from "@dodok/shared";

export class MediaHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MediaHttpError";
  }
}

export function bridgeHttpOrigin(bridgeUrl: string): string {
  const u = new URL(bridgeUrl);
  const protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return `${protocol}//${u.host}`;
}

type Common = { origin: string; token: string; fetch?: typeof fetch; timeoutMs?: number };
const DEFAULT_TIMEOUT_MS = 30_000;

export async function downloadAttachment(o: Common & { id: string }): Promise<{ bytes: Buffer; mime: string }> {
  const res = await (o.fetch ?? fetch)(`${o.origin}${BRIDGE_ATTACHMENTS_PATH}/${o.id}`, {
    headers: { authorization: `Bearer ${o.token}` },
    signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new MediaHttpError(`첨부 받기 실패 ${res.status}`, res.status);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream",
  };
}

export async function uploadAttachment(
  o: Common & { channelId: string; bytes: Uint8Array; name: string; mime?: string; retries?: number },
): Promise<Attachment> {
  const attempt = async (): Promise<Attachment> => {
    const res = await (o.fetch ?? fetch)(`${o.origin}${BRIDGE_ATTACHMENTS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${o.token}`,
        [H.channelId]: o.channelId,
        [H.fileName]: encodeURIComponent(o.name),
        "content-type": o.mime ?? "application/octet-stream",
      },
      body: o.bytes,
      signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new MediaHttpError(`첨부 올리기 실패 ${res.status}`, res.status);
    return Attachment.parse(await res.json());
  };
  let left = o.retries ?? 1;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof MediaHttpError || left <= 0) throw err;
      left--;
    }
  }
}
```

(`body: o.bytes` 가 Node 의 `fetch` 타입에서 `Uint8Array` 로 안 받히면 `Buffer.from(o.bytes)` 로 감싼다. 테스트의 `vi.fn` 이 받는 `init` 모양은 바뀌지 않는다.)

- [ ] **Step 3: `inbound-media` 테스트(실패) → 구현**

```ts
// packages/openclaw-plugin/test/inbound-media.test.ts — 핵심
it("이미지만 받아 저장하고 facts 에 path·contentType·fileName, url 은 없다", async () => {
  const save = vi.fn(async () => ({ path: "/m/inbound/a---1.png", contentType: "image/png" }));
  const r = await prepareInboundMedia([img("a.png"), file("b.pdf")], { download: async () => ({ bytes: Buffer.from([1]), mime: "image/png" }), save });
  expect(r.facts).toEqual([{ path: "/m/inbound/a---1.png", contentType: "image/png", fileName: "a.png", kind: "image" }]);
  expect(r.facts[0]).not.toHaveProperty("url");
  expect(r.notes).toEqual(["[첨부 파일: b.pdf]"]);
  expect(save).toHaveBeenCalledWith(Buffer.from([1]), "image/png", "a.png");
});
it("받기나 저장이 실패한 장은 빼고 알림 줄, 나머지는 계속", async () => {});
it("artifact:// 가 id 가 아니면(계약상 오지 않지만) 실패 줄", async () => {});
it("appendNotes: 본문이 비면 알림 줄만, 있으면 빈 줄 하나 뒤에", () => {
  expect(appendNotes("", ["[첨부 파일: b.pdf]"])).toBe("[첨부 파일: b.pdf]");
  expect(appendNotes("안녕", ["x", "y"])).toBe("안녕\n\nx\ny");
  expect(appendNotes("안녕", [])).toBe("안녕");
});
```

```ts
// packages/openclaw-plugin/src/inbound-media.ts
/** 인바운드 첨부 → OpenClaw media facts(스펙 5.1). SDK 는 deps 로 받는다 — `openclaw` 를 import 하지 않는다 */
import { type Attachment, parseArtifactUrl } from "@dodok/shared";

export type InboundFact = { path: string; contentType: string; fileName: string; kind: "image" };
export type InboundMediaDeps = {
  download(id: string): Promise<{ bytes: Buffer; mime: string }>;
  save(bytes: Buffer, mime: string, name: string): Promise<{ path: string; contentType?: string }>;
};

export async function prepareInboundMedia(atts: readonly Attachment[], deps: InboundMediaDeps): Promise<{ facts: InboundFact[]; notes: string[] }> {
  const facts: InboundFact[] = [];
  const notes: string[] = [];
  for (const a of atts) {
    if (a.kind !== "image") {
      notes.push(`[첨부 파일: ${a.name}]`);
      continue;
    }
    const id = parseArtifactUrl(a.url);
    try {
      if (!id) throw new Error("not an attachment id");
      const { bytes } = await deps.download(id);
      // MIME 은 서버 기록(a.mime)이 정본 — 매직 바이트로 정해졌다
      const saved = await deps.save(bytes, a.mime, a.name);
      facts.push({ path: saved.path, contentType: saved.contentType ?? a.mime, fileName: a.name, kind: "image" });
    } catch {
      notes.push(`[이미지를 불러오지 못했습니다: ${a.name}]`);
    }
  }
  return { facts, notes };
}

export function appendNotes(body: string, notes: readonly string[]): string {
  if (notes.length === 0) return body;
  return body ? `${body}\n\n${notes.join("\n")}` : notes.join("\n");
}
```

- [ ] **Step 4: `outbound-media` 테스트(실패) → 구현**

```ts
// packages/openclaw-plugin/test/outbound-media.test.ts — 핵심
it("툴 인자: mediaUrls 가 있으면 그것, 없으면 media. 빈 값·중복 제외, filename 은 첫 파일 이름", () => {
  expect(collectToolMediaSources({ media: "/a.png", mediaUrls: ["/a.png", "/b.pdf", "", "/a.png"] })).toEqual([{ src: "/a.png" }, { src: "/b.pdf" }]);
  expect(collectToolMediaSources({ media: "/a.png", filename: "보고서.png" })).toEqual([{ src: "/a.png", name: "보고서.png" }]);
  expect(collectToolMediaSources({ message: "hi" })).toEqual([]);
  expect(collectToolMediaSources({ media: 3 })).toEqual([]);
});
it("deliver payload: mediaUrls·mediaUrl, 이름은 attachments[i].name", () => {
  expect(collectDeliverMediaSources({ mediaUrls: ["/o/a---1.png", "https://x/y.png"], attachments: [{ name: "a.png" }, {}] })).toEqual([{ src: "/o/a---1.png", name: "a.png" }, { src: "https://x/y.png" }]);
  expect(collectDeliverMediaSources({ mediaUrl: "/o/b.pdf" })).toEqual([{ src: "/o/b.pdf" }]);
  expect(collectDeliverMediaSources({})).toEqual([]);
});
it("uniqueNames: 겹치면 확장자 앞에 (2)·(3)", () => {
  expect(uniqueNames(["a.png", "a.png", "b", "a.png", "b"])).toEqual(["a.png", "a (2).png", "b", "a (3).png", "b (2)"]);
});
it("올리기: 이름은 로더 fileName → 원천 이름 → basename, 순서대로 id", async () => {});
it("크기 초과는 로드 뒤 검사해 실패로 — 사유 「20 MiB 초과」", async () => {});
it("로드·올리기 실패는 이름과 짧은 사유(120자)로 모으고 나머지는 계속", async () => {});
it("툴 오류 문구·deliver 꼬리 줄", () => {
  const f = [{ name: "report.pdf", reason: "20 MiB 초과" }];
  expect(toolFailureMessage(f)).toBe("dodok: 첨부를 보내지 못했습니다 — report.pdf: 20 MiB 초과");
  expect(deliverFailureLine(f)).toBe("_첨부 1개를 보내지 못했습니다: report.pdf (20 MiB 초과)_");
});
```

```ts
// packages/openclaw-plugin/src/outbound-media.ts
/** 에이전트 미디어 → 서버 첨부(스펙 5.2). SDK 로더·업로더는 deps 로 받는다 — `openclaw` 를 import 하지 않는다 */
import { sanitizeAttachmentName } from "@dodok/shared";

export type MediaSource = { src: string; name?: string };
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

function dedupe(items: MediaSource[]): MediaSource[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.src) ? false : (seen.add(i.src), true)));
}

export function collectToolMediaSources(params: Record<string, unknown>): MediaSource[] {
  const urls = Array.isArray(params["mediaUrls"]) ? params["mediaUrls"].flatMap((v) => str(v) ?? []) : [];
  const list = urls.length > 0 ? urls : [str(params["media"])].flatMap((v) => v ?? []);
  const items = dedupe(list.map((src) => ({ src })));
  const filename = str(params["filename"]);
  if (filename && items[0]) items[0] = { ...items[0], name: filename };
  return items;
}

export function collectDeliverMediaSources(payload: { mediaUrls?: unknown; mediaUrl?: unknown; attachments?: unknown }): MediaSource[] {
  const urls = Array.isArray(payload.mediaUrls) ? payload.mediaUrls.flatMap((v) => str(v) ?? []) : [str(payload.mediaUrl)].flatMap((v) => v ?? []);
  const meta = Array.isArray(payload.attachments) ? payload.attachments : [];
  return dedupe(
    urls.map((src, i) => {
      const name = str((meta[i] as { name?: unknown } | undefined)?.name);
      return name ? { src, name } : { src };
    }),
  );
}

export function uniqueNames(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const count = (used.get(n) ?? 0) + 1;
    used.set(n, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf(".");
    return dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}

const basename = (src: string) => src.split(/[\\/]/).filter(Boolean).at(-1)?.split("?")[0] ?? "";
const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;

export type OutboundMediaDeps = {
  load(src: string): Promise<{ bytes: Buffer; contentType?: string; fileName?: string }>;
  upload(bytes: Buffer, name: string, mime?: string): Promise<{ id: string }>;
  maxBytes: number;
};

export async function uploadOutboundMedia(items: readonly MediaSource[], deps: OutboundMediaDeps): Promise<{ ids: string[]; failures: Array<{ name: string; reason: string }> }> {
  const loaded: Array<{ ok: true; bytes: Buffer; mime?: string; name: string } | { ok: false; name: string; reason: string }> = [];
  for (const item of items) {
    const guess = sanitizeAttachmentName(item.name ?? basename(item.src));
    try {
      const r = await deps.load(item.src);
      const name = sanitizeAttachmentName(item.name ?? r.fileName ?? basename(item.src));
      if (r.bytes.length > deps.maxBytes) loaded.push({ ok: false, name, reason: `${mib(deps.maxBytes)} 초과` });
      else loaded.push({ ok: true, bytes: r.bytes, ...(r.contentType ? { mime: r.contentType } : {}), name });
    } catch (err) {
      loaded.push({ ok: false, name: guess, reason: String((err as Error)?.message ?? err).slice(0, 120) });
    }
  }
  const names = uniqueNames(loaded.map((l) => l.name));
  const ids: string[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  for (const [i, l] of loaded.entries()) {
    const name = names[i] ?? l.name;
    if (!l.ok) {
      failures.push({ name, reason: l.reason });
      continue;
    }
    try {
      ids.push((await deps.upload(l.bytes, name, l.mime)).id);
    } catch (err) {
      failures.push({ name, reason: String((err as Error)?.message ?? err).slice(0, 120) });
    }
  }
  return { ids, failures };
}

export const toolFailureMessage = (f: ReadonlyArray<{ name: string; reason: string }>) =>
  `dodok: 첨부를 보내지 못했습니다 — ${f.map((x) => `${x.name}: ${x.reason}`).join(", ")}`;
export const deliverFailureLine = (f: ReadonlyArray<{ name: string; reason: string }>) =>
  `_첨부 ${f.length}개를 보내지 못했습니다: ${f.map((x) => `${x.name} (${x.reason})`).join(", ")}_`;
```

오류 사유에 **호스트 경로가 들어갈 수 있다**(로더 오류 메시지가 경로를 담는 경우). 채널 본문(`deliverFailureLine`)에 들어가므로, 사유 문자열에서 `/` 나 `\` 로 시작하는 토큰을 `<경로>` 로 바꾸는 한 줄을 넣고 테스트한다(`"ENOENT: /Users/x/a.png"` → `"ENOENT: <경로>"`). Global Constraints 「호스트 경로는 어떤 텍스트에도 쓰지 않는다」.

- [ ] **Step 5: `outbound.ts`·`config.ts`·매니페스트·스키마 설명**

- `BuildOutboundInput` 에 `attachmentIds?: string[]` — `message.attachmentIds = input.attachmentIds ?? []`.
- `messageToolSendToOutbound` 에 `hasMedia?: boolean` — 조건을 `!text && components 없음 && !hasMedia` 로. 오류 문구는 「message: 본문·components·media 중 하나는 있어야 한다」.
- `DodokAccountConfig` 에 `mediaMaxMb: z.int().min(1).max(20).optional()`, `ResolvedDodokAccount.mediaMaxBytes = Math.min((mediaMaxMb ?? 20) * 1024 * 1024, ATTACHMENT_LIMITS.agentFileMaxBytes)`. `openclaw.plugin.json` 의 `channelConfigs.dodok.schema` 에 같은 키 — `manifest.test.ts` 가 어긋남을 잡는다.
- `components-schema.ts`: `media`·`file`·링크 버튼의 `url` 설명에 한 문장 — 「이 메시지와 함께 `media` 로 보낸 파일은 `artifact://<파일 이름>` 으로 가리킨다」. 스키마 모양은 바꾸지 않는다(`components-schema.test.ts` 로 확인).

- [ ] **Step 6: `channel.ts` 배선**

```ts
// import 추가
import { toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { appendNotes, prepareInboundMedia } from "./inbound-media";
import { bridgeHttpOrigin, downloadAttachment, uploadAttachment } from "./media-http";
import { collectDeliverMediaSources, collectToolMediaSources, deliverFailureLine, toolFailureMessage, uploadOutboundMedia } from "./outbound-media";

// dispatchInbound — buildContext 앞
  const origin = bridgeHttpOrigin(account.bridgeUrl!);
  const token = account.token!;
  const save = channelRuntime.media?.saveMediaBuffer ?? getDodokRuntime().channel.media?.saveMediaBuffer;
  const inboundMedia = await prepareInboundMedia(delivery.message.attachments, {
    download: (id) => downloadAttachment({ origin, token, id }),
    save: async (bytes, mime, name) => {
      if (!save) throw new Error("saveMediaBuffer unavailable");
      // maxBytes 를 반드시 준다 — 기본 5 MB 에 기대지 않는다. 릴레이된 에이전트 이미지도 오므로 에이전트 상한으로(6 MiB 넘는 이미지는 Gateway 가 재압축한다, 스파이크 1-12)
      return await save(bytes, mime, "inbound", ATTACHMENT_LIMITS.agentFileMaxBytes, name);
    },
  });
  const media = inboundMedia.facts.length > 0 ? toInboundMediaFacts(inboundMedia.facts) : undefined;
  const body = appendNotes(facts.body, inboundMedia.notes);
  // buildContext 의 message.body·bodyForAgent 를 body 로, 그리고 media 가 있으면 `media` 를 넣는다
  logger.info(logLine("inbound-media", { deliveryId: facts.correlation.deliveryId, images: inboundMedia.facts.length, notes: inboundMedia.notes.length }));
```

- `channelRuntime.media` 가 타입에 없으면 `ChannelRuntime` 을 넓히지 말고 `getDodokRuntime().channel.media` 만 쓴다(타입을 보고 정한다). **로그에 path 를 싣지 않는다** — 개수만.
- `deliver`:

```ts
        deliver: async (payload, info) => {
          const text = payload.text ?? "";
          const sources = collectDeliverMediaSources(payload as never);
          logger.info(logLine("deliver", { /* 기존 */, media: sources.length }));
          if (info.kind !== "final" || (!text.trim() && sources.length === 0)) return;
          const outcome = sources.length === 0 ? { ids: [], failures: [] } : await uploadOutboundMedia(sources, {
            load: async (src) => {
              const r = await loadWebMediaRaw(src, { maxBytes: account.mediaMaxBytes });
              return { bytes: r.buffer, ...(r.contentType ? { contentType: r.contentType } : {}), ...(r.fileName ? { fileName: r.fileName } : {}) };
            },
            upload: (bytes, name, mime) => uploadAttachment({ origin, token, channelId: facts.channelId, bytes, name, ...(mime ? { mime } : {}) }),
            maxBytes: account.mediaMaxBytes,
          });
          const finalText = outcome.failures.length > 0 ? appendNotes(text, [deliverFailureLine(outcome.failures)]) : text;
          const built = buildOutboundMessage({ /* 기존 */, text: finalText, attachmentIds: outcome.ids });
          // …기존 전송
```

- `handleAction`: `const sources = collectToolMediaSources(actionCtx.params);` → `messageToolSendToOutbound({ ..., hasMedia: sources.length > 0 })` → 실패면 기존처럼 던짐 → `bridge` 확인 → 미디어가 있으면 계정을 `resolveDodokAccount(actionCtx.cfg, accountId)` 로 풀어 origin·token·`mediaMaxBytes` 를 얻고 `uploadOutboundMedia(sources, { load: (src) => loadWebMediaRaw(src, { maxBytes, localRoots: actionCtx.mediaAccess?.localRoots, readFile: actionCtx.mediaAccess?.readFile, workspaceDir: actionCtx.mediaAccess?.workspaceDir }) … })`. **실패가 하나라도 있으면 `throw toolInputError(toolFailureMessage(failures))`**(모델이 고칠 수 있다, 스펙 5.2). 성공하면 `built.message.attachmentIds = outcome.ids`. 로그 `tool-send` 에 `media: sources.length` 를 더한다(경로는 싣지 않는다).
- `sendText` 는 건드리지 않는다(스펙 1장 「하지 않는다」).

- [ ] **Step 7: 통과 확인** — `pnpm -F @dodok/openclaw-plugin test`·`typecheck`·`pack:plugin` exit 0(번들이 SDK 서브패스를 외부로 두는지 — `dist/index.js` 에 `openclaw/plugin-sdk/web-media` import 가 문자열로 남는다).

- [ ] **Step 8: 커밋**

```bash
git add packages/openclaw-plugin/src packages/openclaw-plugin/test packages/openclaw-plugin/openclaw.plugin.json
git commit -m "feat(plugin): 인바운드 이미지 facts·아웃바운드 미디어 업로드·미디어 전용 응답"
```

---

### Task 6: 웹 — 첨부 그리기·해석기·크게 보기

**Files:**
- Create: `apps/web/src/features/attachments/{url,resolve,format}.ts`, `{AttachmentGrid,FileCard,ImageViewer,MessageAttachments}.tsx`, 테스트 `attachments.test.tsx`·`resolve.test.ts`·`ImageViewer.test.tsx`
- Modify: `apps/web/src/features/messages/MessageItem.tsx`, `apps/web/src/features/components/{Components.tsx,blocks/MediaBlock.tsx,blocks/FileBlock.tsx,blocks/ActionsBlock.tsx,blocks/artifact.tsx}`, 기존 `blocks.test.tsx`·`a11y.test.tsx` 의 옛 문구

**Interfaces:**
- Consumes: 태스크 1 `parseArtifactUrl`·`Attachment`
- Produces:
  - `attachmentHref(a: Pick<Attachment, "url">, opts?: { download?: boolean }): string | undefined` → `/api/v1/attachments/<id>[?download=1]`
  - `type Resolved = { kind: "attachment"; attachment: Attachment } | { kind: "https"; url: string } | { kind: "missing" } | { kind: "blocked" }`
  - `resolveRef(url: string, attachments: readonly Attachment[]): Resolved`
  - `referencedAttachmentIds(components: ComponentsV1 | undefined, attachments: readonly Attachment[]): Set<string>`
  - `formatSize(bytes: number): string | undefined`(FileBlock 에서 옮김)
  - `<MessageAttachments attachments exclude? />` · `<FileCard name size? mime? href? note? />` · `<ImageViewer images index onIndexChange onClose />`(`images: Array<{ src: string; name: string; downloadHref?: string }>`)
  - `ATTACHMENT_MISSING = "첨부를 찾을 수 없습니다"` · `LINK_BLOCKED`(ActionsBlock 에서 `artifact.tsx` 로 옮김)

- [ ] **Step 1: 해석기 테스트(실패)**

```ts
// apps/web/src/features/attachments/resolve.test.ts
import { describe, expect, it } from "vitest";
import { referencedAttachmentIds, resolveRef } from "./resolve";

const ID1 = "01a0cc16-22ee-7018-826c-e4783d25fa14";
const ID2 = "01a0cc16-22ee-7018-826c-e4783d25fa15";
const a1 = { id: ID1, kind: "image" as const, url: `artifact://${ID1}`, name: "chart.png", mime: "image/png", size: 10, width: 4, height: 3 };
const a2 = { id: ID2, kind: "file" as const, url: `artifact://${ID2}`, name: "report.pdf", mime: "application/pdf", size: 20 };

describe("resolveRef — 같은 메시지 첨부만(스펙 6.3)", () => {
  it("이름으로 찾는다, 없으면 id 로", () => {
    expect(resolveRef("artifact://report.pdf", [a1, a2])).toEqual({ kind: "attachment", attachment: a2 });
    expect(resolveRef(`artifact://${ID1}`, [a1, a2])).toEqual({ kind: "attachment", attachment: a1 });
  });
  it("이름이 같은 첨부가 둘이면 첫 것", () => {
    const dup = { ...a2, id: ID1, name: "report.pdf" };
    expect(resolveRef("artifact://report.pdf", [dup, a2])).toEqual({ kind: "attachment", attachment: dup });
  });
  it("공백·한국어 이름은 퍼센트 인코딩돼 와도 찾는다", () => {
    const k = { ...a2, name: "월간 보고서.pdf" };
    expect(resolveRef("artifact://월간 보고서.pdf", [k]).kind).toBe("attachment");
    expect(resolveRef("artifact://%EC%9B%94%EA%B0%84%20%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf", [k]).kind).toBe("attachment");
  });
  it("못 찾으면 missing, https 는 그대로, 그 밖은 blocked", () => {
    expect(resolveRef("artifact://nope.png", [a1])).toEqual({ kind: "missing" });
    expect(resolveRef("https://e.com/x.png", [a1])).toEqual({ kind: "https", url: "https://e.com/x.png" });
    for (const u of ["javascript:alert(1)", " https://e.com", "HTTPS://e.com", "/api/v1/attachments/x", "artifact:/x"])
      expect(resolveRef(u, [a1])).toEqual({ kind: "blocked" });
  });
  it("referencedAttachmentIds: media·file·링크 버튼이 가리킨 것", () => {
    const components = {
      id: "c", ttlMs: 60_000, reusable: false,
      blocks: [
        { type: "media", items: [{ url: "artifact://chart.png" }, { url: "https://e.com/y.png" }] },
        { type: "actions", items: [{ type: "button", id: "b", label: "열기", style: "secondary", url: `artifact://${ID2}` }] },
      ],
    };
    expect(referencedAttachmentIds(components as never, [a1, a2])).toEqual(new Set([ID1, ID2]));
    expect(referencedAttachmentIds(undefined, [a1])).toEqual(new Set());
  });
});
```

(`components` 모양은 shared `ComponentsV1` 의 입력에 맞춘다 — 필수 필드가 다르면 테스트에서 채운다.)

- [ ] **Step 2: 구현**

```ts
// apps/web/src/features/attachments/url.ts
import { type Attachment, parseArtifactUrl } from "@dodok/shared";
/** 서버 첨부 → 같은 출처 경로(쿠키 인증). artifact://<id> 가 아니면 undefined */
export function attachmentHref(a: Pick<Attachment, "url">, opts: { download?: boolean } = {}): string | undefined {
  const id = parseArtifactUrl(a.url);
  return id ? `/api/v1/attachments/${id}${opts.download ? "?download=1" : ""}` : undefined;
}
```

```ts
// apps/web/src/features/attachments/resolve.ts
import type { Attachment, ComponentsV1 } from "@dodok/shared";

export type Resolved =
  | { kind: "attachment"; attachment: Attachment }
  | { kind: "https"; url: string }
  | { kind: "missing" }
  | { kind: "blocked" };

const PREFIX = "artifact://";

function decode(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/** 카드의 URL 한 개를 그 메시지 첨부로 푼다(스펙 6.3). 접두사로만 가른다 — 대문자·앞 공백은 blocked */
export function resolveRef(url: string, attachments: readonly Attachment[]): Resolved {
  if (url.startsWith("https://")) return { kind: "https", url };
  if (!url.startsWith(PREFIX)) return { kind: "blocked" };
  const ref = url.slice(PREFIX.length);
  if (!ref) return { kind: "missing" };
  const names = [ref, decode(ref)];
  const found =
    attachments.find((a) => names.includes(a.name)) ?? attachments.find((a) => a.id === ref.toLowerCase());
  return found ? { kind: "attachment", attachment: found } : { kind: "missing" };
}

export function referencedAttachmentIds(components: ComponentsV1 | undefined, attachments: readonly Attachment[]): Set<string> {
  const ids = new Set<string>();
  if (!components) return ids;
  const see = (url: string | undefined) => {
    if (!url) return;
    const r = resolveRef(url, attachments);
    if (r.kind === "attachment") ids.add(r.attachment.id);
  };
  for (const b of components.blocks) {
    if (b.type === "media") b.items.forEach((i) => see(i.url));
    else if (b.type === "file") see(b.url);
    else if (b.type === "actions") b.items.forEach((i) => (i.type === "button" ? see(i.url) : undefined));
  }
  return ids;
}
```

`format.ts` 는 `FileBlock.tsx` 의 `formatSize`(와 `UNITS`·`NUM`)를 그대로 옮겨 export 한다. `FileBlock` 은 거기서 import.

- [ ] **Step 3: 그리기 테스트(실패)** — `attachments.test.tsx`:
  - 이미지 한 장: `<img>` 의 `src` 가 `/api/v1/attachments/<id>`, `alt` 가 이름, `loading="lazy"`, **`width`·`height` 속성이 저장값**, 감싼 버튼 이름이 「chart.png 크게 보기」.
  - **[Review Focus 5]** 300×6000 한 장과 6000×300 한 장: 이미지 상자의 `style` 에 `aspect-ratio: 300 / 6000`(또는 `6000 / 300`), 클래스에 `max-w-[360px]`·`max-h-80`. 줄 높이 계산이 저장값으로 된다.
  - 두 장 이상이면 2열 격자.
  - 파일: 이름·크기(「20 B」)·종류(「PDF」)와 내려받기 링크(`href` = `…?download=1` 이 아니라 기본 경로 — 파일은 서버가 `attachment` 로 준다).
  - 이미지 `onError` → 파일 카드 꼴로 물러나 「이미지를 불러오지 못했습니다」와 내려받기.
  - `exclude` 에 든 id 는 그리지 않는다.
- `ImageViewer.test.tsx`: 열면 대화상자 이름이 그 이미지 이름, `n / 전체`, →·← 로 넘기고 끝에서 멈춤(되돌지 않는다), 「원본 내려받기」 링크가 `?download=1`, Esc 로 닫으면 **초점이 연 버튼으로**, `https` 이미지면 내려받기 링크가 없다.

- [ ] **Step 4: 구현** — `AttachmentGrid.tsx`:

```tsx
/** 메시지 첨부 이미지 격자(스펙 6.2). 자리는 저장된 가로·세로로 미리 잡는다 — 가상 목록에서 줄 높이가 튀지 않게 */
export function AttachmentGrid({ images, onOpen }: { images: readonly Attachment[]; onOpen: (index: number, trigger: HTMLElement) => void }) {
  const single = images.length === 1;
  return (
    <div data-slot="attachment-grid" className={cn("mt-1 grid gap-2", single ? "grid-cols-1" : "max-w-[360px] grid-cols-2")}>
      {images.map((a, i) => (
        <AttachmentImage key={a.id} attachment={a} single={single} onOpen={(el) => onOpen(i, el)} />
      ))}
    </div>
  );
}

function AttachmentImage({ attachment: a, single, onOpen }: { attachment: Attachment; single: boolean; onOpen: (el: HTMLElement) => void }) {
  const [failed, setFailed] = useState(false);
  const src = attachmentHref(a);
  if (failed || !src) return <FileCard name={a.name} size={a.size} mime={a.mime} href={src} note="이미지를 불러오지 못했습니다" />;
  const ratio = a.width && a.height ? `${a.width} / ${a.height}` : undefined;
  return (
    <button
      type="button"
      aria-label={`${a.name} 크게 보기`}
      onClick={(e) => onOpen(e.currentTarget)}
      className={cn("overflow-hidden rounded-md bg-muted focus-visible:ring-2 focus-visible:ring-ring", single ? "max-h-80 max-w-[360px]" : "aspect-square")}
      style={single && ratio ? { aspectRatio: ratio } : undefined}
    >
      <img src={src} alt={a.name} loading="lazy" width={a.width} height={a.height} onError={() => setFailed(true)} className="size-full object-contain" />
    </button>
  );
}
```

- 한 장일 때 너비가 360 을 넘지 않고 높이가 320 을 넘지 않게, `aspect-ratio` 와 `max-h-80`(320px) + `max-w-[360px]` 를 함께 준다. 아주 긴 이미지(300×6000)는 높이 320 에 맞춰 너비 16px 이 되는 게 맞다 — 크게 보기로 본다.
- `FileCard.tsx` 는 `FileBlock` 의 모양(아이콘·이름·크기·버튼)을 따르되 종류(`mime` → 「PDF」·「이미지」·「텍스트」·그 밖 확장자 대문자)를 보인다. 버튼은 `<a href={href}>` 「내려받기」(`aria-label="<이름> 내려받기"`). `href` 가 없으면 버튼 대신 `note` 글만.
- `ImageViewer.tsx` 는 `ui/dialog.tsx` 위에 짓는다. 연 요소는 `MessageAttachments` 가 `useRef` 로 쥐고, `DialogContent` 의 `onCloseAutoFocus={(e) => { e.preventDefault(); trigger?.focus(); }}` 로 돌려준다. ←/→ 는 `onKeyDown` 에서. 제목은 `DialogTitle`(이름), 설명은 시각적으로 숨긴 「n / 전체」.
- `MessageAttachments.tsx`: `attachments` 를 이미지·파일로 가르고 `exclude` 를 빼고, 격자 + 파일 카드 목록 + 뷰어 상태.
- `MessageItem.tsx`: `MessageBody` 뒤에 `<MessageAttachments attachments={message.attachments} exclude={referencedAttachmentIds(message.components, message.attachments)} />`. 본문이 빈 메시지(`bodyMd === ""`)면 `MessageBody` 를 그리지 않는다(빈 단락이 줄을 차지하지 않게).
- components 블록:
  - `Components.tsx` 의 `BlockView` 가 `MediaBlock`·`FileBlock` 에 `attachments={message.attachments}` 를 넘긴다.
  - `MediaBlock`: 항목마다 `resolveRef` — `https` 는 지금처럼(결정 8), `attachment`+`image` 는 자기 서버 이미지(누르면 크게 보기 — 블록 안 이미지만 넘긴다), `attachment`+`file` 은 `FileCard`, `missing` 은 `ATTACHMENT_MISSING`, `blocked` 는 `LINK_BLOCKED`. 크게 보기는 **https 이미지에도** 된다(내려받기 링크만 없다).
  - `FileBlock`: `attachment` → `FileCard`(이름은 블록의 `name`), `https` → 지금처럼, `missing`/`blocked` → 문구.
  - `ActionsBlock` 링크 버튼: `attachment` → `<a href={attachmentHref(a)} target="_blank" rel="noopener noreferrer">`, `https` → 지금처럼, `missing` → 비활성 + `ATTACHMENT_MISSING`, `blocked` → `LINK_BLOCKED`.
  - `artifact.tsx`: `ARTIFACT_PENDING`·`ArtifactPending` 을 지우고 `ATTACHMENT_MISSING`·`LINK_BLOCKED`·`isArtifactUrl` 을 둔다. 머리 주석을 새 뜻으로.
- 옛 문구 「첨부는 곧 지원합니다」를 단언하던 테스트는 새 동작(해석·못 찾음)으로 바꾼다 — 지우지 않는다.

- [ ] **Step 5: 통과 확인** — `pnpm -F @dodok/web test`·`typecheck`·`lint` exit 0.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/features/attachments apps/web/src/features/messages/MessageItem.tsx apps/web/src/features/components apps/web/src/a11y.test.tsx
git commit -m "feat(web): 메시지 첨부·artifact:// 해석·크게 보기"
```

---

### Task 7: 웹 — 작성기 이미지 올리기와 전송

**Files:**
- Create: `apps/web/src/features/attachments/{upload.ts,useComposerAttachments.ts}`, `apps/web/src/features/composer/PendingAttachments.tsx`, 테스트
- Modify: `apps/web/src/features/composer/{Composer.tsx,useSendMessage.ts}`, `apps/web/src/features/messages/{timeline.ts,PendingItem.tsx}`, `apps/web/src/app/fileDrop.ts`(+ 테스트)

**Interfaces:**
- Consumes: 태스크 1 `ATTACHMENT_LIMITS`·`isImageMime`, 태스크 3 `POST /api/v1/attachments`, 태스크 6 `AttachmentGrid`
- Produces:
  - `checkImageFile(file: Pick<File, "type" | "size">): string | undefined` — 「이미지만 올릴 수 있습니다」/「5 MB 를 넘습니다」
  - `uploadImage(file: File, channelId: string, onProgress: (ratio: number) => void, xhr?: () => XMLHttpRequest): { promise: Promise<Attachment>; abort(): void }`
  - `useComposerAttachments(channelId: string): { items: ComposerAttachment[]; add(files: readonly File[]): void; remove(key: string): void; clear(): void; uploading: boolean; failed: boolean; ready: Attachment[] }`
  - `type ComposerAttachment = { key: string; name: string; previewUrl: string; progress: number; status: "uploading" | "done" | "error"; attachment?: Attachment; error?: string }`
  - `SendMessage.send(bodyMd: string, attachments?: readonly Attachment[]): Promise<void>`
  - `PendingMessage.attachments?: Attachment[]`

- [ ] **Step 1: `upload.ts` 테스트(실패)** — 가짜 XHR 로:
  - `checkImageFile({ type: "image/svg+xml", size: 1 })` → 「이미지만 올릴 수 있습니다」, `{ type: "image/png", size: 5*1024*1024 + 1 }` → 「5 MB 를 넘습니다」, 정상 → `undefined`.
  - `uploadImage`: `POST /api/v1/attachments?channelId=<id>`, 헤더 `content-type`=파일 타입, `x-dodok-file-name`=퍼센트 인코딩 이름. `upload.onprogress` 가 `onProgress(loaded/total)`. 200 → `Attachment.parse` 결과. 413 → 「5 MB 를 넘습니다」, 400 이면 서버 `message`, 네트워크 오류 → 「올리지 못했습니다」. `abort()` → 프로미스가 `AbortError` 이름의 오류로 끝난다.

- [ ] **Step 2: 구현**

```ts
// apps/web/src/features/attachments/upload.ts
import { ApiError, ATTACHMENT_LIMITS, Attachment, isImageMime } from "@dodok/shared";

export const ONLY_IMAGES = "이미지만 올릴 수 있습니다";
export const TOO_BIG = "5 MB 를 넘습니다";
export const UPLOAD_FAILED = "올리지 못했습니다";

export function checkImageFile(file: Pick<File, "type" | "size">): string | undefined {
  if (!isImageMime(file.type)) return ONLY_IMAGES;
  if (file.size > ATTACHMENT_LIMITS.userImageMaxBytes) return TOO_BIG;
  return undefined;
}

/** XHR — fetch 는 업로드 진행을 주지 않는다(스펙 6.1). 쿠키 인증, 같은 출처 */
export function uploadImage(
  file: File,
  channelId: string,
  onProgress: (ratio: number) => void,
  makeXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): { promise: Promise<Attachment>; abort(): void } {
  const xhr = makeXhr();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open("POST", `/api/v1/attachments?channelId=${encodeURIComponent(channelId)}`);
    xhr.setRequestHeader("content-type", file.type);
    xhr.setRequestHeader("x-dodok-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => (e.lengthComputable ? onProgress(e.loaded / e.total) : undefined);
    xhr.onload = () => {
      if (xhr.status === 200) {
        const parsed = Attachment.safeParse(safeJson(xhr.responseText));
        return parsed.success ? resolve(parsed.data) : reject(new Error(UPLOAD_FAILED));
      }
      if (xhr.status === 413) return reject(new Error(TOO_BIG));
      const body = ApiError.safeParse(safeJson(xhr.responseText));
      reject(new Error(body.success && xhr.status === 400 ? body.data.message : UPLOAD_FAILED));
    };
    xhr.onerror = () => reject(new Error(UPLOAD_FAILED));
    xhr.onabort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 3: `useComposerAttachments` 테스트(실패) → 구현** — `renderHook` 으로:
  - `add([png, svg])` → 둘 다 칩이 생기고 svg 칩은 곧바로 `error: ONLY_IMAGES`(올리지 않는다), png 는 `uploading` → 성공 `done`.
  - 11개째부터는 칩을 만들지 않고 `toast.info("이미지는 한 번에 10장까지 보낼 수 있습니다", { id: "attach-limit" })` 한 번.
  - `remove(key)` → 올리는 중이면 `abort`, `URL.revokeObjectURL` 불림.
  - `channelId` 가 바뀌면 모두 `abort`·`revoke` 하고 비운다(채널별로 들고 다니지 않는다 — 계획 판정. 초안은 채널별로 남지만 첨부는 남지 않는다).
  - `uploading` = 올리는 중이 하나라도, `failed` = 오류 칩이 하나라도, `ready` = `done` 들의 `Attachment`(넣은 순서).
  - 언마운트 때 모두 `abort`·`revoke`.
  - 구현은 `useReducer` + `useRef<Map<string, { abort(): void }>>`. 모듈 상태 없이.

- [ ] **Step 4: 작성기 UI**
  - `PendingAttachments.tsx`: 칩 목록(`role="list"`). 칩마다 미리보기 `<img src={previewUrl} alt="">`, 이름, 올리는 중이면 `<div role="progressbar" aria-valuenow={Math.round(progress*100)} aria-valuemin={0} aria-valuemax={100} aria-label="<이름> 올리는 중">`, 오류면 빨간 글(`text-destructive`)로 사유, 빼기 버튼 `aria-label="<이름> 빼기"`.
  - `Composer.tsx`:
    - 입력 칸 왼쪽에 첨부 버튼(`ImagePlusIcon`, `aria-label="이미지 첨부"`) + 숨긴 `<input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp">`. 고른 뒤 `input.value = ""`(같은 파일을 다시 고를 수 있게).
    - `handlePaste`: `const files = Array.from(data?.files ?? [])`. 없으면 `false`. 이미지만 `add`, 이미지 아닌 파일이 있으면 `toast.info(ONLY_IMAGES, { id: "attach-only-images" })`. 글이 함께 있으면 `false`(글도 들어간다), 없으면 `true`.
    - `drop`: 같은 규칙, `event.preventDefault()`.
    - 보내기 조건: `connected && !uploading && !failed && (!empty || ready.length > 0)`. 사유 글(`hintId` 자리, 우선순위 순): 끊김 「연결되면 보낼 수 있습니다」(기존) → 올리는 중 「이미지를 올리는 중입니다」 → 오류 「올리지 못한 이미지를 빼 주세요」. Enter 전송(`SubmitKeys`)도 같은 조건을 따른다(`live.current.submit` 안에서 검사).
    - `submit`: `const bodyMd = toBodyMd(doc); if (!bodyMd && ready.length === 0) return; void send(bodyMd, ready); clear(); editor.commands.clearContent();`. 슬래시 명령(`/stop`·`/new`)은 첨부가 있어도 지금처럼 명령으로만 처리하고 칩은 남긴다.
  - `useSendMessage`: `send(bodyMd, attachments = [])` — `PendingMessage` 에 `attachments` 를 싣고, `emitAck("message.send", { channelId, clientMsgId, bodyMd, ...(ids.length ? { attachments: ids } : {}) })`. `retry` 는 같은 `attachments` 로(Review Focus 4 — 서버가 `clientMsgId` 로 멱등).
  - `PendingItem.tsx`: 첨부가 있으면 `AttachmentGrid` 로(서버 경로 — 올린 사람은 미묶음도 읽는다). 크게 보기는 확정 메시지에서만(보내는 중에는 누를 것이 없게 `onOpen` 을 비활성).
  - `app/fileDrop.ts`: 창 전역 차단은 그대로 두고 문구를 「이미지는 입력 칸에 놓아 주세요」로(`FILES_LATER` 이름을 `DROP_ON_COMPOSER` 로 바꾼다). 작성기가 먼저 처리한 드롭(`defaultPrevented`)은 지금처럼 건드리지 않는다. 테스트의 옛 문구를 바꾼다.

- [ ] **Step 5: 테스트** — `Composer.attachments.test.tsx`(새):
  - 첨부 버튼으로 PNG → 칩·진행 → 완료 뒤 보내기 켜짐, 보내면 `message.send` 페이로드에 `attachments: [id]`, 칩 비움.
  - **[Review Focus 3]** 글 없이 이미지만 → 보내기 켜짐, `bodyMd: ""`.
  - 올리는 중에는 보내기 꺼짐 + 사유 글, Enter 도 안 보냄.
  - SVG 붙여넣기 → 토스트, 칩 없음. 글+이미지 붙여넣기 → 글도 들어가고 칩도 생김.
  - 오류 칩이 있으면 꺼짐 + 사유, 빼면 켜짐.
  - `useSendMessage.test.ts`: 첨부 있는 전송·재시도가 같은 `attachments`.

- [ ] **Step 6: 통과 확인** — `pnpm -F @dodok/web test`·`typecheck`·`lint` exit 0.

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/features/attachments apps/web/src/features/composer apps/web/src/features/messages/timeline.ts apps/web/src/features/messages/PendingItem.tsx apps/web/src/app/fileDrop.ts apps/web/src/app/fileDrop.test.tsx
git commit -m "feat(web): 작성기 이미지 올리기·미리보기 칩·첨부 전송"
```

---

### Task 8: dev:fake 대본

**Files:**
- Modify: `apps/server/scripts/dev-fake.ts`, `apps/server/test/fakes/scenario.ts`(필요하면), `apps/server/test/dev-fake.test.ts`
- 대본 이미지: 태스크 2 의 `makePng`(스크립트에서 import 해도 된다 — dev-fake 가 이미 `test/fakes` 를 import 한다)

**Interfaces:**
- Consumes: 태스크 4 `ScenarioScript.attachments`·가짜 플러그인 올리기, 태스크 2 `makePng`·`PDF_BYTES`

- [ ] **Step 1: 키워드 다섯**(스펙 8.4) — 기존 components 키워드 표에 더한다:

| 키워드 | 대본 |
| --- | --- |
| 「이미지 보여줘」 | `reply: "그래프입니다"` + `attachments: [chart.png 480×320]` |
| 「보고서 줘」 | `reply: "보고서입니다"` + `attachments: [report.pdf]` |
| 「카드에 이미지」 | `reply: "카드입니다"` + `attachments: [chart.png, 월간 보고서.pdf]` + components `media`(`artifact://chart.png`)·`file`(`artifact://월간 보고서.pdf`, name 「월간 보고서」)·링크 버튼(`artifact://월간 보고서.pdf`)·`media` 항목 하나는 없는 이름(`artifact://없음.png` — 「첨부를 찾을 수 없습니다」 확인용) |
| 「미디어만」 | `reply: ""` + `attachments: [chart.png]` |
| (사람 첨부가 있는 모든 멘션) | 대본 앞에 한 줄 — `받은 첨부 N개, 첫 이미지 W×H`(인바운드 `message.attachments` 에서) |

- [ ] **Step 2: `dev-fake.test.ts` 에 키워드마다 한 사례**(메시지의 `attachments` 개수·이름, 「카드에 이미지」는 components 가 두 첨부를 이름으로 가리킴).

- [ ] **Step 3: 손 확인** — `pnpm -F @dodok/server dev:fake` + `pnpm -F @dodok/web dev` 로 다섯 키워드를 한 번씩 보내 보고 화면이 뜨는지만 본다(정식 검증은 태스크 9).

- [ ] **Step 4: 커밋** — `git add apps/server/scripts/dev-fake.ts apps/server/test/fakes/scenario.ts apps/server/test/dev-fake.test.ts` · `feat(server): dev:fake 첨부 대본 키워드`

---

### Task 9: 브라우저 검증 → 수정 → 재검증

앞선 하위 프로젝트와 같은 규율(`docs/guides/browser-verification.md`, 워커가 한다, 「네가 연 탭은 네가 닫아라」). dev:fake 위에서 스펙 6장·9장을 시나리오로 잰다. 1280px·390px 둘 다.

| # | 시나리오 | 확인 |
| --- | --- | --- |
| 1 | 첨부 버튼으로 PNG 두 장 + 글 → 전송 | 칩 진행, 보내기 조건, 메시지에 2열 격자, 대본의 「받은 첨부 2개」 |
| 2 | 스크린샷 붙여넣기, 글 없이 전송 | 이미지만 있는 메시지, 빈 단락 없음 |
| 3 | SVG·6 MB PNG·11장 | 사유 글·토스트, 올리지 않음 |
| 4 | 올리는 중 칩 빼기, 채널 옮기기 | 취소, 칩 비움, 초안은 남음 |
| 5 | 「이미지 보여줘」·「보고서 줘」·「미디어만」 | 이미지·파일 카드·내려받기 이름(한국어), 호스트 경로 없음 |
| 6 | 「카드에 이미지」 | media·file·링크 버튼이 풀리고, 가리킨 첨부는 카드 아래 중복 없음, 없는 이름은 「첨부를 찾을 수 없습니다」 |
| 7 | 크게 보기 | 열기·←/→·n/전체·원본 내려받기·Esc·초점 복귀, 390px 에서 화면에 맞음 |
| 8 | 새로고침·새 탭 | 첨부가 그대로(서버 정본) |
| 9 | 끊긴 상태 | 올리기는 되고 보내기는 「연결되면 보낼 수 있습니다」 |
| 10 | 키보드만 | 첨부 버튼 → 칩 빼기 → 보내기 → 이미지 크게 보기까지 Tab 으로 |

결함은 심각도·파일:줄로 보고 → 수정 워커 → **범위 재검증**(고친 것 + 그 주변). 재검증 결함 0 이 되면 끝.

---

### Task 10: 문서

- `docs/project-structure.md`: 서버 `modules/attachments/`, 플러그인 세 파일, 웹 `features/attachments/` 를 구성 절에. `data/attachments/` 가 데이터 디렉터리에 든다는 것.
- `docs/plan.md` 8장: Phase 2 「이미지 첨부」 항목에 완료 표시와 확인 방법, 이월 둘(「이미지를 크게 볼 수 없다」·「`media`·`file` 문구 비대칭」) 제거, 스펙 10장 열린 문제 넷을 이월로. 머리 버전 표에 v0.11 한 줄.
- `docs/guides/live-smoke.md`: 원격 Gateway 설치 안내(6절 「사람이 볼 것」)에 스펙 5.3 두 가지 — `attachments.ttlHours`, `tools.fs.workspaceOnly`. 11절 하네스에 첨부 재는 법(가짜 CLI 의 `stdin-record` 에서 `@경로` 파일 크기·magic, 툴 `media` 인자 — 스파이크 보고서 「절차 요지」).
- `infra/`·`.env.example` 이 있으면 `ATTACHMENTS_DIR`(선택) 한 줄.
- 스펙 머리 상태 줄을 「구현 완료」로, 구현이 스펙과 달라진 것이 있으면 스펙 끝에 「구현과 맞춘 것」 장.
- `CLAUDE.md` 「현재 단계」는 조율자가 쓴다.

---

### Task 11: 실연 (사용자 승인 필요)

스펙 8.5. **모델 런 상한은 실연 직전에 사용자에게 받는다**(예상 2회).

1. 런 0회 하네스(live-smoke 11절): 새 번들 설치(**Gateway 먼저 내리고**, 설치 뒤 sha 확인) → 인바운드: 사람 이미지 → 가짜 CLI `stdin-record` 에 `@<ws>/.openclaw-cli-images/<sha>.png`, 크기·magic 이 원본과 같다 → 툴 `media`(PNG·PDF·한국어 이름) → 채널에 첨부 둘, 이름 그대로 → 최종 응답 `MEDIA:` 줄 → 채널에 첨부, **본문에 `MEDIA:` 없음** → 미디어만 있는 응답 → 채널에 첨부만, 호스트 경로 0.
2. 모델 런 ① 사람이 올린 이미지(알아볼 단어)에 대해 묻기 → 맞힘. ② 「작은 파일을 만들어 보내 줘」 → 파일 카드·내려받기.
3. 결과는 `docs/guides/live-smoke.md` 13절로.

---

## Self-Review (계획 작성 때 한 것)

- **스펙 적용 범위**: 결정 1~10 → 태스크 1·2·3·5·6·7(결정 7 크게 보기=6, 결정 8 매직 바이트=2, 결정 9 서버 무-fetch=3·5, 결정 10 의존성=2). 3장 계약 → 1. 4.1~4.7 → 2·3·4. 5.1~5.3 → 5·10. 6.1~6.4 → 6·7. 7장 오류 표 → 각 태스크 테스트. 8.1 → 4, 8.2 → 5, 8.3 → 6·7, 8.4 → 8·9, 8.5 → 11. 9장 완료 기준 → 9·11. 스펙 1장의 「9.4 SDK 확인」은 계획 작성 때 끝냈다(Global Constraints).
- **스펙과 다르게 정한 것**(계획 판정, 스펙 11장 「구현과 맞춘 것」에 옮긴다): ① REST 경로 `/api/v1/…` ② 「채널 멤버」 = 같은 워크스페이스 채널 ③ cascade 없음(삭제 기능이 없다) ④ 인바운드 `saveMediaBuffer` 의 `maxBytes` 는 에이전트 상한(릴레이 이미지) ⑤ 채널을 옮기면 첨부 칩을 비운다 ⑥ 두 POST 의 인증은 `onRequest`(본문을 받기 전에 거절).
- **자리표시 검사**: 「TBD·나중에·적절히」 없음. 테스트 사례를 글로만 적은 곳(태스크 3·4 의 일부 `it`)은 단언할 값이 스펙 문장에 정확히 있다 — 워커가 그 문장을 단언으로 옮긴다.
- **타입 일관**: `findReadable(deps, id, viewer)` 로 태스크 2 본문에서 고쳤고 태스크 3 이 같은 꼴로 부른다. `attachmentIds` 는 1·4·5 가 같은 이름. `ATTACHMENT_MISSING`·`LINK_BLOCKED` 는 6 이 만들고 6 안에서만 쓴다. `makePng` 는 2 가 만들고 4·8 이 쓴다.
- **Review Focus** 다섯 → 태스크 3(1)·2(2)·4·5·7(3)·4·7(4)·6(5)에 테스트를 넣었다.
