import type { AgentCommandsResponse } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DmViewContext } from "@/features/dms/context";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { dmChannelOf } from "../../../test/dms";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, USER } from "../../../test/fixtures";
import {
  confirmed,
  doc,
  flushEditorFrames,
  mention,
  p,
  renderComposer,
  setDoc,
  t,
} from "../../../test/composerHarness";
import { commandSuggestion } from "./CommandList";
import { agentCommandsKeys, commandTrigger, matchCommands } from "./commands";

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
  useRunStore.getState().reset();
});
afterEach(async () => {
  await flushEditorFrames();
  restoreDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const COMMANDS: AgentCommandsResponse["agents"][number]["commands"] = [
  { name: "compact", description: "대화를 요약한다", argumentHint: "[지시]" },
  { name: "context", description: "컨텍스트 사용량" },
  { name: "user:review", description: "(user) 코드 리뷰" },
  { name: "user:user-skill", description: "(user) 내 스킬", aliases: ["user-skill"] },
];

const seed = (qc: QueryClient, row: Partial<AgentCommandsResponse["agents"][number]> = {}) =>
  act(() =>
    qc.setQueryData(agentCommandsKeys.of(CH, CH), [
      { agentId: AGENT, supported: true, commands: COMMANDS, ...row },
    ]),
  );

/** 칩 뒤 공백까지 두고 그 뒤에 글자를 친다 — 실제 입력처럼 suggestion 플러그인이 보게 */
async function typeAfterChip(editor: ReturnType<typeof renderComposer>["editor"], text: string) {
  setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" "))));
  act(() => {
    editor.commands.insertContent(text);
  });
  await flushEditorFrames();
}

const optionNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((o) => o.querySelector("span")?.textContent);

describe("commandTrigger·matchCommands", () => {
  it("칩 하나 + 공백 + `/` 앞부분일 때만", () => {
    const chip = mention(`a:${AGENT}`, "dev");
    expect(commandTrigger(doc(p(chip, t(" /re"))), {})).toEqual({ agentId: AGENT, query: "re" });
    expect(commandTrigger(doc(p(chip, t(" /"))), {})).toEqual({ agentId: AGENT, query: "" });
    expect(commandTrigger(doc(p(chip, t(" /review src"))), {})).toBeNull(); // 인자부터는 닫는다
    expect(commandTrigger(doc(p(chip, t(" /usr/bin"))), {})).toBeNull();
    expect(commandTrigger(doc(p(t("hi "), chip, t(" /re"))), {})).toBeNull();
    expect(commandTrigger(doc(p(mention("u:x", "owner"), t(" /re"))), {})).toBeNull();
    expect(commandTrigger(doc(p(t("/st"))), {})).toBeNull();
    expect(commandTrigger(doc(p(t("/st"))), { directAgentId: AGENT })).toEqual({
      agentId: AGENT,
      query: "st",
    });
  });

  it("allow 는 넘겨받은 새 state 로 본다 — 플러그인 apply 중의 editor 는 아직 옛 문서다(브라우저에서만 난 결함)", () => {
    const { suggestion } = commandSuggestion({
      lookup: () => undefined,
      directAgentId: () => undefined,
      onTrigger: () => {},
      menu: { open: false },
    });
    const chip = mention(`a:${AGENT}`, "dev");
    const oldEditor = { getJSON: () => doc(p(chip, t(" "))) } as never;
    const allow = suggestion.allow as (p: unknown) => boolean;
    expect(allow({ editor: oldEditor, state: { doc: { toJSON: () => doc(p(chip, t(" /"))) } } })).toBe(true);
    expect(allow({ editor: oldEditor, state: { doc: { toJSON: () => doc(p(t("a /"))) } } })).toBe(false);
  });

  it("이름이나 별칭 앞부분(대소문자 무시)", () => {
    expect(matchCommands(COMMANDS, "co").map((c) => c.name)).toEqual(["compact", "context"]);
    expect(matchCommands(COMMANDS, "USER-").map((c) => c.name)).toEqual(["user:user-skill"]);
  });
});

