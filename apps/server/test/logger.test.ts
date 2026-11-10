import { connect, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl, requestLogSerializer } from "../src/logger";
import { bootTestApp } from "./helpers/app";

/** createLogger 의 가림을 그대로 쓰되 줄을 모은다 — pino 의 목적지만 바꾼다 */
function capture(level = "info"): {
  lines: Array<Record<string, unknown>>;
  log: ReturnType<typeof createLogger>;
} {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger(level, { write: (line: string) => void lines.push(JSON.parse(line)) });
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

describe("[F2] err 의 Buffer 속성 — redact 가 걷다 던지지 않게 뗀다", () => {
  const hookToken = "whk_Fq3-Ze9xKpL0mN7bV2cR8tY4uI6oP1aS5dG-hJ3kQwE";
  // Node HTTP 파서 오류와 같은 꼴 — rawPacket 은 받은 요청 바이트다
  const parseError = () =>
    Object.assign(new Error("Parse Error: Invalid header value char"), {
      code: "HPE_INVALID_HEADER_TOKEN",
      bytesParsed: 40,
      rawPacket: Buffer.from(`POST /hooks/${hookToken} HTTP/1.1\r\nBad Header Line\r\n\r\n`),
    });

  it("trace 의 client error 줄을 남긴다 — code 는 그대로, rawPacket 은 없다", () => {
    const { lines, log } = capture("trace");
    expect(() => log.trace({ err: parseError() }, "client error")).not.toThrow();
    expect(lines[0]).toMatchObject({
      msg: "client error",
      err: { code: "HPE_INVALID_HEADER_TOKEN", bytesParsed: 40 },
    });
    expect(lines[0]?.err).not.toHaveProperty("rawPacket");
  });

  it("오류를 첫 인자로 넘겨도(log.error(err)) 같다", () => {
    const { lines, log } = capture("trace");
    expect(() => log.error(parseError())).not.toThrow();
    expect(lines[0]?.err).toMatchObject({ code: "HPE_INVALID_HEADER_TOKEN" });
    expect(lines[0]?.err).not.toHaveProperty("rawPacket");
  });

  it("cause 키도 같은 직렬화를 지난다 — 오류 처리기의 { err, cause } 줄이 던지지 않고 Buffer 만 뗀다", () => {
    const { lines, log } = capture("trace");
    // app.ts 오류 처리기·realtime/socket.ts 와 같은 꼴
    expect(() =>
      log.error({ err: new Error("internal"), cause: parseError() }, "internal error"),
    ).not.toThrow();
    expect(lines[0]?.cause).toMatchObject({
      type: "Error",
      code: "HPE_INVALID_HEADER_TOKEN",
      bytesParsed: 40,
    });
    expect(lines[0]?.cause).not.toHaveProperty("rawPacket");
    expect(JSON.stringify(lines[0])).not.toContain(hookToken);
  });

  it("실제 소켓 — LOG_LEVEL=trace 앱이 잘못된 머리 하나에 400 을 내고 다음 요청도 받는다", async () => {
    const lines: string[] = [];
    const app = await bootTestApp(
      {},
      { logger: createLogger("trace", { write: (line: string) => void lines.push(line) }) },
    );
    try {
      await app.fastify.listen({ host: "127.0.0.1", port: 0 });
      const { port } = app.fastify.server.address() as AddressInfo;
      const raw = await new Promise<string>((resolve) => {
        let got = "";
        const socket = connect(port, "127.0.0.1", () =>
          socket.write(`POST /hooks/${hookToken} HTTP/1.1\r\nHost: x\r\nBad Header Line\r\n\r\n`),
        );
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (got += chunk));
        socket.on("close", () => resolve(got));
        socket.on("error", () => resolve(got));
        socket.setTimeout(2000, () => socket.destroy());
      });
      expect(raw).toMatch(/^HTTP\/1\.1 400 /);
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const clientError = lines.find((line) => line.includes('"msg":"client error"'));
      expect(clientError).toContain("HPE_");
      expect(lines.join("\n")).not.toContain(hookToken.slice(10));
    } finally {
      await app.close();
    }
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

  // whk_ 규칙(/hooks/ 조각 규칙을 비켜 간 꼴)이 - 에서 멈추면 그 뒤가 드러난다 — 위 고정 토큰은 뒷부분에 - 가 없어 그 변이를 못 잡는다
  const dashed = "whk_0BVMW_jJFOfn5u-EVJpO8zLEnAIEkj7oxYm5mdFpTls";
  it.each([
    ["인코딩한 슬래시(404 꼴)", `/hooks%2F${dashed}`, `/hooks%2F${shown}`],
    ["다른 경로의 쿼리", `/api/v1/channels?t=${dashed}`, `/api/v1/channels?t=${shown}`],
  ])("뒷부분에 - 가 든 토큰도 끝까지 가린다 — %s", (_label, url, expected) => {
    expect(redactUrl(url)).toBe(expected);
    expect(redactUrl(url)).not.toContain(dashed.slice(10));
  });

  // 개인 토큰(dpt_ + base64url 43자)은 Authorization 머리로만 받지만 ?token= 으로 잘못 실려 올 수 있다 — 꼬리에 - 가 든 꼴로 [\w-] 가
  // \w 로 줄어든 변이를 잡는다
  const pat = "dpt_Ab3dE-_jJFOfn5u-EVJpO8zLEnAIEkj7oxYm5mdFpTl";
  it.each([
    ["/mcp 쿼리", `/mcp?token=${pat}`, "/mcp?token=dpt_Ab3dE-…"],
    ["다른 쿼리와 함께", `/mcp?x=1&api_key=${pat}&y=2`, "/mcp?x=1&api_key=dpt_Ab3dE-…&y=2"],
  ])("쿼리 속 개인 토큰 꼴도 dpt_ + 6자만 — %s", (_label, url, expected) => {
    expect(redactUrl(url)).toBe(expected);
    expect(redactUrl(url)).not.toContain(pat.slice(10));
  });

  // 초대·재설정 링크(dit_·drt_ + base64url 43자)는 웹 SPA 경로 /join/·/reset/ 에 실린다 — 서버가 웹도 내므로 그 페이지를 여는 요청이
  // 요청 줄에 남는다. 목록의 prefix(원문 앞 8자)만 보인다. 꼬리에 - 가 든 꼴로 [\w-] 가 \w 로 줄어든 변이를 잡는다
  const invite = "dit_Qx7k-_jJFOfn5u-EVJpO8zLEnAIEkj7oxYm5mdFpTl";
  const reset = "drt_Zp2m-_jJFOfn5u-EVJpO8zLEnAIEkj7oxYm5mdFpTl";
  it.each([
    ["/join/<초대>", `/join/${invite}`, "/join/dit_Qx7k…", invite],
    ["/reset/<재설정>", `/reset/${reset}`, "/reset/drt_Zp2m…", reset],
    ["쿼리가 붙은 경로", `/join/${invite}?from=mail`, "/join/dit_Qx7k…?from=mail", invite],
    [
      "쿼리에 실린 초대",
      `/api/v1/invites/accept?token=${invite}`,
      "/api/v1/invites/accept?token=dit_Qx7k…",
      invite,
    ],
    ["쿼리에 실린 재설정", `/x?a=1&t=${reset}&b=2`, "/x?a=1&t=drt_Zp2m…&b=2", reset],
  ])("초대·재설정 링크 토큰은 앞 8자만 — %s", (_label, url, expected, raw) => {
    expect(redactUrl(url)).toBe(expected);
    expect(redactUrl(url)).not.toContain(raw.slice(8));
  });

  it.each([
    ["8자 이하(가릴 꼬리 없음)", "/join/dit_abcd", "/join/dit_abcd"],
    ["9자 — 꼬리 한 글자도 가린다", "/reset/drt_abcde", "/reset/drt_abcd…"],
  ])("짧은 링크 토큰 — %s", (_label, url, expected) => {
    expect(redactUrl(url)).toBe(expected);
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

  // 쿼리 파서(fast-querystring)는 키도 디코드한다 — 인코딩한 키도 relPath 로 받아 둘러보기가 되므로 그 값도 가린다 [태스크 4 리뷰 L3]
  it.each([
    [
      "그대로",
      "/api/v1/runners/r/fs?rootId=src&relPath=secret%2Fdir",
      "/api/v1/runners/r/fs?rootId=src&relPath=…",
    ],
    [
      "첫 쿼리",
      "/api/v1/runners/r/fs?relPath=secret%2Fdir&rootId=src",
      "/api/v1/runners/r/fs?relPath=…&rootId=src",
    ],
    [
      "대문자 인코딩 P",
      "/api/v1/runners/r/fs?rootId=src&rel%50ath=secret%2Fdir",
      "/api/v1/runners/r/fs?rootId=src&rel%50ath=…",
    ],
    [
      "소문자 인코딩 p",
      "/api/v1/runners/r/fs?rootId=src&rel%70ath=secret%2Fdir",
      "/api/v1/runners/r/fs?rootId=src&rel%70ath=…",
    ],
    ["키 전체 인코딩", "/x?%72%65%6C%50%61%74%68=secret", "/x?%72%65%6C%50%61%74%68=…"],
    ["뒤 조각은 그대로", "/x?relPath=secret#frag", "/x?relPath=…#frag"],
  ])("쿼리 relPath 값은 키를 디코드해 가린다 — %s", (_label, url, expected) => {
    expect(redactUrl(url)).toBe(expected);
    expect(redactUrl(url)).not.toContain("secret");
  });

  it.each(["/x?relPathX=keep&prelPath=keep", "/x?rel%2550ath=keep", "/x?a=%E0%A4%A&b=keep"])(
    "relPath 가 아닌 키·잘못된 인코딩은 그대로 — %s",
    (url) => {
      expect(redactUrl(url)).toBe(url);
    },
  );

  it("requestLogSerializer 가 url 을 가린다 — 다른 필드는 그대로", () => {
    expect(
      requestLogSerializer({ method: "POST", url: `/hooks/${token}`, host: "h", ip: "203.0.113.7" }),
    ).toMatchObject({ method: "POST", url: `/hooks/${shown}`, host: "h", remoteAddress: "203.0.113.0/24" });
  });
});
