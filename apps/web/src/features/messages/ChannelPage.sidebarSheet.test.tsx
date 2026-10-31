import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline, type Timeline } from "@/features/messages/timeline";
import { ReadSenderContext } from "@/features/reads/readSender";
import { isViewingAtEnd, useUnread } from "@/features/reads/useUnread";
import { setChannelSeq } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { CH, msg, uid } from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { stubScrollLayout } from "../../../test/scrollLayout";

/**
 * 좁은 화면 사이드바 시트가 타임라인을 덮는 동안의 읽음(plan.md 이월 「좁은 화면 사이드바 시트가 타임라인을 덮어도 읽음이 오른다」).
 * 오른쪽 패널(스레드·활동·설정) 시트는 이미 막는다(`threads.test.tsx` 「채널 읽음과 스레드 패널」) — 왼쪽 시트도 같은 길이다
 */
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const theirs = (seq: number) => msg(seq, { authorId: uid(77), bodyMd: `남의 글 ${seq}` });

let restore: Array<() => void>;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout({ width: 390, height: 600 })];
  wire.socket = createFakeSocket().wire;
  useWireStatus.getState().setStatus("connected");
  useUnread.getState().reset();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      return shellGet(input, init) ?? json(404, {});
    }),
  );
});
afterEach(() => {
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useUnread.getState().reset();
});

it("좁은 화면: 사이드바 시트가 타임라인을 덮고 있으면 새 글이 와도 읽음을 보내지 않고, 닫으면 보낸다", async () => {
  stubMedia(true);
  const items = [1, 2, 3].map(theirs);
  const qc = createQueryClient(() => {});
  qc.setQueryData<Timeline>(qk.timeline(CH, CH), { ...emptyTimeline(), items, lastSeq: 3 });
  setChannelSeq(qc, CH, 3);
  const sender = { request: vi.fn(), dispose: vi.fn() };
  renderRoute(`/c/${CH}/s/${CH}`, qc, (children) => (
    <ReadSenderContext.Provider value={sender}>{children}</ReadSenderContext.Provider>
  ));
  await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 3));

  await userEvent.click(await screen.findByRole("button", { name: "채널 목록 열기" }));
  await screen.findByRole("dialog", { name: "채널 목록" });
  await waitFor(() => expect(isViewingAtEnd(CH)).toBe(false));

  // 시트를 연 채 보고 있던 세션에 새 글이 온다
  act(() => {
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), (prev) =>
      prev ? { ...prev, items: [...prev.items, theirs(4)], lastSeq: 4 } : prev,
    );
    setChannelSeq(qc, CH, 4);
  });
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(sender.request).not.toHaveBeenCalledWith(CH, 4);

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "채널 목록" })).toBeNull());
  await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 4));
  expect(isViewingAtEnd(CH)).toBe(true);
});
