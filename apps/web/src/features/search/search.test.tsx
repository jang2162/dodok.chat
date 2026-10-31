import {
  type Message,
  SEARCH_SNIPPET_CLOSE as C,
  SEARCH_SNIPPET_OPEN as O,
  type SearchHit,
  type SearchResult,
} from "@dodok/shared";
import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { setChannelSeq } from "@/realtime/timelineCache";
import { createQueryClient } from "@/app/queryClient";
import { useJumpStore } from "@/features/messages/jumpTarget";
import { emptyTimeline, type Timeline } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, CH2, msg, uid } from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { DEV } from "../../../test/messages";
import { automationOf } from "../../../test/automationsServer";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { channelOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { dmChannelOf, dmOf } from "../../../test/dms";
import { SEARCH_DEBOUNCE_MS } from "./useSearch";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const RECT = { width: 800, height: 600 };
const ROOT = msg(1, { bodyMd: "루트 질문" });
const range = (from: number, to: number): Message[] =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, { bodyMd: `본문 ${from + i}` }));
const hitOf = (m: Message, over: Partial<SearchHit> = {}): SearchHit => ({
  messageId: m.id,
  channelId: m.channelId,
  conversationId: m.conversationId,
  conversationTitle: "이전 대화",
  seq: m.seq,
  channelArchived: false,
  authorType: "user",
  authorId: ME.user.id,
  createdAt: m.createdAt,
  snippet: `앞 ${O}배포${C} 뒤`,
  ...(m.threadRootId ? { threadRootId: m.threadRootId } : {}),
  ...over,
});

let restore: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
/** 검색 요청 URL → 응답 */
let search: (url: URL) => Response | Promise<Response>;
/** 그 밖의 REST(around 등) — 정확한 URL 로 */
let routes: Map<string, () => Response>;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout(RECT)];
  wire.socket = createFakeSocket().wire;
  useWireStatus.getState().setStatus("connected");
  routes = new Map();
  search = () => json(200, { hits: [], limited: false } satisfies SearchResult);
  fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/agents") return json(200, { agents: [DEV] });
    if (url === "/api/v1/channels")
      return json(200, {
        channels: [channelOf(CH, { name: "general" }), channelOf(CH2, { name: "random" })],
      });
    if (url.startsWith("/api/v1/search?")) return search(new URL(url, "http://x"));
    const r = routes.get(url);
    if (r) return r();
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: url });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useJumpStore.setState({ targets: {} });
});

/** 채널 CH 에 들어가 구독 응답까지 받은 상태(루트 60~100, lastSeq 100) */
function subscribedClient() {
  const qc = createQueryClient(() => {});
  qc.setQueryData<Timeline>(qk.timeline(CH, CH), {
    ...emptyTimeline(),
    items: range(60, 100),
    hasOlder: true,
    lastSeq: 100,
  });
  // 그 채널을 구독했다(채널 커서) — 결과로 가기는 받은 것이 지금 것일 때만 around 로 받는다
  setChannelSeq(qc, CH, 100);
  return qc;
}
const searchCalls = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/v1/search?"));
const params = (u: string) => Object.fromEntries(new URL(u, "http://x").searchParams);

async function openWith(key: { metaKey?: boolean; ctrlKey?: boolean }) {
  await screen.findByTestId("app-shell");
  fireEvent.keyDown(window, { key: "k", ...key });
  return screen.findByRole("dialog", { name: "검색" });
}
async function typeQuery(text: string) {
  const input = screen.getByRole("searchbox", { name: "검색어" });
  // delay:null — 글자마다 setTimeout 을 기다리지 않는다(부하에서 시간 초과의 씨앗)
  await userEvent.setup({ delay: null }).type(input, text);
  return input;
}

