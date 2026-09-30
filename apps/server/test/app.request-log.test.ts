import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { bootTestApp } from "./helpers/app";

function captureLogger() {
  const lines: Array<{ msg?: string; req?: Record<string, unknown> }> = [];
  const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

describe("요청 로그의 원격 주소는 가린 값이다 — IPv4 /24·IPv6 /48(modules/ops/ip.ts ipPrefix)", () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const incoming = (lines: ReturnType<typeof captureLogger>["lines"]) =>
    lines.filter((l) => l.msg === "incoming request").map((l) => l.req);

  it("소켓 주소 IPv4 는 마지막 옥텟을, IPv6 는 뒤 80비트를 가린다 — 나머지 필드는 그대로", async () => {
    const { logger, lines } = captureLogger();
    app = await bootTestApp({ TRUST_PROXY: "false" }, { logger });
    await app.fastify.inject({ method: "GET", url: "/healthz", remoteAddress: "203.0.113.77" });
    await app.fastify.inject({ method: "GET", url: "/healthz", remoteAddress: "2001:db8:aa:bb:cc::5" });
    const reqs = incoming(lines);
    expect(reqs).toEqual([
      expect.objectContaining({ method: "GET", url: "/healthz", remoteAddress: "203.0.113.0/24" }),
      expect.objectContaining({ method: "GET", url: "/healthz", remoteAddress: "2001:db8:aa::/48" }),
    ]);
    const all = JSON.stringify(lines);
    expect(all).not.toContain("203.0.113.77");
    expect(all).not.toContain("2001:db8:aa:bb:cc::5");
  });

  it("TRUST_PROXY=true 면 X-Forwarded-For 첫 값(request.ip)을 가려 싣는다", async () => {
    const { logger, lines } = captureLogger();
    app = await bootTestApp({ TRUST_PROXY: "true" }, { logger });
    await app.fastify.inject({
      method: "GET",
      url: "/healthz",
      remoteAddress: "172.18.0.5",
      headers: { "x-forwarded-for": "198.51.100.23" },
    });
    expect(incoming(lines)).toEqual([expect.objectContaining({ remoteAddress: "198.51.100.0/24" })]);
    expect(JSON.stringify(lines)).not.toContain("198.51.100.23");
  });
});
