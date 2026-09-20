import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH } from "../../../test/fixtures";
import { confirmed, flushEditorFrames, renderComposer } from "../../../test/composerHarness";
import { MentionList, mentionSuggestion } from "./MentionList";
import { type MentionCandidate, mentionCandidates } from "./mentions";
import { DEV, FIN, ME, memberOf } from "../../../test/composerHarness";
import type { Editor } from "@tiptap/core";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

let fake: FakeSocket;
let restoreDom: () => void;

beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
});
afterEach(async () => {
  await flushEditorFrames();
  restoreDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

describe("멘션", () => {
  const candidates = (): MentionCandidate[] =>
    mentionCandidates([memberOf(DEV.id, ["coder"]), memberOf(FIN.id)], [DEV, FIN], ME as never);

  it("suggestion items: 핸들·별칭·이름 앞부분으로 거른다", async () => {
    const { items } = mentionSuggestion(candidates, { open: false });
    const labels = async (query: string) =>
      (await items?.({ query, editor: {} as Editor, signal: new AbortController().signal }))?.map(
        (c) => c.label,
      );
    expect(await labels("")).toEqual(["dev", "fin", "owner"]);
    expect(await labels("co")).toEqual(["dev"]);
    expect(await labels("F")).toEqual(["fin"]);
    expect(await labels("주")).toEqual(["owner"]);
  });

  it("후보 목록: 「AI」 배지, 꺼진 에이전트는 흐리게 + 「꺼짐」, ↑↓·Enter 로 고른다", () => {
    const command = vi.fn();
    const ref: { current: { onKeyDown(e: KeyboardEvent): boolean } | null } = { current: null };
    render(<MentionList items={candidates()} command={command} ref={ref} />);
    const options = within(screen.getByRole("listbox", { name: "멘션 후보" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["@dev개발봇AI", "@finFinanceAI꺼짐", "@owner주인"]);
    expect(options[1]).not.toHaveAttribute("aria-disabled"); // 꺼져 있어도 고를 수 있다
    expect(options[1]).toHaveClass("opacity-50");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    const key = (k: string) =>
      act(() => void ref.current?.onKeyDown(new KeyboardEvent("keydown", { key: k })));
    key("ArrowUp"); // 맨 위에서 위로 → 맨 아래
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(command).toHaveBeenCalledWith({ id: `a:${FIN.id}`, label: "fin" });
    expect(ref.current?.onKeyDown(new KeyboardEvent("keydown", { key: "a" }))).toBe(false);
  });

  it("@ 로 연 후보 목록에서 Enter 는 전송이 아니라 선택 — 닫힌 뒤 Enter 가 전송", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderComposer();
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("@co");
    });
    // focus() 가 미룬 프레임을 돌려 편집기가 선택 영역을 실제로 잡게 한다 —
    // 그 전에 후보를 확정하면 Tiptap 멘션이 부르는 collapseToEnd() 가 던진다(composerHarness 주석)
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["@dev개발봇AI"]);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
      type: "mention",
      attrs: { id: `a:${AGENT}`, label: "dev" },
    });

    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([
      { channelId: CH, clientMsgId: expect.any(String), bodyMd: `<@a:${AGENT}>` },
    ]);
  });
});

it("팝업이 열리면 편집기가 목록과 고른 줄을 가리킨다(aria-controls·aria-activedescendant), 닫히면 뗀다", async () => {
  const { box, editor } = renderComposer();
  expect(box).toHaveAttribute("aria-autocomplete", "list");
  expect(box).not.toHaveAttribute("aria-controls");
  expect(box).not.toHaveAttribute("aria-activedescendant");

  act(() => {
    editor.commands.focus();
    editor.commands.insertContent("@");
  });
  await flushEditorFrames();
  const list = await screen.findByRole("listbox", { name: "멘션 후보" });
  expect(list.id).toBeTruthy();
  await waitFor(() => expect(box).toHaveAttribute("aria-controls", list.id));

  const options = within(list).getAllByRole("option");
  expect(options.map((o) => o.id)).toEqual([`${list.id}-0`, `${list.id}-1`, `${list.id}-2`]);
  await waitFor(() => expect(box).toHaveAttribute("aria-activedescendant", options[0]?.id ?? ""));

  fireEvent.keyDown(box, { key: "ArrowDown" });
  await waitFor(() => expect(box).toHaveAttribute("aria-activedescendant", `${list.id}-1`));
  expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  expect(box).not.toHaveAttribute("aria-controls");
  expect(box).not.toHaveAttribute("aria-activedescendant");
});
