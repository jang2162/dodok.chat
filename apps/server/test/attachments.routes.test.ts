import { ATTACHMENT_LIMITS, type Attachment } from "@dodok/shared";
import { fstatSync, mkdtempSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type App, startAttachmentSweeper } from "../src/app";
import { SESSION_COOKIE } from "../src/auth";
import { channels, workspaces } from "../src/db/schema.sqlite";
import { blobPath, type BlobLocks, createBlobLocks, sha256Of } from "../src/modules/attachments/store";
import { markBound, uploadAttachment } from "../src/modules/attachments/service";
import { createUserMessage } from "../src/modules/messages/service";
import { bootTestApp, login } from "./helpers/app";
import { testEnv } from "./helpers/env";
import { makePng, PDF_BYTES } from "./helpers/png";

const BRIDGE_TOKEN = testEnv.BRIDGE_TOKEN as string;
const NAME = '보고서 "최종" 😀.pdf';

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

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-att-routes-"));
    app = await bootTestApp({ ATTACHMENTS_DIR: dir });
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
        "x-dodok-channel-id": ch,
        "content-type": "application/octet-stream",
        ...headers,
      },
      payload,
    });
  /** 메시지 하나를 만들어 ids 를 묶는다 */
  const bind = (ids: string[]) => {
    const m = createUserMessage(app.db, app.bus, {
      channelId: ch,
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

  it("사람: 5 MiB 넘으면 413, 이미지 아니면 400 VALIDATION 「이미지만 올릴 수 있습니다」", async () => {
    const big = Buffer.concat([makePng(1, 1), Buffer.alloc(ATTACHMENT_LIMITS.userImageMaxBytes)]);
    const r = await upload(big);
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ code: "VALIDATION" });
    const pdf = await upload(PDF_BYTES, { "content-type": "application/pdf" });
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json()).toMatchObject({ code: "VALIDATION", message: "이미지만 올릴 수 있습니다" });
  });

  it("사람: JSON content-type 으로 올려도 JSON 으로 파싱하지 않는다(바이트 그대로 판별)", async () => {
    const r = await upload('{"a":1}', { "content-type": "application/json" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "VALIDATION", message: "이미지만 올릴 수 있습니다" });
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
    expect((await upload(makePng(1, 1), {}, other)).statusCode).toBe(404);
    const viaBridge = await bridgeUpload(PDF_BYTES, { "x-dodok-channel-id": other });
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
  });

  it("브리지: 토큰 없거나 틀리면 401, channel 헤더 없거나 틀리면 400, 없는 채널 404", async () => {
    const noToken = await app.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: { "x-dodok-channel-id": ch },
      payload: PDF_BYTES,
    });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect((await bridgeUpload(PDF_BYTES, { authorization: "Bearer wrong-token-xxxxxxxx" })).statusCode).toBe(
      401,
    );
    expect((await bridgeUpload(PDF_BYTES, { authorization: BRIDGE_TOKEN })).statusCode).toBe(401);
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
    expect((await bridgeUpload(PDF_BYTES, { "x-dodok-channel-id": "nope" })).statusCode).toBe(400);
    const missing = await bridgeUpload(PDF_BYTES, { "x-dodok-channel-id": uuid() });
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

  it("브리지 GET: 미묶음은 404(사람이 올린 것도), 묶인 것은 바이트", async () => {
    const bget = (id: string, token = BRIDGE_TOKEN) =>
      app.fastify.inject({
        method: "GET",
        url: `/bridge/attachments/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
    const mine = (await bridgeUpload(PDF_BYTES, { "x-dodok-file-name": "r.pdf" })).json() as Attachment;
    const human = (await upload(makePng(6, 2))).json() as Attachment;
    expect((await bget(mine.id)).statusCode).toBe(404);
    expect((await bget(human.id)).statusCode).toBe(404);
    bind([mine.id, human.id]);
    expect((await bget(mine.id, "wrong-token-xxxxxxxx")).statusCode).toBe(401);
    const got = await bget(mine.id);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(PDF_BYTES)).toBe(true);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    const img = await bget(human.id);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(makePng(6, 2))).toBe(true);
  });

  it("브리지 POST: 20 MiB 넘으면 413", async () => {
    const r = await bridgeUpload(Buffer.alloc(ATTACHMENT_LIMITS.agentFileMaxBytes + 1, 1));
    expect(r.statusCode).toBe(413);
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
