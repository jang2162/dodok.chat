import type { Agent } from "@dodok/shared";
import { onlineManager } from "@tanstack/react-query";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { agentPath, apiErr, dev, fin, gate, renderPage, stubServer } from "../../../test/agentsPage";

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 에이전트 하나는 「연결」 탭의 에이전트 상세(`/settings/connection/agent/<id>`)가 그린다 — 목록은 트리(connectionsLayout.test)
const treeNav = () => screen.findByRole("navigation", { name: "연결 목록" });
/** 상세 본문 — 트리 줄에도 핸들이 보이므로 핸들 글자는 이 안에서 찾는다 */
const inDetail = async () => within(await screen.findByTestId("agent-detail"));

describe("에이전트 상세", () => {
  it("핸들·이름·OpenClaw id 와 사용 스위치를 보인다 — 트리에는 두 에이전트가 줄로", async () => {
    const a = dev();
    const b = fin();
    stubServer({ agents: [a, b] });
    renderPage(undefined, "owner", agentPath(a));
    expect(await (await inDetail()).findByText("@dev")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Dev 에이전트" })).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("기존 프롬프트")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "@dev 사용" })).toBeChecked();
    expect(screen.getByTestId("page-connection")).toBeInTheDocument();
    const nav = await treeNav();
    expect(within(nav).getByRole("link", { name: /Dev 에이전트/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /Fin 에이전트.*꺼짐/ })).toBeInTheDocument();
  });

  it("꺼진 에이전트는 머리에 「꺼짐」, 스위치는 꺼진 채", async () => {
    const b = fin();
    stubServer({ agents: [b] });
    renderPage(undefined, "owner", agentPath(b));
    expect(await screen.findByRole("switch", { name: "@fin 사용" })).not.toBeChecked();
    expect(screen.getByRole("heading", { level: 1, name: "Fin 에이전트" }).parentElement).toHaveTextContent(
      "꺼짐",
    );
  });

  it("제공자별 id 라벨 — 러너 에이전트는 「러너 에이전트 id」, openclaw 는 「OpenClaw id」", async () => {
    const coder: Agent = {
      ...fin(),
      provider: "runner",
      providerAgentId: "coder",
      handle: "coder",
      name: "Coder",
    };
    stubServer({ agents: [dev(), coder] });
    renderPage(undefined, "owner", agentPath(coder));
    expect(await (await inDetail()).findByText("@coder")).toBeInTheDocument();
    expect(screen.getByText(/^러너 에이전트 id/)).toBeInTheDocument();
    expect(screen.queryByText(/^OpenClaw id/)).toBeNull();
    cleanup();
    const d = dev();
    stubServer({ agents: [d] });
    renderPage(undefined, "owner", agentPath(d));
    expect(await screen.findByText(/^OpenClaw id/)).toBeInTheDocument();
  });

  it("러너 에이전트는 프로그램·묶인 러너 라벨 — 폐기됐으면 그 러너 화면에서 옮기라는 안내, 러너 없으면 그 말. openclaw 는 러너 줄이 없다", async () => {
    const claude = (n: number, runner?: Agent["runner"]): Agent => ({
      ...fin(),
      id: `0190b000-0000-7000-8000-00000000000${n}`,
      provider: "runner",
      program: "claude",
      providerAgentId: `coder${n}`,
      handle: `coder${n}`,
      name: `Coder${n}`,
      ...(runner ? { runner } : {}),
    });
    const t = (n: number) => `0190a000-0000-7000-8000-00000000000${n}`;
    const agents = [
      dev(),
      claude(1, { tokenId: t(1), label: "맥북", revoked: false }),
      claude(2, { tokenId: t(2), label: "옛 노트북", revoked: true }),
      claude(3),
    ];
    const body = async (agent: Agent) => {
      cleanup();
      stubServer({ agents });
      renderPage(undefined, "owner", agentPath(agent));
      await screen.findByText(`@${agent.handle}`);
      return screen.getByTestId("agent-detail");
    };
    expect(await body(agents[1] as Agent)).toHaveTextContent("Claude Code · 러너 맥북");
    const revoked = await body(agents[2] as Agent);
    expect(revoked).toHaveTextContent(
      "Claude Code · 러너 옛 노트북 — 토큰이 폐기돼 맡을 러너가 없습니다. 그 러너 화면에서 프로젝트를 다른 러너로 옮기세요",
    );
    expect(within(revoked).getByRole("link", { name: "그 러너 화면" })).toHaveAttribute(
      "href",
      `/settings/connection/runner/${t(2)}`,
    );
    expect(await body(agents[3] as Agent)).toHaveTextContent("Claude Code · 맡을 러너가 없습니다");
    expect(await body(agents[0] as Agent)).not.toHaveTextContent("러너");
  });

  it("머리 아래 경로 — OpenClaw 는 「<Gateway> · OpenClaw」, 러너는 「<러너> · <프로그램>」, 연결 이름은 그 상세 링크", async () => {
    const d = dev();
    stubServer({ agents: [d] });
    renderPage(undefined, "member", agentPath(d));
    const gateway = await screen.findByRole("link", { name: "사무실" });
    expect(gateway).toHaveAttribute(
      "href",
      "/settings/connection/gateway/01a00000-0000-7000-8000-0000000000a1",
    );
    expect(gateway.closest("p")).toHaveTextContent("사무실 · OpenClaw");
    cleanup();
    const coder: Agent = {
      ...fin(),
      provider: "runner",
      program: "claude",
      providerAgentId: "coder",
      handle: "coder",
      name: "Coder",
      runner: { tokenId: "0190a000-0000-7000-8000-000000000001", label: "맥북", revoked: false },
    };
    stubServer({ agents: [coder] });
    renderPage(undefined, "member", agentPath(coder));
    const runner = await screen.findByRole("link", { name: "맥북" });
    expect(runner.closest("p")).toHaveTextContent("맥북 · Claude Code");
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
    const qc = renderPage(undefined, "owner", agentPath(agent));
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
    const agent = dev();
    stubServer({ agents: [agent], patch: () => apiErr(404, "NOT_FOUND", "agent not found") });
    renderPage(undefined, "owner", agentPath(agent));
    const sw = await screen.findByRole("switch", { name: "@dev 사용" });
    await userEvent.click(sw);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("agent not found"));
    expect(toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toBeChecked();
  });

  it("없는 에이전트 id 면 「이 에이전트를 찾을 수 없습니다」와 「← 연결」", async () => {
    stubServer({ agents: [dev()] });
    renderPage(undefined, "owner", "/settings/connection/agent/0190a000-0000-7000-8000-00000000dead");
    expect(await screen.findByText("이 에이전트를 찾을 수 없습니다")).toBeInTheDocument();
    const back = within(screen.getByTestId("connection-not-found")).getByRole("link", { name: "연결" });
    expect(back).toHaveTextContent("← 연결");
    expect(back).toHaveAttribute("href", "/settings/connection");
  });

  it("상세를 연 채 다른 곳에서 지워지면(목록에서 빠짐) 빈 화면이 아니라 「찾을 수 없습니다」", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    const qc = renderPage(undefined, "owner", agentPath(agent));
    await screen.findByRole("switch", { name: "@dev 사용" });
    server.state.splice(0, 1);
    await qc.invalidateQueries({ queryKey: qk.agents });
    expect(await screen.findByText("이 에이전트를 찾을 수 없습니다")).toBeInTheDocument();
  });

  it("목록 조회가 실패하면 상세 자리에 「다시 시도」 — 원인은 전역 토스트가 한 번 알린다", async () => {
    let first = true;
    const agent = dev();
    stubServer({
      agents: [agent],
      list: (fallback) => {
        if (!first) return fallback();
        first = false;
        return apiErr(403, "FORBIDDEN", "권한이 없다");
      },
    });
    renderPage(undefined, "owner", agentPath(agent));
    await waitFor(() => expect(screen.getAllByText("불러오지 못했습니다").length).toBeGreaterThan(0));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" });
    await userEvent.click(screen.getAllByRole("button", { name: "다시 시도" })[0] as HTMLElement);
    expect(await (await inDetail()).findByText("@dev")).toBeInTheDocument();
  });

  it("다시 불러오기가 실패해도 이미 받은 목록은 그대로 — 원인은 전역 토스트", async () => {
    let n = 0;
    const agent = dev();
    const server = stubServer({
      agents: [agent],
      list: (fallback) => (++n === 1 ? fallback() : apiErr(403, "FORBIDDEN", "권한이 없다")),
    });
    const qc = renderPage(undefined, "owner", agentPath(agent));
    expect(await (await inDetail()).findByText("@dev")).toBeInTheDocument();
    // 화면에 다시 들어온다 — 같은 캐시로 새로 붙어 다시 불러온다(staleTime 0)
    cleanup();
    renderPage(qc, "owner", agentPath(agent));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" }));
    expect(server.count("GET", "/api/v1/agents")).toBe(2);
    expect((await inDetail()).getByText("@dev")).toBeInTheDocument();
    expect(screen.queryByText("불러오지 못했습니다")).not.toBeInTheDocument();
  });
});

