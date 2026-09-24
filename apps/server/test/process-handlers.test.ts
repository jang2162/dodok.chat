import { EventEmitter } from "node:events";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessHandlers, PROCESS_EXIT_TIMEOUT_MS } from "../src/process-handlers";

function setup(close: () => Promise<void> = async () => {}) {
  const proc = new EventEmitter();
  const order: string[] = [];
  const records: Array<{ kind: string; detail?: unknown }> = [];
  const app = {
    logger: pino({ level: "silent" }),
    ops: {
      record: vi.fn((input: { kind: string; detail?: unknown }) => {
        order.push(`record:${input.kind}`);
        records.push(input);
        return null;
      }),
    },
    close: vi.fn(async () => {
      order.push("close");
      await close();
    }),
  };
  const runState = { markClean: vi.fn(() => void order.push("markClean")) };
  const exit = vi.fn((code: number) => void order.push(`exit:${code}`));
  installProcessHandlers({ app, runState, exit, proc });
  return { proc, app, runState, exit, order, records };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("installProcessHandlers", () => {
  it("unhandledRejection 은 crash_rejection(process, error, detail.name)을 남기고 계속 돈다", async () => {
    const { proc, app, exit, records } = setup();
    proc.emit("unhandledRejection", new TypeError("본문 /secret/path"));
    proc.emit("unhandledRejection", "문자열 reject");
    await vi.runAllTimersAsync();
    expect(records).toEqual([
      { kind: "crash_rejection", key: "process", severity: "error", detail: { name: "TypeError" } },
      { kind: "crash_rejection", key: "process", severity: "error", detail: { name: "string" } },
    ]);
    expect(app.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("uncaughtException 은 close 전에 동기로 crash_exception 을 남기고, 닫은 뒤 exit(1) — 깨끗한 표지는 쓰지 않는다", async () => {
    const { proc, runState, order } = setup();
    proc.emit("uncaughtException", new RangeError("x"));
    expect(order).toEqual(["record:crash_exception", "close"]);
    await vi.runAllTimersAsync();
    expect(order).toEqual(["record:crash_exception", "close", "exit:1"]);
    expect(runState.markClean).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("%s 는 close 가 끝난 뒤 markClean → exit(0)", async (sig) => {
    const { proc, order } = setup();
    proc.emit(sig);
    await vi.runAllTimersAsync();
    expect(order).toEqual(["close", "markClean", "exit:0"]);
  });

  it("close 가 상한 안에 안 끝나면 exit(1)·markClean 없음, 두 번째 신호는 다시 닫지 않는다", async () => {
    const { proc, app, runState, exit } = setup(() => new Promise(() => {}));
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(PROCESS_EXIT_TIMEOUT_MS);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(runState.markClean).not.toHaveBeenCalled();
  });

  it("종료 도중의 uncaughtException 은 기록만 하고 종료 코드를 1 로 바꾼다", async () => {
    let release = () => {};
    const { proc, app, runState, exit, records } = setup(() => new Promise<void>((r) => (release = r)));
    proc.emit("SIGTERM");
    proc.emit("uncaughtException", new Error("during close"));
    release();
    await vi.runAllTimersAsync();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(records.map((r) => r.kind)).toEqual(["crash_exception"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runState.markClean).not.toHaveBeenCalled();
  });
});
