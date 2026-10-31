import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { shouldPersist } from "@/pwa/persist";
import {
  GENERAL,
  OPS_CHANNEL,
  REISSUED_TOKEN,
  REISSUED_URL,
  WEBHOOK_TOKEN,
  WEBHOOK_URL,
  automationOf,
  stubAutomationsServer,
} from "../../../test/automationsServer";
import { uid } from "../../../test/fixtures";
import { ME, channelOf, json, renderRoute } from "../../../test/shellApi";

// 자동화 설정 화면(자동화 스펙 「웹」 장): 목록·경고 줄·「지금 실행」·켜기/끄기·삭제, 만들기·수정 대화상자, 웹훅 주소 한 번 보이기
const ADMIN = { ...ME, role: "admin" };
const MEMBER = { ...ME, role: "member" };
const PATH = "/settings/automations";

let toastSuccess: MockInstance<typeof toast.success>;
let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastSuccess = vi.spyOn(toast, "success");
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rowOf = async (name: string) => within(await screen.findByRole("listitem", { name }));
const user = () => userEvent.setup({ delay: null });

async function openCreate() {
  await user().click(await screen.findByRole("button", { name: "만들기" }));
  return screen.findByRole("dialog", { name: "자동화 만들기" });
}

/**
 * 웹훅 원문(`secret` — 앞 6자 뒤)이 대화상자 밖에 남은 자리 — 쿼리·뮤테이션 캐시, 저장소, 주소, 콘솔, 토스트. 화면에 `Toaster` 가
 * 없어 토스트는 `document.body` 로 못 보므로 스파이의 호출 인자를 본다. 콘솔 스파이는 렌더 전에 걸어야 해서 먼저 부르고, 돌려받은
 * 함수에 렌더 결과를 넘긴다
 */
function watchLeaks(secret: string) {
  const consoles = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
  const text = (a: unknown) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a) ?? "";
    } catch {
      return String(a);
    }
  };
  return ({ router, queryClient }: Pick<ReturnType<typeof renderRoute>, "router" | "queryClient">) => {
    const caches = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.state]),
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ]);
    const stored = [localStorage, sessionStorage].flatMap((s) =>
      Array.from({ length: s.length }, (_, i) => {
        const key = s.key(i) ?? "";
        return `${key}=${s.getItem(key) ?? ""}`;
      }),
    );
    const logged = [...consoles, toastSuccess, toastError].flatMap((spy) => spy.mock.calls.flat().map(text));
    return [caches, ...stored, router.state.location.href, window.location.href, ...logged].filter((s) =>
      s.includes(secret),
    );
  };
}

