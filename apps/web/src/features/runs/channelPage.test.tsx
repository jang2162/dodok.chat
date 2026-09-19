import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, msg, RUN, runState, textDelta } from "../../../test/fixtures";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { ME, json, renderRoute, shellGet } from "../../../test/shellApi";
import { useRunStore } from "./runStore";

// 채널 화면이 버블(태스크 8)을 메시지 목록 끝에 끼우는지 — 배선만 잰다. 버블 동작은 StreamingBubble·useChannelBubbles 테스트
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

let fake: FakeSocket;
let restore: Array<() => void>;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout()];
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === "/api/v1/auth/me" ? json(200, ME) : (shellGet(input, init) ?? json(404, {})),
    ),
  );
});
afterEach(() => {
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
});

it("채널 화면: 진행 중인 런이 목록 끝에 버블로 뜨고, 중지를 누르면 run.abort", async () => {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.timeline(CH), { ...emptyTimeline(), items: [msg(1, { bodyMd: "질문" })], lastSeq: 1 });
  act(() => {
    useRunStore.getState().applyState(runState({ status: "streaming" }));
    useRunStore.getState().applyEvent(textDelta(1, "답하는 중"));
  });
  fake.onAck("run.abort", () => ({ ok: true, data: null }));
  renderRoute(`/c/${CH}`, qc);

  expect(await screen.findByText("답하는 중")).toBeInTheDocument();
  const rows = [...document.querySelectorAll("[data-index]")].map((r) => r.textContent ?? "");
  expect(rows.at(-1)).toContain("답하는 중");
  await userEvent.click(screen.getByRole("button", { name: "실행 중지" }));
  expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN }]);
});
