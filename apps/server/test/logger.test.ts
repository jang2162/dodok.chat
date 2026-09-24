import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";

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
