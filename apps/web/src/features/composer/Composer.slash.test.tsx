import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, CH2, RUN, RUN2, runState, uid } from "../../../test/fixtures";
import { json } from "../../../test/shellApi";
import type { ComponentProps } from "react";
import {
  ME,
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
// 「새 대화」 대화상자는 실물이다. `holdOpen` 이면 한 번 열린 뒤 닫히지 않는다 — 「채널이 바뀌면 닫기」를 뺀 상황을 흉내 낸다
const resetDialog = vi.hoisted(() => ({ holdOpen: false }));
vi.mock("@/features/agents/ResetSessionDialog", async (importOriginal) => {
  const { ResetSessionDialog: Real } =
    await importOriginal<typeof import("@/features/agents/ResetSessionDialog")>();
  return {
    ResetSessionDialog: (props: ComponentProps<typeof Real>) => (
      <Real {...props} open={props.open || resetDialog.holdOpen} />
    ),
  };
});

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
  resetDialog.holdOpen = false;
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

describe("(f) /new", () => {
  it("/new + 에이전트 멘션 → 「새 대화」 대화상자, 확인하면 reset", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });

    const dialog = await screen.findByRole("dialog", { name: "새 대화" });
    expect(dialog).toHaveTextContent("@dev 와의 대화 기록을 새로 시작합니다. 진행 중인 실행은 중지됩니다");
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(true);

    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/channels/${CH}/agents/${AGENT}/reset`, "POST"],
    ]);
  });

  it("member 의 /new 는 대화상자 없이 「관리자만」 한 줄 — 요청·메시지 없음, 입력은 그대로(팀 스펙 2장)", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { box, editor } = renderComposer(CH, { ...ME, role: "member" });
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toastError).toHaveBeenCalledWith("「새 대화」는 관리자만 시작할 수 있습니다", {
      id: "slash-invalid",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(false);
  });

  it("열린 채 채널이 바뀌면 닫는다 — 돌아와도 다시 열리지 않고, 요청도 없다", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { box, editor, rerender } = renderComposer(CH);
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("dialog", { name: "새 대화" });

    act(() => rerender(CH2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => rerender(CH));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("대상은 연 채널이다 — 닫기가 없어도(열린 채 옮겨 가 확인해도) 요청은 연 채널로", async () => {
    resetDialog.holdOpen = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { box, editor, rerender } = renderComposer(CH);
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("dialog", { name: "새 대화" });

    act(() => rerender(CH2));
    const dialog = screen.getByRole("dialog", { name: "새 대화" });
    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/channels/${CH}/agents/${AGENT}/reset`, "POST"],
    ]);
  });

  it("wire 가 끊겨도 /new 는 된다(REST)", async () => {
    useWireStatus.getState().setStatus("reconnecting");
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "새 대화" })).toBeInTheDocument();
  });

  it("/new 뒤에 에이전트가 없으면 토스트, 입력은 남긴다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toastError).toHaveBeenCalledWith("/new 뒤에 @에이전트를 붙이세요", expect.anything());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor.getJSON()).toEqual(doc(p(t("/new dev"))));
  });
});
