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
  agentList,
  agentOf,
  apiErr,
  gate,
  memberOf,
  memberUrl,
  members,
  stubSettingsServer,
} from "../../../test/settingsServer";
import { channelOf, json, renderRoute } from "../../../test/shellApi";

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("자동 응답", () => {
  it("확인 문구의 조사는 핸들 받침을 따른다 — 받침 있는 @fin(핀) 은 「을」", async () => {
    stubSettingsServer({ members: members([DEV, true], [FIN]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("switch", { name: "@fin 자동 응답" }));
    const dialog = await screen.findByRole("dialog", { name: "자동 응답 바꾸기" });
    expect(dialog).toHaveTextContent("@dev 의 자동 응답을 끄고 @fin 을 켭니다");
  });

  it("켜진 것이 없으면 확인 없이 그것만 켠다, 끄기도 그것만", async () => {
    const server = stubSettingsServer({ members: members([DEV], [FIN]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
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
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    const dev = within(list).getByRole("switch", { name: "@dev 자동 응답" });
    const fin = within(list).getByRole("switch", { name: "@fin 자동 응답" });

    await userEvent.click(dev);
    let dialog = await screen.findByRole("dialog", { name: "자동 응답 바꾸기" });
    // 조사는 핸들의 받침을 따른다 — @dev(데브) 는 「를」, @fin(핀) 은 「을」
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
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
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
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
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
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    expect(within(list).getByText("채널 프롬프트 오버라이드 없음")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    const box = within(list).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" });
    expect(box).toHaveAttribute("maxLength", "20000");
    await userEvent.type(box, "숫자는 표로");
    await userEvent.click(within(list).getByRole("button", { name: "저장" }));
    expect(await within(list).findByText("숫자는 표로")).toBeInTheDocument();
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
    // 채널 지시가 바뀌면 러너 세션이 새로 시작한다(ADR 0007) — 저장 안내가 그 대가를 알린다
    expect(within(list).getByRole("status")).toHaveTextContent(
      "다음 턴부터 반영됩니다. 러너 에이전트는 다음 런부터 앞 작업 맥락(도구 결과·긴 작업)을 이어 가지 않습니다 — 채널의 최근 글은 그대로 봅니다",
    );

    // 다시 펼치면 안내를 내린다 — 취소로 접어도 다시 뜨지 않는다
    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    await userEvent.click(within(list).getByRole("button", { name: "취소" }));
    expect(within(list).queryByRole("status")).not.toBeInTheDocument();

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
    renderRoute(`/c/${CH}/s/${CH}/settings`);
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
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    await userEvent.click(within(list).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: "@dev 채널 프롬프트 편집" })).toHaveFocus(),
    );
  });
});

describe("에이전트 제거 확인", () => {
  it("열린 채 채널이 바뀌면 닫는다 — 돌아와도 다시 열리지 않고 요청도 없다", async () => {
    const server = stubSettingsServer({
      members: members([DEV]),
      // 채널·멤버만 — 세션 목록(`/conversations?…`)은 셸 기본이 답한다
      override: ({ method, url }) => {
        if (method !== "GET") return undefined;
        if (url === `/api/v1/channels/${CH2}/members`) return json(200, { members: [] });
        if (url === `/api/v1/channels/${CH2}`)
          return json(200, { channel: channelOf(CH2, { name: "random" }) });
        return undefined;
      },
    });
    const queryClient = createQueryClient(() => {});
    // 옮겨 간 채널이 이미 캐시에 있어 채널 화면·설정 패널이 내려가지 않는 경우
    queryClient.setQueryData<Channel>(qk.channel(CH2), channelOf(CH2, { name: "random" }));
    const { router } = renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const list = await agentList();
    await userEvent.click(within(list).getByRole("button", { name: "@dev 제거" }));
    expect(await screen.findByRole("dialog", { name: "에이전트 제거" })).toBeInTheDocument();

    const panel = screen.getByTestId("page-channel-panel");
    await router.navigate({
      to: "/c/$channelId/s/$conversationId/settings",
      params: { channelId: CH2, conversationId: CH2 },
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "에이전트 제거" })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("page-channel-panel")).toBe(panel);

    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/settings`));
    await agentList();
    expect(screen.queryByRole("dialog", { name: "에이전트 제거" })).not.toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });
});
