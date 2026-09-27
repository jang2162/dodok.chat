import type { Agent } from "@dodok/shared";
import { onlineManager } from "@tanstack/react-query";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { apiErr, dev, fin, gate, renderPage, stubServer } from "../../../test/agentsPage";

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
    const trigger = screen.getByRole("button", { name: "에이전트 가져오기" });
    expect(trigger).toBeDisabled(); // 목록을 받기 전엔 등록된 것을 가를 수 없다
    expect(await screen.findByText("에이전트 목록을 불러오지 못했습니다")).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" });
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
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" }));
    expect(server.count("GET", "/api/v1/agents")).toBe(2);
    expect(screen.getByText("@dev")).toBeInTheDocument();
    expect(screen.queryByText("에이전트 목록을 불러오지 못했습니다")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "에이전트 가져오기" })).toBeEnabled();
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
    // 편집칸이 사라져도 초점은 body 로 떨어지지 않고 다시 편집 버튼으로
    expect(screen.getByRole("button", { name: "@dev 기본 프롬프트 편집" })).toHaveFocus();

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
    expect(screen.getByRole("button", { name: "@dev 기본 프롬프트 편집" })).toHaveFocus();
    expect(server.bodies("PATCH")).toEqual([]);
  });
});

describe("member 가 보는 에이전트 화면(팀 스펙 2·6장)", () => {
  it("등록 버튼이 없고, 사용 토글·기본 프롬프트는 값만 — 「관리자만 바꿀 수 있습니다」", async () => {
    const server = stubServer({ agents: [dev()] });
    renderPage(undefined, "member");
    expect(await screen.findByText("@dev")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "에이전트 가져오기" })).toBeNull();
    expect(screen.getByRole("switch", { name: "@dev 사용" })).toBeDisabled();
    expect(screen.getByText("기존 프롬프트")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "@dev 기본 프롬프트 편집" })).toBeNull();
    expect(screen.getByText("관리자만 바꿀 수 있습니다")).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(0);
  });
});
