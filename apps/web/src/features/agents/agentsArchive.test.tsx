import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { createFakeSocket } from "../../../test/fakeSocket";
import {
  ARCHIVED_AT,
  agentDetail,
  agentPath,
  dev,
  discoverUrl,
  fin,
  gate,
  json,
  makeAgent,
  openDiscover,
  renderPage,
  stubServer,
} from "../../../test/agentsPage";

const CONFIRM = "@dev 를 삭제합니다. 채팅 기록은 남고, 되살리면 채널·대화가 그대로 돌아옵니다.";
const detachers: Array<() => void> = [];

afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 보관한 fin — 서버 목록은 보관한 것도 함께 준다(스펙 「에이전트 보관」 절 API 표) */
const archivedFin = () => ({ ...fin(), archivedAt: ARCHIVED_AT });

// 보관은 에이전트 상세에서, 「삭제된 에이전트 N」 묶음은 「연결」 트리에서, 되살리기는 보관한 에이전트의 상세에서(연결 탭 통합 스펙 3.2·3.3)
const treeNav = () => screen.findByRole("navigation", { name: "연결 목록" });

describe("삭제(보관)", () => {
  it("admin 은 상세에 「삭제」 — 확인 문구를 보이고, 확인하면 DELETE 한 번 뒤 트리로 돌아가 접힌 묶음으로 간다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    const { router } = renderPage(undefined, "admin", agentPath(agent));
    await userEvent.click(await screen.findByRole("button", { name: "@dev 삭제" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(CONFIRM)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("DELETE", `/api/v1/agents/${agent.id}`)).toBe(1);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connection"));
    expect(screen.queryByRole("button", { name: "@dev 삭제" })).toBeNull();
    const group = await within(await treeNav()).findByRole("button", { name: "삭제된 에이전트 1" });
    expect(group).toHaveAttribute("aria-expanded", "false");
  });

  it("확인 단추를 같은 틱에 두 번 눌러도 DELETE 는 한 번", async () => {
    const agent = dev();
    const held = gate();
    const server = stubServer({
      agents: [agent],
      archive: async (id, fallback) => {
        await held.opened;
        return fallback(id);
      },
    });
    renderPage(undefined, "admin", agentPath(agent));
    await userEvent.click(await screen.findByRole("button", { name: "@dev 삭제" }));
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" });

    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    held.open();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("DELETE", `/api/v1/agents/${agent.id}`)).toBe(1);
  });

  it("취소하면 요청 없이 닫힌다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "admin", agentPath(agent));
    await userEvent.click(await screen.findByRole("button", { name: "@dev 삭제" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("DELETE", `/api/v1/agents/${agent.id}`)).toBe(0);
  });

  it("member 에게는 「삭제」·「되살리기」가 없다 — 삭제된 에이전트의 상세는 값만", async () => {
    const live = dev();
    const gone = archivedFin();
    stubServer({ agents: [live, gone] });
    const { router } = renderPage(undefined, "member", agentPath(live));
    expect(await within(await agentDetail()).findByText("@dev")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /삭제$/ })).toBeNull();
    await userEvent.click(await within(await treeNav()).findByRole("button", { name: "삭제된 에이전트 1" }));
    await userEvent.click(within(await treeNav()).getByRole("link", { name: /Fin 에이전트/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(agentPath(gone)));
    expect(await within(await agentDetail()).findByText(/@fin/)).toBeInTheDocument();
    expect(screen.getByText("삭제된 에이전트", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /되살리기/ })).toBeNull();
  });
});