describe("권한·탭", () => {
  it("admin 은 설정 탭에 「자동화」가 있고 누르면 /settings/automations", async () => {
    stubAutomationsServer({ me: ADMIN });
    const { router } = renderRoute("/settings/agents");
    await user().click(await screen.findByRole("link", { name: "자동화" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(PATH));
    expect(await screen.findByRole("heading", { level: 1, name: "자동화" })).toBeInTheDocument();
  });

  it("member 는 탭에 없고, 직접 주소로 와도 권한 안내 — 자동화 API 를 부르지 않는다", async () => {
    const server = stubAutomationsServer({ me: MEMBER });
    renderRoute(PATH);
    const page = await screen.findByTestId("page-automations");
    expect(await within(page).findByText(/권한이 없습니다/)).toBeInTheDocument();
    await screen.findByRole("link", { name: "에이전트" });
    expect(screen.queryByRole("link", { name: "자동화" })).toBeNull();
    expect(within(page).queryByRole("button", { name: "만들기" })).toBeNull();
    expect(server.automationCalls()).toEqual([]);
  });

  it("자동화 목록은 오프라인 사본에 담지 않는다", () => {
    expect(shouldPersist({ queryKey: qk.automations }, [])).toBe(false);
  });
});

describe("목록", () => {
  it("이름·채널·종류·반복·다음 실행(워크스페이스 시간대)·웹훅 주소 앞부분·마지막 결과", async () => {
    stubAutomationsServer({
      timeZone: "America/New_York",
      automations: [
        automationOf(1, {
          name: "아침 점검",
          schedule: { repeat: "weekly", weekday: 1, time: "09:00" },
          nextRunAt: "2026-10-12T13:00:00.000Z",
          lastRunAt: "2026-10-05T13:00:00.000Z",
          lastStatus: "ok",
        }),
        automationOf(2, {
          name: "배포 알림",
          kind: "webhook",
          channelId: OPS_CHANNEL.id,
          schedule: undefined,
          nextRunAt: undefined,
          tokenPrefix: "abc123",
        }),
        automationOf(3, {
          name: "매시 확인",
          schedule: { repeat: "hourly", minute: 15 },
          enabled: false,
          nextRunAt: undefined,
          lastRunAt: "2026-10-05T14:20:00.000Z",
          lastStatus: "skipped",
        }),
      ],
    });
    renderRoute(PATH);
    const morning = await rowOf("아침 점검");
    expect(morning.getByText("예약")).toBeInTheDocument();
    expect(morning.getByText("#general")).toBeInTheDocument();
    expect(morning.getByText(/매주 월요일 09:00/)).toBeInTheDocument();
    // 뉴욕 09:00(EDT) — 브라우저 시간대가 아니라 워크스페이스 시간대로 센다
    expect(await morning.findByText(/다음 실행 10월 12일 \(월\) 오전 9:00/)).toBeInTheDocument();
    expect(morning.getByText(/마지막 실행 10월 5일 \(월\) 오전 9:00 · 성공/)).toBeInTheDocument();
    const hook = await rowOf("배포 알림");
    expect(hook.getByText("웹훅")).toBeInTheDocument();
    expect(hook.getByText("#ops")).toBeInTheDocument();
    expect(hook.getByText("…/hooks/whk_abc123…")).toBeInTheDocument();
    expect(hook.getByText("아직 실행하지 않았습니다")).toBeInTheDocument();
    const hourly = await rowOf("매시 확인");
    expect(hourly.getByText(/매시간 15분/)).toBeInTheDocument();
    expect(hourly.getByText("꺼짐")).toBeInTheDocument();
    expect(hourly.queryByText(/다음 실행/)).toBeNull();
    expect(hourly.getByText(/마지막 실행 10월 5일 \(월\) 오전 10:20 · 건너뜀/)).toBeInTheDocument();
    expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
  });

  it("경고 줄 — 채널에 없음·꺼짐·모르는 핸들(조사는 받침대로), 채널 보관", async () => {
    const OLD = channelOf(uid(62), { name: "old", archivedAt: "2026-10-06T00:00:00.000Z" });
    stubAutomationsServer({
      archivedChannels: [OLD],
      automations: [
        automationOf(1, {
          name: "점검",
          warnings: [
            { kind: "agent_not_in_channel", handle: "dev" },
            { kind: "agent_not_in_channel", handle: "fin" },
            { kind: "agent_disabled", handle: "ops" },
            { kind: "unknown_handle", handle: "nobody" },
          ],
        }),
        automationOf(2, { name: "보관된 곳", channelId: OLD.id, warnings: [{ kind: "channel_archived" }] }),
        automationOf(3, { name: "멀쩡함" }),
      ],
    });
    renderRoute(PATH);
    const check = await rowOf("점검");
    const warnings = check.getByRole("list", { name: "경고" });
    expect(within(warnings).getByText("문구의 @dev 가 이 채널에 없습니다")).toBeInTheDocument();
    expect(within(warnings).getByText("문구의 @fin 이 이 채널에 없습니다")).toBeInTheDocument();
    expect(within(warnings).getByText("문구의 @ops 가 꺼져 있거나 삭제되었습니다")).toBeInTheDocument();
    expect(within(warnings).getByText("문구의 @nobody 를 찾을 수 없습니다")).toBeInTheDocument();
    const archived = await rowOf("보관된 곳");
    expect(archived.getByText("채널이 보관되었습니다")).toBeInTheDocument();
    expect(await archived.findByText("#old")).toBeInTheDocument();
    expect((await rowOf("멀쩡함")).queryByRole("list", { name: "경고" })).toBeNull();
  });

  it("「지금 실행」 — 요청이 나가 있는 동안 그 자동화의 버튼만 잠기고, 같은 틱 두 번 눌러도 한 번, 끝나면 성공 토스트", async () => {
    const server = stubAutomationsServer({
      automations: [automationOf(1, { name: "점검" }), automationOf(2, { name: "다른 것" })],
    });
    renderRoute(PATH);
    const row = await rowOf("점검");
    const release = server.holdRun();
    const run = row.getByRole("button", { name: "지금 실행" });
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(run).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(run);
    expect((await rowOf("다른 것")).getByRole("button", { name: "지금 실행" })).not.toHaveAttribute(
      "aria-disabled",
    );
    release();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("「점검」을 게시했습니다"));
    await waitFor(() => expect(run).not.toHaveAttribute("aria-disabled"));
    expect(server.writes()).toEqual([
      { method: "POST", url: `/api/v1/automations/${uid(501)}/run`, body: undefined },
    ]);
  });

  it("「지금 실행」 — 실패(409)하면 풀려 다시 누르면 다시 보내고, 성공한 뒤에도 다시 누르면 또 보낸다", async () => {
    let failures = 1;
    const server = stubAutomationsServer({
      automations: [automationOf(1, { name: "점검" })],
      override: (c) =>
        c.method === "POST" && c.url.endsWith("/run") && failures-- > 0
          ? json(409, { code: "CHANNEL_ARCHIVED", message: "channel is archived" })
          : undefined,
    });
    renderRoute(PATH);
    const run = (await rowOf("점검")).getByRole("button", { name: "지금 실행" });
    // 다음 클릭은 앞 요청이 끝난(토스트) 뒤에 — 나가 있는 동안의 클릭은 걸러지는 것이 맞다
    await user().click(run);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(run).not.toHaveAttribute("aria-disabled"));
    await user().click(run);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(run).not.toHaveAttribute("aria-disabled"));
    await user().click(run);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
    const runUrl = `/api/v1/automations/${uid(501)}/run`;
    expect(server.writes()).toEqual([
      { method: "POST", url: runUrl, body: undefined },
      { method: "POST", url: runUrl, body: undefined },
      { method: "POST", url: runUrl, body: undefined },
    ]);
  });

  it("[D2] 「지금 실행」을 키보드로 누르면 요청이 나가 있는 동안·끝난 뒤에도 초점이 그 버튼에 남는다", async () => {
    const server = stubAutomationsServer({ automations: [automationOf(1, { name: "점검" })] });
    renderRoute(PATH);
    const run = (await rowOf("점검")).getByRole("button", { name: "지금 실행" });
    const release = server.holdRun();
    run.focus();
    await user().keyboard("{Enter}");
    await waitFor(() => expect(run).toHaveTextContent("게시하는 중…"));
    // jsdom 은 disabled 가 된 요소에서 초점을 치우지 않는다 — 브라우저는 치운다. 그래서 「disabled 가 아니다」를 함께 잰다
    expect(run).toHaveAttribute("aria-disabled", "true");
    expect(run).toBeEnabled();
    expect(document.activeElement).toBe(run);
    // 나가 있는 동안 다시 눌러도 보내지 않는다
    await user().keyboard("{Enter}");
    release();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(run).toHaveTextContent("지금 실행"));
    expect(document.activeElement).toBe(run);
    expect(server.writes()).toHaveLength(1);
  });

  it("[D2] 「켜기」 스위치를 키보드로 누르면 요청이 나가 있는 동안·끝난 뒤에도 초점이 남고, 그 사이 누름은 무시한다", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubAutomationsServer({
      automations: [automationOf(1, { name: "점검" })],
      override: async (c) => {
        if (c.method === "PATCH") await held;
        return undefined;
      },
    });
    renderRoute(PATH);
    const row = await rowOf("점검");
    const toggle = row.getByRole("switch", { name: "점검 켜기" });
    toggle.focus();
    await user().keyboard(" ");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));
    expect(toggle).toBeEnabled();
    expect(document.activeElement).toBe(toggle);
    await user().keyboard(" ");
    release();
    expect(await row.findByText("꺼짐")).toBeInTheDocument();
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
    expect(document.activeElement).toBe(toggle);
    expect(server.writes()).toEqual([
      { method: "PATCH", url: `/api/v1/automations/${uid(501)}`, body: { enabled: false } },
    ]);
  });

  it("켜기/끄기 — 스위치가 PATCH { enabled } 를 보내고 줄이 「꺼짐」으로", async () => {
    const server = stubAutomationsServer({ automations: [automationOf(1, { name: "점검" })] });
    renderRoute(PATH);
    const row = await rowOf("점검");
    const toggle = row.getByRole("switch", { name: "점검 켜기" });
    expect(toggle).toBeChecked();
    await user().click(toggle);
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "PATCH", url: `/api/v1/automations/${uid(501)}`, body: { enabled: false } },
      ]),
    );
    expect(await row.findByText("꺼짐")).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it("삭제는 확인 대화상자 뒤 — 취소하면 보내지 않는다", async () => {
    const server = stubAutomationsServer({ automations: [automationOf(1, { name: "점검" })] });
    renderRoute(PATH);
    await user().click((await rowOf("점검")).getByRole("button", { name: "삭제" }));
    const ask = await screen.findByRole("dialog", { name: "자동화 삭제" });
    expect(
      within(ask).getByText(/이미 게시한 메시지는 남고 「⚙ 지운 자동화」로 보입니다/),
    ).toBeInTheDocument();
    await user().click(within(ask).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([]);
    await user().click((await rowOf("점검")).getByRole("button", { name: "삭제" }));
    const again = await screen.findByRole("dialog", { name: "자동화 삭제" });
    await user().click(within(again).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "점검" })).toBeNull());
    expect(server.writes()).toEqual([
      { method: "DELETE", url: `/api/v1/automations/${uid(501)}`, body: undefined },
    ]);
  });

  it("삭제 확인을 취소·Esc 로 닫으면 초점은 누른 「삭제」로 돌아온다", async () => {
    stubAutomationsServer({
      automations: [automationOf(1, { name: "점검" }), automationOf(2, { name: "다른 것" })],
    });
    renderRoute(PATH);
    const remove = (await rowOf("다른 것")).getByRole("button", { name: "삭제" });
    await user().click(remove);
    const ask = await screen.findByRole("dialog", { name: "자동화 삭제" });
    await user().click(within(ask).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(remove).toHaveFocus());
    await user().click(remove);
    await screen.findByRole("dialog", { name: "자동화 삭제" });
    await user().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(remove).toHaveFocus());
  });

  it("삭제한 뒤 초점은 다음 줄의 「삭제」, 마지막 줄이면 앞 줄, 다 지우면 「만들기」", async () => {
    stubAutomationsServer({
      automations: [
        automationOf(1, { name: "가" }),
        automationOf(2, { name: "나" }),
        automationOf(3, { name: "다" }),
      ],
    });
    renderRoute(PATH);
    const removeOf = async (name: string) => (await rowOf(name)).getByRole("button", { name: "삭제" });
    async function remove(name: string) {
      await user().click(await removeOf(name));
      const ask = await screen.findByRole("dialog", { name: "자동화 삭제" });
      await user().click(within(ask).getByRole("button", { name: "삭제" }));
      await waitFor(() => expect(screen.queryByRole("listitem", { name })).toBeNull());
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    const first = await removeOf("가");
    const last = await removeOf("다");
    await remove("나");
    await waitFor(() => expect(last).toHaveFocus());
    await remove("다");
    await waitFor(() => expect(first).toHaveFocus());
    await remove("가");
    expect(await screen.findByText(/아직 자동화가 없습니다/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "만들기" })).toHaveFocus());
  });
});

