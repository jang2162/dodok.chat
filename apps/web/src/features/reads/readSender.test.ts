import type { ConversationRead } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, CH2 } from "../../../test/fixtures";
import { createReadSender, READ_DELAY_MS } from "./readSender";

/** 보낸 것을 기록하고 저장된 위치(커지기만 함)를 돌려주는 가짜 서버 */
function fakeServer() {
  const sent: ConversationRead[] = [];
  let fail: Error | undefined;
  const emit = vi.fn(async (p: ConversationRead) => {
    sent.push(p);
    if (fail) throw fail;
    return { lastReadSeq: p.seq };
  });
  return {
    sent,
    emit,
    failWith(e: Error | undefined) {
      fail = e;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createReadSender", () => {
  it("기본 간격은 1초", () => {
    expect(READ_DELAY_MS).toBe(1_000);
  });

  it("1초 안에 세 번 요청하면 한 번, 가장 큰 seq 로 보낸다", async () => {
    const server = fakeServer();
    const sender = createReadSender(server.emit);
    sender.request(CH, 5);
    sender.request(CH, 7);
    sender.request(CH, 6);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS - 1);
    expect(server.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.sent).toEqual([{ conversationId: CH, seq: 7 }]);
  });

  it("첫 요청부터 1초 — 요청이 이어져도 보내기가 밀리지 않는다", async () => {
    const server = fakeServer();
    const sender = createReadSender(server.emit);
    sender.request(CH, 1);
    await vi.advanceTimersByTimeAsync(600);
    sender.request(CH, 2);
    await vi.advanceTimersByTimeAsync(400);
    expect(server.sent).toEqual([{ conversationId: CH, seq: 2 }]);
  });

  it("세션마다 따로(같은 채널의 두 세션도) — 둘이면 각각 한 번", async () => {
    const server = fakeServer();
    const sender = createReadSender(server.emit);
    sender.request(CH, 3);
    sender.request(CH2, 9);
    sender.request(CH, 4);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
    expect(server.sent).toEqual(
      expect.arrayContaining([
        { conversationId: CH, seq: 4 },
        { conversationId: CH2, seq: 9 },
      ]),
    );
    expect(server.sent).toHaveLength(2);
  });

  it("이미 저장된 위치 이하는 다시 보내지 않는다 — 응답의 위치가 더 크면(다른 기기) 그것까지", async () => {
    const server = fakeServer();
    server.emit.mockImplementationOnce(async (p) => {
      server.sent.push(p);
      return { lastReadSeq: 20 };
    });
    const sender = createReadSender(server.emit);
    sender.request(CH, 10);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
    sender.request(CH, 10);
    sender.request(CH, 20);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
    expect(server.sent).toEqual([{ conversationId: CH, seq: 10 }]);
    sender.request(CH, 21);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
    expect(server.sent.at(-1)).toEqual({ conversationId: CH, seq: 21 });
  });

  it("실패(레이트 초과 포함)는 밖으로 던지지 않고 버린다 — 다음 요청이 같은 seq 를 다시 보낸다", async () => {
    const server = fakeServer();
    server.failWith(Object.assign(new Error("rate limited"), { code: "RATE_LIMITED" }));
    const sender = createReadSender(server.emit);
    sender.request(CH, 8);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
    expect(server.sent).toEqual([{ conversationId: CH, seq: 8 }]);
    // 실패한 것을 스스로 다시 보내지 않는다 — 다음 조건이 설 때(다음 요청) 보낸다
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS * 5);
    expect(server.sent).toHaveLength(1);

    server.failWith(undefined);
    sender.request(CH, 8);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS);
    expect(server.sent).toEqual([
      { conversationId: CH, seq: 8 },
      { conversationId: CH, seq: 8 },
    ]);
  });

  it("dispose 뒤에는 모아 둔 것도, 새 요청도 보내지 않는다", async () => {
    const server = fakeServer();
    const sender = createReadSender(server.emit);
    sender.request(CH, 3);
    sender.dispose();
    sender.request(CH2, 4);
    await vi.advanceTimersByTimeAsync(READ_DELAY_MS * 2);
    expect(server.sent).toEqual([]);
  });

  it("간격을 바꿀 수 있다", async () => {
    const server = fakeServer();
    const sender = createReadSender(server.emit, { delayMs: 50 });
    sender.request(CH, 1);
    await vi.advanceTimersByTimeAsync(50);
    expect(server.sent).toEqual([{ conversationId: CH, seq: 1 }]);
  });
});
