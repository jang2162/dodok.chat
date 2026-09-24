import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/modules/ops/limits";
import { KeyedLimiter, TokenBucket } from "../src/modules/ops/ratelimit";

function clock(start = 0) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe("LIMITS — 스펙 4장 숫자", () => {
  it("스펙 값 그대로다", () => {
    expect(LIMITS).toEqual({
      betterAuthPerMin: 30,
      restPerMin: 300,
      uploadPerMin: 30,
      wire: {
        heavy: { perMin: 30, burst: 10 },
        approval: { perMin: 60, burst: 20 },
        chatter: { perMin: 120, burst: 30 },
      },
      socketsPerUser: 20,
      bridgeFail: { maxFailures: 10, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 },
    });
  });
});

describe("TokenBucket", () => {
  it("연속 burst 개는 통과하고 그다음은 거절한다", () => {
    const c = clock();
    const bucket = new TokenBucket({ perMin: 30, burst: 10, now: c.now });
    expect(Array.from({ length: 10 }, () => bucket.take())).toEqual(Array(10).fill(true));
    expect(bucket.take()).toBe(false);
  });

  it("분당 perMin 속도로 다시 찬다 — 30/분이면 2초에 하나", () => {
    const c = clock();
    const bucket = new TokenBucket({ perMin: 30, burst: 10, now: c.now });
    for (let i = 0; i < 10; i++) bucket.take();
    c.t = 1_999;
    expect(bucket.take()).toBe(false);
    c.t = 2_000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it("오래 쉬어도 burst 를 넘게 쌓이지 않는다", () => {
    const c = clock();
    const bucket = new TokenBucket({ perMin: 30, burst: 10, now: c.now });
    c.t = 3_600_000;
    expect(Array.from({ length: 11 }, () => bucket.take()).filter(Boolean)).toHaveLength(10);
  });
});

describe("KeyedLimiter", () => {
  it("키마다 분당 perMin 개를 따로 센다", () => {
    const c = clock();
    const limiter = new KeyedLimiter({ perMin: 3, now: c.now });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(limiter.take("b")).toBe(true);
  });

  it("창(60초)이 지나면 다시 센다", () => {
    const c = clock();
    const limiter = new KeyedLimiter({ perMin: 1, now: c.now });
    expect(limiter.take("a")).toBe(true);
    c.t = 59_999;
    expect(limiter.take("a")).toBe(false);
    c.t = 60_000;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("키가 maxKeys 를 넘으면 가장 오래된 키를 버린다", () => {
    const c = clock();
    const limiter = new KeyedLimiter({ perMin: 1, maxKeys: 2, now: c.now });
    limiter.take("a");
    limiter.take("b");
    expect(limiter.take("a")).toBe(false);
    limiter.take("c"); // a 를 밀어낸다
    expect(limiter.take("b")).toBe(false);
    expect(limiter.take("a")).toBe(true);
  });
});
