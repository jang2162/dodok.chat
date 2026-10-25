import type { Channel } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { CH2 } from "../../../test/fixtures";
import { channelOf, json, renderRoute } from "../../../test/shellApi";
import { stubMedia } from "../../../test/media";
import { CH, DEV, FIN, OWNER, gate, memberOf, stubSettingsServer } from "../../../test/settingsServer";
import { PROMPT_SAVED_NOTICE } from "./PromptSection";

const region = (name: string) => screen.findByRole("region", { name });
const channelUrl = `/api/v1/channels/${CH}`;
const apiErr = (status: number, code: string, message: string) => json(status, { code, message });

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("패널", () => {
  it("넓은 화면: 채널 화면 오른쪽에 섹션 넷, 「설정 닫기」 → /c/:id", async () => {
    stubSettingsServer();
    const { router } = renderRoute(`/c/${CH}/s/${CH}/settings`);
    const panel = await screen.findByTestId("page-channel-panel");
    expect(screen.getByTestId("page-channel")).toContainElement(panel);
    expect(within(panel).getByRole("heading", { name: "채널 설정" })).toBeInTheDocument();
    for (const name of ["기본", "채널 프롬프트", "릴레이 정책", "멤버"]) {
      expect(await within(panel).findByRole("region", { name })).toBeInTheDocument();
    }
    await userEvent.click(within(panel).getByRole("link", { name: "설정 닫기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument();
  });

  /**
   * 누른 「설정 닫기」 링크는 패널과 함께 언마운트돼 초점이 `<body>` 로 떨어졌다(p2-t14 걱정 6) — 좁은 화면 시트(D14)처럼
   * 헤더의 「채널 설정」 링크로 돌려준다. 마우스로 눌러도 키보드로 눌러도
   */
  it("넓은 화면: 「설정 닫기」를 누르면 초점이 헤더의 「채널 설정」 링크로 간다 — <body> 가 아니다", async () => {
    stubMedia(false);
    stubSettingsServer();
    const { router } = renderRoute(`/c/${CH}/s/${CH}/settings`);
    const header = await screen.findByTestId("channel-header");
    const opener = within(header).getByRole("link", { name: "채널 설정" });

    await userEvent.click(
      within(await screen.findByTestId("page-channel-panel")).getByRole("link", { name: "설정 닫기" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    await waitFor(() => expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument());
    expect(document.activeElement).not.toBe(document.body);
    expect(opener).toHaveFocus();

    // 다시 열어 키보드로 닫아도 같다
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/settings`));
    within(await screen.findByTestId("page-channel-panel"))
      .getByRole("link", { name: "설정 닫기" })
      .focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("폭이 바뀌어도(오른쪽 패널 ↔ 전체 화면 시트) 고치던 초안은 그대로다", async () => {
    const media = stubMedia(false);
    stubSettingsServer();
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const basic = await region("기본");
    await userEvent.type(within(basic).getByLabelText("이름"), "-고침");
    await userEvent.type(within(await region("채널 프롬프트")).getByLabelText("채널 프롬프트"), "짧게");

    media.setNarrow(true);
    const sheet = await screen.findByRole("dialog", { name: "채널 설정" });
    expect(within(sheet).getByLabelText("이름")).toHaveValue("general-고침");
    expect(within(sheet).getByRole("textbox", { name: "채널 프롬프트" })).toHaveValue("짧게");

    media.setNarrow(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const panel = screen.getByTestId("page-channel-panel");
    expect(within(panel).getByLabelText("이름")).toHaveValue("general-고침");
    expect(within(panel).getByRole("textbox", { name: "채널 프롬프트" })).toHaveValue("짧게");
  });

  it("좁은 화면: 전체 화면 시트, 닫기 → /c/:id", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    stubSettingsServer();
    const { router } = renderRoute(`/c/${CH}/s/${CH}/settings`);
    const sheet = await screen.findByRole("dialog", { name: "채널 설정" });
    expect(sheet).toHaveAttribute("data-testid", "page-channel-panel");
    expect(sheet).toHaveClass("w-full");
    expect(await within(sheet).findByRole("region", { name: "기본" })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(screen.queryByRole("dialog", { name: "채널 설정" })).not.toBeInTheDocument();
  });

  it("채널을 옮기면(패널이 남아 있어도) 고치던 초안은 따라가지 않는다 — 옮겨 간 채널 값", async () => {
    const server = stubSettingsServer({
      override: ({ method, url }) =>
        method === "GET" && url === `/api/v1/channels/${CH2}`
          ? json(200, { channel: channelOf(CH2, { name: "random" }) })
          : method === "GET" && url === `/api/v1/channels/${CH2}/members`
            ? json(200, { members: [] })
            : undefined,
    });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Channel>(qk.channel(CH2), channelOf(CH2, { name: "random" }));
    const { router } = renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const basic = await region("기본");
    await userEvent.type(within(basic).getByLabelText("이름"), "-초안");
    const panel = screen.getByTestId("page-channel-panel");

    await router.navigate({
      to: "/c/$channelId/s/$conversationId/settings",
      params: { channelId: CH2, conversationId: CH2 },
    });
    await waitFor(() =>
      expect(within(screen.getByTestId("page-channel-panel")).getByLabelText("이름")).toHaveValue("random"),
    );
    // 라우트 컴포넌트는 그대로다 — 안쪽만 새로 그렸다
    expect(screen.getByTestId("page-channel-panel")).toBe(panel);
    expect(within(await region("기본")).getByRole("button", { name: "저장" })).toBeDisabled();
    expect(server.writes()).toEqual([]);
  });

  it("목록의 자리값으로는 폼을 채우지 않는다 — 상세를 받은 뒤 그 값으로", async () => {
    const detail = gate();
    stubSettingsServer({
      channelList: () => [channelOf(CH, { name: "목록 이름" })],
      override: async ({ method, url }) => {
        if (method === "GET" && url === channelUrl) await detail.opened;
        return undefined;
      },
    });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Channel[]>(qk.channels, [channelOf(CH, { name: "목록 이름" })]);
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const panel = await screen.findByTestId("page-channel-panel");
    // 헤더는 자리값으로 곧바로 그리지만, 패널은 기다린다
    expect(await within(screen.getByTestId("channel-header")).findByText("목록 이름")).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent("불러오는 중…");
    expect(within(panel).queryByRole("region", { name: "기본" })).not.toBeInTheDocument();

    detail.open();
    const basic = await within(panel).findByRole("region", { name: "기본" });
    expect(within(basic).getByLabelText("이름")).toHaveValue("general");
  });
});

describe("기본", () => {
  it("이름·주제 저장 → PATCH, 주제를 비우면 null, 캐시(상세·목록)를 응답으로 — 다시 부르지 않는다", async () => {
    const server = stubSettingsServer({ channel: { topic: "옛 주제" } });
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const basic = await region("기본");
    const name = within(basic).getByLabelText("이름");
    const topic = within(basic).getByLabelText("주제");
    expect(name).toHaveValue("general");
    expect(name).toHaveAttribute("maxLength", "80");
    expect(topic).toHaveValue("옛 주제");
    expect(topic).toHaveAttribute("maxLength", "500");
    const save = within(basic).getByRole("button", { name: "저장" });
    expect(save).toBeDisabled();

    await userEvent.clear(name);
    expect(within(basic).getByText("이름은 비울 수 없습니다")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await userEvent.type(name, "  dev-talk ");
    await userEvent.clear(topic);
    const detailGets = server.count("GET", channelUrl);
    await userEvent.click(save);

    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "PATCH", url: channelUrl, body: { name: "dev-talk", topic: null } },
      ]),
    );
    expect(await within(basic).findByRole("status")).toHaveTextContent("저장했습니다");
    expect(within(basic).getByLabelText("이름")).toHaveValue("dev-talk");
    expect(save).toBeDisabled();
    const cached = queryClient.getQueryData<Channel>(qk.channel(CH));
    expect(cached?.name).toBe("dev-talk");
    expect(cached).not.toHaveProperty("topic");
    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.name)).toEqual(["dev-talk"]);
    expect(
      await within(screen.getByTestId("channel-header")).findByRole("heading", { name: /dev-talk/ }),
    ).toBeInTheDocument();
    expect(server.count("GET", channelUrl)).toBe(detailGets);
    expect(server.count("GET", "/api/v1/channels")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("VALIDATION·CONFLICT 는 섹션 안(토스트 없음), 그 밖(500)은 전역 토스트(섹션 안 없음)", async () => {
    let reply = apiErr(400, "VALIDATION", "body — name: 이상하다");
    stubSettingsServer({ override: ({ method }) => (method === "PATCH" ? reply : undefined) });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const basic = await region("기본");
    await userEvent.type(within(basic).getByLabelText("이름"), "!");
    await userEvent.click(within(basic).getByRole("button", { name: "저장" }));
    expect(await within(basic).findByRole("alert")).toHaveTextContent("body — name: 이상하다");
    // 서버 문구가 가리킨 칸에 표시가 붙는다
    expect(within(basic).getByLabelText("이름")).toHaveAttribute("aria-invalid", "true");
    expect(within(basic).getByLabelText("주제")).not.toHaveAttribute("aria-invalid");
    expect(toastError).not.toHaveBeenCalled();

    reply = apiErr(500, "INTERNAL", "서버가 넘어졌다");
    await userEvent.click(within(basic).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("서버가 넘어졌다"));
    expect(within(basic).queryByRole("alert")).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

describe("채널 프롬프트", () => {
  it("남은 글자 수, 저장 → PATCH { prompt } 와 반영 안내, 비우면 null", async () => {
    const server = stubSettingsServer();
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("채널 프롬프트");
    const box = within(section).getByRole("textbox", { name: "채널 프롬프트" });
    expect(box).toHaveAttribute("maxLength", "20000");
    expect(within(section).getByText("20,000자 남음")).toBeInTheDocument();
    expect(within(section).queryByText(PROMPT_SAVED_NOTICE)).not.toBeInTheDocument();

    await userEvent.type(box, "간결하게");
    expect(within(section).getByText("19,996자 남음")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(await within(section).findByRole("status")).toHaveTextContent(
      "다음 턴부터 반영됩니다. Claude 러너 에이전트는 다음 런에서 앞 맥락을 비웁니다. OpenClaw 에이전트는 이미 대화한 세션에 온전히 반영되지 않고 새 세션부터 반영됩니다",
    );
    expect(box).toHaveValue("간결하게");

    // 다시 고치면 안내를 내린다
    await userEvent.clear(box);
    expect(within(section).queryByRole("status")).not.toBeInTheDocument();
    await userEvent.type(box, "   ");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.writes().map((c) => c.body)).toEqual([{ prompt: "간결하게" }, { prompt: null }]),
    );
    expect(await within(section).findByRole("status")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });
});

describe("릴레이 정책", () => {
  const withAgents = () => [memberOf("user", OWNER), memberOf("agent", DEV), memberOf("agent", FIN)];

  it("검증 오류는 섹션 안 + 그 칸에 표시(aria-invalid·설명) — 요청하지 않는다", async () => {
    const server = stubSettingsServer();
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("릴레이 정책");
    const turns = within(section).getByLabelText("턴 상한");
    const daily = within(section).getByLabelText("일일 실행 상한");
    await userEvent.clear(turns);
    await userEvent.type(turns, "33");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(within(section).getByRole("alert")).toHaveTextContent("턴 상한은 0~32");
    expect(turns).toHaveAttribute("aria-invalid", "true");
    expect(turns).toHaveAccessibleDescription(/턴 상한은 0~32/);
    expect(daily).not.toHaveAttribute("aria-invalid");

    await userEvent.clear(turns);
    await userEvent.type(turns, "3");
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
    expect(turns).not.toHaveAttribute("aria-invalid");
    await userEvent.type(daily, "0");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(within(section).getByRole("alert")).toHaveTextContent("일일 상한");
    expect(daily).toHaveAttribute("aria-invalid", "true");
    expect(daily).toHaveAccessibleDescription(/일일 상한/);
    expect(turns).not.toHaveAttribute("aria-invalid");
    expect(server.writes()).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("숫자 칸은 붙여넣기를 자르지 않는다 — 넘치면 검증 문구로 알린다", async () => {
    const server = stubSettingsServer();
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("릴레이 정책");
    const turns = within(section).getByLabelText("턴 상한");
    await userEvent.clear(turns);
    await userEvent.paste("100");
    expect(turns).toHaveValue("100"); // 「10」으로 잘려 조용히 유효값이 되지 않는다
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(within(section).getByRole("alert")).toHaveTextContent("턴 상한은 0~32");

    const daily = within(section).getByLabelText("일일 실행 상한");
    await userEvent.clear(turns);
    await userEvent.type(turns, "4");
    daily.focus();
    await userEvent.paste("12345678901");
    expect(daily).toHaveValue("12345678901");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(within(section).getByRole("alert")).toHaveTextContent("일일 상한은 1~999,999,999");
    expect(server.writes()).toEqual([]);
  });

  it("「모든 에이전트끼리 허용」을 끄면 from→to 체크 목록(자기 자신 없음) — 고른 쌍·상한으로 PATCH", async () => {
    const server = stubSettingsServer({ members: withAgents() });
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/${CH}/s/${CH}/settings`, queryClient);
    const section = await region("릴레이 정책");
    const all = within(section).getByRole("switch", { name: "모든 에이전트끼리 허용" });
    expect(all).toBeChecked();
    expect(within(section).queryByRole("checkbox")).not.toBeInTheDocument();

    await userEvent.click(all);
    // 멤버를 받은 뒤 쌍이 뜬다
    await within(section).findByRole("checkbox", { name: "@dev → @fin" });
    expect(within(section).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(section).getByRole("checkbox", { name: "@fin → @dev" })).not.toBeChecked();
    await userEvent.click(within(section).getByRole("checkbox", { name: "@dev → @fin" }));
    const turns = within(section).getByLabelText("턴 상한");
    await userEvent.clear(turns);
    await userEvent.type(turns, "2");
    await userEvent.type(within(section).getByLabelText("일일 실행 상한"), "10");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(server.writes()).toEqual([
        {
          method: "PATCH",
          url: channelUrl,
          body: {
            relayPolicy: { maxRelayTurns: 2, allowPairs: [{ from: DEV, to: FIN }], dailyRunLimit: 10 },
          },
        },
      ]),
    );
    expect(await within(section).findByRole("status")).toHaveTextContent(
      "저장했습니다. Claude 러너 에이전트는 다음 런에서 앞 맥락을 비웁니다",
    );
    expect(queryClient.getQueryData<Channel>(qk.channel(CH))?.relayPolicy).toEqual({
      maxRelayTurns: 2,
      allowPairs: [{ from: DEV, to: FIN }],
      dailyRunLimit: 10,
    });
    // 저장 뒤 폼은 캐시 값 그대로
    expect(within(section).getByRole("switch", { name: "모든 에이전트끼리 허용" })).not.toBeChecked();
    expect(within(section).getByRole("checkbox", { name: "@dev → @fin" })).toBeChecked();
  });

  it("일일 상한을 비우면 없앤다(보내지 않음), 서버 VALIDATION 은 섹션 안", async () => {
    let reply: Response | undefined;
    const server = stubSettingsServer({
      channel: { relayPolicy: { maxRelayTurns: 4, allowPairs: "all", dailyRunLimit: 5 } },
      override: ({ method }) => (method === "PATCH" ? reply : undefined),
    });
    renderRoute(`/c/${CH}/s/${CH}/settings`);
    const section = await region("릴레이 정책");
    const daily = within(section).getByLabelText("일일 실행 상한");
    expect(daily).toHaveValue("5");
    await userEvent.clear(daily);
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.writes().map((c) => c.body)).toEqual([
        { relayPolicy: { maxRelayTurns: 4, allowPairs: "all" } },
      ]),
    );

    reply = apiErr(400, "VALIDATION", "relayPolicy: invalid");
    await userEvent.type(daily, "7");
    await userEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent("relayPolicy: invalid");
    expect(toastError).not.toHaveBeenCalled();
  });
});
