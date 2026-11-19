import { act, screen, waitFor, within } from "@testing-library/react";
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
import { conversationOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
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

/** 좁은 화면 머리의 단추 이름 — 세션 제목(이름 바꾸기 단추)은 제목 줄이라 뺀다 */
const headerButtons = (header: HTMLElement) =>
  within(header)
    .getAllByRole("button")
    .filter((b) => b.dataset.testid !== "conversation-title")
    .map((b) => b.getAttribute("aria-label"));

/** 세션 하나(「이전 대화」 — 열린 세션, owner 가 바꿀 수 있다)와 그 초대 목록(빈)까지 답하는 서버 */
function stubSessionServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, ME);
      if (url === `/api/v1/conversations/${CH}`) return json(200, { conversation: conversationOf(CH) });
      if (url === `/api/v1/conversations/${CH}/agents`) return json(200, { invited: [] });
      return shellGet(input, init) ?? json(404, {});
    }),
  );
}

/** 「더 보기」 메뉴를 연다 — 트리거에 초점을 준 뒤 Enter(jsdom 의 window blur 가 클릭으로 연 Radix 메뉴를 닫는다 — invitedAgents.test) */
async function openMore(user: ReturnType<typeof userEvent.setup>, header: HTMLElement) {
  const more = await within(header).findByRole("button", { name: "더 보기" });
  more.focus();
  await user.keyboard("{Enter}");
  return { more, menu: await screen.findByRole("menu") };
}

it("overflow mirrors desktop actions", async () => {
  stubMedia(true);
  stubSessionServer();
  const user = userEvent.setup();
  const { router } = renderRoute(`/c/${CH}/s/${CH}`);
  const header = await screen.findByTestId("channel-header");
  // 제목 두 줄 — 위 채널 이름, 아래 지금 세션 제목(이름 바꾸기 그대로)
  await within(header).findByTestId("conversation-title");
  expect(within(header).getByRole("heading", { level: 1 }).textContent).not.toBe("");
  await waitFor(() => expect(headerButtons(header)).toEqual(["채널 목록 열기", "세션 목록", "더 보기"]));
  expect(within(header).queryAllByRole("link")).toEqual([]);
  for (const name of ["채널 목록 열기", "세션 목록", "더 보기"])
    expect(within(header).getByRole("button", { name })).toHaveClass("size-11");

  const { menu } = await openMore(user, header);
  await waitFor(() =>
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["에이전트 초대", "새 세션", "파일", "채널 설정", "세션 닫기"]),
  );
  // 되돌릴 수 없는 「세션 닫기」만 구분선 아래 맨 끝
  const separators = within(menu).getAllByRole("separator");
  expect(separators).toHaveLength(1);
  expect(separators[0]?.nextElementSibling).toHaveTextContent("세션 닫기");
  for (const item of within(menu).getAllByRole("menuitem")) expect(item).toHaveClass("min-h-11");

  // 「새 세션」은 데스크톱 링크와 같은 주소로
  await user.click(within(menu).getByRole("menuitem", { name: "새 세션" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/new`));
});

it("좁은 화면 「더 보기」 — Esc 로 닫으면 초점이 단추로, 대화상자를 연 줄도 닫으면 초점이 「더 보기」로, 「채널 설정」은 설정 패널", async () => {
  stubMedia(true);
  stubSessionServer();
  const user = userEvent.setup();
  const { router } = renderRoute(`/c/${CH}/s/${CH}`);
  const header = await screen.findByTestId("channel-header");
  await within(header).findByTestId("conversation-title");

  const { more } = await openMore(user, header);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(more).toHaveFocus());

  // 「세션 닫기」 → 확인 대화상자, 취소하면 초점이 「더 보기」로
  let { menu } = await openMore(user, header);
  await user.click(within(menu).getByRole("menuitem", { name: "세션 닫기" }));
  const confirm = await screen.findByRole("dialog", { name: "세션 닫기" });
  await user.click(within(confirm).getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "세션 닫기" })).toBeNull());
  await waitFor(() => expect(more).toHaveFocus());

  // 「에이전트 초대」 → 초대 대화상자, Esc 로 닫으면 초점이 「더 보기」로
  ({ menu } = await openMore(user, header));
  await user.click(within(menu).getByRole("menuitem", { name: "에이전트 초대" }));
  await screen.findByRole("dialog", { name: "에이전트 초대" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "에이전트 초대" })).toBeNull());
  await waitFor(() => expect(more).toHaveFocus());

  // 「채널 설정」 → 설정 패널(데스크톱 링크와 같은 주소)
  ({ menu } = await openMore(user, header));
  await user.click(within(menu).getByRole("menuitem", { name: "채널 설정" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/settings`));
});

it("resize while menu open", async () => {
  const media = stubMedia(true);
  stubSessionServer();
  const user = userEvent.setup();
  renderRoute(`/c/${CH}/s/${CH}`);
  const header = await screen.findByTestId("channel-header");
  await within(header).findByTestId("conversation-title");
  await openMore(user, header);
  media.setNarrow(false);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(within(header).queryByRole("button", { name: "더 보기" })).toBeNull();
  expect(within(header).getByRole("link", { name: "채널 설정" })).toBeInTheDocument();
  expect(within(header).getByRole("link", { name: "새 세션" })).toBeInTheDocument();
  expect(within(header).getByRole("button", { name: "세션 닫기" })).toBeInTheDocument();
  expect(within(header).getByRole("button", { name: "에이전트 초대" })).toBeInTheDocument();
});
