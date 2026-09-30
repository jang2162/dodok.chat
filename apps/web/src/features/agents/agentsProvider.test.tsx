import { createQueryClient } from "@/app/queryClient";
import { qk } from "@/api/queries";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErr, dev, json, openDiscover, renderPage, stubServer } from "../../../test/agentsPage";
import { ID_TAKEN } from "./ManualAgentForm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runnerAgents = [
  { providerAgentId: "coder", name: "코더", hint: "맥북 · my-repo · sonnet" },
  { providerAgentId: "writer", name: "작가", hint: "데스크톱 · docs · haiku" },
];

async function pickClaude(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("radio", { name: "Claude 러너" }));
}

describe("에이전트 가져오기 — 제공자", () => {
  it("열면 OpenClaw — Claude 러너로 바꾸면 러너 목록(러너 라벨·작업 디렉터리 라벨·모델)으로 바뀐다", async () => {
    const server = stubServer({
      discover: () => json(200, { agents: [{ providerAgentId: "ops", name: "Ops" }] }),
      discoverClaude: () => json(200, { agents: runnerAgents }),
    });
    renderPage();
    const dialog = await openDiscover();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeChecked();
    expect(await within(dialog).findByRole("checkbox", { name: "Ops" })).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents/discover?provider=claude")).toBe(0);

    await pickClaude(dialog);
    expect(await within(dialog).findByRole("checkbox", { name: "코더" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: "Ops" })).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("맥북 · my-repo · sonnet");
    expect(dialog).toHaveTextContent("데스크톱 · docs · haiku");
    // 등록하면 그 러너 토큰에 묶인다
    expect(dialog).toHaveTextContent(
      "등록하면 지금 그 id 를 알린 러너(줄 맨 앞 이름)에 묶여, 그 러너만 이 에이전트를 맡습니다",
    );
    expect(server.count("GET", "/api/v1/agents/discover?provider=claude")).toBe(1);

    // 되돌리면 OpenClaw 목록
    await userEvent.click(within(dialog).getByRole("radio", { name: "OpenClaw" }));
    expect(await within(dialog).findByRole("checkbox", { name: "Ops" })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("에 묶여");
    expect(within(dialog).queryByRole("checkbox", { name: "코더" })).not.toBeInTheDocument();
  });

  it("Claude 러너 목록에서 고른 것은 provider claude 로 등록한다", async () => {
    const server = stubServer({ agents: [dev()], discoverClaude: () => json(200, { agents: runnerAgents }) });
    renderPage();
    const dialog = await openDiscover();
    await pickClaude(dialog);
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "코더" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "1개 등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      { provider: "claude", providerAgentId: "coder", handle: "coder", name: "코더" },
    ]);
  });

  it("러너가 없으면 「연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요」, owner 에게는 연결 페이지 링크", async () => {
    stubServer();
    renderPage();
    const dialog = await openDiscover();
    await pickClaude(dialog);
    const link = await within(dialog).findByRole("link", { name: "연결 페이지" });
    expect(dialog).toHaveTextContent("연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요");
    expect(link).toHaveAttribute("href", "/settings/connection");
  });

  it("admin 에게는 같은 안내에 링크가 없다 — 연결 페이지는 owner 만 본다", async () => {
    stubServer();
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const dialog = await openDiscover();
    await pickClaude(dialog);
    expect(await within(dialog).findByText(/연결된 러너가 없습니다/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
  });

  it("러너 목록을 못 받으면 서버 문구 대신 고정 문구, 직접 입력은 Claude 러너 id 로 provider claude 를 보낸다", async () => {
    const server = stubServer({
      discoverClaude: () => apiErr(503, "ADAPTER_UNAVAILABLE", "adapter not configured"),
    });
    renderPage();
    const dialog = await openDiscover();
    await pickClaude(dialog);
    expect(await within(dialog).findByText("러너 목록을 가져오지 못했습니다")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("adapter not configured");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Claude 러너 에이전트 id" }), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      { provider: "claude", providerAgentId: "coder", handle: "coder", name: "coder" },
    ]);
  });

  it("id 중복 409(details.field providerAgentId)는 id 칸 아래 고정 문구 — 서버 문구는 보이지 않는다", async () => {
    // 다른 탭에서 같은 id 를 먼저 등록한 경합 — 목록은 registeredIds 로 먼저 거르므로 이 경로로만 닿는다
    stubServer({
      discoverClaude: () => apiErr(503, "ADAPTER_UNAVAILABLE", "adapter not configured"),
      create: () =>
        json(409, {
          code: "CONFLICT",
          message: "providerAgentId coder 는 이미 등록돼 있다",
          details: { field: "providerAgentId" },
        }),
    });
    renderPage();
    const dialog = await openDiscover();
    await pickClaude(dialog);
    const id = await within(dialog).findByRole("textbox", { name: "Claude 러너 에이전트 id" });
    await userEvent.type(id, "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(id).toHaveAccessibleDescription(ID_TAKEN));
    expect(id).toHaveAttribute("aria-invalid", "true");
    expect(dialog).not.toHaveTextContent("이미 등록돼 있다");
  });

  it("다시 열면 OpenClaw 로 돌아간다", async () => {
    stubServer({ discoverClaude: () => json(200, { agents: runnerAgents }) });
    const qc = renderPage();
    let dialog = await openDiscover();
    await pickClaude(dialog);
    await within(dialog).findByRole("checkbox", { name: "코더" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await openDiscover();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeChecked();
    expect(qc.getQueryData(qk.agents)).toBeDefined();
  });
});
