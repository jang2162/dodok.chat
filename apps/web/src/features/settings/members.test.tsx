import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import {
  CH,
  DEV,
  FIN,
  agentList,
  agentOf,
  apiErr,
  gate,
  memberUrl,
  members,
  membersSection,
  membersUrl,
  stubSettingsServer,
} from "../../../test/settingsServer";
import { uid } from "../../../test/fixtures";
import { renderRoute } from "../../../test/shellApi";

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("추가·제거", () => {
  it("등록됐고 아직 멤버가 아닌 에이전트만 고른다 → POST { memberType: agent, memberId } → 행이 생긴다", async () => {
    const server = stubSettingsServer({ members: members([DEV]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["에이전트 선택", "@fin — FIN 봇"]);
    expect(within(section).getByRole("button", { name: "추가" })).toBeDisabled();
    // 추가는 응답으로 캐시를 고친다 — 다시 받지 않는다. 처음 받은 횟수는 화면 조각이 뜨는 순서에 따라 달라 그 뒤로만 센다
    const fetched = server.count("GET", membersUrl);

    await userEvent.selectOptions(select, FIN);
    await userEvent.click(within(section).getByRole("button", { name: "추가" }));
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "POST", url: membersUrl, body: { memberType: "agent", memberId: FIN } },
      ]),
    );
    expect(await within(await agentList()).findByText("@fin")).toBeInTheDocument();
    expect(within(section).getByText(/등록된 에이전트가 모두 채널에 있습니다/)).toBeInTheDocument();
    // owner 는 admin 이상이라 등록 링크가 있다(o4 — member 는 없다, roleView.test.tsx)
    expect(within(section).getByRole("link", { name: "에이전트 등록" })).toHaveAttribute(
      "href",
      "/settings/agents",
    );
    expect(server.count("GET", membersUrl)).toBe(fetched);
  });

  it("등록된 에이전트가 없으면 /settings/agents 로 안내", async () => {
    stubSettingsServer({ agents: [] });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    expect(
      await within(section).findByRole("link", { name: "에이전트 화면에서 등록하세요" }),
    ).toHaveAttribute("href", "/settings/agents");
    expect(within(section).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("추가 CONFLICT 는 섹션 안(토스트 없음)", async () => {
    stubSettingsServer({
      override: ({ method }) => (method === "POST" ? apiErr(409, "CONFLICT", "이미 채널 멤버다") : undefined),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, DEV);
    await userEvent.click(within(section).getByRole("button", { name: "추가" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent("이미 채널 멤버다");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("제거는 확인 뒤 DELETE → 행이 빠진다. 취소하면 보내지 않는다", async () => {
    const server = stubSettingsServer({ members: members([DEV], [FIN]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 제거" }));
    let dialog = await screen.findByRole("dialog", { name: "에이전트 제거" });
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.writes()).toEqual([]);

    await userEvent.click(within(list).getByRole("button", { name: "@dev 제거" }));
    dialog = await screen.findByRole("dialog", { name: "에이전트 제거" });
    expect(dialog).toHaveTextContent("@dev 를 이 채널에서 뺍니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "제거" }));
    await waitFor(() => expect(within(list).queryByText("@dev")).not.toBeInTheDocument());
    expect(server.writes()).toEqual([{ method: "DELETE", url: memberUrl(DEV), body: undefined }]);
    expect(within(list).getByText("@fin")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("제거 실패·초점·목록 상태", () => {
  it("제거가 실패하면 토스트 하나와 열린 대화상자 — 다시 시도할 수 있다", async () => {
    let fail = true;
    const server = stubSettingsServer({
      members: members([DEV]),
      override: ({ method }) =>
        method === "DELETE" && fail ? apiErr(500, "INTERNAL", "지우지 못했다") : undefined,
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 제거" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 제거" });
    await userEvent.click(within(dialog).getByRole("button", { name: "제거" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("지우지 못했다"));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "에이전트 제거" })).toBe(dialog);
    expect(within(list).getByText("@dev")).toBeInTheDocument();

    fail = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "제거" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.writes()).toHaveLength(2);
  });

  it("제거 뒤 초점은 「에이전트 추가」로, 취소 뒤에는 누른 「제거」 버튼으로 돌아간다", async () => {
    stubSettingsServer({ members: members([DEV]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const list = await agentList();
    const removeButton = within(list).getByRole("button", { name: "@dev 제거" });

    await userEvent.click(removeButton);
    let dialog = await screen.findByRole("dialog", { name: "에이전트 제거" });
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(removeButton).toHaveFocus());

    await userEvent.click(removeButton);
    dialog = await screen.findByRole("dialog", { name: "에이전트 제거" });
    await userEvent.click(within(dialog).getByRole("button", { name: "제거" }));
    await waitFor(() =>
      expect(within(section).getByRole("combobox", { name: "에이전트 추가" })).toHaveFocus(),
    );
  });

  it("에이전트 목록을 아직 못 받았거나 실패했으면 「아직 에이전트가 없습니다」 대신 상태를 보인다", async () => {
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryDefaults(qk.agents, { retryDelay: 0 });
    const agentsGate = gate();
    let fail = false;
    stubSettingsServer({
      members: members(),
      override: async ({ method, url }) => {
        if (method !== "GET" || url !== "/api/v1/agents") return undefined;
        await agentsGate.opened;
        return fail ? apiErr(500, "INTERNAL", "에이전트를 불러오지 못했다") : undefined;
      },
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const section = await membersSection();
    expect(await within(section).findByText("에이전트 목록을 불러오는 중…")).toBeInTheDocument();
    expect(within(section).queryByText("아직 에이전트가 없습니다.")).not.toBeInTheDocument();

    fail = true;
    agentsGate.open();
    expect(await within(section).findByText("에이전트 목록을 불러오지 못했습니다")).toBeInTheDocument();
    expect(within(section).queryByText("아직 에이전트가 없습니다.")).not.toBeInTheDocument();
    fail = false;
    await userEvent.click(within(section).getByRole("button", { name: "다시 시도" }));
    expect(await within(section).findByRole("combobox", { name: "에이전트 추가" })).toBeInTheDocument();
  });

  it("멤버 조회가 실패하면 그 자리에 상태와 「다시 시도」", async () => {
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryDefaults(qk.members(CH), { retryDelay: 0 });
    let fail = true;
    stubSettingsServer({
      members: members([DEV]),
      override: ({ method, url }) =>
        method === "GET" && url === membersUrl && fail
          ? apiErr(500, "INTERNAL", "멤버를 불러오지 못했다")
          : undefined,
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const section = await membersSection();
    expect(await within(section).findByText("멤버 목록을 불러오지 못했습니다")).toBeInTheDocument();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("멤버를 불러오지 못했다"));

    fail = false;
    await userEvent.click(within(section).getByRole("button", { name: "다시 시도" }));
    expect(await within(await agentList()).findByText("@dev")).toBeInTheDocument();
  });

  it("꺼진 에이전트는 고를 수 있고 「(꺼짐)」으로 보인다", async () => {
    stubSettingsServer({ agents: [agentOf(FIN, "fin", { enabled: false })], members: members() });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["에이전트 선택", "@fin — FIN 봇 (꺼짐)"]);
  });

  it("삭제(보관)한 에이전트는 셀렉트에도 멤버 행에도 없다 — 멤버 응답이 낡아 아직 싣고 있어도", async () => {
    const archivedAt = "2026-10-05T00:00:00.000Z";
    const third = uid(32);
    stubSettingsServer({
      agents: [
        agentOf(DEV, "dev", { archivedAt }),
        agentOf(FIN, "fin"),
        agentOf(third, "ops", { archivedAt }),
      ],
      members: members([DEV], [FIN]),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const list = await agentList();
    expect(await within(list).findByText("@fin")).toBeInTheDocument();
    expect(within(list).queryByText("@dev")).toBeNull();
    expect(within(section).queryByRole("combobox", { name: "에이전트 추가" })).toBeNull();
    expect(within(section).getByText(/등록된 에이전트가 모두 채널에 있습니다/)).toBeInTheDocument();
  });

  it("OpenClaw 에이전트는 셀렉트·멤버 행에 Gateway 이름 — 두 Gateway 의 같은 id 를 가른다", async () => {
    const office = { id: uid(30), name: "사무실" };
    const home = { id: uid(31), name: "집" };
    stubSettingsServer({
      agents: [
        agentOf(DEV, "dev", { gateway: office }),
        agentOf(FIN, "dev-home", { providerAgentId: "dev", gateway: home }),
      ],
      members: members([DEV]),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["에이전트 선택", "@dev-home · 집 — DEV-HOME 봇"]);
    const list = await agentList();
    expect(
      await within(list).findByText((_, el) => el?.tagName === "SPAN" && el.textContent === "@dev · 사무실"),
    ).toBeInTheDocument();
  });

  it("추가 CONFLICT 는 고른 칸에 이어 붙는다(aria-invalid·설명)", async () => {
    stubSettingsServer({
      override: ({ method }) => (method === "POST" ? apiErr(409, "CONFLICT", "이미 채널 멤버다") : undefined),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, DEV);
    await userEvent.click(within(section).getByRole("button", { name: "추가" }));
    await waitFor(() => expect(select).toHaveAccessibleDescription("이미 채널 멤버다"));
    expect(select).toHaveAttribute("aria-invalid", "true");
  });
});