describe("검색 대화상자 열기", () => {
  it("⌘K·Ctrl+K 로 열고 Esc 로 닫는다 — 검색어 칸에 초점", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await openWith({ metaKey: true });
    expect(screen.getByRole("searchbox", { name: "검색어" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "검색" })).toBeNull());
    await openWith({ ctrlKey: true });
  });

  it("Alt·Shift 가 섞이면 열지 않는다 — 여는 키는 기본 동작(Ctrl+K 주소창)을 막는다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await screen.findByTestId("app-shell");
    expect(fireEvent.keyDown(window, { key: "k", metaKey: true, altKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "K", ctrlKey: true, shiftKey: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog", { name: "검색" })).toBeNull();
    const open = createEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent(window, open);
    expect(open.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog", { name: "검색" })).toBeInTheDocument();
  });

  it("한글 입력기 상태(key 가 「k」 가 아니다)여도 물리 키 K 면 연다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await screen.findByTestId("app-shell");
    fireEvent.keyDown(window, { key: "ㅏ", code: "KeyK", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "검색" })).toBeInTheDocument();
  });

  it("작성기 안에서 눌러도 연다 — 닫으면 작성기로 돌아간다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    act(() => box.focus());
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "검색" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("다른 대화상자가 열려 있으면 무시한다 — 그 위에 겹쳐 열지 않는다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await userEvent.click(await screen.findByRole("button", { name: "채널 만들기" }));
    await screen.findByRole("dialog", { name: "채널 만들기" });
    expect(fireEvent.keyDown(window, { key: "k", metaKey: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("dialog", { name: "검색" })).toBeNull();
  });

  it("열린 채 Ctrl+K 를 다시 누르면 기본 동작을 막고 대화상자는 그대로", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ ctrlKey: true });
    expect(fireEvent.keyDown(window, { key: "k", ctrlKey: true })).toBe(false);
    expect(screen.getByRole("dialog", { name: "검색" })).toBe(dialog);
  });

  it("닫으면 초점이 연 자리로 돌아간다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const opener = await screen.findByRole("button", { name: /검색/ });
    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "검색" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "검색" })).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("사이드바 위의 검색 칸을 눌러도 열린다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await userEvent.click(await screen.findByRole("button", { name: /검색/ }));
    expect(await screen.findByRole("dialog", { name: "검색" })).toBeInTheDocument();
  });

  it("좁은 화면(390px)에서는 전체 시트", async () => {
    stubMedia(true);
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ ctrlKey: true });
    expect(dialog).toHaveAttribute("data-slot", "sheet-content");
    expect(dialog).toHaveClass("h-dvh");
  });
});

