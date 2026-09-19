import { WIRE_PROTOCOL } from "@dodok/shared";
import { io } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieSessionToken } from "../src/realtime/cookie-auth";
import { bootTestApp, login } from "./helpers/app";

const ORIGIN = "http://localhost:5173";

describe("cookieSessionToken", () => {
  it("Origin 이 APP_ORIGIN 과 같으면 dodok.session 값을 꺼낸다(URL 인코딩 풀기)", () => {
    expect(cookieSessionToken({ origin: ORIGIN, cookie: "a=1; dodok.session=tok%2Eabc; b=2" }, ORIGIN)).toBe(
      "tok.abc",
    );
  });
  it("APP_ORIGIN 끝의 / 는 무시한다", () => {
    expect(cookieSessionToken({ origin: ORIGIN, cookie: "dodok.session=t" }, `${ORIGIN}/`)).toBe("t");
  });
  it("Origin 이 다르거나 없으면 쿠키를 읽지 않는다(CSWSH)", () => {
    expect(
      cookieSessionToken({ origin: "http://evil.test", cookie: "dodok.session=t" }, ORIGIN),
    ).toBeUndefined();
    expect(cookieSessionToken({ cookie: "dodok.session=t" }, ORIGIN)).toBeUndefined();
  });
  it("쿠키가 없거나 값이 비었거나 잘못 인코딩돼 있으면 undefined", () => {
    expect(cookieSessionToken({ origin: ORIGIN }, ORIGIN)).toBeUndefined();
    expect(cookieSessionToken({ origin: ORIGIN, cookie: "dodok.session=" }, ORIGIN)).toBeUndefined();
    expect(cookieSessionToken({ origin: ORIGIN, cookie: "dodok.session=%E0%A4%A" }, ORIGIN)).toBeUndefined();
  });
});

describe("wire 쿠키 인증", () => {
  let app: Awaited<ReturnType<typeof bootTestApp>>;
  let token: string;
  beforeAll(async () => {
    app = await bootTestApp(); // bootTestApp 은 listen 하지 않는다
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    token = (await login(app)).token; // 앱당 login 1회(레이트리밋 5/분)
  });
  afterAll(() => app.close());

  const open = (opts: { cookie?: string; origin?: string; token?: string; protocol?: number }) =>
    new Promise<{ ok: true } | { ok: false; code: string }>((resolve) => {
      const socket = io(app.url, {
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
        auth: { protocol: opts.protocol ?? WIRE_PROTOCOL, ...(opts.token ? { token: opts.token } : {}) },
        // Node 전송(ws)은 extraHeaders 를 웹소켓 핸드셰이크 헤더로 싣는다
        extraHeaders: {
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
      });
      socket.on("connect", () => {
        socket.close();
        resolve({ ok: true });
      });
      socket.on("connect_error", (err) => {
        socket.close();
        resolve({ ok: false, code: (err as unknown as { data?: { code: string } }).data?.code ?? "?" });
      });
    });

  it("토큰 없이 같은 출처 쿠키로 붙는다", async () => {
    await expect(open({ origin: ORIGIN, cookie: `dodok.session=${token}` })).resolves.toEqual({ ok: true });
  });
  it("setCookie 처럼 URL 인코딩된 쿠키 값으로도 붙는다", async () => {
    await expect(
      open({ origin: ORIGIN, cookie: `a=1; dodok.session=${encodeURIComponent(token)}; b=2` }),
    ).resolves.toEqual({ ok: true });
  });
  it("Origin 이 다르면 쿠키가 맞아도 UNAUTHORIZED", async () => {
    await expect(open({ origin: "http://evil.test", cookie: `dodok.session=${token}` })).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });
  it("Origin 이 없으면 쿠키가 맞아도 UNAUTHORIZED", async () => {
    await expect(open({ cookie: `dodok.session=${token}` })).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });
  it("토큰이 있으면 토큰을 쓴다(쿠키가 틀려도 붙는다)", async () => {
    await expect(open({ token, origin: ORIGIN, cookie: "dodok.session=bogus" })).resolves.toEqual({
      ok: true,
    });
  });
  it("틀린 쿠키는 UNAUTHORIZED", async () => {
    await expect(open({ origin: ORIGIN, cookie: "dodok.session=bogus" })).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  });
  it("프로토콜이 틀리면 쿠키가 맞아도 PROTOCOL_MISMATCH", async () => {
    await expect(
      open({ protocol: WIRE_PROTOCOL + 1, origin: ORIGIN, cookie: `dodok.session=${token}` }),
    ).resolves.toEqual({ ok: false, code: "PROTOCOL_MISMATCH" });
  });
});
