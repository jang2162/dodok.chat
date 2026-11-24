import type { Person } from "@dodok/shared";
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
  OWNER,
  type Call,
  agentList,
  agentOf,
  apiErr,
  gate,
  memberOf,
  memberUrl,
  members,
  membersSection,
  membersUrl,
  stubSettingsServer,
} from "../../../test/settingsServer";
import { uid } from "../../../test/fixtures";
import { json, renderRoute } from "../../../test/shellApi";

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MIA = uid(40);
const JO = uid(41);
const GONE = uid(42);
const LEFT = uid(43);
const personOf = (id: string, handle: string, over: Partial<Person> = {}): Person => ({
  id,
  handle,
  displayName: `${handle} 님`,
  role: "member",
  deactivatedAt: null,
  statusMessage: null,
  ...over,
});
const PEOPLE: Person[] = [
  personOf(OWNER, "owner", { displayName: "주인", role: "owner" }),
  personOf(MIA, "mia", { displayName: "미아" }),
  personOf(JO, "jo", { displayName: "조" }),
  personOf(GONE, "gone", { deactivatedAt: "2026-11-01T00:00:00.000Z" }),
  personOf(LEFT, "left", { role: undefined }),
];

/**
 * 공용 가짜 서버(settingsServer)의 POST 는 에이전트 멤버만 만든다 — 사람 POST 와 `/people` 은 여기서 흉내 낸다.
 * `fail` 이 준 응답이면 그것을 돌려준다(그 id 의 POST 만)
 */
function stubWithPeople(
  opts: Parameters<typeof stubSettingsServer>[0] & { fail?: (call: Call) => Response | undefined } = {},
) {
  const server = stubSettingsServer({
    ...opts,
    override: (call) => {
      if (call.method === "GET" && call.url === "/api/v1/people") return json(200, { people: PEOPLE });
      const failed = call.method === "POST" ? opts.fail?.(call) : undefined;
      if (failed) return failed;
      if (call.method === "POST" && call.url === membersUrl && call.body?.memberType === "user") {
        const member = memberOf("user", String(call.body.memberId));
        server.state.members = [...server.state.members, member];
        return json(201, { member });
      }
      return opts.override?.(call);
    },
  });
  return server;
}

