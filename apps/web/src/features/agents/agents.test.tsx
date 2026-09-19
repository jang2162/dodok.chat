import type { Agent } from "@dodok/shared";
import { onlineManager, type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { AgentsPage } from "./AgentsPage";

type Body = Record<string, unknown>;
type Reply = Response | Promise<Response>;
type Call = { method: string; url: string; body: unknown };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const apiErr = (status: number, code: string, message: string) => json(status, { code, message });

let seq = 0;
function makeAgent(fields: Partial<Agent> & Pick<Agent, "providerAgentId" | "handle" | "name">): Agent {
  seq += 1;
  return {
    id: `0190a000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    workspaceId: "0190a000-0000-7000-8000-00000000ffff",
    provider: "openclaw",
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
    ...fields,
  };
}
const dev = () =>
  makeAgent({ providerAgentId: "dev", handle: "dev", name: "Dev 에이전트", basePrompt: "기존 프롬프트" });
const fin = () => makeAgent({ providerAgentId: "fin", handle: "fin", name: "Fin 에이전트", enabled: false });

/**
 * URL 로 가르는 가짜 서버. 에이전트 목록을 서버 상태로 들고, POST·PATCH 기본 처리기는 그 상태를 고쳐 `{ agent }` 를 돌려준다.
 * 처리기를 바꾸는 테스트는 마지막 인자(기본 처리기)로 넘길 수 있다
 */
function stubServer(
  opts: {
    agents?: Agent[];
    list?: (fallback: () => Reply) => Reply;
    discover?: () => Reply;
    create?: (body: Body, fallback: (body: Body) => Reply) => Reply;
    patch?: (id: string, body: Body, fallback: (id: string, body: Body) => Reply) => Reply;
  } = {},
) {
  const state = [...(opts.agents ?? [])];
  const calls: Call[] = [];
  const listDefault = () => json(200, { agents: state });
  const createDefault = (body: Body) => {
    const agent = makeAgent(body as Pick<Agent, "providerAgentId" | "handle" | "name">);
    state.push(agent);
    return json(201, { agent });
  };
  const patchDefault = (id: string, body: Body) => {
    const i = state.findIndex((a) => a.id === id);
    const current = state[i];
    if (!current) return apiErr(404, "NOT_FOUND", "agent not found");
    const next: Agent = { ...current, ...(body as Partial<Agent>) };
    if (body.basePrompt === null) delete next.basePrompt;
    state[i] = next;
    return json(200, { agent: next });
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: Body | undefined = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (method === "GET" && url === "/api/v1/agents") return (opts.list ?? ((f) => f()))(listDefault);
    if (method === "GET" && url === "/api/v1/agents/discover")
      return (opts.discover ?? (() => json(200, { agents: [] })))();
    if (method === "POST" && url === "/api/v1/agents")
      return (opts.create ?? ((b, f) => f(b)))(body ?? {}, createDefault);
    const m = /^\/api\/v1\/agents\/([^/]+)$/.exec(url);
    if (method === "PATCH" && m?.[1])
      return (opts.patch ?? ((i, b, f) => f(i, b)))(m[1], body ?? {}, patchDefault);
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    bodies: (method: string) => calls.filter((c) => c.method === method).map((c) => c.body),
  };
}

function renderPage(qc: QueryClient = createQueryClient(() => {})) {
  render(
    <QueryClientProvider client={qc}>
      <AgentsPage />
    </QueryClientProvider>,
  );
  return qc;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** 목록을 받기 전엔 가져오기 버튼이 잠겨 있다 — 풀리길 기다려 누른다 */
async function openDiscover() {
  const trigger = await screen.findByRole("button", { name: "Gateway 에서 가져오기" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  return screen.findByRole("dialog");
}

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("목록", () => {
  it("핸들·이름·OpenClaw id 와 사용 스위치를 보인다", async () => {
    stubServer({ agents: [dev(), fin()] });
    renderPage();
    expect(await screen.findByText("@dev")).toBeInTheDocument();
    expect(screen.getByText("Dev 에이전트")).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("기존 프롬프트")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "@dev 사용" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "@fin 사용" })).not.toBeChecked();
    expect(screen.getByRole("heading", { level: 1, name: "에이전트" })).toBeInTheDocument();
    expect(screen.getByTestId("page-agents")).toBeInTheDocument();
  });

  it("사용 스위치를 끄면 요청 중엔 잠그고, PATCH { enabled: false } 응답으로 캐시를 고친다 — 다시 불러오지 않는다", async () => {
    const agent = dev();
    const g = gate();
    const server = stubServer({
      agents: [agent],
      patch: async (id, body, fallback) => {
        await g.opened;
        return fallback(id, body);
      },
    });
    const qc = renderPage();
    const sw = await screen.findByRole("switch", { name: "@dev 사용" });
    await userEvent.click(sw);
    await waitFor(() => expect(sw).toBeDisabled());
    expect(sw).toBeChecked(); // 낙관적 갱신은 하지 않는다
    g.open();
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(sw).toBeEnabled();
    expect(server.bodies("PATCH")).toEqual([{ enabled: false }]);
    expect(server.count("PATCH", `/api/v1/agents/${agent.id}`)).toBe(1);
    expect(qc.getQueryData<Agent[]>(qk.agents)?.[0]?.enabled).toBe(false);
    expect(server.count("GET", "/api/v1/agents")).toBe(1);
  });

  it("사용 토글이 실패하면 스위치는 그대로이고 전역 토스트가 서버 message 를 알린다", async () => {
    stubServer({ agents: [dev()], patch: () => apiErr(404, "NOT_FOUND", "agent not found") });
    renderPage();
    const sw = await screen.findByRole("switch", { name: "@dev 사용" });
    await userEvent.click(sw);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("agent not found"));
    expect(toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toBeChecked();
  });

  it("등록된 에이전트가 없으면 가져오기로 안내한다", async () => {
    stubServer();
    renderPage();
    expect(await screen.findByText(/등록된 에이전트가 없습니다/)).toBeInTheDocument();
  });

  it("목록 조회가 실패하면 그 자리에 「다시 시도」 — 원인은 전역 토스트가 한 번 알린다", async () => {
    let first = true;
    stubServer({
      agents: [dev()],
      list: (fallback) => {
        if (!first) return fallback();
        first = false;
        return apiErr(403, "FORBIDDEN", "권한이 없다");
      },
    });
    renderPage();
    const trigger = screen.getByRole("button", { name: "Gateway 에서 가져오기" });
    expect(trigger).toBeDisabled(); // 목록을 받기 전엔 등록된 것을 가를 수 없다
    expect(await screen.findByText("에이전트 목록을 불러오지 못했습니다")).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("권한이 없다");
    expect(trigger).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("@dev")).toBeInTheDocument();
    expect(trigger).toBeEnabled();
  });

  it("다시 불러오기가 실패해도 이미 받은 목록은 그대로 — 원인은 전역 토스트", async () => {
    let n = 0;
    const server = stubServer({
      agents: [dev()],
      list: (fallback) => (++n === 1 ? fallback() : apiErr(403, "FORBIDDEN", "권한이 없다")),
    });
    const qc = renderPage();
    expect(await screen.findByText("@dev")).toBeInTheDocument();
    // 화면에 다시 들어온다 — 같은 캐시로 새로 붙어 다시 불러온다(staleTime 0)
    cleanup();
    renderPage(qc);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("권한이 없다"));
    expect(server.count("GET", "/api/v1/agents")).toBe(2);
    expect(screen.getByText("@dev")).toBeInTheDocument();
    expect(screen.queryByText("에이전트 목록을 불러오지 못했습니다")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gateway 에서 가져오기" })).toBeEnabled();
  });
});

describe("기본 프롬프트", () => {
  it("편집해 저장하면 PATCH { basePrompt }, 비워 저장하면 null — 남은 글자 수를 보인다", async () => {
    const server = stubServer({ agents: [dev()] });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "@dev 기본 프롬프트 편집" }));
    const box = screen.getByRole("textbox", { name: "@dev 기본 프롬프트" });
    expect(box).toHaveValue("기존 프롬프트");
    expect(screen.getByText("19,993자 남음")).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "새 프롬프트");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "@dev 기본 프롬프트" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("새 프롬프트")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "@dev 기본 프롬프트 편집" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "@dev 기본 프롬프트" }));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("기본 프롬프트 없음")).toBeInTheDocument();
    expect(server.bodies("PATCH")).toEqual([{ basePrompt: "새 프롬프트" }, { basePrompt: null }]);
    expect(server.count("GET", "/api/v1/agents")).toBe(1);
  });

  it("취소하면 요청 없이 닫힌다", async () => {
    const server = stubServer({ agents: [dev()] });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "@dev 기본 프롬프트 편집" }));
    await userEvent.type(screen.getByRole("textbox", { name: "@dev 기본 프롬프트" }), " 덧붙임");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("textbox", { name: "@dev 기본 프롬프트" })).not.toBeInTheDocument();
    expect(screen.getByText("기존 프롬프트")).toBeInTheDocument();
    expect(server.bodies("PATCH")).toEqual([]);
  });
});

describe("Gateway 에서 가져오기", () => {
  const discovered = [
    { providerAgentId: "dev", name: "Dev" },
    { providerAgentId: "Fin Bot", name: "Fin" },
    { providerAgentId: "ops" },
  ];

  it("등록 안 된 것만 체크 목록 — 핸들 기본값은 handleFrom, 고른 수만큼 POST 하고 목록을 갱신한다", async () => {
    const server = stubServer({ agents: [dev()], discover: () => json(200, { agents: discovered }) });
    renderPage();
    const dialog = await openDiscover();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(dialog).queryByRole("checkbox", { name: "Dev" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Fin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ops" }));
    expect(within(dialog).getByRole("textbox", { name: "Fin 핸들" })).toHaveValue("fin-bot");
    expect(within(dialog).getByRole("textbox", { name: "Fin 이름" })).toHaveValue("Fin");
    expect(within(dialog).getByRole("textbox", { name: "ops 핸들" })).toHaveValue("ops");
    const opsName = within(dialog).getByRole("textbox", { name: "ops 이름" });
    expect(opsName).toHaveValue("ops");
    await userEvent.clear(opsName);
    await userEvent.type(opsName, "Ops");

    await userEvent.click(within(dialog).getByRole("button", { name: "2개 등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      { providerAgentId: "Fin Bot", handle: "fin-bot", name: "Fin" },
      { providerAgentId: "ops", handle: "ops", name: "Ops" },
    ]);
    expect(screen.getByText("@fin-bot")).toBeInTheDocument();
    expect(screen.getByText("@ops")).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("핸들이 겹치면(409) 그 항목 핸들 칸 아래 서버 message — 나머지는 등록되고 대화상자는 남는다(토스트 없음)", async () => {
    const server = stubServer({
      agents: [dev()],
      discover: () => json(200, { agents: discovered }),
      create: (body, fallback) =>
        body.handle === "ops" ? apiErr(409, "CONFLICT", "handle @ops 는 이미 쓰이고 있다") : fallback(body),
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Fin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ops" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2개 등록" }));

    const opsHandle = within(dialog).getByRole("textbox", { name: "ops 핸들" });
    await waitFor(() => expect(opsHandle).toHaveAccessibleDescription("handle @ops 는 이미 쓰이고 있다"));
    expect(opsHandle).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).queryByRole("checkbox", { name: "Fin" })).not.toBeInTheDocument();
    expect(screen.getByText("@fin-bot")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();

    await userEvent.clear(opsHandle);
    await userEvent.type(opsHandle, "ops2");
    expect(within(dialog).queryByText("handle @ops 는 이미 쓰이고 있다")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "1개 등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("@ops2")).toBeInTheDocument();
    expect(server.bodies("POST")).toHaveLength(3);
  });

  it("항목 옆 OpenClaw id 는 이름과 다를 때만 적는다", async () => {
    stubServer({
      discover: () =>
        json(200, {
          agents: [
            { providerAgentId: "Fin Bot", name: "Fin" },
            { providerAgentId: "ops" },
            { providerAgentId: "qa", name: "qa" },
          ],
        }),
    });
    renderPage();
    const dialog = await openDiscover();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    expect(within(dialog).getByText("Fin Bot")).toBeInTheDocument();
    expect(within(dialog).getAllByText("ops")).toHaveLength(1);
    expect(within(dialog).getAllByText("qa")).toHaveLength(1);
  });

  it("다시 열면 discover 를 새로 부른다 — 받기 전엔 지난 목록 대신 「불러오는 중」", async () => {
    const g = gate();
    let n = 0;
    const server = stubServer({
      agents: [dev()],
      discover: async () => {
        if (++n === 2) await g.opened;
        return json(200, { agents: discovered });
      },
    });
    renderPage();
    let dialog = await openDiscover();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await openDiscover();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Gateway 에서 불러오는 중…");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    g.open();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(2);
  });

  it("열려 있는 동안 다시 불러와도 고른 항목·편집은 그대로 — 재연결로는 부르지 않고, 오프라인에서 열면 「불러오는 중」", async () => {
    const g = gate();
    let n = 0;
    const server = stubServer({
      agents: [dev()],
      discover: async () => {
        if (++n === 2) await g.opened;
        return json(200, { agents: discovered });
      },
    });
    const qc = renderPage();
    await screen.findByText("@dev");
    onlineManager.setOnline(false);
    const dialog = await openDiscover();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Gateway 에서 불러오는 중…");
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(0);
    onlineManager.setOnline(true);

    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Fin" }));
    const finHandle = within(dialog).getByRole("textbox", { name: "Fin 핸들" });
    // 재연결 — 다시 부르지 않는다(부르면 편집 중인 목록이 흔들린다)
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await userEvent.clear(finHandle);
    await userEvent.type(finHandle, "fin2");
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(1);

    // 누가 ["agents"] 를 무효화해 discover 가 다시 불려도 목록은 그대로 둔다
    void qc.invalidateQueries({ queryKey: qk.agents });
    await waitFor(() => expect(server.count("GET", "/api/v1/agents/discover")).toBe(2));
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Fin" })).toBeChecked();
    expect(finHandle).toHaveValue("fin2");
    g.open();
    await waitFor(() => expect(qc.isFetching({ queryKey: qk.discover })).toBe(0));
    expect(within(dialog).getByRole("textbox", { name: "Fin 핸들" })).toHaveValue("fin2");
    expect(within(dialog).getByRole("button", { name: "1개 등록" })).toBeEnabled();
  });

  it("등록하는 동안엔 닫을 수 없다(닫기 버튼·Esc·바깥 클릭) — 끝나면 실패 항목을 대화상자 안에 보이고 닫을 수 있다", async () => {
    const g = gate();
    const server = stubServer({
      agents: [dev()],
      discover: () => json(200, { agents: discovered }),
      create: async (body, fallback) => {
        await g.opened;
        return body.handle === "ops"
          ? apiErr(409, "CONFLICT", "handle @ops 는 이미 쓰이고 있다")
          : fallback(body);
      },
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Fin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ops" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2개 등록" }));

    const closeButton = within(dialog).getByRole("button", { name: "닫기" });
    await waitFor(() => expect(closeButton).toBeDisabled());
    await userEvent.keyboard("{Escape}");
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    if (!overlay) throw new Error("오버레이가 없다");
    await userEvent.click(overlay);
    expect(screen.getByRole("dialog")).toBe(dialog);

    g.open();
    const opsHandle = within(dialog).getByRole("textbox", { name: "ops 핸들" });
    await waitFor(() => expect(opsHandle).toHaveAccessibleDescription("handle @ops 는 이미 쓰이고 있다"));
    expect(server.bodies("POST")).toHaveLength(2);
    expect(screen.getByText("@fin-bot")).toBeInTheDocument();
    expect(closeButton).toBeEnabled();
    await userEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    [503, "ADAPTER_UNAVAILABLE", "Gateway 에 연결되지 않았습니다"],
    [403, "FORBIDDEN", "Gateway 권한(agents.list)이 없습니다"],
    [504, "TIMEOUT", "Gateway 에서 목록을 가져오지 못했습니다"],
  ])("discover %i(%s) → 「%s」 + 직접 입력 폼 — 토스트·재시도 없음", async (status, code, text) => {
    const server = stubServer({ agents: [dev()], discover: () => apiErr(status, code, "gateway says no") });
    renderPage();
    const dialog = await openDiscover();
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "OpenClaw id" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "핸들" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "이름" })).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("새로 등록할 것이 없으면 그렇게 알리고, 「직접 입력」으로 폼을 연다", async () => {
    stubServer({ agents: [dev()], discover: () => json(200, { agents: [{ providerAgentId: "dev" }] }) });
    renderPage();
    const dialog = await openDiscover();
    expect(await within(dialog).findByText("새로 등록할 에이전트가 없습니다")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    expect(within(dialog).getByRole("textbox", { name: "OpenClaw id" })).toBeInTheDocument();

    // 닫았다 다시 열면 목록부터
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const reopened = await openDiscover();
    expect(await within(reopened).findByText("새로 등록할 에이전트가 없습니다")).toBeInTheDocument();
  });
});

describe("직접 입력", () => {
  const unavailable = () => apiErr(503, "ADAPTER_UNAVAILABLE", "adapter not configured");

  it("핸들·이름은 OpenClaw id 를 따라 채워지고 손대면 그 값을 쓴다 — 409 면 핸들 칸 아래 서버 message(토스트 없음)", async () => {
    const server = stubServer({
      agents: [dev()],
      discover: unavailable,
      create: (body, fallback) =>
        body.handle === "main-agent"
          ? apiErr(409, "CONFLICT", "handle @main-agent 는 이미 쓰이고 있다")
          : fallback(body),
    });
    renderPage();
    const dialog = await openDiscover();
    const id = await within(dialog).findByRole("textbox", { name: "OpenClaw id" });
    const handle = within(dialog).getByRole("textbox", { name: "핸들" });
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    await userEvent.type(id, "Main Agent");
    expect(handle).toHaveValue("main-agent");
    expect(name).toHaveValue("Main Agent");

    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(handle).toHaveAccessibleDescription("handle @main-agent 는 이미 쓰이고 있다"));
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(toastError).not.toHaveBeenCalled();

    await userEvent.clear(handle);
    await userEvent.type(handle, "main2");
    expect(within(dialog).queryByText("handle @main-agent 는 이미 쓰이고 있다")).not.toBeInTheDocument();
    await userEvent.type(id, "!");
    expect(handle).toHaveValue("main2");
    expect(name).toHaveValue("Main Agent!");

    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      { providerAgentId: "Main Agent", handle: "main-agent", name: "Main Agent" },
      { providerAgentId: "Main Agent!", handle: "main2", name: "Main Agent!" },
    ]);
    expect(screen.getByText("@main2")).toBeInTheDocument();
  });

  it("이미 등록된 OpenClaw id·규칙 밖 핸들이면 요청하지 않고 폼 안에서 알린다", async () => {
    const server = stubServer({ agents: [dev()], discover: unavailable });
    renderPage();
    const dialog = await openDiscover();
    const id = await within(dialog).findByRole("textbox", { name: "OpenClaw id" });
    const submit = within(dialog).getByRole("button", { name: "등록" });
    await userEvent.type(id, "dev");
    expect(id).toHaveAccessibleDescription("이미 등록된 OpenClaw id 입니다");
    expect(submit).toBeDisabled();

    await userEvent.type(id, "2");
    const handle = within(dialog).getByRole("textbox", { name: "핸들" });
    await userEvent.clear(handle);
    await userEvent.type(handle, "Bad Handle");
    expect(handle).toHaveAccessibleDescription("영문 소문자·숫자·_·- 로 2~32자");
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(server.bodies("POST")).toEqual([]);
  });
});
