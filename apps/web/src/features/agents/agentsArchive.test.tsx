import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { createFakeSocket } from "../../../test/fakeSocket";
import {
  ARCHIVED_AT,
  dev,
  discoverUrl,
  fin,
  gate,
  json,
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

describe("삭제(보관)", () => {
  it("admin 은 살아 있는 줄마다 「삭제」 — 확인 문구를 보이고, 확인하면 DELETE 한 번 뒤 목록에서 빠져 접힌 묶음으로 간다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "admin");
    await userEvent.click(await screen.findByRole("button", { name: "@dev 삭제" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(CONFIRM)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("DELETE", `/api/v1/agents/${agent.id}`)).toBe(1);
    expect(screen.queryByRole("button", { name: "@dev 삭제" })).toBeNull();
    const group = screen.getByRole("button", { name: "삭제된 에이전트 1" });
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
    renderPage(undefined, "admin");
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
    renderPage(undefined, "admin");
    await userEvent.click(await screen.findByRole("button", { name: "@dev 삭제" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.count("DELETE", `/api/v1/agents/${agent.id}`)).toBe(0);
  });

  it("member 에게는 「삭제」·「되살리기」가 없다 — 삭제된 묶음은 이름만", async () => {
    stubServer({ agents: [dev(), archivedFin()] });
    renderPage(undefined, "member");
    expect(await screen.findByText("@dev")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /삭제$/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "삭제된 에이전트 1" }));
    expect(screen.getByText("@fin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /되살리기/ })).toBeNull();
  });
});

describe("삭제된 에이전트 묶음", () => {
  it("접혀 있고 펼치면 줄마다 「되살리기」 — 누르면 restore 뒤 살아 있는 목록으로 돌아온다", async () => {
    const gone = archivedFin();
    const server = stubServer({ agents: [dev(), gone] });
    renderPage(undefined, "admin");
    const group = await screen.findByRole("button", { name: "삭제된 에이전트 1" });
    // 접힌 동안 보관한 줄은 보이지 않는다 — 살아 있는 목록에도 없다
    expect(screen.queryByText("@fin")).toBeNull();
    expect(screen.queryByRole("switch", { name: "@fin 사용" })).toBeNull();

    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: "@fin 되살리기" }));

    expect(await screen.findByRole("switch", { name: "@fin 사용" })).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/agents/${gone.id}/restore`)).toBe(1);
    expect(screen.queryByRole("button", { name: /^삭제된 에이전트/ })).toBeNull();
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
    renderPage(undefined, "admin");
    await userEvent.click(await screen.findByRole("button", { name: "삭제된 에이전트 1" }));
    const restore = screen.getByRole("button", { name: "@fin 되살리기" });
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
    expect(await screen.findByRole("button", { name: "삭제된 에이전트 1" })).toBeInTheDocument();
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
    const subscriptions = createSubscriptions({ socket: fake.wire, queryClient: qc, fetchPage: vi.fn() });
    detachers.push(
      attachHandlers(fake.wire, {
        queryClient: qc,
        subscriptions,
        onUnauthorized: () => {},
        notify: { currentChannelId: () => undefined, openActivity: () => {} },
      }),
    );
    renderPage(qc, "admin");
    expect(await screen.findByRole("switch", { name: "@dev 사용" })).toBeInTheDocument();

    // 다른 탭이 보관했다
    server.state[0] = { ...agent, archivedAt: ARCHIVED_AT };
    act(() => fake.serverEmit("agents.changed", {}));

    expect(await screen.findByRole("button", { name: "삭제된 에이전트 1" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "@dev 사용" })).toBeNull();
  });
});
