import ipaddr from "ipaddr.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { clientAddressOf, fastifyTrustProxy, parseTrustProxy } from "../src/http/client-address";
import { bootTestApp } from "./helpers/app";
import { testEnv } from "./helpers/env";

/** ::ffff:0:0/96 의 여집합 — 앞 i-1 비트는 그 구간과 같고 i 번째 비트만 다른 /i 를 i=1..96 으로 모은다 */
function allIPv6ButMapped(): string[] {
  const mapped = 0xffffn << 32n;
  return Array.from({ length: 96 }, (_, k) => {
    const flipped = mapped ^ (1n << BigInt(127 - k));
    const base = (flipped >> BigInt(127 - k)) << BigInt(127 - k);
    const bytes = Array.from({ length: 16 }, (_, b) => Number((base >> BigInt(8 * (15 - b))) & 0xffn));
    return `${ipaddr.fromByteArray(bytes).toString()}/${k + 1}`;
  });
}

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

  it("모든 IPv4·IPv6 를 덮는 다른 표기도 거절한다 — IPv4-mapped·넷마스크·쪼갠 대역의 합", () => {
    for (const raw of [
      "::ffff:0:0/96",
      "::ffff:0.0.0.0/96",
      "::/1",
      "::/64",
      "0:0:0:0:0:ffff:0:0/80",
      "0.0.0.0/1, 128.0.0.0/1",
      "0.0.0.0/128.0.0.0, 128.0.0.0/1",
      "0.0.0.0/2,64.0.0.0/2,128.0.0.0/2,192.0.0.0/2",
      "::ffff:0:0/97, 128.0.0.0/1",
      "::/1, 8000::/1",
      "8000::/1, ::/2, 4000::/2",
      // ::ffff:0:0/96 만 빼고 IPv6 전부 — IPv4 는 안 믿어도 IPv6 클라이언트는 모두 꾸민다
      allIPv6ButMapped().join(","),
    ]) {
      expect(() => parseTrustProxy(raw), raw).toThrow(/TRUST_PROXY 가 모든 주소를 믿는다/);
    }
  });

  it("정상 /32·/128·좁은 대역·전체에 못 미치는 합은 통과한다", () => {
    for (const raw of [
      "172.18.0.5/32",
      "172.18.0.5",
      "::ffff:172.18.0.5",
      "::ffff:172.18.0.5/128",
      "::1/128",
      "fd00::5/128",
      "172.18.0.0/16",
      "10.0.0.0/255.0.0.0",
      "2001:db8::/32",
      "0.0.0.0/1",
      "0.0.0.0/2, 128.0.0.0/1",
      "4000::/2, 8000::/1",
      // 여집합에서 하나라도 빠지면 「전체」가 아니다
      allIPv6ButMapped().slice(1).join(","),
    ]) {
      expect(parseTrustProxy(raw).kind, raw).toBe("list");
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
