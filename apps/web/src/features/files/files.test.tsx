import type { Attachment, DirectSummary, FileList, FileListItem, Person } from "@dodok/shared";
import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJumpStore } from "@/features/messages/jumpTarget";
import { useWireStatus } from "@/realtime/wire";
import { flushEditorFrames } from "../../../test/composerHarness";
import { dmChannelOf, dmOf } from "../../../test/dms";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, CH2, uid } from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { agentOf } from "../../../test/settingsServer";
import { channelOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { FILES_DEBOUNCE_MS } from "./queries";

// 파일함 계획 태스크 4 — 패널 「파일」 탭과 사이드바 「파일」 전체 화면(웹)

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const MIA = uid(6_001);
const person = (id: string, handle: string, displayName: string): Person => ({
  id,
  handle,
  displayName,
  role: "member",
  deactivatedAt: null,
  statusMessage: null,
});
const MIA_P = person(MIA, "mia", "미아");
const OWNER_P = { ...person(ME.user.id, ME.user.handle, ME.user.displayName), role: "owner" as const };
const DEV = agentOf(AGENT, "dev", { name: "Dev 봇" });

const DM = uid(33); // 나 ↔ dev 에이전트 DM
const LONE = uid(34); // 나·mia 의 그룹(상대가 하나뿐 — 「(그룹)」)
const ONE = uid(35); // 나 ↔ mia 1:1(한 줄기)
const ONE_CONV = uid(40);
const SESSION = uid(41);
const ROOT = uid(42);

const directChannel = (id: string) =>
  channelOf(id, { name: "direct", visibility: "private", kind: "direct" });
const directOf = (id: string, users: Person[], over: Partial<DirectSummary> = {}): DirectSummary => ({
  channel: directChannel(id),
  users,
  agents: [],
  sessions: false,
  lastMessageAt: "2026-11-09T01:00:00.000Z",
  readOnlyReason: null,
  ...over,
});
const LONE_D = directOf(LONE, [MIA_P], { sessions: true });
const ONE_D = directOf(ONE, [MIA_P]);

const att = (
  n: number,
  kind: "image" | "file",
  name: string,
  over: Partial<Attachment> = {},
): Attachment => ({
  id: uid(9_000 + n),
  kind,
  url: `artifact://${uid(9_000 + n)}`,
  name,
  mime: kind === "image" ? "image/png" : "application/pdf",
  size: 1_258_291,
  ...(kind === "image" ? { width: 40, height: 30 } : {}),
  ...over,
});
const item = (attachment: Attachment, over: Partial<FileListItem> = {}): FileListItem => ({
  attachment,
  messageId: uid(8_000 + Number(attachment.id.slice(-4))),
  channelId: CH,
  conversationId: CH,
  conversationTitle: "세션",
  seq: 3,
  authorType: "user",
  authorId: MIA,
  createdAt: "2026-11-08T03:00:00.000Z",
  channelArchived: false,
  ...over,
});

const PHOTO = item(att(1, "image", "사진.png"));
const REPORT = item(att(2, "file", "report.pdf"));

type Files = (url: URL) => Response | Promise<Response>;
let files: Files;
let filesCalls: URL[];

/** 셸 + 파일함이 부르는 REST. `/attachments` 의 응답은 `files` 가 정한다 */
function stubServer({ members = [] as Array<{ type: "user" | "agent"; id: string }> } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, ME);
      if (url === "/api/v1/people") return json(200, { people: [OWNER_P, MIA_P] });
      if (url === "/api/v1/agents") return json(200, { agents: [DEV] });
      if (url === "/api/v1/channels")
        return json(200, {
          channels: [channelOf(CH, { name: "기획" }), channelOf(CH2, { name: "random" })],
        });
      if (url === "/api/v1/dms") return json(200, { dms: [dmOf(dmChannelOf(DM, ME.user.id, AGENT), DEV)] });
      if (url === "/api/v1/directs") return json(200, { directs: [LONE_D, ONE_D] });
      if (url === `/api/v1/channels/${DM}`) return json(200, { channel: dmChannelOf(DM, ME.user.id, AGENT) });
      if (url === `/api/v1/channels/${LONE}`) return json(200, { channel: LONE_D.channel });
      if (url === `/api/v1/channels/${ONE}`) return json(200, { channel: ONE_D.channel });
      if (url === `/api/v1/channels/${CH}`) return json(200, { channel: channelOf(CH, { name: "기획" }) });
      if (url === `/api/v1/channels/${CH}/members`)
        return json(200, {
          members: members.map((m) => ({
            id: `m-${m.id}`,
            channelId: CH,
            memberType: m.type,
            memberId: m.id,
            autoRespond: false,
            aliases: [],
            joinedAt: "2026-11-01T00:00:00.000Z",
          })),
        });
      if (url.startsWith("/api/v1/attachments?") || url === "/api/v1/attachments") {
        const u = new URL(url, "http://x");
        filesCalls.push(u);
        return files(u);
      }
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: url });
    }),
  );
}

