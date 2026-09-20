import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { RUN, RUN2, runEvent, textDelta } from "../../../test/fixtures";
import { useLiveRunEvents } from "./useLiveRunEvents";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const toolStart = (seq: number, runId = RUN) =>
  runEvent({ type: "TOOL_CALL_START", runId, seq, toolCallId: `t${seq}`, toolCallName: "Read" });

let fake: FakeSocket;
beforeEach(() => {
  fake = createFakeSocket();
  wire.socket = fake.wire;
});
afterEach(() => {
  wire.socket = undefined;
});

const emit = (event: unknown) => act(() => fake.serverEmit("run.event", { event }));

it("고른 런의 이벤트만 seq 순으로 모은다", () => {
  const { result } = renderHook(() => useLiveRunEvents(RUN));
  emit(toolStart(2));
  emit(toolStart(1));
  emit(toolStart(3, RUN2));
  expect(result.current.map((e) => e.seq)).toEqual([1, 2]);
});

it("행이 되지 않는 이벤트(텍스트 델타)는 모으지 않는다 — 델타마다 다시 정렬하지 않게", () => {
  const { result } = renderHook(() => useLiveRunEvents(RUN));
  emit(textDelta(1, "가"));
  emit(textDelta(2, "나"));
  expect(result.current).toEqual([]);
  emit(toolStart(3));
  expect(result.current).toHaveLength(1);
});

it("런을 바꾸면 앞 런의 이벤트를 버린다", () => {
  const { result, rerender } = renderHook(({ runId }: { runId: string }) => useLiveRunEvents(runId), {
    initialProps: { runId: RUN },
  });
  emit(toolStart(1));
  expect(result.current).toHaveLength(1);
  rerender({ runId: RUN2 });
  expect(result.current).toEqual([]);
});

it("떼어 내면 리스너를 거둔다", () => {
  const { unmount } = renderHook(() => useLiveRunEvents(RUN));
  expect(fake.listenerCount()).toBe(1);
  unmount();
  expect(fake.listenerCount()).toBe(0);
});

it("소켓이 없으면(연결 전) 빈 채로 돈다", () => {
  wire.socket = undefined;
  const { result } = renderHook(() => useLiveRunEvents(RUN));
  expect(result.current).toEqual([]);
});