describe("검색하기", () => {
  it("입력이 멈춘 뒤 한 번만 부른다(디바운스) — 1글자는 부르지 않고 안내", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await openWith({ metaKey: true });
    await typeQuery("배");
    expect(screen.getByText("2글자 이상 입력하세요")).toBeInTheDocument();
    await typeQuery("포를");
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    expect(params(searchCalls()[0]!)).toEqual({ q: "배포를" });
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(searchCalls()).toHaveLength(1);
    expect(await screen.findByText("결과가 없습니다")).toBeInTheDocument();
  });

  it("1글자로 줄이면 옛 결과를 곧바로 숨기고 안내만 — 디바운스를 기다리지 않는다", async () => {
    search = () => json(200, { hits: [hitOf(msg(70), { snippet: "옛 결과" })], limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포를");
    expect(await within(dialog).findByText("옛 결과")).toBeInTheDocument();
    await typeQuery("{Backspace}{Backspace}");
    expect(within(dialog).getByText("2글자 이상 입력하세요")).toBeInTheDocument();
    expect(within(dialog).queryByText("옛 결과")).toBeNull();
    expect(within(dialog).queryByRole("list", { name: "검색 결과" })).toBeNull();
  });

  it("늦게 온 옛 검색어 응답이 새 결과를 덮지 않는다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    search = (u) =>
      u.searchParams.get("q") === "배포"
        ? gate.then(() => json(200, { hits: [hitOf(msg(70), { snippet: "옛 결과" })], limited: true }))
        : json(200, { hits: [hitOf(msg(71), { snippet: "새 결과" })], limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    await typeQuery("를");
    expect(await within(dialog).findByText("새 결과")).toBeInTheDocument();
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(within(dialog).queryByText("옛 결과")).toBeNull();
    expect(within(dialog).queryByText("2글자는 최근 90일에서 50개까지만 찾습니다")).toBeNull();
  });

  it("스니펫의 일치 부분은 <mark>, HTML 주입 문자열은 글자 그대로(Review Focus 4)", async () => {
    search = () =>
      json(200, {
        hits: [hitOf(msg(70), { snippet: `<img src=x onerror=alert(1)> ${O}<b>배포</b>${C} %_"*` })],
        limited: false,
      });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    const result = await within(dialog).findByRole("button", { name: /<b>배포<\/b>/ });
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("b")).toBeNull();
    expect(within(result).getByText("<b>배포</b>").tagName).toBe("MARK");
    // 결과 줄: 채널 이름·작성자
    expect(result).toHaveTextContent("#general");
  });

  it("내 DM 의 결과는 채널 이름 대신 「DM · <에이전트 이름>」(에이전트 DM 계획 판정 PD3)", async () => {
    const dm = dmChannelOf(uid(9), ME.user.id, DEV.id);
    routes.set("/api/v1/dms", () => json(200, { dms: [dmOf(dm, DEV)] }));
    search = () =>
      json(200, { hits: [hitOf(msg(70, { channelId: dm.id, conversationId: uid(91) }))], limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    const result = await within(dialog).findByRole("button", { name: /배포/ });
    await waitFor(() => expect(result).toHaveTextContent(`DM · ${DEV.name}`));
    expect(result).not.toHaveTextContent("#");
  });

  it("필터 — 채널·사람/에이전트·기간이 요청에 실린다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "채널" }), "random");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "작성자" }), "agent");
    fireEvent.change(within(dialog).getByLabelText("시작 날짜"), { target: { value: "2026-09-01" } });
    fireEvent.change(within(dialog).getByLabelText("끝 날짜"), { target: { value: "2026-09-20" } });
    await waitFor(() =>
      expect(params(searchCalls().at(-1)!)).toEqual({
        q: "배포",
        channelId: CH2,
        authorType: "agent",
        from: "2026-09-01",
        to: "2026-09-20",
      }),
    );
  });

  it("작성자 거르개 「자동화」 — authorType=automation 이 요청에 실린다", async () => {
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "작성자" }), "자동화");
    await waitFor(() =>
      expect(params(searchCalls().at(-1)!)).toEqual({ q: "배포", authorType: "automation" }),
    );
  });

  it("채널 거르개에 내 DM 이 「DM · <에이전트 이름>」으로 — 고르면 그 DM 채널 id 가 실린다", async () => {
    const dm = dmChannelOf(uid(9), ME.user.id, DEV.id);
    routes.set("/api/v1/dms", () => json(200, { dms: [dmOf(dm, DEV)] }));
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    const channel = within(dialog).getByRole("combobox", { name: "채널" });
    await within(channel).findByRole("option", { name: `DM · ${DEV.name}` });
    await userEvent.selectOptions(channel, `DM · ${DEV.name}`);
    await waitFor(() => expect(params(searchCalls().at(-1)!)).toEqual({ q: "배포", channelId: dm.id }));
  });

  it("더 보기 — 커서로 다음 쪽을 이어 붙인다", async () => {
    search = (u) =>
      u.searchParams.get("cursor") === "c2"
        ? json(200, { hits: [hitOf(msg(71), { snippet: "둘째 쪽" })], limited: false })
        : json(200, { hits: [hitOf(msg(70), { snippet: "첫째 쪽" })], nextCursor: "c2", limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포를");
    await userEvent.click(await within(dialog).findByRole("button", { name: "더 보기" }));
    expect(await within(dialog).findByText("둘째 쪽")).toBeInTheDocument();
    expect(within(dialog).getByText("첫째 쪽")).toBeInTheDocument();
    expect(params(searchCalls().at(-1)!)).toEqual({ q: "배포를", cursor: "c2" });
    expect(within(dialog).queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  it("다음 쪽이 실패하면(429) 받은 결과는 두고 목록 아래에 한 줄", async () => {
    search = (u) =>
      u.searchParams.get("cursor") === "c2"
        ? json(429, { code: "RATE_LIMITED", message: "검색 요청이 너무 많습니다" })
        : json(200, { hits: [hitOf(msg(70), { snippet: "첫째 쪽" })], nextCursor: "c2", limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포를");
    await userEvent.click(await within(dialog).findByRole("button", { name: "더 보기" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("검색 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요");
    expect(within(dialog).getByText("첫째 쪽")).toBeInTheDocument();
    // 한 줄은 목록 아래
    const list = within(dialog).getByRole("list", { name: "검색 결과" });
    expect(list.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("2글자(limited) — 「더 보기」 없이 안내 한 줄", async () => {
    // 커서가 실려 와도(서버는 싣지 않는다) limited 면 더 보기를 두지 않는다
    search = () => json(200, { hits: [hitOf(msg(70))], nextCursor: "x", limited: true });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포");
    expect(await within(dialog).findByText("2글자는 최근 90일에서 50개까지만 찾습니다")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  it("429(RATE_LIMITED) — 대화상자 안에 한 줄, 입력은 그대로", async () => {
    search = () => json(429, { code: "RATE_LIMITED", message: "검색 요청이 너무 많습니다" });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    const input = await typeQuery("배포를");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "검색 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요",
    );
    expect(input).toHaveValue("배포를");
    // 재시도하지 않는다(되풀이해도 같은 한도)
    expect(searchCalls()).toHaveLength(1);
  });

  it("그 밖의 오류 — 서버 문구 한 줄", async () => {
    search = () => json(500, { code: "INTERNAL", message: "서버 오류" });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포를");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("검색하지 못했습니다 — 서버 오류");
  });
});

/** 답글(133) 하나가 걸리는 검색 — 채널 목록은 루트를 가졌고, 스레드 최신 50 에는 그 답글이 없어 around 로 받는다 */
function replyResultClient() {
  const reply = msg(133, { threadRootId: ROOT.id, bodyMd: "찾던 답글" });
  search = () => json(200, { hits: [hitOf(reply, { snippet: "찾던 답글" })], limited: false });
  const qc = subscribedClient();
  qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({ ...t!, items: [ROOT, ...t!.items] }));
  // 스레드 최신 50 에는 그 답글이 없다 — around 로 받는다(서버 스레드 REST 도 around 를 받는다)
  const replies = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      msg(from + i, { threadRootId: ROOT.id, bodyMd: `답글 ${from + i}` }),
    );
  routes.set(`/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?limit=50`, () =>
    json(200, { root: ROOT, messages: replies(200, 249), hasMore: true }),
  );
  routes.set(`/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?limit=50&around=133`, () =>
    json(200, {
      root: ROOT,
      messages: [...replies(110, 132), reply, ...replies(134, 150)],
      hasMore: true,
      hasMoreAfter: true,
    }),
  );
  return qc;
}

/** 검색에서 그 답글 결과를 골라 스레드 패널까지 */
async function pickReplyResult(qc: ReturnType<typeof replyResultClient>) {
  const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc);
  const dialog = await openWith({ metaKey: true });
  await typeQuery("찾던");
  const result = await within(dialog).findByRole("button", { name: /찾던 답글/ });
  expect(result).toHaveTextContent("스레드 답글");
  await userEvent.setup({ delay: null }).click(result);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/t/${ROOT.id}`));
  return screen.findByTestId("thread-panel");
}

describe("결과로 가기", () => {
  it("채널 결과 — 대화상자가 닫히고 그 채널을 around 로 받아 그 메시지를 강조한다", async () => {
    search = () => json(200, { hits: [hitOf(msg(10), { snippet: "열째 메시지" })], limited: false });
    routes.set(`/api/v1/conversations/${CH}/messages?limit=50&around=10`, () =>
      json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }),
    );
    const { router } = renderRoute(`/c/${CH2}/s/${CH2}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("열째");
    await userEvent.click(await within(dialog).findByRole("button", { name: /열째 메시지/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "검색" })).toBeNull());
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`);
    await waitFor(() =>
      expect(screen.getByText("본문 10").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
  });

  it("결과를 고르면 초점이 연 자리가 아니라 도착한 메시지 행으로 간다", async () => {
    search = () => json(200, { hits: [hitOf(msg(80), { snippet: "여든째 메시지" })], limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    // 같은 화면의 검색 단추로 연다 — 닫혀도 그 자리가 남아 있어 지금까지는 그리로 돌아갔다
    const opener = await screen.findByRole("button", { name: /검색/ });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "검색" });
    await typeQuery("여든째");
    await userEvent.click(await within(dialog).findByRole("button", { name: /여든째 메시지/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "검색" })).toBeNull());
    const row = () => screen.getByText("본문 80").closest("[data-index]");
    await waitFor(() => expect(row()).toHaveFocus());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(row()).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it("같은 채널의 다른 세션 결과 — 줄에 세션 제목, 누르면 그 세션의 그 메시지로(지금 세션이 아니라)", async () => {
    const SIDE = uid(9_001);
    const hit = msg(12, { conversationId: SIDE, bodyMd: "곁 세션 글" });
    search = () =>
      json(200, {
        hits: [hitOf(hit, { snippet: "곁 세션 글", conversationTitle: "배포 회고" })],
        limited: false,
      });
    const side = (from: number, to: number) => range(from, to).map((m) => ({ ...m, conversationId: SIDE }));
    routes.set(`/api/v1/conversations/${SIDE}/messages?limit=50&around=12`, () =>
      json(200, { messages: side(5, 15), hasMore: false, hasMoreAfter: true }),
    );
    // 그 세션을 이 탭에서 연 적이 있다 — 최신 창(20~30)에는 그 메시지가 없어 around 로 받는다
    const qc = subscribedClient();
    qc.setQueryData<Timeline>(qk.timeline(CH, SIDE), {
      ...emptyTimeline(),
      items: side(20, 30),
      hasOlder: true,
      lastSeq: 30,
    });
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc);
    const dialog = await openWith({ metaKey: true });
    await typeQuery("곁 세션");
    const row = await within(dialog).findByRole("button", { name: /곁 세션 글/ });
    expect(row).toHaveTextContent("배포 회고");
    await userEvent.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${SIDE}`));
    await waitFor(() =>
      expect(screen.getByText("본문 12").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
  });

  it("답글 결과 — 채널은 그 루트로, 스레드 패널은 around 로 받은 그 답글로", async () => {
    const panel = await pickReplyResult(replyResultClient());
    // 채널 목록은 루트를 강조한다(이미 가진 루트라 around 를 부르지 않는다). 루트 강조는 누르자마자 켜져 HIGHLIGHT_MS 뒤 꺼지므로
    // around 를 기다리는 패널보다 먼저 본다 — 느린 머신에서 패널을 기다리다 루트 강조를 놓치지 않게
    const channel = screen.getByRole("region", { name: "메시지" });
    await waitFor(() =>
      expect(within(channel).getByText("루트 질문").closest("[data-index]")).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
    await waitFor(() =>
      expect(within(panel).getByText("찾던 답글").closest("[data-index]")).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(
      `/api/v1/conversations/${CH}/messages?limit=50&around=133`,
    );
    // 초점은 스레드 패널의 그 답글이 받는다 — 채널 목록의 루트가 가져가지 않는다
    await waitFor(() => expect(within(panel).getByText("찾던 답글").closest("[data-index]")).toHaveFocus());
  });

  it("좁은 화면 — 스레드 시트가 열리며 탭 머리에 준 초점도 도착한 그 답글이 받는다", async () => {
    stubMedia(true);
    const panel = await pickReplyResult(replyResultClient());
    await waitFor(() => expect(within(panel).getByText("찾던 답글").closest("[data-index]")).toHaveFocus());
  });

  it("보관한 채널의 결과 — 줄에 「보관됨」과 채널 이름, 누르면 읽기 전용 채널 화면으로(Review Focus 4)", async () => {
    const ARC = uid(3);
    const archived = channelOf(ARC, { name: "old-news", archivedAt: "2027-01-20T00:00:00.000Z" });
    const hit = msg(10, { channelId: ARC, bodyMd: "보관 전 메시지" });
    search = () =>
      json(200, { hits: [hitOf(hit, { snippet: "보관 전 메시지", channelArchived: true })], limited: false });
    routes.set("/api/v1/channels?archived=1", () => json(200, { channels: [archived] }));
    routes.set(`/api/v1/channels/${ARC}`, () => json(200, { channel: archived }));
    // 구독 응답(최신 창)을 받은 상태 — 보관한 채널도 구독·읽기는 그대로다
    const qc = subscribedClient();
    qc.setQueryData<Timeline>(qk.timeline(ARC, ARC), {
      ...emptyTimeline(),
      items: range(1, 20).map((m) => (m.seq === 10 ? hit : { ...m, channelId: ARC })),
      lastSeq: 20,
    });
    setChannelSeq(qc, ARC, 20);
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc);
    const dialog = await openWith({ metaKey: true });
    await typeQuery("보관 전");
    const row = await within(dialog).findByRole("button", { name: /보관 전 메시지/ });
    await waitFor(() => expect(row).toHaveTextContent("#old-news"));
    expect(within(row).getByText("보관됨")).toBeInTheDocument();

    await userEvent.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${ARC}/s/${ARC}`));
    expect(await screen.findByText("보관된 채널입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("보관 전 메시지", { selector: "p" }).closest("[data-index]")).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
  });

  it("결과 줄에 작성자 이름 — 에이전트 결과", async () => {
    search = () =>
      json(200, { hits: [hitOf(msg(70), { authorType: "agent", authorId: AGENT })], limited: false });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포를");
    expect(await within(dialog).findByRole("button", { name: /배포/ })).toHaveTextContent("Dev");
  });

  it("결과 줄에 작성자 이름 — 자동화 결과는 admin 이상에게 「⚙ 자동화 · <이름>」", async () => {
    const morning = automationOf(1, { name: "아침 점검" });
    routes.set("/api/v1/automations", () => json(200, [morning]));
    search = () =>
      json(200, {
        hits: [hitOf(msg(70), { authorType: "automation", authorId: morning.id })],
        limited: false,
      });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    const dialog = await openWith({ metaKey: true });
    await typeQuery("배포를");
    const hit = await within(dialog).findByRole("button", { name: /배포/ });
    await waitFor(() => expect(hit).toHaveTextContent("⚙ 자동화 · 아침 점검"));
  });
});