describe("작성기 `/` 명령(에이전트 명령 스펙 5.5)", () => {
  it("typing / after mention chip opens that agent's commands", async () => {
    const { editor, qc } = renderComposer();
    seed(qc);
    await typeAfterChip(editor, "/");
    const list = await screen.findByRole("listbox", { name: "명령 후보" });
    expect(optionNames(list)).toEqual(["/compact", "/context", "/user:review", "/user:user-skill"]);
    act(() => {
      editor.commands.insertContent("con");
    });
    await waitFor(() =>
      expect(optionNames(screen.getByRole("listbox", { name: "명령 후보" }))).toEqual(["/context"]),
    );
  });

  it("목록은 처음 `/` 를 칠 때 받고, 도착하면 열린 목록을 그린다 — 그 전에는 묻지 않는다", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ agents: [{ agentId: AGENT, supported: true, commands: COMMANDS }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { editor } = renderComposer();
    setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" 안녕"))));
    await flushEditorFrames();
    expect(fetchMock).not.toHaveBeenCalled();
    await typeAfterChip(editor, "/co");
    const list = await screen.findByRole("listbox", { name: "명령 후보" });
    expect(optionNames(list)).toEqual(["/compact", "/context"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(
      `/conversations/${CH}/agent-commands`,
    );
  });

  it("alias match (user-skill) shows the skill", async () => {
    const { editor, qc } = renderComposer();
    seed(qc);
    await typeAfterChip(editor, "/user-");
    const list = await screen.findByRole("listbox", { name: "명령 후보" });
    expect(optionNames(list)).toEqual(["/user:user-skill"]);
  });

  it('choosing inserts "/name "', async () => {
    const { box, editor, qc } = renderComposer();
    seed(qc);
    await typeAfterChip(editor, "/user:r");
    await screen.findByRole("listbox", { name: "명령 후보" });
    fireEvent.keyDown(box, { key: "Enter" }); // 목록이 열려 있으면 Enter 는 선택
    expect(fake.sentOf("message.send")).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "명령 후보" })).not.toBeInTheDocument());
    expect(editor.getJSON().content?.[0]?.content?.[1]).toEqual({ type: "text", text: " /user:review " });
  });

  it("1:1 agent DM opens list at start", async () => {
    const dm = dmChannelOf(CH, USER, AGENT);
    const { editor, qc } = renderComposer(CH, undefined, (children) => (
      <DmViewContext.Provider value={{ kind: "dm", channel: dm, readOnly: null }}>
        {children}
      </DmViewContext.Provider>
    ));
    seed(qc);
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("/co");
    });
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "명령 후보" });
    expect(optionNames(list)).toEqual(["/compact", "/context"]);
  });

  it("일반 채널의 맨 앞 `/` 는 목록을 띄우지 않는다", async () => {
    const { editor, qc } = renderComposer();
    seed(qc);
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("/co");
    });
    await flushEditorFrames();
    expect(screen.queryByRole("listbox", { name: "명령 후보" })).not.toBeInTheDocument();
  });

  it("blocked command shows reason and does not send", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" /restart"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(await screen.findByRole("alert")).toHaveTextContent("이 명령은 dodok 에서 쓸 수 없습니다");
    expect(editor.isEmpty).toBe(false); // 입력은 그대로
    // 고치면 사유가 지워지고 보낼 수 있다
    setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" /status"))));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([
      expect.objectContaining({ bodyMd: `<@a:${AGENT}> /status` }),
    ]);
  });

  it("unsupported agent shows update line", async () => {
    const { editor, qc } = renderComposer();
    seed(qc, { supported: false, commands: [] });
    await typeAfterChip(editor, "/");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "이 에이전트는 명령을 지원하지 않습니다 — 러너·플러그인을 업데이트하세요",
    );
    expect(screen.queryByRole("listbox", { name: "명령 후보" })).not.toBeInTheDocument();
  });

  it('"/stop" still stops', () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(true);
  });
});
