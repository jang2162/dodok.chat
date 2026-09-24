import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      localLoginPerMin: 5,
      restPerMin: 300,
      uploadPerMin: 30,
      wire: {
        heavy: { perMin: 30, burst: 10 },
        replay: { perMin: 120, burst: 30 },
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

  it("시계가 뒤로 가도 토큰 빚이 생기지 않는다 — 돌아간 시각부터 다시 찬다", () => {
    const c = clock(3_600_000);
    const bucket = new TokenBucket({ perMin: 30, burst: 10, now: c.now });
    for (let i = 0; i < 10; i++) bucket.take();
    c.t -= 60_000;
    expect(bucket.take()).toBe(false);
    c.t += 2_000;
    expect(bucket.take()).toBe(true);
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

  it("perMin 0 이면 첫 요청부터 거절한다", () => {
    const limiter = new KeyedLimiter({ perMin: 0, now: clock().now });
    expect([limiter.take("a"), limiter.take("a")]).toEqual([false, false]);
  });

  it("시계가 창 시작보다 뒤로 가면 그 창을 끝난 것으로 본다 — 역행한 만큼 막힘이 늘지 않는다", () => {
    const c = clock(3_600_000);
    const limiter = new KeyedLimiter({ perMin: 1, now: c.now });
    expect(limiter.take("a")).toBe(true);
    c.t = 0;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });
});

describe("기본 시계는 단조 시계다 — 벽시계(Date)가 뛰어도 창·버킷이 따라가지 않는다", () => {
  // Date 만 가짜로 — performance.now 는 그대로 흐른다. 만든 뒤에 벽시계를 옮긴다
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-25T03:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("KeyedLimiter — 벽시계가 2분 앞으로 뛰어도 같은 창이다", () => {
    const limiter = new KeyedLimiter({ perMin: 1 });
    expect(limiter.take("a")).toBe(true);
    vi.setSystemTime(Date.parse("2026-09-25T03:02:00.000Z"));
    expect(limiter.take("a")).toBe(false);
  });

  it("TokenBucket — 벽시계가 1분 앞으로 뛰어도 다시 차지 않는다", () => {
    const bucket = new TokenBucket({ perMin: 30, burst: 1 });
    expect(bucket.take()).toBe(true);
    vi.setSystemTime(Date.parse("2026-09-25T03:01:00.000Z"));
    expect(bucket.take()).toBe(false);
  });
});
