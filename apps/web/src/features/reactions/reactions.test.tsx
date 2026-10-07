import { type Message, type Person, REACTION_EMOJIS } from "@dodok/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelArchivedContext } from "@/features/channels/archived";
import { MessageItem } from "@/features/messages/MessageItem";
import { PendingItem } from "@/features/messages/PendingItem";
import { emptyTimeline, type Timeline, upsert } from "@/features/messages/timeline";
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
 * 메뉴를 키보드(초점 + Enter)로 연다. 마우스 클릭으로 연 메뉴에서 항목을 고르면 같은 파일의 다음 테스트에서 트리거가
 * 클릭으로 열리지 않는다(user-event + jsdom 에서 재현, 키보드로 열면 매번 열린다). 마우스 열기는 피커 테스트가 한 번 확인한다
 */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  screen.getByRole("button", { name: "반응 추가" }).focus();
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

  it("보관한 채널이면 칩은 눌러도 아무 일이 없는 disabled", async () => {
    const onToggle = vi.fn();
    renderWithClient(
      <ChannelArchivedContext.Provider value={true}>
        <ReactionChips message={withReactions(1, thumbs([MIA_ID]))} me={USER} onToggle={onToggle} />
      </ChannelArchivedContext.Provider>,
      authorsClient(undefined, PEOPLE),
    );
    const chip = screen.getByRole("button", { name: /👍\s*1/ });
    expect(chip).toBeDisabled();
    await userEvent.click(chip);
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
    expect(screen.getByRole("button", { name: /👍\s*1/ })).toBeDisabled();
  });

  it("마우스가 없는 기기(hover: none)에서는 「반응 추가」가 늘 보이는 클래스를 가진다 — PR2", () => {
    renderWithClient(<MessageItem message={ROOT_MSG} head />, authorsClient(undefined, PEOPLE));
    const cls = screen.getByRole("button", { name: "반응 추가" }).className;
    expect(cls).toContain("[@media(hover:none)]:opacity-100");
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("group-focus-within:opacity-100");
  });
});