describe("삭제된 에이전트 묶음", () => {
  it("트리에서 접혀 있고 펼치면 줄마다 상세 링크 — 상세의 「되살리기」를 누르면 restore 뒤 살아 있는 에이전트로 돌아온다", async () => {
    const gone = archivedFin();
    const server = stubServer({ agents: [dev(), gone] });
    const { router } = renderPage(undefined, "admin");
    const nav = await treeNav();
    const group = await within(nav).findByRole("button", { name: "삭제된 에이전트 1" });
    // 접힌 동안 보관한 줄은 보이지 않는다 — 살아 있는 줄에도 없다
    expect(within(nav).queryByRole("link", { name: /Fin 에이전트/ })).toBeNull();

    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(within(nav).getByRole("link", { name: /Fin 에이전트/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(agentPath(gone)));
    await userEvent.click(await screen.findByRole("button", { name: "@fin 되살리기" }));

    expect(await screen.findByRole("switch", { name: "@fin 사용" })).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/agents/${gone.id}/restore`)).toBe(1);
    await waitFor(() => expect(within(nav).queryByRole("button", { name: /^삭제된 에이전트/ })).toBeNull());
  });

  it("「되살리기」를 같은 틱에 두 번 눌러도 restore 는 한 번", async () => {
    const gone = archivedFin();
    const held = gate();
    const server = stubServer({
      agents: [gone],
      restore: async (id, fallback) => {
        await held.opened;
        return fallback(id);
      },
    });
    renderPage(undefined, "admin", agentPath(gone));
    const restore = await screen.findByRole("button", { name: "@fin 되살리기" });
    act(() => {
      fireEvent.click(restore);
      fireEvent.click(restore);
    });
    held.open();
    expect(await screen.findByRole("switch", { name: "@fin 사용" })).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/agents/${gone.id}/restore`)).toBe(1);
  });

  it("살아 있는 에이전트가 없고 삭제된 것만 있어도 묶음은 보인다", async () => {
    stubServer({ agents: [archivedFin()] });
    renderPage(undefined, "admin");
    expect(
      await within(await treeNav()).findByRole("button", { name: "삭제된 에이전트 1" }),
    ).toBeInTheDocument();
  });
});

describe("삭제·되살리기 뒤 초점 — 누른 단추가 사라져도 body 로 떨어지지 않는다", () => {
  it("삭제하면 초점은 트리의 「삭제된 에이전트 N」 묶음 단추로", async () => {
    const agent = dev();
    stubServer({ agents: [agent, fin()] });
    renderPage(undefined, "admin", agentPath(agent));
    await userEvent.click(await screen.findByRole("button", { name: "@dev 삭제" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }));

    const group = await within(await treeNav()).findByRole("button", { name: "삭제된 에이전트 1" });
    await waitFor(() => expect(group).toHaveFocus());
  });

  it("되살리면 초점은 그 에이전트 상세의 제목으로", async () => {
    const gone = archivedFin();
    stubServer({ agents: [dev(), gone] });
    renderPage(undefined, "admin", agentPath(gone));
    await userEvent.click(await screen.findByRole("button", { name: "@fin 되살리기" }));

    expect(await screen.findByRole("switch", { name: "@fin 사용" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Fin 에이전트" })).toHaveFocus(),
    );
  });

  it("프로젝트가 없는 옛 러너 에이전트는 되살릴 수 없다 — 단추 대신 안내", async () => {
    const old = makeAgent({
      provider: "runner",
      providerAgentId: "r-old",
      handle: "old",
      name: "Old",
      archivedAt: ARCHIVED_AT,
      runnerAgent: {
        projectId: null,
        model: null,
        permissionMode: "default",
        allowedTools: null,
        disallowedTools: [],
      },
    });
    stubServer({ agents: [old] });
    renderPage(undefined, "admin", agentPath(old));
    expect(await within(await agentDetail()).findByText(/@old/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /되살리기/ })).toBeNull();
  });
});

describe("가져오기의 삭제된 항목", () => {
  it("archivedAgentId 가 실린 항목은 체크 대신 「삭제됨 — 되살리기」 — 누르면 restore, 그 항목은 목록에서 빠진다", async () => {
    const gone = archivedFin();
    const server = stubServer({
      agents: [dev(), gone],
      discover: () =>
        json(200, {
          agents: [
            { providerAgentId: "fin", name: "Fin 에이전트", archivedAgentId: gone.id },
            { providerAgentId: "ops", name: "Ops" },
          ],
        }),
    });
    renderPage(undefined, "admin");
    const dialog = await openDiscover();
    const restore = await within(dialog).findByRole("button", { name: "Fin 에이전트 삭제됨 — 되살리기" });
    expect(restore).toHaveTextContent("삭제됨 — 되살리기");
    expect(within(dialog).queryByRole("checkbox", { name: "Fin 에이전트" })).toBeNull();
    expect(within(dialog).getByRole("checkbox", { name: "Ops" })).toBeInTheDocument();

    await userEvent.click(restore);

    await waitFor(() =>
      expect(within(dialog).queryByRole("button", { name: /삭제됨 — 되살리기/ })).toBeNull(),
    );
    expect(server.count("POST", `/api/v1/agents/${gone.id}/restore`)).toBe(1);
    expect(server.count("GET", discoverUrl())).toBe(1);
    // 대화상자가 열려 있어 뒤 페이지는 접근성 트리에서 가려진다
    expect(screen.getByRole("switch", { name: "@fin 사용", hidden: true })).toBeInTheDocument();
  });
});

describe("가져오기 — 이 화면이 모르는 보관", () => {
  it("목록 캐시에 없는 보관이어도 서버 archivedAgentId 가 있으면 「삭제됨 — 되살리기」", async () => {
    const goneId = "0190a000-0000-7000-8000-00000000abcd";
    const server = stubServer({
      agents: [dev()],
      discover: () =>
        json(200, { agents: [{ providerAgentId: "fin", name: "Fin", archivedAgentId: goneId }] }),
      restore: (id) => json(200, { agent: { ...fin(), id, archivedAt: null } }),
    });
    renderPage(undefined, "admin");
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("button", { name: "Fin 삭제됨 — 되살리기" }));
    await waitFor(() => expect(server.count("POST", `/api/v1/agents/${goneId}/restore`)).toBe(1));
    expect(within(dialog).queryByRole("checkbox", { name: "Fin" })).toBeNull();
  });
});

