import { describe, expect, it } from "vitest";
import { BridgeAuthGuard } from "../src";

const A = "203.0.113.7";
const SEC = 1_000;

function failTimes(guard: BridgeAuthGuard, address: string, times: number, at: number): boolean[] {
  return Array.from({ length: times }, () => guard.fail(address, at));
}

describe("BridgeAuthGuard — 브리지 인증 실패 카운터(스펙 4.1)", () => {
  it("60초 안 10번째 실패에서 막히기 시작한다 — fail 은 그 한 번만 true", () => {
    const guard = new BridgeAuthGuard();
    expect(failTimes(guard, A, 9, 0)).toEqual(Array(9).fill(false));
    expect(guard.isBlocked(A, 0)).toBe(false);
    expect(guard.fail(A, 30 * SEC)).toBe(true);
    expect(guard.isBlocked(A, 30 * SEC)).toBe(true);
    // 막힌 동안의 실패는 새로 막히기 시작한 것이 아니다
    expect(guard.fail(A, 31 * SEC)).toBe(false);
    // 그 실패가 막힘을 지우지 않는다
    expect(guard.isBlocked(A, 31 * SEC)).toBe(true);
  });

  it("막힌 지 59.999초는 여전히 막히고 60초에 저절로 풀린다(Review Focus 3)", () => {
    const guard = new BridgeAuthGuard();
    failTimes(guard, A, 10, 5 * SEC);
    expect(guard.isBlocked(A, 5 * SEC + 59_999)).toBe(true);
    expect(guard.isBlocked(A, 5 * SEC + 60_000)).toBe(false);
  });

  it("풀린 뒤에는 처음부터 다시 센다 — 실패 하나로 다시 막히지 않는다", () => {
    const guard = new BridgeAuthGuard();
    failTimes(guard, A, 10, 0);
    expect(guard.fail(A, 60 * SEC)).toBe(false);
    expect(guard.isBlocked(A, 60 * SEC)).toBe(false);
    expect(failTimes(guard, A, 8, 61 * SEC)).toEqual(Array(8).fill(false));
    expect(guard.fail(A, 62 * SEC)).toBe(true);
  });

  it("창(60초) 밖의 실패는 새로 센다", () => {
    const guard = new BridgeAuthGuard();
    failTimes(guard, A, 9, 0);
    expect(guard.fail(A, 60 * SEC)).toBe(false);
    expect(guard.isBlocked(A, 60 * SEC)).toBe(false);
    expect(failTimes(guard, A, 8, 61 * SEC)).toEqual(Array(8).fill(false));
    expect(guard.fail(A, 70 * SEC)).toBe(true);
  });

  it("주소마다 따로 센다", () => {
    const guard = new BridgeAuthGuard();
    failTimes(guard, A, 10, 0);
    expect(guard.isBlocked(A, 0)).toBe(true);
    expect(guard.isBlocked("203.0.113.8", 0)).toBe(false);
  });

  it("기억하는 주소가 1024개를 넘으면 가장 오래된 주소부터 버린다", () => {
    const guard = new BridgeAuthGuard();
    failTimes(guard, "addr-0", 10, 0);
    for (let i = 1; i < 1024; i++) guard.fail(`addr-${i}`, 1);
    expect(guard.isBlocked("addr-0", 2)).toBe(true);
    guard.fail("addr-1024", 2);
    expect(guard.isBlocked("addr-0", 2)).toBe(false);
    // 버려진 주소는 처음부터 센다
    expect(failTimes(guard, "addr-0", 9, 3)).toEqual(Array(9).fill(false));
  });

  it("상한·창·막는 시간은 옵션으로 바꾼다", () => {
    const guard = new BridgeAuthGuard({ maxFailures: 2, windowMs: 10, blockMs: 100, maxAddresses: 1 });
    expect(guard.fail(A, 0)).toBe(false);
    expect(guard.fail(A, 5)).toBe(true);
    expect(guard.isBlocked(A, 104)).toBe(true);
    expect(guard.isBlocked(A, 105)).toBe(false);
    guard.fail("other", 0);
    guard.fail(A, 200);
    guard.fail("x", 200);
    expect(guard.fail(A, 201)).toBe(false); // maxAddresses 1 — "x" 가 A 를 밀어냈다
  });

  it("성공으로 카운터를 비우는 API 가 없다 — 성공한 인증은 막힘을 풀지 않는다", () => {
    const methods = Object.getOwnPropertyNames(BridgeAuthGuard.prototype).filter((n) => n !== "constructor");
    expect(methods.sort()).toEqual(["fail", "isBlocked"]);
  });
});
