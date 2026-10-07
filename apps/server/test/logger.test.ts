import { describe, expect, it } from "vitest";
import { createLogger, redactUrl, requestLogSerializer } from "../src/logger";

/** createLogger 의 가림을 그대로 쓰되 줄을 모은다 — pino 의 목적지만 바꾼다 */
function capture(): { lines: Array<Record<string, unknown>>; log: ReturnType<typeof createLogger> } {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger("info", { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { lines, log };
}

describe("createLogger 가림", () => {
  it("깊이 0~3 의 token 을 *** 로 가린다", () => {
    const { lines, log } = capture();
    log.info(
      { token: "a", x: { token: "b" }, y: { z: { token: "c" } }, p: { q: { r: { token: "d" } } } },
      "m",
    );
    expect(lines[0]).toMatchObject({
      token: "***",
      x: { token: "***" },
      y: { z: { token: "***" } },
      p: { q: { r: { token: "***" } } },
    });
  });

  // 소스의 목록을 가져오지 않고 여기에 다시 적는다 — 소스에서 하나를 지우면 이 표가 잡는다
  it.each([
    "token",
    "LOCAL_AUTH_TOKEN",
    "BRIDGE_TOKEN",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_DEV_GATEWAY_TOKEN",
    "BETTER_AUTH_SECRET",
    "VAPID_PRIVATE_KEY",
    "privateKey",
    "password",
    "authorization",
    "cookie",
    "set-cookie",
  ])("%s 를 깊이 0 과 3 에서 가린다", (key) => {
    const { lines, log } = capture();
    log.info({ [key]: "top", a: { b: { c: { [key]: "deep" } } } }, "m");
    expect(lines[0]).toMatchObject({ [key]: "***", a: { b: { c: { [key]: "***" } } } });
  });

  it("set-cookie·cookie·authorization 헤더를 가린다(res.headers·req.headers 깊이)", () => {
    const { lines, log } = capture();
    log.info(
      {
        "set-cookie": "top",
        res: { headers: { "set-cookie": ["s=1"] } },
        req: { headers: { cookie: "c=1", authorization: "Bearer x", "x-keep": "ok" } },
      },
      "m",
    );
    expect(lines[0]).toMatchObject({
      "set-cookie": "***",
      res: { headers: { "set-cookie": "***" } },
      req: { headers: { cookie: "***", authorization: "***", "x-keep": "ok" } },
    });
  });
});

describe("요청 로그의 URL — 웹훅 토큰 가림", () => {
  // 실제 발급과 같은 꼴(whk_ + base64url 43자)
  const token = "whk_0BVMW_jJFOfn5uqEVJpO8zLEnAIEkj7oxYm5mdFpTls";
  const shown = "whk_0BVMW_…";

  it.each([
    ["/hooks/<token>", `/hooks/${token}`, `/hooks/${shown}`],
    ["쿼리가 붙어도 — 쿼리는 그대로", `/hooks/${token}?delivery=1&x=2`, `/hooks/${shown}?delivery=1&x=2`],
    ["끝 슬래시·뒤 조각(404 꼴)", `/hooks/${token}/extra`, `/hooks/${shown}/extra`],
    ["대소문자(404 꼴)", `/HOOKS/${token}`, `/HOOKS/${shown}`],
    ["퍼센트 인코딩한 조각 — 앞 10자만", `/hooks/%77hk_${token.slice(4)}`, "/hooks/%77hk_0BVM…"],
    ["인코딩한 슬래시(404 꼴) — whk_ 토큰 꼴", `/hooks%2F${token}`, `/hooks%2F${shown}`],
    ["쿼리 속 토큰 꼴", `/hooks?t=${token}`, `/hooks?t=${shown}`],
  ])("%s", (_label, url, expected) => {
    expect(redactUrl(url)).toBe(expected);
    expect(redactUrl(url)).not.toContain(token.slice(10));
  });

  it.each([
    "/api/v1/channels?limit=50&after=12",
    "/bridge/attachments/01999999-0000-7000-8000-000000000001",
    "/api/v1/automations/01999999-0000-7000-8000-000000000001/token",
    "/hooks/whk_nope",
    "/socket.io/?EIO=4&transport=polling&sid=abcdefghijklmnopqrstuvwxyz",
  ])("다른 경로·짧은 조각은 그대로 — %s", (url) => {
    expect(redactUrl(url)).toBe(url);
  });

  it("requestLogSerializer 가 url 을 가린다 — 다른 필드는 그대로", () => {
    expect(
      requestLogSerializer({ method: "POST", url: `/hooks/${token}`, host: "h", ip: "203.0.113.7" }),
    ).toMatchObject({ method: "POST", url: `/hooks/${shown}`, host: "h", remoteAddress: "203.0.113.0/24" });
  });
});