describe("직접 입력의 삭제된 자리", () => {
  it("이 화면이 아는 보관한 id 면 요청 전에 「삭제된 에이전트입니다」와 「되살리기」 — 누르면 restore 뒤 닫힌다", async () => {
    const gone = archivedFin();
    const server = stubServer({ agents: [dev(), gone] });
    renderPage(undefined, "admin");
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("button", { name: "직접 입력" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "OpenClaw id" }), "fin");
    expect(within(dialog).getByText("삭제된 에이전트입니다")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "등록" })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole("button", { name: "되살리기" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("POST", `/api/v1/agents/${gone.id}/restore`)).toBe(1);
    expect(server.bodies("POST").filter((b) => b !== undefined)).toEqual([]);
  });

  it("서버가 409 AGENT_ARCHIVED 로 막으면(이 화면이 몰랐던 보관) 토스트 없이 id 칸에 문구와 「되살리기」(details.agentId)", async () => {
    const goneId = "0190a000-0000-7000-8000-00000000abcd";
    const server = stubServer({
      agents: [dev()],
      create: () =>
        json(409, { code: "AGENT_ARCHIVED", message: "삭제된 에이전트입니다", details: { agentId: goneId } }),
      restore: (id) => json(200, { agent: { ...archivedFin(), id, archivedAt: null } }),
    });
    const toastError = vi.spyOn(await import("sonner").then((m) => m.toast), "error");
    renderPage(undefined, "admin");
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("button", { name: "직접 입력" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "OpenClaw id" }), "fin");
    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));

    expect(await within(dialog).findByText("삭제된 에이전트입니다")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "되살리기" }));
    await waitFor(() => expect(server.count("POST", `/api/v1/agents/${goneId}/restore`)).toBe(1));
  });
});

describe("다른 탭", () => {
  it("agents.changed 를 받으면 목록을 다시 받아 바뀐 것을 그린다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    const qc = createQueryClient(() => {});
    const fake = createFakeSocket();
    fake.socket.connected = true;
    fake.socket.active = true;
    const subscriptions = createSubscriptions({ socket: fake.wire, queryClient: qc });
    detachers.push(
      attachHandlers(fake.wire, {
        queryClient: qc,
        subscriptions,
        onUnauthorized: () => {},
        notify: {
          currentChannelId: () => undefined,
          currentConversationId: () => undefined,
          openActivity: () => {},
        },
      }),
    );
    renderPage(qc, "admin", agentPath(agent));
    expect(await screen.findByRole("switch", { name: "@dev 사용" })).toBeInTheDocument();

    // 다른 탭이 보관했다 — 열린 상세가 「삭제된 에이전트」로, 트리에 묶음이 생긴다
    server.state[0] = { ...agent, archivedAt: ARCHIVED_AT };
    act(() => fake.serverEmit("agents.changed", {}));

    expect(
      await within(await treeNav()).findByRole("button", { name: "삭제된 에이전트 1" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "@dev 사용" })).toBeNull();
    expect(screen.getByText("삭제된 에이전트", { selector: "[data-slot=badge]" })).toBeInTheDocument();
  });
});
