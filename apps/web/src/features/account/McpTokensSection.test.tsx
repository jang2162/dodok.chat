import type { PersonalTokenIssued, PersonalTokenSummary } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeResponse } from "@/api/queries";

// 토스트 호출을 모두 적는다 — 원문이 토스트로 새지 않는지 본다(renderRoute 는 Toaster 를 그리지 않아 DOM 으로는 못 본다)
const toasted = vi.hoisted(() => [] as unknown[][]);
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  const record =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      toasted.push(args);
      return fn(...args);
    };
  const methods = Object.fromEntries(
    Object.entries(actual.toast).map(([k, v]) => [k, typeof v === "function" ? record(v) : v]),
  );
  return { ...actual, toast: Object.assign(record(actual.toast), methods) };
});
import { ME, json, renderRoute, shellGet } from "../../../test/shellApi";
import { mcpAddCommand } from "./tokens";

afterEach(() => {
  toasted.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 「내 계정」 이 그리는 me — 표시 이름 칸이 user 의 칸을 다 읽는다 */
const MEMBER: MeResponse = {
  ...ME,
  user: {
    id: "01a00000-0000-7000-8000-000000000002",
    workspaceId: "w",
    handle: "mia",
    displayName: "미아",
    email: "mia@example.com",
    authProvider: "local",
    createdAt: "2026-09-26T00:00:00.000Z",
  },
  role: "member",
};

const RAW = "dpt_abc123SECRETsecretSECRETsecretSECRETsecret";
const tokenOf = (n: number, over: Partial<PersonalTokenSummary> = {}): PersonalTokenSummary => ({
  id: `01a00000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`,
  label: `토큰 ${n}`,
  prefix: `pre${String(n).padStart(3, "0")}`,
  createdAt: "2027-01-15T08:00:00.000Z",
  ...over,
});

type Issue = (label: string) => Response;

/** `/me/tokens` 를 흉내 내는 서버 — 목록은 살아 있는 토큰만, 발급은 `issue` 가 정한다(기본은 원문 RAW 로 성공) */
function stubTokenServer(
  initial: PersonalTokenSummary[] = [],
  issue?: Issue,
  opts: { listPending?: boolean } = {},
) {
  let tokens = [...initial];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === "/api/v1/auth/me") return json(200, MEMBER);
    if (url === "/api/v1/me/tokens" && method === "GET")
      return opts.listPending ? new Promise<Response>(() => {}) : json(200, { tokens });
    if (url === "/api/v1/me/tokens" && method === "POST") {
      const label = (body as { label: string }).label;
      if (issue) return issue(label);
      const token = tokenOf(tokens.length + 50, { label, prefix: RAW.slice(4, 10) });
      tokens = [token, ...tokens];
      return json(201, { token, raw: RAW } satisfies PersonalTokenIssued);
    }
    const revoke = /^\/api\/v1\/me\/tokens\/([^/]+)$/.exec(url);
    if (revoke && method === "DELETE") {
      tokens = tokens.filter((t) => t.id !== revoke[1]);
      return new Response(null, { status: 204 });
    }
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

async function openSection() {
  const page = await screen.findByTestId("page-account");
  return within(page).findByRole("region", { name: "MCP 토큰" });
}

async function issue(label: string) {
  const section = await openSection();
  const trigger = within(section).getByRole("button", { name: "새 토큰 발급" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await userEvent.type(within(dialog).getByLabelText("이름"), label);
  await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
  return dialog;
}

/** 원문이 남을 수 있는 자리 전부 — 쿼리·뮤테이션 캐시 */
const cacheDump = (qc: QueryClient) =>
  JSON.stringify({
    queries: qc
      .getQueryCache()
      .getAll()
      .map((q) => ({ key: q.queryKey, state: q.state })),
    mutations: qc
      .getMutationCache()
      .getAll()
      .map((m) => ({ state: m.state, options: m.options.mutationKey })),
  });

describe("MCP 토큰", () => {
  it("목록 — 이름·dpt_ 앞부분·만든 때·마지막 사용", async () => {
    stubTokenServer([tokenOf(1, { lastUsedAt: "2027-01-16T09:30:00.000Z" }), tokenOf(2)]);
    renderRoute("/settings/account");
    const section = await openSection();
    const first = await within(section).findByRole("listitem", { name: "토큰 1" });
    expect(within(first).getByText("dpt_pre001…")).toBeInTheDocument();
    expect(first).not.toHaveTextContent("마지막 사용 없음");
    expect(within(section).getByRole("listitem", { name: "토큰 2" })).toHaveTextContent("마지막 사용 없음");
  });

  it("없으면 빈 안내", async () => {
    stubTokenServer();
    renderRoute("/settings/account");
    const section = await openSection();
    expect(await within(section).findByText("발급한 토큰이 없습니다.")).toBeInTheDocument();
  });

  it("발급 — 원문·「닫으면 다시 볼 수 없습니다」·복사·claude mcp add 예시를 보인다", async () => {
    const { calls } = stubTokenServer();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderRoute("/settings/account");
    const dialog = await issue("  노트북 ");

    expect(await within(dialog).findByText(RAW)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ label: "노트북" });
    expect(within(dialog).getByText("닫으면 다시 볼 수 없습니다.")).toBeInTheDocument();
    const command = within(dialog).getByTestId("mcp-add-command");
    expect(command).toHaveTextContent(
      `claude mcp add --transport http dodok ${window.location.origin}/mcp --header "Authorization: Bearer ${RAW}"`,
      { normalizeWhitespace: false },
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "토큰 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(RAW);
    await userEvent.click(within(dialog).getByRole("button", { name: "명령 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(mcpAddCommand(window.location.origin, RAW));
  });

  it("원문은 「복사했습니다」 전에는 Esc 로 닫히지 않고, 닫은 뒤에는 DOM·캐시·저장소·콘솔 어디에도 없다", async () => {
    stubTokenServer();
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args));
    const { queryClient } = renderRoute("/settings/account");
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW);
    // 보이는 동안에도 캐시에는 없다 — 원문은 대화상자 상태에만 있다
    expect(cacheDump(queryClient)).not.toContain("SECRET");

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toHaveTextContent(RAW);

    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const section = await openSection();
    // 목록은 다시 받아 새 줄을 보인다 — 앞부분만
    expect(await within(section).findByRole("listitem", { name: "새것" })).toHaveTextContent("dpt_abc123…");
    expect(document.body.textContent).not.toContain("SECRET");
    expect(cacheDump(queryClient)).not.toContain("SECRET");
    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ""}`),
    );
    expect(stored.join("\n")).not.toContain("SECRET");
    expect(JSON.stringify(logged)).not.toContain("SECRET");
    expect(JSON.stringify(toasted)).not.toContain("SECRET");

    // 다시 열면 처음부터 — 앞 원문은 없다
    await userEvent.click(within(section).getByRole("button", { name: "새 토큰 발급" }));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByLabelText("이름")).toHaveValue("");
    expect(again).not.toHaveTextContent("SECRET");
  });

  it("살아 있는 토큰이 10개면 발급 버튼이 잠기고 까닭을 보인다 — 9개면 열린다", async () => {
    stubTokenServer(Array.from({ length: 10 }, (_, i) => tokenOf(i + 1)));
    renderRoute("/settings/account");
    const section = await openSection();
    await within(section).findByRole("listitem", { name: "토큰 10" });
    expect(within(section).getByRole("button", { name: "새 토큰 발급" })).toBeDisabled();
    expect(within(section).getByText(/10개까지 발급할 수 있습니다/)).toBeInTheDocument();

    // 하나를 폐기하면 다시 열린다
    await userEvent.click(within(section).getByRole("button", { name: "토큰 3 폐기" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "폐기" }));
    await waitFor(() => expect(within(section).queryByRole("listitem", { name: "토큰 3" })).toBeNull());
    expect(within(section).getByRole("button", { name: "새 토큰 발급" })).toBeEnabled();
    expect(within(section).queryByText(/10개까지 발급할 수 있습니다/)).toBeNull();
  });

  it("목록을 받기 전에는 발급 버튼이 잠겨 있다 — 몇 개인지 모르면 상한을 넘길 수 있다", async () => {
    stubTokenServer([], undefined, { listPending: true });
    renderRoute("/settings/account");
    const section = await openSection();
    expect(within(section).getByRole("button", { name: "새 토큰 발급" })).toBeDisabled();
  });

  it("서버가 상한(CONFLICT)으로 막으면 대화상자 안에 같은 까닭", async () => {
    stubTokenServer([], () => json(409, { code: "CONFLICT", message: "too many tokens" }));
    renderRoute("/settings/account");
    const dialog = await issue("열한째");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/10개까지 발급할 수 있습니다/);
    expect(dialog).not.toHaveTextContent("too many tokens");
  });

  it("폐기는 확인을 거친다 — 취소하면 그대로, 확인하면 DELETE 뒤 목록에서 빠지고 초점은 이웃 줄의 「폐기」로", async () => {
    const { calls } = stubTokenServer([tokenOf(1), tokenOf(2)]);
    renderRoute("/settings/account");
    const section = await openSection();
    await userEvent.click(await within(section).findByRole("button", { name: "토큰 1 폐기" }));
    let confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent("「토큰 1」 토큰을 폐기할까요?");
    await userEvent.click(within(confirm).getByRole("button", { name: "취소" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(within(section).getByRole("button", { name: "토큰 1 폐기" }));
    confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "폐기" }));
    await waitFor(() => expect(within(section).queryByRole("listitem", { name: "토큰 1" })).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      `/api/v1/me/tokens/${tokenOf(1).id}`,
    ]);
    await waitFor(() => expect(within(section).getByRole("button", { name: "토큰 2 폐기" })).toHaveFocus());
  });

  it("마지막 토큰을 폐기하면 목록이 빈 안내로 바뀌고 초점은 「새 토큰 발급」으로", async () => {
    stubTokenServer([tokenOf(1)]);
    renderRoute("/settings/account");
    const section = await openSection();
    await userEvent.click(await within(section).findByRole("button", { name: "토큰 1 폐기" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "폐기" }));
    expect(await within(section).findByText("발급한 토큰이 없습니다.")).toBeInTheDocument();
    await waitFor(() => expect(within(section).getByRole("button", { name: "새 토큰 발급" })).toHaveFocus());
  });
});

describe("mcpAddCommand", () => {
  it("오리진 끝 슬래시를 떼고 /mcp 를 붙인다", () => {
    expect(mcpAddCommand("https://chat.example.com/", "dpt_x")).toBe(
      'claude mcp add --transport http dodok https://chat.example.com/mcp --header "Authorization: Bearer dpt_x"',
    );
  });
});
