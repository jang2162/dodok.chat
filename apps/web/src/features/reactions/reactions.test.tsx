import { type Message, type Person, REACTION_EMOJIS, type Result } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelArchivedContext } from "@/features/channels/archived";
import { MessageItem } from "@/features/messages/MessageItem";
import { PendingItem } from "@/features/messages/PendingItem";
import { emptyTimeline, type Timeline, upsert } from "@/features/messages/timeline";
import { CHANNEL_ARCHIVED_TEXT } from "@/api/formErrors";
import { qk } from "@/api/queries";
import { getThread, getTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, msg, USER } from "../../../test/fixtures";
import { authorsClient, OWNER_PERSON, renderWithClient } from "../../../test/messages";
import { ReactionChips } from "./ReactionChips";
import { ReactionPicker } from "./ReactionPicker";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

const MIA_ID = "00000000-0000-4000-8000-0000000000a1";
const GONE_ID = "00000000-0000-4000-8000-0000000000a2";
const MIA: Person = { id: MIA_ID, handle: "mia", displayName: "미아", role: "member", deactivatedAt: null };
const GONE: Person = {
  id: GONE_ID,
  handle: "gone",
  displayName: "떠난 사람",
  role: "member",
  deactivatedAt: "2027-02-01T00:00:00.000Z",
};
const PEOPLE = [OWNER_PERSON, MIA, GONE];

let fake: FakeSocket;
beforeEach(() => {
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  vi.mocked(toast.error).mockClear();
});

/**
 * 메뉴를 키보드(초점 + Enter)로 연다. jsdom 은 초점이 없던 문서에서 요소로 초점이 갈 때 window 에 blur 를 쏘고, Radix 메뉴는
 * window blur 에 닫힌다 — 그래서 열기 전에 트리거에 초점을 준다(키보드로 열거나 `focus()` 뒤 클릭). 그러지 않으면 파일의 둘째
 * 테스트부터 메뉴가 열리자마자 닫힌다. 마우스 열기는 파일 첫 테스트인 피커 테스트가 확인한다
 */
async function openPicker(
  user: ReturnType<typeof userEvent.setup>,
  scope: Pick<typeof screen, "getByRole"> = screen,
) {
  scope.getByRole("button", { name: "반응 추가" }).focus();
  await user.keyboard("{Enter}");
}

const withReactions = (seq: number, reactions: Message["reactions"], over: Partial<Message> = {}) =>
  msg(seq, { reactions, ...over });

describe("ReactionPicker", () => {
  it("「반응 추가」 → 메뉴에 이모지 8개, 화살표·Enter 로 고르고 Esc 로 닫으면 초점이 버튼으로 돌아온다", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithClient(<ReactionPicker onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: "반응 추가" });
    await user.click(trigger);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([...REACTION_EMOJIS]);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(REACTION_EMOJIS[1]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await user.click(trigger);
    await screen.findAllByRole("menuitem");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("가로 한 줄이라 ←·→ 로도 옮긴다 — 끝에서는 멈춘다(↑·↓ 와 같다)", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderWithClient(<ReactionPicker onPick={onPick} />);
    await openPicker(user);
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{End}{ArrowRight}");
    expect(items[7]).toHaveFocus();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(REACTION_EMOJIS[6]);
  });
});

