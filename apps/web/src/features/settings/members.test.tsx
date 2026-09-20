import type { Channel, ChannelMember } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { CH2 } from "../../../test/fixtures";
import {
  CH,
  DEV,
  DEV_AGENT,
  FIN,
  FIN_AGENT,
  OWNER,
  agentOf,
  gate,
  memberOf,
  stubSettingsServer,
} from "../../../test/settingsServer";
import { channelOf, json, renderRoute } from "../../../test/shellApi";

const members = (...agents: Array<[id: string, autoRespond?: boolean]>) => [
  memberOf("user", OWNER),
  ...agents.map(([id, autoRespond = false]) => memberOf("agent", id, { autoRespond })),
];
const membersUrl = `/api/v1/channels/${CH}/members`;
const memberUrl = (agentId: string) => `${membersUrl}/${agentId}`;
const apiErr = (status: number, code: string, message: string) => json(status, { code, message });

async function membersSection() {
  return screen.findByRole("region", { name: "멤버" });
}
/** 멤버를 받아 에이전트 행이 뜬 뒤의 목록 */
async function agentList() {
  return within(await membersSection()).findByRole("list", { name: "채널 에이전트" });
}

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
    renderRoute(`/c/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["에이전트 선택", "@fin — FIN 봇"]);
    expect(within(section).getByRole("button", { name: "추가" })).toBeDisabled();

    await userEvent.selectOptions(select, FIN);
    await userEvent.click(within(section).getByRole("button", { name: "추가" }));
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "POST", url: membersUrl, body: { memberType: "agent", memberId: FIN } },
      ]),
    );
    expect(await within(await agentList()).findByText("@fin")).toBeInTheDocument();
    expect(within(section).getByText(/등록된 에이전트가 모두 채널에 있습니다/)).toBeInTheDocument();
    expect(server.count("GET", membersUrl)).toBe(1);
  });

  it("등록된 에이전트가 없으면 /agents 로 안내", async () => {
    stubSettingsServer({ agents: [] });
    renderRoute(`/c/${CH}/settings`);
    const section = await membersSection();
    expect(
      await within(section).findByRole("link", { name: "에이전트 화면에서 등록하세요" }),
    ).toHaveAttribute("href", "/agents");
    expect(within(section).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("추가 CONFLICT 는 섹션 안(토스트 없음)", async () => {
    stubSettingsServer({
      override: ({ method }) => (method === "POST" ? apiErr(409, "CONFLICT", "이미 채널 멤버다") : undefined),
    });
    renderRoute(`/c/${CH}/settings`);
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
    renderRoute(`/c/${CH}/settings`);
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
    renderRoute(`/c/${CH}/settings`);
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
    renderRoute(`/c/${CH}/settings`);
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

  it("「새 대화」를 닫으면 초점은 누른 버튼으로 돌아간다", async () => {
    stubSettingsServer({ members: members([DEV]) });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    const button = within(list).getByRole("button", { name: "@dev 새 대화" });
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "새 대화" });
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(button).toHaveFocus());
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
    renderRoute(`/c/${CH}/settings`, queryClient);
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
    renderRoute(`/c/${CH}/settings`, queryClient);
    const section = await membersSection();
    expect(await within(section).findByText("멤버 목록을 불러오지 못했습니다")).toBeInTheDocument();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("멤버를 불러오지 못했다"));

    fail = false;
    await userEvent.click(within(section).getByRole("button", { name: "다시 시도" }));
    expect(await within(await agentList()).findByText("@dev")).toBeInTheDocument();
  });

  it("꺼진 에이전트는 고를 수 있고 「(꺼짐)」으로 보인다", async () => {
    stubSettingsServer({ agents: [agentOf(FIN, "fin", { enabled: false })], members: members() });
    renderRoute(`/c/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["에이전트 선택", "@fin — FIN 봇 (꺼짐)"]);
  });

  it("추가 CONFLICT 는 고른 칸에 이어 붙는다(aria-invalid·설명)", async () => {
    stubSettingsServer({
      override: ({ method }) => (method === "POST" ? apiErr(409, "CONFLICT", "이미 채널 멤버다") : undefined),
    });
    renderRoute(`/c/${CH}/settings`);
    const section = await membersSection();
    const select = await within(section).findByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, DEV);
    await userEvent.click(within(section).getByRole("button", { name: "추가" }));
    await waitFor(() => expect(select).toHaveAccessibleDescription("이미 채널 멤버다"));
    expect(select).toHaveAttribute("aria-invalid", "true");
  });
});
describe("자동 응답", () => {
  it("켜진 것이 없으면 확인 없이 그것만 켠다, 끄기도 그것만", async () => {
    const server = stubSettingsServer({ members: members([DEV], [FIN]) });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    const dev = within(list).getByRole("switch", { name: "@dev 자동 응답" });
    await userEvent.click(dev);
    await waitFor(() => expect(dev).toBeChecked());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(dev);
    await waitFor(() => expect(dev).not.toBeChecked());
    expect(server.writes()).toEqual([
      { method: "PATCH", url: memberUrl(DEV), body: { autoRespond: true } },
      { method: "PATCH", url: memberUrl(DEV), body: { autoRespond: false } },
    ]);
  });

  it("다른 에이전트가 켜져 있으면 확인 → 그쪽을 먼저 끄고(끝난 뒤) 이쪽을 켠다. 취소하면 보내지 않는다", async () => {
    const finOff = gate();
    const server = stubSettingsServer({
      members: members([DEV], [FIN, true]),
      override: async ({ method, url }) => {
        if (method === "PATCH" && url === memberUrl(FIN)) await finOff.opened;
        return undefined;
      },
    });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    const dev = within(list).getByRole("switch", { name: "@dev 자동 응답" });
    const fin = within(list).getByRole("switch", { name: "@fin 자동 응답" });

    await userEvent.click(dev);
    let dialog = await screen.findByRole("dialog", { name: "자동 응답 바꾸기" });
    expect(dialog).toHaveTextContent("@fin 의 자동 응답을 끄고 @dev 를 켭니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.writes()).toEqual([]);

    await userEvent.click(dev);
    dialog = await screen.findByRole("dialog", { name: "자동 응답 바꾸기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "바꾸기" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    // 앞 걸음이 끝나기 전에는 다음을 보내지 않는다 — 그동안 스위치는 잠긴다
    expect(dev).toBeDisabled();
    expect(fin).toBeDisabled();
    await new Promise((r) => setTimeout(r, 20));
    expect(server.writes()).toHaveLength(1);

    finOff.open();
    await waitFor(() => expect(dev).toBeChecked());
    expect(fin).not.toBeChecked();
    expect(dev).toBeEnabled();
    expect(server.writes()).toEqual([
      { method: "PATCH", url: memberUrl(FIN), body: { autoRespond: false } },
      { method: "PATCH", url: memberUrl(DEV), body: { autoRespond: true } },
    ]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["앞(끄기)이 실패하면 멈춘다 — 켜지 않는다", FIN, 500, { fin: true, dev: false }, 1],
    ["뒤(켜기)가 실패하면 이미 끈 것은 되돌리지 않는다", DEV, 500, { fin: false, dev: false }, 2],
    // 전역 토스트가 빼는 코드(폼 오류)도 폼이 없으니 여기서 한 번 알린다
    ["CONFLICT 로 실패해도 멈추고 알린다", FIN, 409, { fin: true, dev: false }, 1],
  ])("%s, 토스트 하나", async (_name, failing, status, after, sent) => {
    const server = stubSettingsServer({
      members: members([DEV], [FIN, true]),
      override: ({ method, url }) =>
        method === "PATCH" && url === memberUrl(failing)
          ? apiErr(status, status === 409 ? "CONFLICT" : "INTERNAL", "저장 실패")
          : undefined,
    });
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/${CH}/settings`, queryClient);
    const list = await agentList();
    const dev = within(list).getByRole("switch", { name: "@dev 자동 응답" });
    await userEvent.click(dev);
    const dialog = await screen.findByRole("dialog", { name: "자동 응답 바꾸기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "바꾸기" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("저장 실패"));
    await waitFor(() => expect(dev).toBeEnabled());
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(server.writes()).toHaveLength(sent);
    const cached = queryClient.getQueryData<ChannelMember[]>(qk.members(CH)) ?? [];
    const on = (id: string) => cached.find((m) => m.memberId === id)?.autoRespond;
    expect({ fin: on(FIN), dev: on(DEV) }).toEqual(after);
    expect(within(list).getByRole("switch", { name: "@fin 자동 응답" })).toHaveAttribute(
      "aria-checked",
      String(after.fin),
    );
  });

  it("확인 대화상자가 열린 사이 다른 에이전트가 켜지면(wire) 확인 때 다시 계산해 그것도 끈다", async () => {
    const OPS = "01a00000-0000-7000-8000-000000000013";
    const server = stubSettingsServer({
      agents: [DEV_AGENT, FIN_AGENT, agentOf(OPS, "ops")],
      members: [...members([DEV], [FIN, true]), memberOf("agent", OPS)],
    });
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/${CH}/settings`, queryClient);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("switch", { name: "@dev 자동 응답" }));
    const dialog = await screen.findByRole("dialog", { name: "자동 응답 바꾸기" });

    // 대화상자가 열린 사이 다른 탭이 @ops 를 켰다 — wire 가 멤버 목록 캐시를 바꾼다
    server.state.members = server.state.members.map((m) =>
      m.memberId === OPS ? { ...m, autoRespond: true } : m,
    );
    queryClient.setQueryData(qk.members(CH), server.state.members);

    await userEvent.click(within(dialog).getByRole("button", { name: "바꾸기" }));
    await waitFor(() => expect(server.writes()).toHaveLength(3));
    expect(server.writes()).toEqual([
      { method: "PATCH", url: memberUrl(FIN), body: { autoRespond: false } },
      { method: "PATCH", url: memberUrl(OPS), body: { autoRespond: false } },
      { method: "PATCH", url: memberUrl(DEV), body: { autoRespond: true } },
    ]);
  });
});

describe("채널 프롬프트 오버라이드", () => {
  it("펼쳐 저장 → PATCH { promptOverride }, 비우면 null. VALIDATION 은 폼 안", async () => {
    let reply: Response | undefined;
    const server = stubSettingsServer({
      members: members([DEV]),
      override: ({ method }) => (method === "PATCH" ? reply : undefined),
    });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    expect(within(list).getByText("채널 프롬프트 오버라이드 없음")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    const box = within(list).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" });
    expect(box).toHaveAttribute("maxLength", "20000");
    await userEvent.type(box, "숫자는 표로");
    await userEvent.click(within(list).getByRole("button", { name: "저장" }));
    expect(await within(list).findByText("숫자는 표로")).toBeInTheDocument();
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();

    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    await userEvent.clear(within(list).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" }));
    await userEvent.click(within(list).getByRole("button", { name: "저장" }));
    expect(await within(list).findByText("채널 프롬프트 오버라이드 없음")).toBeInTheDocument();
    expect(server.writes().map((c) => c.body)).toEqual([
      { promptOverride: "숫자는 표로" },
      { promptOverride: null },
    ]);

    reply = apiErr(400, "VALIDATION", "promptOverride: too long");
    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    await userEvent.type(within(list).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" }), "x");
    await userEvent.click(within(list).getByRole("button", { name: "저장" }));
    expect(await within(list).findByRole("alert")).toHaveTextContent("promptOverride: too long");
    expect(within(list).getByRole("button", { name: "저장" })).toBeEnabled();
    expect(within(list).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(toastError).not.toHaveBeenCalled();
  });
});
describe("오버라이드 저장 중·초점", () => {
  it("저장 중에는 칸·버튼을 잠그고 「저장 중…」, 닫힌 뒤 초점은 편집 버튼으로 돌아간다", async () => {
    const saving = gate();
    stubSettingsServer({
      members: members([DEV]),
      override: async ({ method }) => {
        if (method === "PATCH") await saving.opened;
        return undefined;
      },
    });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    const editButton = within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" });
    await userEvent.click(editButton);
    const box = within(list).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" });
    await userEvent.type(box, "짧게");
    await userEvent.click(within(list).getByRole("button", { name: "저장" }));

    expect(await within(list).findByRole("button", { name: "저장 중…" })).toBeDisabled();
    expect(box).toBeDisabled();
    expect(within(list).getByRole("button", { name: "취소" })).toBeDisabled();

    saving.open();
    await waitFor(() => expect(within(list).queryByRole("textbox")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" })).toHaveFocus(),
    );
  });

  it("취소해도 초점은 편집 버튼으로 돌아간다", async () => {
    stubSettingsServer({ members: members([DEV]) });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    await userEvent.click(within(list).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" })).toHaveFocus(),
    );
  });
});

describe("새 대화", () => {
  it("확인 → 이 채널로 POST reset, 성공하면 닫힌다", async () => {
    const server = stubSettingsServer({ members: members([DEV]) });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 새 대화" }));
    const dialog = await screen.findByRole("dialog", { name: "새 대화" });
    expect(dialog).toHaveTextContent("@dev 와의 대화 기록을 새로 시작합니다. 진행 중인 실행은 중지됩니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.writes()).toEqual([
      { method: "POST", url: `/api/v1/channels/${CH}/agents/${DEV}/reset`, body: undefined },
    ]);
  });

  it.each([
    [
      "409 권한 부족",
      apiErr(409, "CONFLICT", "ADAPTER_CAPABILITY_MISSING: sessions.reset"),
      "Gateway 권한(operator.admin)이 없어 새 대화를 시작할 수 없습니다",
    ],
    ["503", apiErr(503, "ADAPTER_UNAVAILABLE", "adapter down"), "Gateway 에 연결되지 않았습니다"],
  ])("%s → 대화상자 안 문구(토스트 없음)", async (_name, reply, text) => {
    stubSettingsServer({
      members: members([DEV]),
      override: ({ method, url }) => (method === "POST" && url.endsWith("/reset") ? reply : undefined),
    });
    renderRoute(`/c/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 새 대화" }));
    const dialog = await screen.findByRole("dialog", { name: "새 대화" });
    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(text);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("열린 채 채널이 바뀌면 닫는다 — 돌아와도 다시 열리지 않고 요청도 없다", async () => {
    const server = stubSettingsServer({
      members: members([DEV]),
      override: ({ method, url }) => {
        if (method !== "GET" || !url.startsWith(`/api/v1/channels/${CH2}`)) return undefined;
        return url.endsWith("/members")
          ? json(200, { members: [] })
          : json(200, { channel: channelOf(CH2, { name: "random" }) });
      },
    });
    const queryClient = createQueryClient(() => {});
    // 옮겨 간 채널이 이미 캐시에 있어 채널 화면·설정 패널이 내려가지 않는 경우
    queryClient.setQueryData<Channel>(qk.channel(CH2), channelOf(CH2, { name: "random" }));
    const { router } = renderRoute(`/c/${CH}/settings`, queryClient);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 새 대화" }));
    expect(await screen.findByRole("dialog", { name: "새 대화" })).toBeInTheDocument();

    const panel = screen.getByTestId("page-channel-settings");
    await router.navigate({ to: "/c/$channelId/settings", params: { channelId: CH2 } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 대화" })).not.toBeInTheDocument());
    expect(screen.getByTestId("page-channel-settings")).toBe(panel);

    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/settings`));
    await agentList();
    expect(screen.queryByRole("dialog", { name: "새 대화" })).not.toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });
});
