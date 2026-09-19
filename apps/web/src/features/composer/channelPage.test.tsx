import type { Message, Result } from "@dodok/shared";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, msg } from "../../../test/fixtures";
import { ME, json, renderRoute, shellGet } from "../../../test/shellApi";

// 채널 화면이 작성기 자리를 채우고, 보내는 중 항목의 다시 보내기·삭제를 PendingActionsContext 로 내려 주는지 잰다.
// 목록(태스크 7)은 아직 없으므로 헤더 자리에 컨텍스트를 읽는 탐침을 둔다
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
vi.mock("@/app/layout/ChannelHeader", async () => {
  const { usePendingActions } = await import("@/features/messages/pendingActions");
  const { useQueryClient } = await import("@tanstack/react-query");
  const timeline = await import("@/realtime/timelineCache");
  return {
    ChannelHeader: ({ channelId }: { channelId: string }) => {
      const actions = usePendingActions();
      const qc = useQueryClient();
      const first = () => timeline.getTimeline(qc, channelId)?.pending[0]?.clientMsgId ?? "";
      return (
        <div>
          <button type="button" onClick={() => actions?.retry(first())}>
            탐침 다시 보내기
          </button>
          <button type="button" onClick={() => actions?.discard(first())}>
            탐침 삭제
          </button>
        </div>
      );
    },
  };
});

let fake: FakeSocket;
let restoreDom: () => void;
beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === "/api/v1/auth/me" ? json(200, ME) : (shellGet(input, init) ?? json(404, {})),
    ),
  );
});
afterEach(() => {
  restoreDom();
  vi.unstubAllGlobals();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const confirmed = (payload: unknown): Result<{ message: Message }> => {
  const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
  return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd }) } };
};

async function sendFailing(text: string) {
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: Editor }).editor;
  act(() => {
    editor.commands.setContent(text);
    editor.commands.focus("end");
  });
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  fireEvent.keyDown(box, { key: "Enter" });
}

it("작성기 자리: 작성 중 표시 + 작성기", async () => {
  renderRoute(`/c/${CH}`);
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const slot = box.closest('[data-slot="composer"]');
  expect(slot).not.toBeNull();
  expect(within(slot as HTMLElement).getByRole("button", { name: "보내기" })).toBeInTheDocument();
});

it("PendingActions: 다시 보내기는 같은 clientMsgId 로 다시 보내 확정, 삭제는 캐시에서만", async () => {
  const { queryClient } = renderRoute(`/c/${CH}`);
  await sendFailing("실패할 글");
  await waitFor(() => expect(getTimeline(queryClient, CH)?.pending.map((p) => p.state)).toEqual(["failed"]));
  const id = getTimeline(queryClient, CH)?.pending[0]?.clientMsgId;

  fake.onAck("message.send", confirmed);
  await userEvent.click(screen.getByRole("button", { name: "탐침 다시 보내기" }));
  await waitFor(() => expect(getTimeline(queryClient, CH)?.pending).toEqual([]));
  expect(getTimeline(queryClient, CH)?.items.map((m) => m.clientMsgId)).toEqual([id]);
  expect(fake.sentOf("message.send").map((p) => (p as { clientMsgId: string }).clientMsgId)).toEqual([
    id,
    id,
  ]);

  await sendFailing("버릴 글");
  await waitFor(() => expect(getTimeline(queryClient, CH)?.pending).toHaveLength(1));
  const sent = fake.sent.length;
  await userEvent.click(screen.getByRole("button", { name: "탐침 삭제" }));
  expect(getTimeline(queryClient, CH)?.pending).toEqual([]);
  expect(fake.sent).toHaveLength(sent);
});