describe("만들기·수정 대화상자", () => {
  it("이름(공백만 포함)이나 문구가 비면 만들 수 없다", async () => {
    stubAutomationsServer();
    renderRoute(PATH);
    const dialog = await openCreate();
    const submit = within(dialog).getByRole("button", { name: "만들기" });
    expect(submit).toBeDisabled();
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "점검해 줘");
    expect(submit).toBeDisabled();
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    await user().type(name, "   ");
    expect(submit).toBeDisabled();
    await user().type(name, "아침");
    expect(submit).toBeEnabled();
  });

  it("시각 칸을 비우면 만들 수 없다 — 매시간은 시각을 보지 않는다", async () => {
    stubAutomationsServer();
    renderRoute(PATH);
    const dialog = await openCreate();
    const submit = within(dialog).getByRole("button", { name: "만들기" });
    await user().type(within(dialog).getByRole("textbox", { name: "이름" }), "아침");
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "점검해 줘");
    expect(submit).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText("시각"), { target: { value: "" } });
    expect(submit).toBeDisabled();
    await user().selectOptions(within(dialog).getByRole("combobox", { name: "반복" }), "hourly");
    expect(submit).toBeEnabled();
  });

  it("반복에 따라 칸이 바뀐다 — 매주는 요일, 매시간은 분만, 웹훅은 예약 칸 없음", async () => {
    stubAutomationsServer();
    renderRoute(PATH);
    const dialog = await openCreate();
    const repeat = within(dialog).getByRole("combobox", { name: "반복" });
    expect(repeat).toHaveValue("daily");
    expect(within(dialog).getByLabelText("시각")).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "요일" })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "분" })).toBeNull();
    await user().selectOptions(repeat, "weekly");
    expect(within(dialog).getByRole("combobox", { name: "요일" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("시각")).toBeInTheDocument();
    await user().selectOptions(repeat, "hourly");
    expect(within(dialog).getByRole("combobox", { name: "분" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("시각")).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "요일" })).toBeNull();
    await user().click(within(dialog).getByRole("radio", { name: "웹훅" }));
    expect(within(dialog).queryByRole("combobox", { name: "반복" })).toBeNull();
  });

  it("예약 만들기 — 고른 그대로 POST, 닫히고 목록에 보인다", async () => {
    const server = stubAutomationsServer();
    renderRoute(PATH);
    const dialog = await openCreate();
    await user().type(within(dialog).getByRole("textbox", { name: "이름" }), "아침 점검");
    await user().selectOptions(within(dialog).getByRole("combobox", { name: "채널" }), OPS_CHANNEL.id);
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "어제 로그 점검해 줘");
    await user().selectOptions(within(dialog).getByRole("combobox", { name: "반복" }), "weekly");
    await user().selectOptions(within(dialog).getByRole("combobox", { name: "요일" }), "1");
    fireEvent.change(within(dialog).getByLabelText("시각"), { target: { value: "09:30" } });
    await user().click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([
      {
        method: "POST",
        url: "/api/v1/automations",
        body: {
          kind: "schedule",
          name: "아침 점검",
          channelId: OPS_CHANNEL.id,
          bodyMd: "어제 로그 점검해 줘",
          schedule: { repeat: "weekly", weekday: 1, time: "09:30" },
        },
      },
    ]);
    expect(await rowOf("아침 점검")).toBeTruthy();
  });

  it("매시간 만들기 — 고른 분을 그대로 보낸다", async () => {
    const server = stubAutomationsServer();
    renderRoute(PATH);
    const dialog = await openCreate();
    await user().type(within(dialog).getByRole("textbox", { name: "이름" }), "매시 확인");
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "확인해 줘");
    await user().selectOptions(within(dialog).getByRole("combobox", { name: "반복" }), "hourly");
    await user().selectOptions(within(dialog).getByRole("combobox", { name: "분" }), "15");
    await user().click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([
      {
        method: "POST",
        url: "/api/v1/automations",
        body: {
          kind: "schedule",
          name: "매시 확인",
          channelId: GENERAL.id,
          bodyMd: "확인해 줘",
          schedule: { repeat: "hourly", minute: 15 },
        },
      },
    ]);
  });

  it("만드는 중에는 Esc 로 닫히지 않는다 — 응답의 웹훅 주소가 닫힌 대화상자로 사라지지 않게", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubAutomationsServer({
      override: async (c) => {
        if (c.method === "POST" && c.url === "/api/v1/automations") await held;
        return undefined;
      },
    });
    renderRoute(PATH);
    const dialog = await openCreate();
    await user().type(within(dialog).getByRole("textbox", { name: "이름" }), "배포 알림");
    await user().click(within(dialog).getByRole("radio", { name: "웹훅" }));
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "배포가 끝났습니다");
    await user().click(within(dialog).getByRole("button", { name: "만들기" }));
    await within(dialog).findByRole("button", { name: "만드는 중…" });
    await user().keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "자동화 만들기" })).toBeInTheDocument();
    release();
    expect(await within(dialog).findByText(WEBHOOK_URL)).toBeInTheDocument();
  });

  it("웹훅 만들기 — 주소를 한 번만 보이고(「이 주소는 다시 볼 수 없습니다」·복사), 원문은 대화상자 밖 어디에도 남지 않는다", async () => {
    const secret = WEBHOOK_TOKEN.slice("whk_abc123".length);
    const watch = watchLeaks(secret);
    const server = stubAutomationsServer();
    const app = renderRoute(PATH);
    const leaks = () => watch(app);
    const dialog = await openCreate();
    await user().type(within(dialog).getByRole("textbox", { name: "이름" }), "배포 알림");
    await user().click(within(dialog).getByRole("radio", { name: "웹훅" }));
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "배포가 끝났습니다");
    await user().click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByText(WEBHOOK_URL)).toBeInTheDocument();
    expect(within(dialog).getByText(/이 주소는 다시 볼 수 없습니다/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "주소 복사" })).toBeInTheDocument();
    expect(server.writes()[0]?.body).toEqual({
      kind: "webhook",
      name: "배포 알림",
      channelId: GENERAL.id,
      bodyMd: "배포가 끝났습니다",
    });

    // 원문은 대화상자의 컴포넌트 상태에만 — 쿼리·뮤테이션 캐시, 저장소, 주소, 콘솔, 토스트 어디에도 없다
    expect(leaks()).toEqual([]);

    // 닫는 길은 「복사했습니다」뿐 — Esc 로는 닫히지 않는다
    await user().keyboard("{Escape}");
    expect(screen.getByText(WEBHOOK_URL)).toBeInTheDocument();
    await user().click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(secret);
    expect(leaks()).toEqual([]);

    // 목록에는 앞 6자만, 수정 대화상자를 다시 열어도 주소는 없다
    const row = await rowOf("배포 알림");
    expect(row.getByText("…/hooks/whk_abc123…")).toBeInTheDocument();
    await user().click(row.getByRole("button", { name: "수정" }));
    const edit = await screen.findByRole("dialog", { name: "자동화 수정" });
    expect(within(edit).queryByText(WEBHOOK_URL)).toBeNull();
    expect(document.body.textContent).not.toContain(secret);
    await user().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 만든 그 대화상자를 다시 열어도 빈 폼이다
    const again = await openCreate();
    expect(within(again).getByRole("textbox", { name: "이름" })).toHaveValue("");
    expect(document.body.textContent).not.toContain(secret);
  });

  it("주소 다시 만들기 — 확인한 뒤 새 주소를 한 번 보이고, 목록은 새 앞부분, 원문은 대화상자 밖 어디에도 남지 않는다", async () => {
    const hook = automationOf(1, {
      name: "배포 알림",
      kind: "webhook",
      schedule: undefined,
      nextRunAt: undefined,
      tokenPrefix: "abc123",
    });
    const secret = REISSUED_TOKEN.slice("whk_zyx987".length);
    const watch = watchLeaks(secret);
    const server = stubAutomationsServer({ automations: [hook] });
    const app = renderRoute(PATH);
    const leaks = () => watch(app);
    await user().click((await rowOf("배포 알림")).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog", { name: "자동화 수정" });
    await user().click(within(dialog).getByRole("button", { name: "주소 다시 만들기" }));
    expect(within(dialog).getByText(/옛 주소는 곧바로 쓸 수 없게 됩니다/)).toBeInTheDocument();
    expect(server.writes()).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "다시 만들기" }));
    expect(await within(dialog).findByText(REISSUED_URL)).toBeInTheDocument();
    expect(within(dialog).getByText(/이 주소는 다시 볼 수 없습니다/)).toBeInTheDocument();
    expect(server.writes()).toEqual([
      { method: "POST", url: `/api/v1/automations/${hook.id}/token`, body: undefined },
    ]);
    expect(leaks()).toEqual([]);
    await user().click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await (await rowOf("배포 알림")).findByText("…/hooks/whk_zyx987…")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(secret);
    expect(leaks()).toEqual([]);
  });

  it("예약 자동화에는 「주소 다시 만들기」가 없다", async () => {
    stubAutomationsServer({ automations: [automationOf(1, { name: "점검" })] });
    renderRoute(PATH);
    await user().click((await rowOf("점검")).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog", { name: "자동화 수정" });
    expect(within(dialog).queryByRole("button", { name: "주소 다시 만들기" })).toBeNull();
  });

  it("이름이 겹치면(409) 이름 칸에 알린다 — 대화상자는 그대로, 전역 토스트 없음", async () => {
    stubAutomationsServer({
      override: (c) =>
        c.method === "POST" && c.url === "/api/v1/automations"
          ? json(409, {
              code: "CONFLICT",
              message: "automation name is already used",
              details: { field: "name" },
            })
          : undefined,
    });
    renderRoute(PATH);
    const dialog = await openCreate();
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    await user().type(name, "점검");
    await user().type(within(dialog).getByRole("textbox", { name: "문구" }), "점검해 줘");
    await user().click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByText("같은 이름의 자동화가 있습니다")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "자동화 만들기" })).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("문구의 @ 는 작성기와 같은 후보 — 채널의 에이전트를 골라 평문 @핸들로, Esc 는 후보만 닫는다", async () => {
    stubAutomationsServer();
    renderRoute(PATH);
    const dialog = await openCreate();
    const body = within(dialog).getByRole("textbox", { name: "문구" });
    await user().type(body, "@d");
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    expect(within(list).getByRole("option", { name: /@dev/ })).toBeInTheDocument();
    await user().keyboard("{Enter}");
    expect(body).toHaveValue("@dev ");
    expect(screen.queryByRole("listbox", { name: "멘션 후보" })).toBeNull();
    await user().type(body, "봐 줘 @");
    expect(await screen.findByRole("listbox", { name: "멘션 후보" })).toBeInTheDocument();
    await user().keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "멘션 후보" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "자동화 만들기" })).toBeInTheDocument();
    expect(body).toHaveValue("@dev 봐 줘 @");
  });

  it("수정 — 지금 값이 채워지고 PATCH 로 보낸다", async () => {
    const server = stubAutomationsServer({
      automations: [
        automationOf(1, {
          name: "점검",
          bodyMd: "@dev 어제 로그",
          schedule: { repeat: "weekdays", time: "08:00" },
        }),
      ],
    });
    renderRoute(PATH);
    await user().click((await rowOf("점검")).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog", { name: "자동화 수정" });
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    expect(name).toHaveValue("점검");
    expect(within(dialog).getByRole("textbox", { name: "문구" })).toHaveValue("@dev 어제 로그");
    expect(within(dialog).getByRole("combobox", { name: "반복" })).toHaveValue("weekdays");
    expect(within(dialog).getByLabelText("시각")).toHaveValue("08:00");
    expect(within(dialog).queryByRole("radio", { name: "웹훅" })).toBeNull();
    await user().clear(name);
    await user().type(name, "평일 점검");
    await user().click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([
      {
        method: "PATCH",
        url: `/api/v1/automations/${uid(501)}`,
        body: {
          name: "평일 점검",
          channelId: GENERAL.id,
          bodyMd: "@dev 어제 로그",
          schedule: { repeat: "weekdays", time: "08:00" },
        },
      },
    ]);
    expect(await rowOf("평일 점검")).toBeTruthy();
  });

  it("보관된 채널의 자동화를 고쳐도 채널 칸은 그 채널(보관됨) — 몰래 다른 채널로 옮기지 않는다", async () => {
    const OLD = channelOf(uid(62), { name: "old", archivedAt: "2026-10-06T00:00:00.000Z" });
    const server = stubAutomationsServer({
      archivedChannels: [OLD],
      automations: [
        automationOf(1, { name: "점검", channelId: OLD.id, warnings: [{ kind: "channel_archived" }] }),
      ],
    });
    renderRoute(PATH);
    await user().click((await rowOf("점검")).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog", { name: "자동화 수정" });
    const channel = within(dialog).getByRole("combobox", { name: "채널" });
    expect(channel).toHaveValue(OLD.id);
    expect(await within(channel).findByRole("option", { name: "#old (보관됨)" })).toBeInTheDocument();
    await user().click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.writes()[0]?.body).toMatchObject({ channelId: OLD.id }));
  });
});