describe("메모(OpenClaw 에이전트의 basePrompt — 에이전트에게 전달되지 않음)", () => {
  it("편집해 저장하면 PATCH { basePrompt }, 비워 저장하면 null — 남은 글자 수를 보인다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "owner", agentPath(agent));
    await userEvent.click(await screen.findByRole("button", { name: "@dev 메모 편집" }));
    const box = screen.getByRole("textbox", { name: "@dev 메모" });
    expect(box).toHaveValue("기존 프롬프트");
    // 칸 이름은 「메모」, 에이전트에게 가지 않는다는 것을 설명으로 함께 읽는다
    expect(screen.getByText("메모", { selector: "label" })).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(expect.stringContaining("에이전트에게 전달되지 않음"));
    expect(screen.getByText("19,993자 남음")).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "새 프롬프트");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "@dev 메모" })).not.toBeInTheDocument());
    expect(screen.getByText("새 프롬프트")).toBeInTheDocument();
    expect(screen.getByText("메모(에이전트에게 전달되지 않음)")).toBeInTheDocument();
    expect(screen.queryByText(/기본 프롬프트/)).toBeNull();
    // 편집칸이 사라져도 초점은 body 로 떨어지지 않고 다시 편집 버튼으로
    expect(screen.getByRole("button", { name: "@dev 메모 편집" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "@dev 메모 편집" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "@dev 메모" }));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("메모 없음")).toBeInTheDocument();
    expect(server.bodies("PATCH")).toEqual([{ basePrompt: "새 프롬프트" }, { basePrompt: null }]);
    expect(server.count("GET", "/api/v1/agents")).toBe(1);
  });

  it("취소하면 요청 없이 닫힌다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "owner", agentPath(agent));
    await userEvent.click(await screen.findByRole("button", { name: "@dev 메모 편집" }));
    await userEvent.type(screen.getByRole("textbox", { name: "@dev 메모" }), " 덧붙임");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("textbox", { name: "@dev 메모" })).not.toBeInTheDocument();
    expect(screen.getByText("기존 프롬프트")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "@dev 메모 편집" })).toHaveFocus();
    expect(server.bodies("PATCH")).toEqual([]);
  });
});

describe("member 가 보는 에이전트 화면(팀 스펙 2·6장)", () => {
  it("등록 버튼이 없고, 사용 토글·메모는 값만 — 「관리자만 바꿀 수 있습니다」", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "member", agentPath(agent));
    expect(await (await inDetail()).findByText("@dev")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "에이전트 가져오기" })).toBeNull();
    expect(screen.getByRole("switch", { name: "@dev 사용" })).toBeDisabled();
    expect(screen.getByText("기존 프롬프트")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "@dev 메모 편집" })).toBeNull();
    expect(screen.getByText("관리자만 바꿀 수 있습니다")).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(0);
  });
});