describe("ReactionChips", () => {
  const thumbs = (userIds: string[]): Message["reactions"] => [
    { emoji: "👍", count: userIds.length, userIds },
  ];

  it("리액션이 없으면 아무것도 그리지 않는다", () => {
    const { container } = renderWithClient(
      <ReactionChips message={msg(1)} me={USER} onToggle={() => {}} />,
      authorsClient(undefined, PEOPLE),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("`👍 3` 칩 — 내가 단 칩은 aria-pressed=true, 누르면 onToggle 이 반대 상태로 불린다", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderWithClient(
      <ReactionChips
        message={withReactions(1, [
          { emoji: "👍", count: 3, userIds: [MIA_ID, USER, GONE_ID] },
          { emoji: "🎉", count: 1, userIds: [MIA_ID] },
        ])}
        me={USER}
        onToggle={onToggle}
      />,
      authorsClient(undefined, PEOPLE),
    );
    const mine = screen.getByRole("button", { name: /👍\s*3/ });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(mine).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: /🎉\s*1/ })).toHaveAttribute("aria-pressed", "false");
    await user.click(mine);
    expect(onToggle).toHaveBeenCalledWith("👍", false);
    await user.click(screen.getByRole("button", { name: /🎉\s*1/ }));
    expect(onToggle).toHaveBeenLastCalledWith("🎉", true);
  });

  const people3 = () =>
    renderWithClient(
      <ReactionChips
        message={withReactions(1, thumbs([MIA_ID, USER, GONE_ID]))}
        me={USER}
        onToggle={() => {}}
      />,
      authorsClient(undefined, PEOPLE),
    );

  it("마우스를 올리면 「@mia, @owner」, 비활성 멤버는 「@핸들 (비활성)」", async () => {
    people3();
    await userEvent.hover(screen.getByRole("button", { name: /👍\s*3/ }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("@mia, @owner, @gone (비활성)");
  });

  it("초점이 와도 같은 툴팁이 뜬다", async () => {
    people3();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: /👍\s*3/ })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("@mia, @owner, @gone (비활성)");
  });

  it("보관한 채널이면 칩은 aria-disabled — 눌러도(클릭·Enter·Space) 아무 일이 없고, 키보드 초점은 받아 툴팁을 읽는다", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderWithClient(
      <ChannelArchivedContext.Provider value={true}>
        <ReactionChips message={withReactions(1, thumbs([MIA_ID]))} me={USER} onToggle={onToggle} />
      </ChannelArchivedContext.Provider>,
      authorsClient(undefined, PEOPLE),
    );
    const chip = screen.getByRole("button", { name: /👍\s*1/ });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    await user.tab();
    expect(chip).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("@mia");
    await user.keyboard("{Enter} ");
    await user.click(chip);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("MessageItem 안의 리액션", () => {
  const ROOT_MSG = msg(1, { bodyMd: "루트" });
  const timelineWith = (...items: Message[]): Timeline =>
    items.reduce((t, m) => upsert(t, m), emptyTimeline());
  const emptyAck = () => ({ ok: true as const, data: null });

  it("반응 추가 → 칩이 곧바로 생기고 reaction.set {on:true} 가 나간다. 서버 message.updated 가 오면 그것으로 맞춘다", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    qc.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    fake.onAck("reaction.set", emptyAck);
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={ROOT_MSG} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "🎉" }));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([{ emoji: "🎉", count: 1, userIds: [USER] }]);
    expect(fake.sentOf("reaction.set")).toEqual([{ messageId: ROOT_MSG.id, emoji: "🎉", on: true }]);

    // 서버 정본: mia 도 달았다 — 캐시는 이것으로 바뀐다(낙관값을 덮는다)
    const server = withReactions(1, [{ emoji: "🎉", count: 2, userIds: [MIA_ID, USER] }], {
      id: ROOT_MSG.id,
    });
    act(() => {
      qc.setQueryData(qk.timeline(CH), (t: Timeline) => upsert(t, server));
    });
    expect(getTimeline(qc, CH)?.items[0]?.reactions[0]?.count).toBe(2);
  });

  it("ack 실패 → 원래대로 되돌리고 「반응을 저장하지 못했습니다」 토스트", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    qc.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    fake.onAck("reaction.set", () => ({
      ok: false as const,
      error: { code: "INTERNAL", message: "boom" },
    }));
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={ROOT_MSG} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("반응을 저장하지 못했습니다", expect.anything()),
    );
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([]);
  });

  it("Review Focus 1 — 켜기·끄기를 연달아 눌러 첫 요청이 늦게 실패해도 화면은 마지막(끄기) 상태", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    const base = withReactions(1, [], { id: ROOT_MSG.id });
    qc.setQueryData(qk.timeline(CH), timelineWith(base));
    let failFirst!: () => void;
    let calls = 0;
    fake.onAck("reaction.set", () => {
      calls += 1;
      if (calls === 1)
        return new Promise((resolve) => {
          failFirst = () => resolve({ ok: false, error: { code: "INTERNAL", message: "late" } });
        });
      return emptyAck();
    });
    const user = userEvent.setup();
    const { rerender } = renderWithClient(<MessageItem message={base} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toHaveLength(1);
    // 목록이 캐시의 새 메시지로 다시 그려진 것처럼 — 칩이 보이면 같은 칩을 눌러 끈다
    rerender(<MessageItem message={getTimeline(qc, CH)?.items[0] as Message} head />);
    await user.click(await screen.findByRole("button", { name: /👍\s*1/ }));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([]);
    expect(fake.sentOf("reaction.set")).toEqual([
      { messageId: ROOT_MSG.id, emoji: "👍", on: true },
      { messageId: ROOT_MSG.id, emoji: "👍", on: false },
    ]);
    // 첫 요청(켜기)이 이제야 실패한다 — 마지막 요청이 아니므로 되돌리지 않는다
    await act(async () => failFirst());
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  /** reaction.set ack 을 붙들어 두었다가 테스트가 순서를 골라 풀어 준다(보낸 순) */
  function holdAcks() {
    const pending: Array<(r: Result<unknown>) => void> = [];
    fake.onAck("reaction.set", () => new Promise<Result<unknown>>((resolve) => pending.push(resolve)));
    return {
      settle: (i: number, r: Result<unknown>) => act(async () => pending[i]?.(r)),
    };
  }
  const failed = (code: "RATE_LIMITED" | "TIMEOUT" | "CHANNEL_ARCHIVED" | "INTERNAL") => ({
    ok: false as const,
    error: { code, message: code },
  });
  const thumbsMine: Message["reactions"] = [{ emoji: "👍", count: 1, userIds: [USER] }];

  /** 리액션 없는 루트에 피커로 👍 를 켜고, 다시 그려진 칩으로 끈다 — 두 요청 모두 ack 을 기다린다 */
  async function thumbsOnThenOff(qc: ReturnType<typeof authorsClient>) {
    const base = withReactions(1, [], { id: ROOT_MSG.id });
    qc.setQueryData(qk.timeline(CH), timelineWith(base));
    const acks = holdAcks();
    const user = userEvent.setup();
    const { rerender } = renderWithClient(<MessageItem message={base} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    rerender(<MessageItem message={getTimeline(qc, CH)?.items[0] as Message} head />);
    await user.click(await screen.findByRole("button", { name: /👍\s*1/ }));
    expect(fake.sentOf("reaction.set")).toEqual([
      { messageId: ROOT_MSG.id, emoji: "👍", on: true },
      { messageId: ROOT_MSG.id, emoji: "👍", on: false },
    ]);
    return acks;
  }

  it("켜기·끄기가 둘 다 실패하면 서버에 없는 칩을 남기지 않는다 — 요청 전 상태(빈 목록)로 맞추고 토스트는 한 번", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    const acks = await thumbsOnThenOff(qc);
    await acks.settle(0, failed("RATE_LIMITED"));
    await acks.settle(1, failed("RATE_LIMITED"));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([]);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("반응을 저장하지 못했습니다", expect.anything());
    // 다 끝나면 message.updated 듣기도 거둔다
    expect(fake.listenerCount()).toBe(0);
  });

  it("켜기는 성공하고 끄기만 실패하면 서버에 있는 내 👍 가 남는다", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    const acks = await thumbsOnThenOff(qc);
    await acks.settle(0, emptyAck());
    await acks.settle(1, failed("RATE_LIMITED"));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual(thumbsMine);
  });

  it("마지막 요청이 실패해도 그사이 받은 message.updated 가 말한 상태로 맞춘다 — 서버는 처리했는데 ack 만 시간 초과", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    const base = withReactions(1, [], { id: ROOT_MSG.id });
    qc.setQueryData(qk.timeline(CH), timelineWith(base));
    const acks = holdAcks();
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={base} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    act(() => {
      fake.serverEmit("message.updated", {
        message: withReactions(1, thumbsMine, { id: ROOT_MSG.id }),
      });
    });
    await acks.settle(0, failed("TIMEOUT"));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual(thumbsMine);
  });

  it("같은 메시지의 다른 이모지는 따로 센다 — 👍 가 늦게 실패하면 👍 만 되돌리고 그 뒤에 단 🎉 는 남긴다", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    qc.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    const acks = holdAcks();
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={ROOT_MSG} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "🎉" }));
    expect(getTimeline(qc, CH)?.items[0]?.reactions.map((r) => r.emoji)).toEqual(["👍", "🎉"]);
    await acks.settle(1, emptyAck());
    await acks.settle(0, failed("INTERNAL"));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([{ emoji: "🎉", count: 1, userIds: [USER] }]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("ack CHANNEL_ARCHIVED → 되돌리고 보관 문구 토스트, 채널·채널 목록을 다시 받는다", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    qc.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    qc.setQueryData(qk.channel(CH), { id: CH });
    qc.setQueryData(qk.channels, [{ id: CH }]);
    fake.onAck("reaction.set", () => failed("CHANNEL_ARCHIVED"));
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={ROOT_MSG} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(CHANNEL_ARCHIVED_TEXT, { id: "channel-archived" });
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([]);
    expect(qc.getQueryState(qk.channel(CH))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.channels)?.isInvalidated).toBe(true);
  });

  /** 채널 타임라인과 그 루트의 스레드 패널이 둘 다 열려 있다(넓은 화면에서 나란히 보인다) */
  const bothOpen = () => {
    const qc = authorsClient(undefined, PEOPLE);
    qc.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    qc.setQueryData(
      qk.thread(CH, ROOT_MSG.id),
      timelineWith(ROOT_MSG, msg(2, { threadRootId: ROOT_MSG.id })),
    );
    fake.onAck("reaction.set", emptyAck);
    return qc;
  };
  const rootIn = (t: Timeline | undefined) => t?.items.find((m) => m.id === ROOT_MSG.id)?.reactions;

  it("채널에서 루트에 달면 열린 스레드 패널의 같은 루트도 곧바로 바뀐다", async () => {
    const qc = bothOpen();
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={ROOT_MSG} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "🎉" }));
    const mine = [{ emoji: "🎉", count: 1, userIds: [USER] }];
    expect(rootIn(getTimeline(qc, CH))).toEqual(mine);
    expect(rootIn(getThread(qc, CH, ROOT_MSG.id))).toEqual(mine);
  });

  it("스레드 패널에서 루트에 달면 채널 타임라인의 같은 루트도 곧바로 바뀐다", async () => {
    const qc = bothOpen();
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={ROOT_MSG} head inThread />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👀" }));
    const mine = [{ emoji: "👀", count: 1, userIds: [USER] }];
    expect(rootIn(getThread(qc, CH, ROOT_MSG.id))).toEqual(mine);
    expect(rootIn(getTimeline(qc, CH))).toEqual(mine);
  });

  it("채널 행에서 켜고 스레드 패널 칩으로 끈 뒤 둘 다 실패해도 서버에 없는 칩을 남기지 않는다 — 두 행이 요청 하나로 센다", async () => {
    const qc = bothOpen();
    const acks = holdAcks();
    const user = userEvent.setup();
    const rows = (inChannel: Message, inPanel: Message) => (
      <>
        <section aria-label="채널">
          <MessageItem message={inChannel} head />
        </section>
        <section aria-label="스레드 패널">
          <MessageItem message={inPanel} head inThread />
        </section>
      </>
    );
    const { rerender } = renderWithClient(rows(ROOT_MSG, ROOT_MSG), qc);
    await openPicker(user, within(screen.getByRole("region", { name: "채널" })));
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    // 두 캐시의 메시지로 다시 그려진 것처럼 — 스레드 패널 칩으로 끈다
    const rootOf = (t: Timeline | undefined) => t?.items.find((m) => m.id === ROOT_MSG.id) as Message;
    rerender(rows(rootOf(getTimeline(qc, CH)), rootOf(getThread(qc, CH, ROOT_MSG.id))));
    const panel = within(screen.getByRole("region", { name: "스레드 패널" }));
    await user.click(panel.getByRole("button", { name: /👍\s*1/ }));
    expect(fake.sentOf("reaction.set")).toEqual([
      { messageId: ROOT_MSG.id, emoji: "👍", on: true },
      { messageId: ROOT_MSG.id, emoji: "👍", on: false },
    ]);
    await acks.settle(0, failed("TIMEOUT"));
    await acks.settle(1, failed("TIMEOUT"));
    expect(rootIn(getTimeline(qc, CH))).toEqual([]);
    expect(rootIn(getThread(qc, CH, ROOT_MSG.id))).toEqual([]);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(0);
  });

  it("켜고 행이 다시 마운트된 뒤 칩으로 끄고 둘 다 실패해도 서버에 없는 칩을 남기지 않는다", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    qc.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    const acks = holdAcks();
    const user = userEvent.setup();
    const { unmount } = renderWithClient(<MessageItem message={ROOT_MSG} head />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    // 가상 목록이 행을 지웠다 다시 그리거나 채널을 옮겼다 돌아온 것처럼 — 새 행이 캐시의 메시지로 그려진다
    unmount();
    renderWithClient(<MessageItem message={getTimeline(qc, CH)?.items[0] as Message} head />, qc);
    await user.click(screen.getByRole("button", { name: /👍\s*1/ }));
    expect(fake.sentOf("reaction.set")).toHaveLength(2);
    await acks.settle(0, failed("TIMEOUT"));
    await acks.settle(1, failed("TIMEOUT"));
    expect(getTimeline(qc, CH)?.items[0]?.reactions).toEqual([]);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(0);
  });

  it("나가 있는 요청은 QueryClient 마다 따로다 — 다른 클라이언트의 요청에 끼어 그 클라이언트 캐시로 되돌리지 않는다", async () => {
    const acks = holdAcks();
    const user = userEvent.setup();
    const mineA = authorsClient(undefined, PEOPLE);
    const onA = withReactions(1, thumbsMine, { id: ROOT_MSG.id });
    mineA.setQueryData(qk.timeline(CH), timelineWith(onA));
    const a = renderWithClient(<MessageItem message={onA} head />, mineA);
    await user.click(within(a.container).getByRole("button", { name: /👍\s*1/ }));

    const emptyB = authorsClient(undefined, PEOPLE);
    emptyB.setQueryData(qk.timeline(CH), timelineWith(ROOT_MSG));
    const b = renderWithClient(<MessageItem message={ROOT_MSG} head />, emptyB);
    await openPicker(user, within(b.container));
    await user.click(await screen.findByRole("menuitem", { name: "👍" }));
    await acks.settle(1, failed("TIMEOUT"));
    expect(getTimeline(emptyB, CH)?.items[0]?.reactions).toEqual([]);
    await acks.settle(0, emptyAck());
    expect(getTimeline(mineA, CH)?.items[0]?.reactions).toEqual([]);
  });

  it("스레드 패널 안에서도 달린다 — 스레드 캐시가 바뀐다", async () => {
    const qc = authorsClient(undefined, PEOPLE);
    const reply = msg(2, { threadRootId: ROOT_MSG.id });
    qc.setQueryData(qk.thread(CH, ROOT_MSG.id), timelineWith(ROOT_MSG, reply));
    fake.onAck("reaction.set", emptyAck);
    const user = userEvent.setup();
    renderWithClient(<MessageItem message={reply} head inThread />, qc);
    await openPicker(user);
    await user.click(await screen.findByRole("menuitem", { name: "✅" }));
    const t = getThread(qc, CH, ROOT_MSG.id);
    expect(t?.items.find((m) => m.id === reply.id)?.reactions).toEqual([
      { emoji: "✅", count: 1, userIds: [USER] },
    ]);
    // 채널 타임라인 캐시는 만들어지지 않는다(들어간 적 없는 채널에 빈 목록을 두지 않는다)
    expect(getTimeline(qc, CH)).toBeUndefined();
  });

  it("시스템 메시지에는 버튼·칩이 없다", () => {
    const sys = msg(1, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      reactions: [{ emoji: "👍", count: 1, userIds: [MIA_ID] }],
    });
    renderWithClient(<MessageItem message={sys} head />, authorsClient(undefined, PEOPLE));
    expect(screen.queryByRole("button", { name: "반응 추가" })).toBeNull();
    expect(screen.queryByRole("button", { name: /👍/ })).toBeNull();
  });

  it("보내는 중 항목에는 버튼·칩이 없다", () => {
    renderWithClient(
      <PendingItem
        pending={{
          clientMsgId: "c1",
          channelId: CH,
          bodyMd: "보내는 중",
          createdAt: ROOT_MSG.createdAt,
          state: "sending",
        }}
      />,
      authorsClient(undefined, PEOPLE),
    );
    expect(screen.queryByRole("button", { name: "반응 추가" })).toBeNull();
  });

  it("보관한 채널이면 「반응 추가」가 없다", () => {
    renderWithClient(
      <ChannelArchivedContext.Provider value={true}>
        <MessageItem message={withReactions(1, [{ emoji: "👍", count: 1, userIds: [MIA_ID] }])} head />
      </ChannelArchivedContext.Provider>,
      authorsClient(undefined, PEOPLE),
    );
    expect(screen.queryByRole("button", { name: "반응 추가" })).toBeNull();
    expect(screen.getByRole("button", { name: /👍\s*1/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("마우스가 없는 기기(hover: none)에서는 「반응 추가」가 늘 보이는 클래스를 가진다 — PR2", () => {
    renderWithClient(<MessageItem message={ROOT_MSG} head />, authorsClient(undefined, PEOPLE));
    const cls = screen.getByRole("button", { name: "반응 추가" }).className;
    expect(cls).toContain("[@media(hover:none)]:opacity-100");
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("group-focus-within:opacity-100");
  });
});
