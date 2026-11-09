import { BridgeAuthGuard } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { ATTACHMENT_LIMITS, type Attachment } from "@dodok/shared";
import { fstatSync, mkdtempSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import pino from "pino";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type App, createApp, startAttachmentSweeper } from "../src/app";
import { loadConfig } from "../src/config";
import { SESSION_COOKIE } from "../src/auth";
import { attachments, channels, workspaces } from "../src/db/schema.sqlite";
import { blobPath, type BlobLocks, createBlobLocks, sha256Of } from "../src/modules/attachments/store";
import { registerAttachmentRoutes } from "../src/modules/attachments/routes";
import { markBound, uploadAttachment } from "../src/modules/attachments/service";
import { createUserMessage } from "../src/modules/messages/service";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { attachmentsDirOf, bootTestApp, login } from "./helpers/app";
import { testEnv } from "./helpers/env";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { makePng, PDF_BYTES } from "./helpers/png";
import { channelConversation, seedConversation } from "./helpers/seed";

/** 그 테스트의 앱 가짜 Gateway 에 발급한 브리지 토큰 — beforeEach 가 채운다 */
let BRIDGE_TOKEN: string;
const NAME = '보고서 "최종" 😀.pdf';

/** 로그를 줄 단위로 모은다 — 오류 로그 단언용 */
function captureLogger() {
  const lines: Array<{ level: number; msg?: string } & Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

/** 이 프로세스가 연 fd 중 path 와 같은 파일(dev·ino)이 있는가 — macOS `/dev/fd`, Linux `/proc/self/fd` */
function isOpen(path: string): boolean {
  const target = statSync(path);
  const fdDir = existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  return readdirSync(fdDir).some((n) => {
    try {
      const s = fstatSync(Number(n));
      return s.ino === target.ino && s.dev === target.dev;
    } catch {
      return false;
    }
  });
}

describe("첨부 HTTP (스펙 4.3)", () => {
  let app: App;
  let dir: string;
  let session: { authorization: string };
  let sessionToken: string;
  let ch: string;
  let seq = 0;
  const { logger, lines } = captureLogger();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-att-routes-"));
    app = await bootTestApp({ ATTACHMENTS_DIR: dir }, { logger });
    BRIDGE_TOKEN = issueBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, "gw").token;
    const l = await login(app);
    session = l.headers;
    sessionToken = l.token;
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: session,
      payload: { name: "att" },
    });
    expect(res.statusCode).toBe(201);
    ch = res.json().channel.id;
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const upload = (payload: Buffer | string, headers: Record<string, string> = {}, channelId = ch) =>
    app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${channelId}`,
      headers: { ...session, "content-type": "image/png", ...headers },
      payload,
    });
  const bridgeUpload = (payload: Buffer, headers: Record<string, string> = {}) =>
    app.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: {
        authorization: `Bearer ${BRIDGE_TOKEN}`,
        "x-dodok-conversation-id": channelConversation(app.db, ch),
        "content-type": "application/octet-stream",
        ...headers,
      },
      payload,
    });
  /** 메시지 하나를 만들어 ids 를 묶는다 */
  const bind = (ids: string[], channelId = ch) => {
    const m = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channelId),
      authorId: app.ownerUserId,
      bodyMd: "첨부",
      clientMsgId: `att-${++seq}`,
    });
    markBound(app.db, ids, m.id);
  };

  it("사람: PNG 올리기 → 200 Attachment, 받기는 inline·nosniff·CSP·immutable", async () => {
    const up = await upload(makePng(4, 3), { "x-dodok-file-name": encodeURIComponent("스샷.png") });
    expect(up.statusCode).toBe(200);
    const a = up.json() as Attachment;
    expect(a).toMatchObject({ kind: "image", mime: "image/png", name: "스샷.png", width: 4, height: 3 });
    expect(a.url).toBe(`artifact://${a.id}`);
    const get = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${a.id}`,
      headers: session,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(get.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(get.headers["content-disposition"]).toBe("inline");
    expect(get.rawPayload.equals(makePng(4, 3))).toBe(true);
    const dl = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${a.id}?download=1`,
      headers: session,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(
      /^attachment; filename="[^"]*"; filename\*=UTF-8''%EC%8A%A4%EC%83%B7\.png$/,
    );
  });

  it("사람: 세션 쿠키로도 올리고 받는다(인증이 onRequest 에 있어도 쿠키는 파싱돼 있다)", async () => {
    const cookie = `${SESSION_COOKIE}=${sessionToken}`;
    const up = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${ch}`,
      headers: { cookie, "content-type": "image/png" },
      payload: makePng(2, 2),
    });
    expect(up.statusCode).toBe(200);
    const get = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${up.json().id}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
  });

  it("사람: 이름 헤더가 없으면 image.png", async () => {
    const up = await upload(makePng(2, 1));
    expect(up.json()).toMatchObject({ name: "image.png" });
  });

  it("사람: 20 MiB 넘는 본문은 413(서비스와 같은 문구·maxBytes), 5 MiB 넘는 PNG 는 400(maxBytes 5 MiB)", async () => {
    const huge = Buffer.concat([
      PDF_BYTES,
      Buffer.alloc(ATTACHMENT_LIMITS.userFileMaxBytes + 1 - PDF_BYTES.length),
    ]);
    const r = await upload(huge, { "content-type": "application/pdf" });
    expect(r.statusCode).toBe(413);
    // Fastify 의 일반 문구가 아니라 첨부 서비스의 문구·상한
    expect(r.json()).toEqual({
      code: "VALIDATION",
      message: "크기 상한을 넘는다",
      details: { maxBytes: 20971520 },
    });
    // 본문 상한(20 MiB)은 지나고 판별 뒤 이미지 상한이 막는다
    const png = makePng(1, 1);
    const big = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024 - png.length)]);
    const img = await upload(big);
    expect(img.statusCode).toBe(400);
    expect(img.json()).toEqual({
      code: "VALIDATION",
      message: "크기 상한을 넘는다",
      details: { maxBytes: 5242880 },
    });
  });

  it("사람: PDF 는 200 file, 정확히 20 MiB 파일도 200", async () => {
    const pdf = await upload(PDF_BYTES, {
      "content-type": "application/pdf",
      "x-dodok-file-name": encodeURIComponent("보고서.pdf"),
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.json()).toMatchObject({ kind: "file", mime: "application/pdf", name: "보고서.pdf" });
    const max = Buffer.concat([
      PDF_BYTES,
      Buffer.alloc(ATTACHMENT_LIMITS.userFileMaxBytes - PDF_BYTES.length),
    ]);
    const r = await upload(max, { "content-type": "application/pdf" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: "file", size: ATTACHMENT_LIMITS.userFileMaxBytes });
  });

  it("[Review Focus 4] 사람이 .png 이름으로 올린 HTML — file 로 저장, 받기는 octet-stream·attachment·sandbox·nosniff", async () => {
    const up = await upload(Buffer.from("<html><script>alert(1)</script></html>"), {
      "x-dodok-file-name": encodeURIComponent("x.png"),
    });
    expect(up.statusCode).toBe(200);
    const a = up.json() as Attachment;
    expect(a).toMatchObject({ kind: "file", mime: "application/octet-stream", name: "x.png" });
    const get = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${a.id}`,
      headers: session,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("application/octet-stream");
    expect(String(get.headers["content-disposition"])).toMatch(/^attachment;/);
    expect(get.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("사람: 1 MiB 넘는 이미지(2 MiB)·정확히 5 MiB 이미지는 200 — 라우트 bodyLimit 이 서버 기본 1 MiB 를 넓힌다", async () => {
    for (const size of [2 * 1024 * 1024, ATTACHMENT_LIMITS.userImageMaxBytes]) {
      const png = makePng(3, 3);
      const r = await upload(Buffer.concat([png, Buffer.alloc(size - png.length)]));
      expect(r.statusCode, `${size} B`).toBe(200);
      expect(r.json()).toMatchObject({ kind: "image", size });
    }
  });

  it("사람: JSON content-type 으로 올려도 JSON 으로 파싱하지 않는다(바이트 그대로 판별)", async () => {
    const r = await upload('{"a":1}', { "content-type": "application/json" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: "file", mime: "application/json", size: 7 });
  });

  it("사람: 처음 보는 content-type 이어도 바이트로 판별한다", async () => {
    const r = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${ch}`,
      headers: { ...session, "content-type": "x-weird/thing" },
      payload: makePng(3, 3),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("사람: 없는 채널·다른 워크스페이스 채널 → 404, 채널 id 가 없거나 틀리면 400, 로그인 없음 → 401", async () => {
    const missing = await upload(makePng(1, 1), {}, uuid());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });

    const ws = uuid();
    app.db.insert(workspaces).values({ id: ws, name: "other", createdAt: new Date() }).run();
    const other = uuid();
    app.db
      .insert(channels)
      .values({
        id: other,
        workspaceId: ws,
        name: "other",
        relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
        visibility: "public",
        createdBy: app.ownerUserId,
        createdAt: new Date(),
      })
      .run();
    seedConversation(app.db, other, { createdBy: app.ownerUserId, createdAt: new Date() });
    expect((await upload(makePng(1, 1), {}, other)).statusCode).toBe(404);
    // 다른 워크스페이스 채널 메시지에 묶인 첨부도 이 워크스페이스 사람에게는 없는 것이다
    const foreign = await uploadAttachment(
      { db: app.db, dir },
      { channelId: other, uploader: { type: "user", userId: app.ownerUserId }, bytes: makePng(8, 1) },
    );
    bind([foreign.id], other);
    const foreignGet = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${foreign.id}`,
      headers: session,
    });
    expect(foreignGet.statusCode).toBe(404);
    expect(foreignGet.json()).toMatchObject({ code: "NOT_FOUND" });
    const viaBridge = await bridgeUpload(PDF_BYTES, {
      "x-dodok-conversation-id": channelConversation(app.db, other),
    });
    expect(viaBridge.statusCode).toBe(404);

    expect((await upload(makePng(1, 1), {}, "not-a-uuid")).statusCode).toBe(400);
    const noQuery = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { ...session, "content-type": "image/png" },
      payload: makePng(1, 1),
    });
    expect(noQuery.statusCode).toBe(400);

    const anon = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${ch}`,
      headers: { "content-type": "image/png" },
      payload: makePng(1, 1),
    });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ code: "UNAUTHORIZED" });
    const anonGet = await app.fastify.inject({ method: "GET", url: `/api/v1/attachments/${uuid()}` });
    expect(anonGet.statusCode).toBe(401);
  });

  it("사람: 로그인 없이 5 MiB 넘게 보내도 413 이 아니라 401 — 인증이 본문 파싱보다 먼저다", async () => {
    const big = Buffer.alloc(ATTACHMENT_LIMITS.userImageMaxBytes + 1);
    const r = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${ch}`,
      headers: { "content-type": "image/png" },
      payload: big,
    });
    expect(r.statusCode).toBe(401);
  });

  it("사람: 남의 미묶음 첨부·브리지 미묶음 첨부·없는 id GET → 404, 틀린 id → 400", async () => {
    const theirs = await uploadAttachment(
      { db: app.db, dir },
      { channelId: ch, uploader: { type: "user", userId: uuid() }, bytes: makePng(5, 5) },
    );
    const get = (id: string) =>
      app.fastify.inject({ method: "GET", url: `/api/v1/attachments/${id}`, headers: session });
    const r = await get(theirs.id);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
    const bridged = (await bridgeUpload(PDF_BYTES)).json() as Attachment;
    expect((await get(bridged.id)).statusCode).toBe(404);
    expect((await get(uuid())).statusCode).toBe(404);
    expect((await get("nope")).statusCode).toBe(400);
    // 묶이면 워크스페이스 채널의 사람은 본다
    bind([theirs.id, bridged.id]);
    expect((await get(theirs.id)).statusCode).toBe(200);
    expect((await get(bridged.id)).statusCode).toBe(200);
  });

  it("사람: 행은 있는데 블롭 파일이 없으면 500 이 아니라 404", async () => {
    const a = (await upload(makePng(7, 7))).json() as Attachment;
    await rm(blobPath(dir, sha256Of(makePng(7, 7))));
    const r = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${a.id}`,
      headers: session,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
    // 오류 응답은 블롭 응답 헤더(1년 immutable 캐시·내려받기)를 달지 않는다
    expect(r.headers["cache-control"]).toBeUndefined();
    expect(r.headers["content-disposition"]).toBeUndefined();
  });

  it("사람: 블롭 파일 크기가 저장값과 다르면 200 을 흉내 내지 않고 500, 오류 로그에 id·크기 둘(경로 없이)", async () => {
    const png = makePng(11, 11);
    const a = (await upload(png)).json() as Attachment;
    const path = blobPath(dir, sha256Of(png));
    writeFileSync(path, png.subarray(0, 10)); // 디스크 손상·손 조작 흉내
    const before = lines.length;
    const r = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${a.id}`,
      headers: session,
    });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ code: "INTERNAL", message: "internal error" });
    expect(r.headers["cache-control"]).toBeUndefined();
    expect(r.headers["content-disposition"]).toBeUndefined();
    const errors = lines.slice(before).filter((l) => l.level >= 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.cause).toEqual({ attachmentId: a.id, storedSize: png.length, blobSize: 10 });
    expect(JSON.stringify(errors)).not.toContain(dir);
    await vi.waitFor(() => expect(isOpen(path)).toBe(false), { timeout: 3000, interval: 20 });
  });

  it("저장값이 헤더로 못 쓰는 문자면(mime 에 개행) 파일을 열기 전에 500 — 블롭 fd 가 남지 않는다", async () => {
    const png = makePng(12, 12);
    const a = (await upload(png)).json() as Attachment;
    app.db.update(attachments).set({ mime: "image/png\n" }).where(eq(attachments.id, a.id)).run();
    const path = blobPath(dir, sha256Of(png));
    const r = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${a.id}`,
      headers: session,
    });
    expect(r.statusCode).toBe(500);
    expect(r.headers["cache-control"]).toBeUndefined();
    expect(isOpen(path)).toBe(false);
  });

  it("브리지: 토큰 없거나 틀리면 401, channel 헤더 없거나 틀리면 400, 없는 채널 404", async () => {
    const noToken = await app.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: { "x-dodok-conversation-id": channelConversation(app.db, ch) },
      payload: PDF_BYTES,
    });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await bridgeUpload(PDF_BYTES, { authorization: "Bearer wrong-token-xxxxxxxx" })).statusCode).toBe(
      401,
    );
    expect((await bridgeUpload(PDF_BYTES, { authorization: BRIDGE_TOKEN })).statusCode).toBe(401);
    // Bearer 스킴 이름은 대소문자를 가리지 않는다(RFC 9110 11.1)
    expect((await bridgeUpload(PDF_BYTES, { authorization: `bearer ${BRIDGE_TOKEN}` })).statusCode).toBe(200);
    // 사람 세션 토큰은 브리지 토큰이 아니다
    expect((await bridgeUpload(PDF_BYTES, { authorization: `Bearer ${sessionToken}` })).statusCode).toBe(401);

    const noChannel = await app.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
      payload: PDF_BYTES,
    });
    expect(noChannel.statusCode).toBe(400);
    expect(noChannel.json()).toMatchObject({ code: "VALIDATION" });
    expect((await bridgeUpload(PDF_BYTES, { "x-dodok-conversation-id": "nope" })).statusCode).toBe(400);
    const missing = await bridgeUpload(PDF_BYTES, { "x-dodok-conversation-id": uuid() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("브리지: 토큰이 틀린 20 MiB 넘는 본문도 413 이 아니라 401 — 인증이 본문 파싱보다 먼저다", async () => {
    const r = await bridgeUpload(Buffer.alloc(ATTACHMENT_LIMITS.agentFileMaxBytes + 1), {
      authorization: "Bearer wrong-token-xxxxxxxx",
    });
    expect(r.statusCode).toBe(401);
  });

  it("[Review Focus 1] 브리지: 한국어·따옴표·이모지 이름이 내려받기 이름으로 돌아온다", async () => {
    const up = await bridgeUpload(PDF_BYTES, {
      "x-dodok-file-name": encodeURIComponent(NAME),
      "content-type": "application/pdf",
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ kind: "file", mime: "application/pdf", name: NAME });
    bind([up.json().id]);
    const get = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${up.json().id}`,
      headers: session,
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("application/pdf");
    const cd = get.headers["content-disposition"] as string;
    expect(cd.startsWith('attachment; filename="')).toBe(true);
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1] ?? "")).toBe(NAME);
    expect(cd).not.toMatch(/[\r\n]/);
    // 따옴표 안 ASCII 이름에 따옴표·ASCII 밖 문자가 없다
    const ascii = /^attachment; filename="([^"]*)"; /.exec(cd)?.[1];
    expect(ascii).toMatch(/^[\x20-\x7e]+$/);
    expect(get.rawPayload.equals(PDF_BYTES)).toBe(true);
  });

  it("브리지: filename* 값에 RFC 5987 밖 문자(' ( ) *)를 그대로 두지 않는다", async () => {
    const name = "it's (v2)*.pdf";
    const up = await bridgeUpload(PDF_BYTES, { "x-dodok-file-name": encodeURIComponent(name) });
    bind([up.json().id]);
    const get = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${up.json().id}`,
      headers: session,
    });
    const ext = (get.headers["content-disposition"] as string).split("filename*=UTF-8''")[1] ?? "";
    expect(ext).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(ext)).toBe(name);
  });

  it("브리지: 이름 헤더의 %0d%0a 는 이름에서 빠진다(헤더 주입 없음)", async () => {
    const up = await bridgeUpload(PDF_BYTES, {
      "x-dodok-file-name": encodeURIComponent("a\r\nSet-Cookie: x=1.pdf"),
    });
    expect(up.json()).toMatchObject({ name: "aSet-Cookie: x=1.pdf" });
    bind([up.json().id]);
    const get = await app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${up.json().id}`,
      headers: session,
    });
    expect(get.headers["set-cookie"]).toBeUndefined();
    expect(get.headers["content-disposition"]).not.toMatch(/[\r\n]/);
  });

  it("브리지: 잘못된 퍼센트 인코딩 이름은 400 이 아니라 기본 이름(file)", async () => {
    const up = await bridgeUpload(PDF_BYTES, { "x-dodok-file-name": "%E0%A4%A" });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: "file" });
  });

  it("브리지 GET: 그 Gateway 가 올린 것은 묶이기 전후로 바이트, 사람이 올린 것은 묶여도 404(열린 런의 트리거 첨부만 — attachments.bridge-scope)", async () => {
    const bget = (id: string, token = BRIDGE_TOKEN) =>
      app.fastify.inject({
        method: "GET",
        url: `/bridge/attachments/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
    const mine = (await bridgeUpload(PDF_BYTES, { "x-dodok-file-name": "r.pdf" })).json() as Attachment;
    const human = (await upload(makePng(6, 2))).json() as Attachment;
    expect((await bget(mine.id)).statusCode).toBe(200);
    expect((await bget(human.id)).statusCode).toBe(404);
    bind([mine.id, human.id]);
    expect((await bget(mine.id, "wrong-token-xxxxxxxx")).statusCode).toBe(401);
    const got = await bget(mine.id);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(PDF_BYTES)).toBe(true);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect((await bget(human.id)).statusCode).toBe(404);
    const png = (await bridgeUpload(makePng(6, 3))).json() as Attachment;
    const img = await bget(png.id);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(makePng(6, 3))).toBe(true);
    // 브리지 GET 은 이미지도 inline 이 아니라 내려받기다
    expect(img.headers["content-disposition"]).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  });

  it("브리지 POST: 1 MiB 넘는 파일(2 MiB)·정확히 20 MiB 는 200 — 라우트 bodyLimit 이 서버 기본 1 MiB 를 넓힌다", async () => {
    for (const size of [2 * 1024 * 1024, ATTACHMENT_LIMITS.agentFileMaxBytes]) {
      const r = await bridgeUpload(Buffer.alloc(size, 3));
      expect(r.statusCode, `${size} B`).toBe(200);
      expect(r.json()).toMatchObject({ kind: "file", size });
    }
  });

  it("브리지 POST: 20 MiB 넘으면 413", async () => {
    const r = await bridgeUpload(Buffer.alloc(ATTACHMENT_LIMITS.agentFileMaxBytes + 1, 1));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({
      code: "VALIDATION",
      message: "크기 상한을 넘는다",
      details: { maxBytes: ATTACHMENT_LIMITS.agentFileMaxBytes },
    });
  });

  it("이 스코프의 원시 파서가 바깥 JSON 경로를 바꾸지 않는다", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: session,
      payload: { name: "json-still" },
    });
    expect(res.statusCode).toBe(201);
    const bad = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: { ...session, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("받다가 끊으면 블롭 파일을 연 채 남기지 않는다", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_LIMITS.agentFileMaxBytes, 7);
    const up = (await bridgeUpload(bytes, { "x-dodok-file-name": "big.bin" })).json() as Attachment;
    bind([up.id]);
    const path = blobPath(dir, sha256Of(bytes));
    await app.fastify.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.fastify.server.address() as { port: number };
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/v1/attachments/${up.id}`,
      headers: session,
    });
    const firstChunk = new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        res.once("data", () => {
          res.pause();
          resolve();
        });
      });
      req.on("error", reject);
    });
    req.end();
    await firstChunk;
    // 대조군: 받는 중에는 열려 있다(검출기가 실제로 fd 를 본다)
    expect(isOpen(path)).toBe(true);
    req.on("error", () => {});
    req.destroy();
    await vi.waitFor(() => expect(isOpen(path)).toBe(false), { timeout: 3000, interval: 20 });
    // 실제 HTTP 에서도 /bridge/attachments 는 Socket.IO(/bridge 는 네임스페이스, 경로는 /socket.io/)가 가로채지 않는다
    const viaHttp = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const r = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/bridge/attachments/${up.id}`,
          headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        },
      );
      r.on("error", reject);
      r.end();
    });
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.body.equals(bytes)).toBe(true);
  });
});

describe("첨부 정리 배선 (스펙 4.7)", () => {
  it("startAttachmentSweeper: 바로 한 번, 그 뒤 주기마다 돌고 close() 는 타이머를 멈추고 진행 중인 정리를 기다린다", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const sweep = vi.fn(() => {
      calls++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const s = startAttachmentSweeper(sweep, 20);
    expect(calls).toBe(1);
    // 진행 중이면 겹쳐 돌지 않는다
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
    release?.();
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 1000, interval: 5 });
    let closed = false;
    const closing = s.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(false); // 두 번째 정리가 아직 진행 중
    release?.();
    await closing;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(2); // 멈춘 뒤에는 다시 돌지 않는다
  });

  it("startAttachmentSweeper: 정리가 던져도 다음 주기에 다시 돈다", async () => {
    const sweep = vi.fn(async () => {
      throw new Error("boom");
    });
    const s = startAttachmentSweeper(sweep, 10);
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 1000,
      interval: 5,
    });
    await s.close();
  });

  it("앱: 부팅 때 고아 블롭을 치우고, 업로드와 정리가 같은 잠금 객체를 지난다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-att-sweep-"));
    const orphan = sha256Of(Buffer.from("orphan"));
    mkdirSync(join(dir, orphan.slice(0, 2)), { recursive: true });
    writeFileSync(blobPath(dir, orphan), "orphan");
    const inner = createBlobLocks();
    const seen: string[] = [];
    const locks: BlobLocks = {
      run(sha, fn) {
        seen.push(sha);
        return inner.run(sha, fn);
      },
    };
    const app = await bootTestApp({ ATTACHMENTS_DIR: dir }, { blobLocks: locks });
    try {
      await vi.waitFor(() => expect(existsSync(blobPath(dir, orphan))).toBe(false), {
        timeout: 3000,
        interval: 10,
      });
      expect(seen).toContain(orphan);
      const { headers } = await login(app);
      const created = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers,
        payload: { name: "sweep" },
      });
      const png = makePng(9, 9);
      const up = await app.fastify.inject({
        method: "POST",
        url: `/api/v1/attachments?channelId=${created.json().channel.id}`,
        headers: { ...headers, "content-type": "image/png" },
        payload: png,
      });
      expect(up.statusCode).toBe(200);
      expect(seen).toContain(sha256Of(png));
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** 부팅한 앱에서 채널을 만들고 PNG 하나를 올린다 */
  async function uploadPng(app: App, png: Buffer) {
    const { headers } = await login(app);
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers,
      payload: { name: "sweep" },
    });
    return app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${created.json().channel.id}`,
      headers: { ...headers, "content-type": "image/png" },
      payload: png,
    });
  }
  const writeOrphan = (dir: string, label: string) => {
    const sha = sha256Of(Buffer.from(label));
    mkdirSync(join(dir, sha.slice(0, 2)), { recursive: true });
    writeFileSync(blobPath(dir, sha), label);
    return sha;
  };
  const sweepFailures = (lines: Array<{ msg?: string }>) =>
    lines.filter((l) => l.msg === "attachments sweep failed");

  it("앱: 주입 없이 부팅해도 업로드와 주기 정리가 같은 잠금 객체(app.blobLocks)를 지난다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-att-locks-"));
    const app = await bootTestApp({ ATTACHMENTS_DIR: dir }, { attachmentSweepIntervalMs: 10 });
    try {
      const run = vi.spyOn(app.blobLocks, "run");
      const orphan = writeOrphan(dir, "orphan-periodic");
      await vi.waitFor(() => expect(existsSync(blobPath(dir, orphan))).toBe(false), {
        timeout: 3000,
        interval: 10,
      });
      expect(run).toHaveBeenCalledWith(orphan, expect.any(Function));
      const up = await uploadPng(app, makePng(10, 10));
      expect(up.statusCode).toBe(200);
      // 10 ms 정리 틱도 같은 png sha 로 run 을 부를 수 있다 — 업로드 쪽 콜백만 행을 돌려준다는 점으로 가른다(a3-t3 재리뷰 N1)
      const values = await Promise.all(run.mock.results.map((r) => r.value));
      expect(values.some((v) => (v as { id?: string } | undefined)?.id === up.json().id)).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("앱: close() 뒤에는 정리 타이머가 돌지 않는다(닫힌 db 에 닿지 않는다)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-att-close-"));
    const { logger, lines } = captureLogger();
    const app = await bootTestApp({ ATTACHMENTS_DIR: dir }, { logger, attachmentSweepIntervalMs: 10 });
    try {
      // 대조군: 주기 정리가 돌고 있다
      const orphan = writeOrphan(dir, "orphan-before-close");
      await vi.waitFor(() => expect(existsSync(blobPath(dir, orphan))).toBe(false), {
        timeout: 3000,
        interval: 10,
      });
      await app.close();
      await new Promise((r) => setTimeout(r, 150));
      expect(sweepFailures(lines)).toEqual([]);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("앱: 정리 타이머를 켠 뒤 부팅이 실패해도 타이머를 멈춘다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-att-bootfail-"));
    const orphan = writeOrphan(dir, "orphan-boot-fail");
    const { logger, lines } = captureLogger();
    // adapter.status() 는 정리 타이머를 켠 뒤(watchGatewayReconnecting)에 처음 불린다
    class StatusThrows extends FakeAdapter {
      override status(): never {
        throw new Error("status boom");
      }
    }
    try {
      await expect(
        bootTestApp(
          { ATTACHMENTS_DIR: dir },
          { adapters: [new StatusThrows()], logger, attachmentSweepIntervalMs: 10 },
        ),
      ).rejects.toThrow("status boom");
      // 실패 전에 켜진 부팅 정리를 undo 가 db 를 닫기 전에 끝까지 기다렸다(타이머가 켜졌다는 대조군이기도 하다)
      expect(existsSync(blobPath(dir, orphan))).toBe(false);
      await new Promise((r) => setTimeout(r, 150));
      expect(sweepFailures(lines)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("앱: ATTACHMENTS_DIR 이 없으면 부팅 때 만든다", async () => {
    const base = mkdtempSync(join(tmpdir(), "dodok-att-mk-"));
    const dir = join(base, "nested", "attachments");
    const app = await bootTestApp({ ATTACHMENTS_DIR: dir });
    try {
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      await app.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("테스트 헬퍼의 첨부 디렉터리", () => {
  it("bootTestApp: ATTACHMENTS_DIR 을 안 주면 앱마다 새 임시 디렉터리를 만들고 close() 뒤 지운다", async () => {
    const a = await bootTestApp();
    const b = await bootTestApp();
    const da = attachmentsDirOf(a);
    const db = attachmentsDirOf(b);
    try {
      expect(da).toBeDefined();
      expect(db).toBeDefined();
      expect(da).not.toBe(db);
      expect(statSync(da as string).isDirectory()).toBe(true);
      await a.close();
      expect(existsSync(da as string)).toBe(false);
      expect(existsSync(db as string)).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
    expect(existsSync(db as string)).toBe(false);
  });

  it("bootTestApp: ATTACHMENTS_DIR 을 주면 그대로 쓰고 지우지 않는다(호출자 몫)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-att-own-"));
    const app = await bootTestApp({ ATTACHMENTS_DIR: dir });
    expect(attachmentsDirOf(app)).toBe(dir);
    await app.close();
    expect(existsSync(dir)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("testEnv 만으로 createApp 을 부르면 부팅이 실패한다 — 앱끼리 디렉터리를 나눠 쓰거나 저장소에 쓰지 않게", async () => {
    await expect(createApp(loadConfig(testEnv), { adapters: [new FakeAdapter()] })).rejects.toThrow(
      /ENOTDIR/,
    );
  });
});

describe("브리지 첨부 인증 — 실패 카운터(운영 보강 스펙 4.1)", () => {
  it("검증 함수가 던지면 거절하되 실패로 세지 않는다 — 저장소가 잠깐 잠긴 동안 정상 플러그인 주소가 막히지 않게", async () => {
    const app = await bootTestApp();
    const fastify = Fastify();
    const guard = new BridgeAuthGuard({ maxFailures: 1 });
    let verify: () => { tokenId: string; gatewayId: string } | null = () => {
      throw new Error("db locked");
    };
    registerAttachmentRoutes(fastify, {
      auth: app.auth,
      db: app.db,
      workspaceId: app.workspaceId,
      dir: attachmentsDirOf(app) as string,
      verifyBridgeToken: () => verify(),
      acceptBridgeGateway: () => true,
      bridgeGuard: { guard, now: () => 0, onBlocked: () => {} },
      locks: createBlobLocks(),
    });
    const get = () =>
      fastify.inject({
        method: "GET",
        url: `/bridge/attachments/${uuid()}`,
        headers: { authorization: "Bearer x" },
      });
    try {
      for (let i = 0; i < 3; i++) expect((await get()).statusCode).not.toBe(200);
      expect(guard.isBlocked("127.0.0.1", 0)).toBe(false);
      // 대조: 토큰이 틀리면(null) 한 번에 센다
      verify = () => null;
      await get();
      expect(guard.isBlocked("127.0.0.1", 0)).toBe(true);
    } finally {
      await fastify.close();
      await app.close();
    }
  });
});
