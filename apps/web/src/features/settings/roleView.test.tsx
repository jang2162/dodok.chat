import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ME, renderRoute } from "../../../test/shellApi";
import {
  CH,
  DEV,
  FIN,
  agentList,
  apiErr,
  members,
  membersSection,
  membersUrl,
  memberOf,
  stubSettingsServer,
} from "../../../test/settingsServer";

// member 가 보는 채널 설정(팀 스펙 2·6장) — 관리 항목은 값을 보이되 잠그고, 이름·주제·에이전트 넣기·빼기는 열려 있다
const MEMBER = { ...ME, role: "member" };
const LOCKED = "관리자만 바꿀 수 있습니다";
const region = (name: string) => screen.findByRole("region", { name });

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("member 의 채널 설정", () => {
  it("채널 프롬프트: 값은 보이고 잠겼다 — 저장 없이 「관리자만」", async () => {
    stubSettingsServer({ me: MEMBER, channel: { prompt: "짧게 답해" } });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("채널 프롬프트");
    const box = within(section).getByRole("textbox", { name: "채널 프롬프트" });
    expect(box).toHaveValue("짧게 답해");
    expect(box).toBeDisabled();
    expect(within(section).queryByRole("button", { name: "저장" })).toBeNull();
    expect(within(section).getByText(LOCKED)).toBeInTheDocument();
  });

  it("릴레이 정책(일일 한도 포함): 값은 보이고 잠겼다", async () => {
    stubSettingsServer({
      me: MEMBER,
      channel: { relayPolicy: { maxRelayTurns: 3, allowPairs: "all", dailyRunLimit: 20 } },
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("릴레이 정책");
    expect(within(section).getByRole("textbox", { name: "턴 상한" })).toHaveValue("3");
    expect(within(section).getByRole("textbox", { name: "턴 상한" })).toBeDisabled();
    expect(within(section).getByRole("textbox", { name: "일일 실행 상한" })).toBeDisabled();
    expect(within(section).getByRole("switch", { name: "모든 에이전트끼리 허용" })).toBeDisabled();
    expect(within(section).queryByRole("button", { name: "저장" })).toBeNull();
    expect(within(section).getByText(LOCKED)).toBeInTheDocument();
  });

  it("기본(이름·주제)은 열려 있다 — 저장하면 PATCH { name, topic }", async () => {
    const server = stubSettingsServer({ me: MEMBER });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("기본");
    const name = within(section).getByRole("textbox", { name: "이름" });
    expect(name).toBeEnabled();
    await userEvent.clear(name);
    await userEvent.type(name, "잡담");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).toEqual({ name: "잡담", topic: null });
  });

  it("에이전트 줄: 넣기·빼기는 열려 있고, 자동 응답·오버라이드는 값만", async () => {
    const server = stubSettingsServer({
      me: MEMBER,
      members: [memberOf("agent", DEV, { autoRespond: true, promptOverride: "dev 에게만" })],
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const list = await agentList();
    expect(within(list).getByRole("switch", { name: "@dev 자동 응답" })).toBeChecked();
    expect(within(list).getByRole("switch", { name: "@dev 자동 응답" })).toBeDisabled();
    expect(within(list).getByText("dev 에게만")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "@dev 채널 프롬프트 편집" })).toBeNull();
    expect(within(list).getByText(LOCKED)).toBeInTheDocument();

    const select = within(section).getByRole("combobox", { name: "에이전트 추가" });
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, FIN);
    await userEvent.click(within(section).getByRole("button", { name: "추가" }));
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "POST", url: membersUrl, body: { memberType: "agent", memberId: FIN } },
      ]),
    );
    expect(within(list).getByRole("button", { name: "@dev 제거" })).toBeEnabled();
  });

  it("에이전트가 모두 채널에 있으면 안내 문구만 — 「에이전트 등록」 링크는 admin 이상에게만(o4)", async () => {
    stubSettingsServer({ me: MEMBER, members: members([DEV], [FIN]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    expect(await within(section).findByText(/등록된 에이전트가 모두 채널에 있습니다/)).toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: "에이전트 등록" })).toBeNull();
  });

  it("등록된 에이전트가 없으면 안내 문구만 — 「에이전트 화면에서 등록하세요」 링크는 admin 이상에게만", async () => {
    stubSettingsServer({ me: MEMBER, agents: [] });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    expect(await within(section).findByText(/등록된 에이전트가 없습니다/)).toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: "에이전트 화면에서 등록하세요" })).toBeNull();
  });

  it("owner·admin 에게는 잠김이 없다", async () => {
    stubSettingsServer({ me: { ...ME, role: "admin" }, members: members([DEV]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("채널 프롬프트");
    expect(within(section).getByRole("textbox", { name: "채널 프롬프트" })).toBeEnabled();
    expect(within(section).getByRole("button", { name: "저장" })).toBeInTheDocument();
    expect(screen.queryByText(LOCKED)).toBeNull();
    const list = await agentList();
    expect(await within(list).findByRole("button", { name: "@dev 채널 프롬프트 편집" })).toBeInTheDocument();
    // 「새 대화」는 걷었다 — admin 에게도 없다
    expect(within(list).queryByRole("button", { name: /새 대화/ })).toBeNull();
  });
});

describe("역할이 내려간 직후(Review Focus 5)", () => {
  it("남은 저장 버튼을 누르면 403 → 「권한이 없습니다」 한 줄, me 를 다시 받아 섹션이 잠긴다", async () => {
    let role = "admin";
    const server = stubSettingsServer({
      me: { ...ME, role: "admin" },
      channel: { prompt: "원래 지시" },
      override: ({ method, url }) => {
        if (url === "/api/v1/auth/me") return new Response(JSON.stringify({ ...ME, role }), { status: 200 });
        if (method === "PATCH" && url === `/api/v1/channels/${CH}`)
          return apiErr(403, "FORBIDDEN", "channel field prompt requires admin");
        return undefined;
      },
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("채널 프롬프트");
    const box = within(section).getByRole("textbox", { name: "채널 프롬프트" });
    await userEvent.clear(box);
    await userEvent.type(box, "새 지시");
    role = "member"; // 그 사이 owner 가 역할을 내렸다
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" }));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(await within(section).findByText(LOCKED)).toBeInTheDocument();
    expect(within(section).getByRole("textbox", { name: "채널 프롬프트" })).toBeDisabled();
    // 잠긴 칸은 저장되지 않은 초안이 아니라 서버 값을 보인다
    expect(within(section).getByRole("textbox", { name: "채널 프롬프트" })).toHaveValue("원래 지시");
    expect(server.writes()).toHaveLength(1);
  });

  it("릴레이 정책도 잠기면 초안 대신 서버 값을 보인다", async () => {
    let role = "admin";
    const server = stubSettingsServer({
      me: { ...ME, role: "admin" },
      channel: { relayPolicy: { maxRelayTurns: 3, allowPairs: "all", dailyRunLimit: 20 } },
      override: ({ method, url }) => {
        if (url === "/api/v1/auth/me") return new Response(JSON.stringify({ ...ME, role }), { status: 200 });
        if (method === "PATCH" && url === `/api/v1/channels/${CH}`)
          return apiErr(403, "FORBIDDEN", "channel field relayPolicy requires admin");
        return undefined;
      },
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("릴레이 정책");
    const turns = within(section).getByRole("textbox", { name: "턴 상한" });
    await userEvent.clear(turns);
    await userEvent.type(turns, "7");
    role = "member";
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(await within(section).findByText(LOCKED)).toBeInTheDocument();
    expect(within(section).getByRole("textbox", { name: "턴 상한" })).toBeDisabled();
    expect(within(section).getByRole("textbox", { name: "턴 상한" })).toHaveValue("3");
    expect(server.writes()).toHaveLength(1);
  });
});