async function openInvite() {
  const section = await membersSection();
  const button = within(section).getByRole("button", { name: "초대" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  return { section, button, dialog: await screen.findByRole("dialog", { name: "채널에 초대" }) };
}
/** 후보 목록의 줄 단추들의 핸들(보이는 순서) */
const candidateHandles = (dialog: HTMLElement) =>
  within(within(dialog).getByRole("list", { name: "초대 후보" }))
    .getAllByRole("button")
    .map((b) => [...b.querySelectorAll("span")].find((el) => el.textContent?.startsWith("@"))?.textContent);
const candidate = (dialog: HTMLElement, handle: string) =>
  within(dialog).getByRole("button", { name: new RegExp(`@${handle}(?![\\w-])`) });
const peopleList = async () => within(await membersSection()).findByRole("list", { name: "채널 사람" });

describe("초대 대화상자", () => {
  it("사람과 에이전트를 한 목록에 — 이미 멤버·보관 에이전트·비활성·membership 없는 사람은 없다, 종류·꺼짐 표시", async () => {
    stubWithPeople({
      agents: [
        agentOf(DEV, "dev"),
        agentOf(FIN, "fin", { enabled: false }),
        agentOf(uid(33), "ops", { archivedAt: "2026-10-05T00:00:00.000Z" }),
      ],
      members: members([DEV]),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toEqual(["@mia", "@jo", "@fin"]));
    expect(candidate(dialog, "mia")).toHaveTextContent("사람");
    expect(candidate(dialog, "fin")).toHaveTextContent("에이전트");
    expect(candidate(dialog, "fin")).toHaveTextContent("꺼짐");
    expect(candidate(dialog, "mia")).not.toHaveTextContent("꺼짐");
  });

  it("검색칸 하나가 핸들·이름(대소문자 무시, 앞 @ 무시)으로 둘 다 거른다", async () => {
    stubWithPeople({ members: members() });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toEqual(["@mia", "@jo", "@dev", "@fin"]));
    const search = within(dialog).getByRole("textbox", { name: "사람·에이전트 찾기" });
    await userEvent.type(search, "@F");
    expect(candidateHandles(dialog)).toEqual(["@fin"]);
    await userEvent.clear(search);
    await userEvent.type(search, "미아");
    expect(candidateHandles(dialog)).toEqual(["@mia"]);
    await userEvent.clear(search);
    await userEvent.type(search, "봇");
    expect(candidateHandles(dialog)).toEqual(["@dev", "@fin"]);
    await userEvent.type(search, "zz");
    expect(within(dialog).getByText("찾는 사람이나 에이전트가 없습니다.")).toBeInTheDocument();
  });

  it("나 자신은 아직 참여하지 않았을 때만 후보에 있다", async () => {
    stubWithPeople({ members: [memberOf("agent", DEV)] });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toEqual(["@owner", "@mia", "@jo", "@fin"]));
  });

  it("여럿 골라 「초대」 → 고른 차례로 POST 하나씩, 전부 성공하면 닫히고 초점은 「초대」, 두 묶음에 보인다", async () => {
    const server = stubWithPeople({ members: members() });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog, button } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toHaveLength(4));
    await userEvent.click(candidate(dialog, "fin"));
    await userEvent.click(candidate(dialog, "mia"));
    expect(candidate(dialog, "fin")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "초대 (2)" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.writes()).toEqual([
      { method: "POST", url: membersUrl, body: { memberType: "agent", memberId: FIN } },
      { method: "POST", url: membersUrl, body: { memberType: "user", memberId: MIA } },
    ]);
    await waitFor(() => expect(button).toHaveFocus());
    expect(within(await agentList()).getByText("@fin")).toBeInTheDocument();
    expect(within(await peopleList()).getByText("@mia")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("일부가 실패(409 AGENT_ARCHIVED)하면 성공한 것은 들어가고, 실패한 줄만 까닭과 함께 골라 둔 채 남는다 — 닫히지 않는다", async () => {
    const server = stubWithPeople({
      members: members(),
      fail: ({ body }) =>
        body?.memberId === DEV ? apiErr(409, "AGENT_ARCHIVED", "삭제된 에이전트입니다") : undefined,
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toHaveLength(4));
    await userEvent.click(candidate(dialog, "dev"));
    await userEvent.click(candidate(dialog, "fin"));
    await userEvent.click(candidate(dialog, "jo"));
    await userEvent.click(within(dialog).getByRole("button", { name: "초대 (3)" }));

    await waitFor(() => expect(server.writes()).toHaveLength(3));
    const devRow = candidate(dialog, "dev");
    await waitFor(() => expect(devRow).toHaveAccessibleDescription("삭제된 에이전트입니다"));
    expect(devRow).toHaveAttribute("aria-invalid", "true");
    expect(devRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog", { name: "채널에 초대" })).toBe(dialog);
    expect(candidateHandles(dialog)).toEqual(["@mia", "@dev"]);
    expect(within(dialog).getByRole("button", { name: "초대 (1)" })).toBeInTheDocument();
    // 대화상자가 열려 있어 뒤 화면은 aria-hidden — hidden 으로 찾는다
    expect(
      within(screen.getByRole("list", { name: "채널 에이전트", hidden: true })).getByText("@fin"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "채널 사람", hidden: true })).getByText("@jo"),
    ).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("폼 밖 오류(500)는 전역 토스트와 그 줄의 짧은 문구", async () => {
    stubWithPeople({
      members: members(),
      fail: () => apiErr(500, "INTERNAL", "넣지 못했다"),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toHaveLength(4));
    await userEvent.click(candidate(dialog, "mia"));
    await userEvent.click(within(dialog).getByRole("button", { name: "초대 (1)" }));
    await waitFor(() => expect(candidate(dialog, "mia")).toHaveAccessibleDescription("초대하지 못했습니다"));
    expect(toastError).toHaveBeenCalledWith("넣지 못했다");
  });

  it("아무것도 고르지 않으면 「초대」는 보내지 않는다", async () => {
    const server = stubWithPeople({ members: members() });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toHaveLength(4));
    const submit = within(dialog).getByRole("button", { name: "초대" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(submit);
    expect(server.writes()).toEqual([]);
  });

  it("등록된 에이전트가 없으면 대화상자에서 설정 → 연결로 안내", async () => {
    stubWithPeople({ agents: [] });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    expect(await within(dialog).findByRole("link", { name: "설정 → 연결에서 데려오세요" })).toHaveAttribute(
      "href",
      "/settings/connection",
    );
  });

  it("에이전트가 모두 채널에 있으면 그 안내와(admin 이상) 「에이전트 등록」 링크 — 사람은 여전히 고른다", async () => {
    stubWithPeople({ members: members([DEV], [FIN]) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    expect(await within(dialog).findByText(/등록된 에이전트가 모두 채널에 있습니다/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "에이전트 등록" })).toHaveAttribute(
      "href",
      "/settings/connection",
    );
    await waitFor(() => expect(candidateHandles(dialog)).toEqual(["@mia", "@jo"]));
  });

  it("OpenClaw 에이전트는 후보·멤버 행에 Gateway 이름 — 두 Gateway 의 같은 id 를 가른다", async () => {
    const office = { id: uid(30), name: "사무실" };
    const home = { id: uid(31), name: "집" };
    stubWithPeople({
      agents: [
        agentOf(DEV, "dev", { gateway: office }),
        agentOf(FIN, "dev-home", { providerAgentId: "dev", gateway: home }),
      ],
      members: members([DEV]),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    expect(
      await within(list).findByText((_, el) => el?.tagName === "SPAN" && el.textContent === "@dev · 사무실"),
    ).toBeInTheDocument();
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toContain("@dev-home · 집"));
  });
});

describe("멤버 칸 — 사람·에이전트 두 묶음", () => {
  it("사람 행은 아바타·이름·@핸들과 「빼기」 → 확인 뒤 DELETE …/members/<user id> → 빠지고 초점은 「초대」", async () => {
    const server = stubWithPeople({ members: [...members([DEV]), memberOf("user", MIA)] });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await membersSection();
    const people = await peopleList();
    expect(within(people).getByText("미아")).toBeInTheDocument();
    expect(within(people).getByText("@mia")).toBeInTheDocument();
    expect(within(people).getByText("주인")).toBeInTheDocument();
    expect(within(await agentList()).getByText("@dev")).toBeInTheDocument();

    await userEvent.click(within(people).getByRole("button", { name: "@mia 빼기" }));
    const dialog = await screen.findByRole("dialog", { name: "사람 빼기" });
    expect(dialog).toHaveTextContent("@mia 를 이 채널에서 뺍니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "빼기" }));
    await waitFor(() => expect(within(people).queryByText("@mia")).not.toBeInTheDocument());
    expect(server.writes()).toEqual([{ method: "DELETE", url: memberUrl(MIA), body: undefined }]);
    expect(within(people).getByText("주인")).toBeInTheDocument();
    await waitFor(() => expect(within(section).getByRole("button", { name: "초대" })).toHaveFocus());
  });

  it("사람 목록에 없는 멤버는 「알 수 없는 사람」", async () => {
    stubWithPeople({ members: [memberOf("user", uid(44))] });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    expect(await within(await peopleList()).findByText("알 수 없는 사람")).toBeInTheDocument();
  });
});

describe("추가·제거", () => {
  it("추가 CONFLICT 는 그 줄에 이어 붙는다(aria-invalid·설명, 토스트 없음)", async () => {
    stubWithPeople({
      fail: () => apiErr(409, "CONFLICT", "이미 채널 멤버다"),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toContain("@dev"));
    await userEvent.click(candidate(dialog, "dev"));
    await userEvent.click(within(dialog).getByRole("button", { name: "초대 (1)" }));
    await waitFor(() => expect(candidate(dialog, "dev")).toHaveAccessibleDescription("이미 채널 멤버다"));
    expect(candidate(dialog, "dev")).toHaveAttribute("aria-invalid", "true");
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

  it("제거 뒤 초점은 「초대」로, 취소 뒤에는 누른 「제거」 버튼으로 돌아간다", async () => {
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
    await waitFor(() => expect(within(section).getByRole("button", { name: "초대" })).toHaveFocus());
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
    expect(await within(section).findByText("아직 에이전트가 없습니다.")).toBeInTheDocument();
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

  it("삭제(보관)한 에이전트는 초대 후보에도 멤버 행에도 없다 — 멤버 응답이 낡아 아직 싣고 있어도", async () => {
    const archivedAt = "2026-10-05T00:00:00.000Z";
    const third = uid(32);
    stubWithPeople({
      agents: [
        agentOf(DEV, "dev", { archivedAt }),
        agentOf(FIN, "fin"),
        agentOf(third, "ops", { archivedAt }),
      ],
      members: members([DEV], [FIN]),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const list = await agentList();
    expect(await within(list).findByText("@fin")).toBeInTheDocument();
    expect(within(list).queryByText("@dev")).toBeNull();
    const { dialog } = await openInvite();
    await waitFor(() => expect(candidateHandles(dialog)).toEqual(["@mia", "@jo"]));
    expect(within(dialog).getByText(/등록된 에이전트가 모두 채널에 있습니다/)).toBeInTheDocument();
  });
});
