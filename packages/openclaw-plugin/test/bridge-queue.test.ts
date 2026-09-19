import { describe, expect, it } from "vitest";
import { DEFAULT_BACKOFF, OutboundQueue, backoffDelayMs } from "../src/bridge-queue";

describe("backoffDelayMs", () => {
  it("지수로 늘고 상한에서 멈춘다 (지터 0)", () => {
    const opts = { baseMs: 500, maxMs: 10_000, jitter: 0 };
    expect([0, 1, 2, 3, 4, 5, 10].map((attempt) => backoffDelayMs(attempt, opts, () => 0.5))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  it("지터는 ±비율 안에 머문다", () => {
    const opts = { baseMs: 1000, maxMs: 10_000, jitter: 0.2 };
    expect(backoffDelayMs(0, opts, () => 0)).toBe(800);
    expect(backoffDelayMs(0, opts, () => 1)).toBe(1200);
    expect(backoffDelayMs(10, opts, () => 1)).toBe(12_000);
  });

  it("기본 상한은 10s(지터 포함 12s) — 서버를 늦게 띄워도 첫 연결이 오래 밀리지 않는다(실연 21.5s, live-smoke 5.1)", () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 500, maxMs: 10_000, jitter: 0.2 });
    expect(backoffDelayMs(20, DEFAULT_BACKOFF, () => 1)).toBe(12_000);
  });
});

describe("OutboundQueue", () => {
  it("연결 전 항목을 순서대로 모았다가 flush 로 내보낸다", async () => {
    const queue = new OutboundQueue<string>({ max: 3 });
    queue.push("a");
    queue.push("b");
    const sent: string[] = [];
    await queue.flush(async (item) => {
      sent.push(item);
    });
    expect(sent).toEqual(["a", "b"]);
    expect(queue.depth).toBe(0);
  });

  it("보내다 실패하면 그 항목부터 큐에 남기고 멈춘다", async () => {
    const queue = new OutboundQueue<string>({ max: 5 });
    for (const item of ["a", "b", "c"]) queue.push(item);
    const sent: string[] = [];
    await expect(
      queue.flush(async (item) => {
        if (item === "b") throw new Error("down");
        sent.push(item);
      }),
    ).rejects.toThrow("down");
    expect(sent).toEqual(["a"]);
    expect(queue.depth).toBe(2);
  });

  it("상한을 넘으면 가장 오래된 것을 버리고 버린 항목을 돌려준다", () => {
    const queue = new OutboundQueue<string>({ max: 2 });
    expect(queue.push("a")).toBeUndefined();
    expect(queue.push("b")).toBeUndefined();
    expect(queue.push("c")).toBe("a");
    expect(queue.depth).toBe(2);
  });
});
