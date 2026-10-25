import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, CH2, RUN, RUN2, runState, uid } from "../../../test/fixtures";
import { json } from "../../../test/shellApi";
import {
  confirmed,
  doc,
  flushEditorFrames,
  mention,
  p,
  renderComposer,
  setDoc,
  settleAcks,
  t,
} from "../../../test/composerHarness";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

let fake: FakeSocket;
let restoreDom: () => void;
let toastInfo: MockInstance<typeof toast.info>;
let toastError: MockInstance<typeof toast.error>;

beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
  toastInfo = vi.spyOn(toast, "info");
  toastError = vi.spyOn(toast, "error");
});
afterEach(async () => {
  await flushEditorFrames();
  restoreDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

describe("(e) /stop", () => {
  const seedRuns = () =>
    act(() => {
      const s = useRunStore.getState();
      s.applyState(runState({ id: RUN, status: "streaming" }));
      s.applyState(runState({ id: RUN2, status: "queued" }));
      s.applyState(runState({ id: uid(103), status: "done" }));
      s.applyState(runState({ id: uid(104), channelId: CH2, status: "streaming" }));
    });

  it("이 채널의 끝나지 않은 런마다 run.abort, 메시지로 보내지 않고 비운다", async () => {
    fake.onAck("run.abort", () => ({ ok: true, data: null }));
    seedRuns();
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN }, { runId: RUN2 }]);
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(true);
    // 실패 토스트는 아래 테스트가 같은 기다림으로 잰다 — 여기서 없으면 정말 없다
    await settleAcks();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("진행 중인 런이 없으면 「진행 중인 실행이 없습니다」", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("run.abort")).toEqual([]);
    expect(toastInfo).toHaveBeenCalledWith("진행 중인 실행이 없습니다");
  });

  it("ack 실패는 코드별 문구 토스트", async () => {
    fake.onAck("run.abort", () => ({ ok: false, error: { code: "NOT_FOUND", message: "run not found" } }));
    act(() => useRunStore.getState().applyState(runState({ id: RUN, status: "streaming" })));
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    await settleAcks();
    expect(toastError).toHaveBeenCalledWith("이미 끝났거나 없는 실행입니다", expect.anything());
  });
});

describe("(f) /new 는 명령이 아니다", () => {
  it("/new @dev 는 보통 메시지로 나간다 — 대화상자·REST 요청 없음", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([
      { channelId: CH, clientMsgId: expect.any(String), bodyMd: `/new <@a:${AGENT}>` },
    ]);
    await waitFor(() => expect(editor.isEmpty).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
