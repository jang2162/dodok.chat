import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { clientAddressOf, fastifyTrustProxy, parseTrustProxy } from "../src/http/client-address";
import { bootTestApp } from "./helpers/app";
import { testEnv } from "./helpers/env";

describe("parseTrustProxy", () => {
  it("비었거나 false 면 아무도 믿지 않는다", () => {
    for (const raw of [undefined, "", "false", " false "])
      expect(parseTrustProxy(raw)).toEqual({ kind: "none" });
  });

  it("IP·CIDR 쉼표 목록은 공백을 걷어 그대로 싣는다", () => {
    expect(parseTrustProxy("172.18.0.5/32, 10.0.0.1")).toEqual({
      kind: "list",
      entries: ["172.18.0.5/32", "10.0.0.1"],
    });
    expect(parseTrustProxy("::1")).toEqual({ kind: "list", entries: ["::1"] });
  });

  it("true 는 받지 않는다 — 이유를 말한다", () => {
    expect(() => parseTrustProxy("true")).toThrow(/TRUST_PROXY=true/);
  });

  it("IP·CIDR 이 아닌 것은 던진다 — 이름 붙은 범위·/0·빈 칸 포함", () => {
    for (const raw of ["not-an-ip", "loopback", "uniquelocal", "0.0.0.0/0", "10.0.0.1,", "10.0.0.1/33"]) {
      expect(() => parseTrustProxy(raw), raw).toThrow(/TRUST_PROXY/);
    }
  });

  it("fastifyTrustProxy — none 은 false, 목록은 쉼표로 이은 문자열", () => {
    expect(fastifyTrustProxy({ kind: "none" })).toBe(false);
    expect(fastifyTrustProxy({ kind: "list", entries: ["172.18.0.5/32", "10.0.0.1"] })).toBe(
      "172.18.0.5/32,10.0.0.1",
    );
  });
});

describe("clientAddressOf", () => {
  const proxy = parseTrustProxy("172.18.0.5/32");
  const at = (address: string, xff?: string) => ({
    address,
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });

  it("아무도 믿지 않으면 XFF 를 읽지 않고 연결 주소", () => {
    expect(clientAddressOf({ kind: "none" })(at("10.0.0.9", "1.2.3.4"))).toBe("10.0.0.9");
  });

  it("믿는 프록시가 덧붙인 XFF 는 오른쪽 값 — 클라이언트가 꾸민 왼쪽 값이 아니다", () => {
    expect(clientAddressOf(proxy)(at("172.18.0.5", "1.2.3.4, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("믿지 않는 이웃이 보낸 XFF 는 무시하고 그 연결 주소", () => {
    expect(clientAddressOf(proxy)(at("172.18.0.6", "1.2.3.4"))).toBe("172.18.0.6");
  });

  it("IPv4-mapped 연결 주소(::ffff:172.18.0.5)도 그 프록시로 믿는다", () => {
    expect(clientAddressOf(proxy)(at("::ffff:172.18.0.5", "203.0.113.7"))).toBe("203.0.113.7");
  });

  it("믿는 프록시에 XFF 가 없으면 연결 주소", () => {
    expect(clientAddressOf(proxy)(at("172.18.0.5"))).toBe("172.18.0.5");
  });
});

describe("TRUST_PROXY 부팅", () => {
  it("loadConfig 가 true 를 설정 오류로 거절한다", () => {
    expect(() => loadConfig({ ...testEnv, TRUST_PROXY: "true" })).toThrow(/설정 오류[\s\S]*TRUST_PROXY=true/);
  });

  it("bootTestApp({TRUST_PROXY:true}) 는 뜨지 않는다", async () => {
    await expect(bootTestApp({ TRUST_PROXY: "true" })).rejects.toThrow(/TRUST_PROXY=true/);
  });
});
