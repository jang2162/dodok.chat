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
