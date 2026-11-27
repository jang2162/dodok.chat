import type { Agent } from "@dodok/shared";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPath, dev, renderPage, stubServer } from "../../../test/agentsPage";

// 에이전트별 런 상한(분) — 기본은 없음. 비워 저장하면 null(상한 없음)

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const card = () => screen.findByRole("region", { name: "런 상한" });

describe("런 상한", () => {
  it("상한이 없는 에이전트 — 칸이 비어 있고, 분을 넣어 저장하면 PATCH { runTimeoutMinutes }", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "admin", agentPath(agent));
    const region = await card();
    const input = within(region).getByRole("spinbutton", { name: "런 상한(분)" });
    expect(input).toHaveValue(null);
    await userEvent.type(input, "180");
    await userEvent.click(within(region).getByRole("button", { name: "@dev 런 상한 저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ runTimeoutMinutes: 180 }]));
  });

  it("값을 지우고 저장하면 null(상한 없음)", async () => {
    const agent: Agent = { ...dev(), runTimeoutMinutes: 30 };
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "admin", agentPath(agent));
    const region = await card();
    const input = within(region).getByRole("spinbutton", { name: "런 상한(분)" });
    expect(input).toHaveValue(30);
    await userEvent.clear(input);
    await userEvent.click(within(region).getByRole("button", { name: "@dev 런 상한 저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ runTimeoutMinutes: null }]));
  });

  it("범위 밖이면 보내지 않고 오류를 보인다", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "admin", agentPath(agent));
    const region = await card();
    const input = within(region).getByRole("spinbutton", { name: "런 상한(분)" });
    await userEvent.type(input, "2000");
    await userEvent.click(within(region).getByRole("button", { name: "@dev 런 상한 저장" }));
    expect(await within(region).findByText("1~1440 분 사이의 정수로 넣으세요")).toBeInTheDocument();
    expect(server.bodies("PATCH")).toEqual([]);
  });

  it("member 는 값만 본다", async () => {
    const agent: Agent = { ...dev(), runTimeoutMinutes: 90 };
    stubServer({ agents: [agent] });
    renderPage(undefined, "member", agentPath(agent));
    const region = await card();
    expect(region).toHaveTextContent("90분");
    expect(within(region).queryByRole("spinbutton")).toBeNull();
  });
});