const list = (items: FileListItem[], nextCursor?: string): Response =>
  json(200, { items, ...(nextCursor ? { nextCursor } : {}) } satisfies FileList);
const lastCall = () => filesCalls.at(-1) as URL;
const panel = () => screen.findByTestId("page-channel-panel");
const photos = () => screen.queryByRole("region", { name: "사진" });
const fileRows = () => screen.queryByRole("region", { name: "파일" });
const segment = (name: string) => screen.getByRole("button", { name });

let restoreDom: Array<() => void>;
beforeEach(() => {
  restoreDom = [stubEditorDom(), stubScrollLayout()];
  wire.socket = createFakeSocket().wire;
  useWireStatus.getState().setStatus("connected");
  useJumpStore.setState({ targets: {} });
  filesCalls = [];
  files = () => list([PHOTO, REPORT]);
});
afterEach(async () => {
  await flushEditorFrames();
  for (const restore of restoreDom) restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

describe("목록 꼴", () => {
  it("패널 「전체」 — 그 채널만 받아 사진 격자(lazy) 위·파일 줄 아래, 줄에는 이름·크기·올린 사람·세션 제목·날짜", async () => {
    stubServer();
    renderRoute(`/c/${CH}/s/${CH}/files`);
    const p = await panel();
    expect(p).toHaveAttribute("data-panel-tab", "files");
    await waitFor(() => expect(fileRows()).not.toBeNull());
    expect(lastCall().searchParams.get("channelId")).toBe(CH);
    expect(lastCall().searchParams.has("kind")).toBe(false);
    const grid = photos() as HTMLElement;
    const img = within(grid).getByRole("img", { name: "사진.png" });
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("src", `/api/v1/attachments/${PHOTO.attachment.id}`);
    // 사진이 파일보다 먼저
    expect(
      grid.compareDocumentPosition(fileRows() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const row = within(fileRows() as HTMLElement).getByRole("listitem");
    expect(row).toHaveTextContent("report.pdf");
    expect(row).toHaveTextContent("1.2 MB");
    expect(row).toHaveTextContent("미아");
    expect(row).toHaveTextContent("세션");
    expect(row).toHaveTextContent("11월 8일");
    // 패널은 그 대화 안이라 대화 이름(「#기획」)을 싣지 않는다
    expect(row).not.toHaveTextContent("#기획");
    expect(row).not.toHaveTextContent("보관됨");
    // 사진은 파일 칸에 없다
    expect(within(fileRows() as HTMLElement).queryByText("사진.png")).toBeNull();
  });

  it("「사진」은 kind=image 로 격자만, 「파일」은 kind=file 로 줄만", async () => {
    stubServer();
    files = (u) =>
      list(
        u.searchParams.get("kind") === "image"
          ? [PHOTO]
          : u.searchParams.get("kind") === "file"
            ? [REPORT]
            : [PHOTO, REPORT],
      );
    renderRoute(`/c/${CH}/s/${CH}/files`);
    await waitFor(() => expect(fileRows()).not.toBeNull());
    expect(segment("전체")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(segment("사진"));
    await waitFor(() => expect(lastCall().searchParams.get("kind")).toBe("image"));
    await waitFor(() => expect(fileRows()).toBeNull());
    expect(photos()).not.toBeNull();
    expect(segment("사진")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(segment("파일"));
    await waitFor(() => expect(lastCall().searchParams.get("kind")).toBe("file"));
    await waitFor(() => expect(photos()).toBeNull());
    expect(fileRows()).not.toBeNull();
  });

  it("보관한 채널의 줄에는 「보관됨」, 이름은 방향 제어 문자를 빼고 <bdi> 로 격리", async () => {
    stubServer();
    files = () => list([item(att(3, "file", "invoice\u202Efdp.exe"), { channelArchived: true })]);
    renderRoute(`/c/${CH}/s/${CH}/files`);
    const row = await within(await panel()).findByRole("listitem");
    expect(row).toHaveTextContent("보관됨");
    expect(within(row).getByText("invoicefdp.exe").tagName).toBe("BDI");
    expect(row.outerHTML).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/);
  });

  it("한 줄기 direct 의 패널에는 세션 제목이 없다", async () => {
    stubServer();
    files = () => list([item(att(4, "file", "a.zip"), { channelId: ONE, conversationId: ONE_CONV })]);
    renderRoute(`/c/${ONE}/s/${ONE_CONV}/files`);
    const row = await within(await panel()).findByRole("listitem");
    expect(row).toHaveTextContent("a.zip");
    expect(row).not.toHaveTextContent("세션");
  });

  it("전체 화면 — 채널을 싣지 않고 받아 「#기획 · 세션」·「DM · Dev 봇」·「DM · 미아 (그룹)」", async () => {
    stubServer();
    files = () =>
      list([
        item(att(5, "file", "a.pdf")),
        item(att(6, "file", "b.pdf"), { channelId: DM, conversationId: uid(43) }),
        item(att(7, "file", "c.pdf"), { channelId: LONE, conversationId: uid(44) }),
      ]);
    renderRoute("/files");
    const page = await screen.findByTestId("page-files");
    const rows = await within(page).findAllByRole("listitem");
    expect(lastCall().searchParams.has("channelId")).toBe(false);
    expect(rows[0]).toHaveTextContent("#기획 · 세션");
    expect(rows[1]).toHaveTextContent("DM · Dev 봇");
    expect(rows[1]).not.toHaveTextContent("세션");
    expect(rows[2]).toHaveTextContent("DM · 미아 (그룹)");
  });

  it("「더 보기」는 cursor 로 다음 쪽을 받아 두 칸을 함께 늘린다", async () => {
    stubServer();
    files = (u) =>
      u.searchParams.get("cursor") === "c1"
        ? list([item(att(8, "image", "둘.png")), item(att(9, "file", "둘.pdf"))])
        : list([PHOTO, REPORT], "c1");
    renderRoute(`/c/${CH}/s/${CH}/files`);
    await waitFor(() => expect(fileRows()).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "더 보기" }));
    await waitFor(() => expect(within(fileRows() as HTMLElement).getAllByRole("listitem")).toHaveLength(2));
    expect(lastCall().searchParams.get("cursor")).toBe("c1");
    expect(within(photos() as HTMLElement).getAllByRole("img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
  });

  it("빈 상태 — 거름 없으면 「아직 주고받은 파일이 없습니다」, 거름이 있으면 「조건에 맞는 파일이 없습니다」 + 「거름 지우기」", async () => {
    stubServer();
    files = () => list([]);
    renderRoute(`/c/${CH}/s/${CH}/files`);
    expect(await screen.findByText("아직 주고받은 파일이 없습니다")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "거름 지우기" })).toBeNull();
    await userEvent.click(segment("사진"));
    expect(await screen.findByText("조건에 맞는 파일이 없습니다")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "거름 지우기" }));
    expect(await screen.findByText("아직 주고받은 파일이 없습니다")).toBeInTheDocument();
    expect(segment("전체")).toHaveAttribute("aria-pressed", "true");
    expect(lastCall().searchParams.has("kind")).toBe(false);
  });
});

describe("거름", () => {
  it("이름 칸은 입력이 멈춘 뒤 q 로 다시 받는다(그 전에는 부르지 않는다)", async () => {
    stubServer();
    renderRoute(`/c/${CH}/s/${CH}/files`);
    await waitFor(() => expect(fileRows()).not.toBeNull());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(screen.getByRole("searchbox", { name: "이름으로 찾기" }), "보고");
      expect(filesCalls.some((u) => u.searchParams.has("q"))).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS));
      await waitFor(() => expect(lastCall().searchParams.get("q")).toBe("보고"));
      expect(filesCalls.filter((u) => u.searchParams.has("q"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("일반 채널의 올린 사람 후보는 채널 멤버 — 고르면 authorType·authorId", async () => {
    stubServer({
      members: [
        { type: "user", id: ME.user.id },
        { type: "agent", id: AGENT },
      ],
    });
    renderRoute(`/c/${CH}/s/${CH}/files`);
    const select = await screen.findByRole("combobox", { name: "올린 사람" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["모두", "주인", "Dev 봇"]);
    await userEvent.selectOptions(select, `agent:${AGENT}`);
    await waitFor(() => expect(lastCall().searchParams.get("authorType")).toBe("agent"));
    expect(lastCall().searchParams.get("authorId")).toBe(AGENT);
  });

  it("에이전트 DM 의 후보는 나와 그 에이전트", async () => {
    stubServer();
    renderRoute(`/c/${DM}/s/${uid(43)}/files`);
    const select = await screen.findByRole("combobox", { name: "올린 사람" });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["모두", "주인", "Dev 봇"]),
    );
  });

  it("direct 의 후보는 나 + 참여자(users·agents)", async () => {
    stubServer();
    renderRoute(`/c/${ONE}/s/${ONE_CONV}/files`);
    const select = await screen.findByRole("combobox", { name: "올린 사람" });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["모두", "주인", "미아"]),
    );
  });

  it("전체 화면 — 후보는 워크스페이스 사람·에이전트, 대화 고르기는 channelId", async () => {
    stubServer();
    renderRoute("/files");
    const author = await screen.findByRole("combobox", { name: "올린 사람" });
    await waitFor(() =>
      expect(
        within(author)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["모두", "주인", "미아", "Dev 봇"]),
    );
    const conv = screen.getByRole("combobox", { name: "대화" });
    await waitFor(() =>
      expect(
        within(conv)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(
        expect.arrayContaining([
          "모든 대화",
          "#기획",
          "#random",
          "DM · Dev 봇",
          "DM · 미아 (그룹)",
          "DM · 미아",
        ]),
      ),
    );
    await userEvent.selectOptions(conv, DM);
    await waitFor(() => expect(lastCall().searchParams.get("channelId")).toBe(DM));
  });
});

describe("이동", () => {
  it("「메시지로 가기」 — requestJump 뒤 /c/<ch>/s/<conv>, 「내려받기」는 ?download=1", async () => {
    stubServer();
    // 세션 id 를 채널 id 와 다르게 — 둘을 바꿔 써도 통과하지 않게
    const report = { ...REPORT, conversationId: SESSION };
    files = () => list([report]);
    const { router } = renderRoute(`/c/${CH}/s/${CH}/files`);
    const row = await within(await panel()).findByRole("listitem");
    expect(within(row).getByRole("link", { name: "report.pdf 내려받기" })).toHaveAttribute(
      "href",
      `/api/v1/attachments/${REPORT.attachment.id}?download=1`,
    );
    await userEvent.click(within(row).getByRole("button", { name: "메시지로 가기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${SESSION}`));
    expect(useJumpStore.getState().targets[`${SESSION}:`]).toEqual({
      messageId: report.messageId,
      seq: report.seq,
      focus: true,
    });
  });

  it("답글의 파일이면 스레드 주소 …/t/<루트>", async () => {
    stubServer();
    files = () => list([item(att(10, "file", "답.pdf"), { conversationId: SESSION, threadRootId: ROOT })]);
    const { router } = renderRoute("/files");
    const row = await within(await screen.findByTestId("page-files")).findByRole("listitem");
    await userEvent.click(within(row).getByRole("button", { name: "메시지로 가기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${SESSION}/t/${ROOT}`));
  });

  it("좁은 화면 — 「메시지로 가기」를 누르면 패널 시트가 닫힌다", async () => {
    stubMedia(true);
    stubServer();
    renderRoute(`/c/${CH}/s/${CH}/files`);
    const sheet = await panel();
    await userEvent.click(await within(sheet).findByRole("button", { name: "메시지로 가기" }));
    await waitFor(() => expect(screen.queryByTestId("page-channel-panel")).toBeNull());
  });

  it("사진을 누르면 크게 보기 — 그 안의 「메시지로 가기」로 간다", async () => {
    stubServer();
    const { router } = renderRoute(`/c/${CH}/s/${CH}/files`);
    await userEvent.click(await screen.findByRole("button", { name: "사진.png 크게 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "사진.png" });
    await userEvent.click(within(dialog).getByRole("button", { name: "메시지로 가기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(useJumpStore.getState().targets[`${CH}:`]?.messageId).toBe(PHOTO.messageId);
  });
});

describe("다시 받기", () => {
  /** 창이 초점을 잃었다 다시 받은 것처럼 */
  const refocus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
  afterEach(() => focusManager.setFocused(undefined));

  it("전체 화면은 실시간 대신 창이 초점을 받을 때 다시 받는다", async () => {
    stubServer();
    renderRoute("/files");
    await within(await screen.findByTestId("page-files")).findAllByRole("listitem");
    const before = filesCalls.length;
    refocus();
    await waitFor(() => expect(filesCalls.length).toBe(before + 1));
  });

  it("패널 탭은 초점으로 다시 받지 않는다(앱 기본 — 새 글은 channel.activity 가 알린다)", async () => {
    stubServer();
    renderRoute(`/c/${CH}/s/${CH}/files`);
    await waitFor(() => expect(fileRows()).not.toBeNull());
    const before = filesCalls.length;
    refocus();
    await new Promise((r) => setTimeout(r, 50));
    expect(filesCalls.length).toBe(before);
  });
});

describe("[Review Focus 5] 파일 탭을 연 채 채널을 옮김", () => {
  it("거름이 초기화되고 옛 채널의 줄이 한 틱도 보이지 않는다 — 새 채널을 받기 전에도", async () => {
    stubServer();
    let release: () => void = () => {};
    files = (u) =>
      u.searchParams.get("channelId") === CH2
        ? new Promise<Response>((resolve) => {
            release = () =>
              resolve(list([item(att(11, "file", "새.pdf"), { channelId: CH2, conversationId: CH2 })]));
          })
        : list([PHOTO, REPORT]);
    const { router } = renderRoute(`/c/${CH}/s/${CH}/files`);
    await waitFor(() => expect(fileRows()).not.toBeNull());
    await userEvent.click(segment("파일"));
    await waitFor(() => expect(lastCall().searchParams.get("kind")).toBe("file"));
    await act(() => router.navigate({ to: `/c/${CH2}/s/${CH2}/files` }));
    await waitFor(() => expect(lastCall().searchParams.get("channelId")).toBe(CH2));
    // 옮긴 채널에서도 파일 탭은 그대로
    expect(await panel()).toHaveAttribute("data-panel-tab", "files");
    expect(screen.queryByText("report.pdf")).toBeNull();
    expect(screen.queryByRole("img", { name: "사진.png" })).toBeNull();
    expect(segment("전체")).toHaveAttribute("aria-pressed", "true");
    expect(lastCall().searchParams.has("kind")).toBe(false);
    await act(async () => release());
    expect(await screen.findByText("새.pdf")).toBeInTheDocument();
  });
});
