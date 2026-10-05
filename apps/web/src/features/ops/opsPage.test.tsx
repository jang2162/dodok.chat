import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket } from "../../../test/fakeSocket";
import { OWNER } from "../../../test/setupServer";
import { uid } from "../../../test/fixtures";
import { agentOf } from "../../../test/settingsServer";
import { createQueryClient } from "@/app/queryClient";
import { ME, TEST_GATEWAY, channelOf, json } from "../../../test/shellApi";
import {
  eventOf,
  opsStatusOf,
  renderOps,
  rowOf,
  runsOf,
  stubOpsServer,
  withRunners,
} from "../../../test/opsServer";

afterEach(() => {
  useWireStatus.getState().setStatus("idle");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOME_ID = uid(902);
const OFFICE_OFF = (() => {
  const [office] = opsStatusOf().gateways;
  if (!office) throw new Error("기본 Gateway 가 없다");
  return {
    ...office,
    enabled: false,
    gateway: { ...office.gateway, state: "disabled" as const, version: null },
  };
})();

const region = (name: string) => screen.findByRole("region", { name });
/** 상태 카드의 한 줄 — 이름(dt)으로 찾는다 */
const statusRow = async (name: string) => {
  const card = await region("상태");
  return within(card).getByText(name, { selector: "dt" }).closest("[data-status-row]") as HTMLElement;
};

/** 좁은 화면(768px 미만)으로 답하는 matchMedia */
function narrow(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string): MediaQueryList =>
      ({
        matches: query.includes("max-width") ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

describe("권한", () => {
  it("member 가 직접 주소로 오면 「권한이 없습니다」 — ops API 를 부르지 않는다", async () => {
    const server = stubOpsServer({ me: { ...ME, role: "member" } });
    renderOps({ ...ME, role: "member" });
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "상태" })).not.toBeInTheDocument();
    expect(server.opsCalls()).toEqual([]);
  });

  it("owner 는 제목 「운영」과 네 섹션을 본다", async () => {
    stubOpsServer();
    renderOps();
    expect(screen.getByRole("heading", { level: 1, name: "운영" })).toBeInTheDocument();
    for (const name of ["상태", "런", "한도", "최근 사건"]) expect(await region(name)).toBeInTheDocument();
  });
});

describe("상태 카드 — 문제가 있는 줄만 강조", () => {
  it("모두 괜찮으면 강조된 줄이 없다", async () => {
    stubOpsServer();
    renderOps();
    const card = await region("상태");
    expect(within(card).getAllByText("연결됨")).toHaveLength(2);
    expect(card.querySelectorAll("[data-problem]")).toHaveLength(0);
  });

  it("Gateway 끊김·플러그인 끊김·드리프트·디스크 부족·직전 비정상 종료는 강조", async () => {
    stubOpsServer({
      status: opsStatusOf({
        gateway: { state: "down", version: "2026.9.5", pinned: "2026.9.4", drift: true },
        plugin: { state: "down" },
        disk: { level: "warn", freeBytes: 512 * 1024 ** 2, totalBytes: 100 * 1024 ** 3 },
        server: { previousClean: false },
      }),
    });
    renderOps();
    expect(await statusRow("Gateway 「사무실」")).toHaveAttribute("data-problem");
    expect(await statusRow("플러그인 「사무실」")).toHaveAttribute("data-problem");
    const version = await statusRow("Gateway 「사무실」 버전");
    expect(version).toHaveAttribute("data-problem");
    expect(version).toHaveTextContent("저장소가 검증한 버전(2026.9.4)과 다릅니다");
    const disk = await statusRow("디스크 여유");
    expect(disk).toHaveAttribute("data-problem");
    expect(disk).toHaveTextContent("512 MB");
    expect(await statusRow("직전 종료")).toHaveAttribute("data-problem");
    expect(await statusRow("서버")).not.toHaveAttribute("data-problem");
  });

  it("드리프트가 아니면 버전 줄에 핀 문구가 없다", async () => {
    stubOpsServer();
    renderOps();
    const version = await statusRow("Gateway 「사무실」 버전");
    expect(version).toHaveTextContent("2026.9.4");
    expect(version).not.toHaveTextContent("저장소가 검증한");
  });

  it("Gateway 마다 Gateway·플러그인·버전 줄을 반복한다 — 꺼진 Gateway 는 줄이 없다", async () => {
    const [office] = opsStatusOf().gateways;
    if (!office) throw new Error("기본 Gateway 가 없다");
    stubOpsServer({
      status: opsStatusOf({
        gateways: [
          office,
          {
            ...office,
            id: HOME_ID,
            name: "집",
            gateway: { state: "down", version: "2026.9.5", pinned: "2026.9.4", drift: true },
            plugin: { state: "down" },
          },
          {
            ...office,
            id: uid(903),
            name: "창고",
            enabled: false,
            gateway: { ...office.gateway, state: "disabled" },
          },
        ],
      }),
    });
    renderOps();
    expect(await statusRow("Gateway 「사무실」")).not.toHaveAttribute("data-problem");
    expect(await statusRow("플러그인 「사무실」")).not.toHaveAttribute("data-problem");
    expect(await statusRow("Gateway 「사무실」 버전")).toHaveTextContent("2026.9.4");
    expect(await statusRow("Gateway 「집」")).toHaveAttribute("data-problem");
    expect(await statusRow("플러그인 「집」")).toHaveAttribute("data-problem");
    expect(await statusRow("Gateway 「집」 버전")).toHaveTextContent(
      "저장소가 검증한 버전(2026.9.4)과 다릅니다",
    );
    const card = await region("상태");
    expect(within(card).queryByText(/창고/)).toBeNull();
  });

  it.each([
    ["Gateway 0개", []],
    ["모두 꺼짐", [{ ...OFFICE_OFF }]],
  ])(
    "%s 면 Gateway·플러그인·버전 줄이 없고 강조도 없다(멀티 Gateway Review Focus 5)",
    async (_, gateways) => {
      stubOpsServer({ status: opsStatusOf({ gateways, adapter: { provider: "openclaw", gateways: [] } }) });
      renderOps();
      const card = await region("상태");
      await within(card).findByText("디스크 여유", { selector: "dt" });
      expect(within(card).queryByText(/Gateway|플러그인/, { selector: "dt" })).toBeNull();
      expect(card.querySelectorAll("[data-problem]")).toHaveLength(0);
    },
  );

  it("디스크를 못 쟀으면 「알 수 없음」, 직전 종료 표지가 없으면 「알 수 없음」 — 강조하지 않는다", async () => {
    stubOpsServer({ status: opsStatusOf({ disk: { level: "unknown" }, server: { previousClean: null } }) });
    renderOps();
    const disk = await statusRow("디스크 여유");
    expect(disk).toHaveTextContent("알 수 없음");
    expect(disk).not.toHaveAttribute("data-problem");
    const shutdown = await statusRow("직전 종료");
    expect(shutdown).toHaveTextContent("알 수 없음");
    expect(shutdown).not.toHaveAttribute("data-problem");
  });
});

/** 실제 wire 핸들러를 붙인 QueryClient 로 운영 화면을 그린다 — 서버 이벤트는 `fake.serverEmit` 으로 */
function renderLive() {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  const qc = createQueryClient(() => {});
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient: qc, fetchPage: vi.fn() });
  attachHandlers(fake.wire, {
    queryClient: qc,
    subscriptions,
    onUnauthorized: () => {},
    notify: { currentChannelId: () => undefined, openActivity: () => {} },
  });
  act(() => useWireStatus.getState().setStatus("connected"));
  renderOps(OWNER, qc);
  return { fake, qc };
}

describe("상태 카드 — 실시간(브라우저 검증 D1)", () => {
  it("연결 줄은 wire 어댑터 상태를 따른다 — 끊김 사건(60초)을 기다리지 않고 바로 바뀌고, 돌아오면 바로 돌아온다", async () => {
    const server = stubOpsServer();
    const { fake } = renderLive();
    expect(await statusRow("Gateway 「사무실」")).toHaveTextContent("연결됨");
    // 연결 줄(OpenClaw)과 러너 줄은 같은 목록 응답 하나를 나눠 쓴다(리뷰 M4)
    await waitFor(() => expect(server.count("GET", "/api/v1/adapter/status")).toBe(1));
    await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBe(1));

    act(() =>
      fake.serverEmit("adapter.status", {
        provider: "openclaw",
        gateways: [{ ...TEST_GATEWAY, gateway: "reconnecting", bridge: "down" }],
      }),
    );
    expect(await statusRow("Gateway 「사무실」")).toHaveTextContent("재연결 중");
    expect(await statusRow("Gateway 「사무실」")).toHaveAttribute("data-problem");
    expect(await statusRow("플러그인 「사무실」")).toHaveTextContent("연결 안 됨");
    expect(await statusRow("플러그인 「사무실」")).toHaveAttribute("data-problem");

    act(() => fake.serverEmit("adapter.status", { provider: "openclaw", gateways: [TEST_GATEWAY] }));
    expect(await statusRow("Gateway 「사무실」")).not.toHaveAttribute("data-problem");
    expect(await statusRow("플러그인 「사무실」")).not.toHaveAttribute("data-problem");
    // 상태를 다시 부르지 않았다 — 캐시만 바뀌었다
    expect(server.count("GET", "/api/v1/ops/status")).toBe(1);
  });

  it("Claude 러너 줄 — 붙은 수 / 토큰 수, wire adapter.status(claude)가 바로 고친다", async () => {
    const server = stubOpsServer({ adapter: withRunners(1, 2) });
    const { fake, qc } = renderLive();
    await waitFor(async () =>
      expect(await statusRow("Claude 러너")).toHaveTextContent("1대 붙음 / 토큰 2개"),
    );
    expect(await statusRow("Gateway 「사무실」")).toHaveTextContent("연결됨");
    expect(server.count("GET", "/api/v1/adapter/status")).toBe(1);
    // 재연결 때처럼 `adapter` 앞머리를 무효화하면 두 줄이 함께 다시 받되 요청은 하나
    await act(() => qc.invalidateQueries({ queryKey: qk.adapter }));
    expect(server.count("GET", "/api/v1/adapter/status")).toBe(2);
    act(() =>
      fake.serverEmit("adapter.status", { provider: "claude", runners: { connected: 2, tokens: 2 } }),
    );
    await waitFor(async () =>
      expect(await statusRow("Claude 러너")).toHaveTextContent("2대 붙음 / 토큰 2개"),
    );
    // OpenClaw 줄은 그대로
    expect(await statusRow("Gateway 「사무실」")).toHaveTextContent("연결됨");
  });

  it("러너 어댑터가 없는 서버면 Claude 러너 줄이 없다", async () => {
    stubOpsServer();
    renderOps();
    const card = await region("상태");
    await within(card).findByText("Gateway 「사무실」", { selector: "dt" });
    await waitFor(() => expect(within(card).queryByText("Claude 러너", { selector: "dt" })).toBeNull());
  });

  it("wire 가 끊겨 있으면 연결 줄은 운영 상태 응답의 값 — 멈춘 어댑터 캐시를 믿지 않는다", async () => {
    stubOpsServer({ status: opsStatusOf({ gateway: { state: "down" }, plugin: { state: "down" } }) });
    renderOps();
    expect(await statusRow("Gateway 「사무실」")).toHaveTextContent("연결 안 됨");
    expect(await statusRow("플러그인 「사무실」")).toHaveAttribute("data-problem");
  });

  it("ops.event(disk_low) 가 오면 상태를 다시 받아 디스크 줄이 바뀐다", async () => {
    const server = stubOpsServer();
    const { fake } = renderLive();
    expect(await statusRow("디스크 여유")).toHaveTextContent("50 GB");
    server.setStatus(
      opsStatusOf({
        disk: { level: "error", freeBytes: 100 * 1024 ** 2, totalBytes: 10 * 1024 ** 3 },
        unacked: { warn: 0, error: 1 },
      }),
    );
    act(() =>
      fake.serverEmit("ops.event", {
        event: eventOf(9, { kind: "disk_low", severity: "error", key: "disk", detail: {} }),
        unacked: { warn: 0, error: 1 },
      }),
    );
    await waitFor(async () => expect(await statusRow("디스크 여유")).toHaveTextContent("100 MB"));
    expect(await statusRow("디스크 여유")).toHaveAttribute("data-problem");
    expect(server.count("GET", "/api/v1/ops/status")).toBe(2);
  });

  it("운영 화면이 떠 있는 동안 30초마다 상태를 다시 받는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = stubOpsServer();
    renderOps();
    await statusRow("Gateway 「사무실」");
    await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBe(1));
    server.setStatus(opsStatusOf({ runsToday: 42 }));
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(server.count("GET", "/api/v1/ops/status")).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBe(2));
    expect(await within(await region("한도")).findByText("오늘 42 / 300회")).toBeInTheDocument();
  });
});

describe("런 표", () => {
  const CHANNEL = rowOf(1, { name: "general", runs: 9, failed: 2, aborted: 1, blocked: 3 });
  const AGENT_ROW = rowOf(2, { name: "Dev", runs: 9, failed: 2, aborted: 1 });

  it("「오늘」이 기본 — 채널별·에이전트별 런·실패·중지·차단", async () => {
    const server = stubOpsServer({
      runs: (days) => runsOf({ days, byChannel: [CHANNEL], byAgent: [AGENT_ROW] }),
    });
    renderOps();
    const runs = await region("런");
    expect(within(runs).getByRole("button", { name: "오늘" })).toHaveAttribute("aria-pressed", "true");
    const byChannel = await within(runs).findByRole("table", { name: "채널별" });
    const row = within(byChannel).getByRole("row", { name: /general/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["general", "9", "2", "1", "3"]);
    expect(within(runs).getByRole("table", { name: "에이전트별" })).toHaveTextContent("Dev");
    expect(server.count("GET", "/api/v1/ops/runs?days=1")).toBe(1);
  });

  it("에이전트별 표는 삭제(보관)한 에이전트도 기록으로 남기고 「삭제됨」을 붙인다", async () => {
    stubOpsServer({
      runs: (days) =>
        runsOf({ days, byChannel: [], byAgent: [AGENT_ROW, rowOf(3, { name: "Fin", runs: 1 })] }),
      agents: [
        agentOf(AGENT_ROW.id, "dev", { archivedAt: "2026-10-05T00:00:00.000Z" }),
        agentOf(uid(3), "fin"),
      ],
    });
    renderOps();
    const table = await within(await region("런")).findByRole("table", { name: "에이전트별" });
    const dev = within(table).getByRole("row", { name: /Dev/ });
    expect(await within(dev).findByText("삭제됨")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: /Fin/ })).queryByText("삭제됨")).toBeNull();
  });

  it("「7일」로 바꾸면 days=7 을 부른다", async () => {
    const server = stubOpsServer({
      runs: (days) =>
        runsOf({ days, byChannel: [rowOf(1, { name: days === 7 ? "일주일" : "하루", runs: 1 })] }),
    });
    renderOps();
    const runs = await region("런");
    await within(runs).findByText("하루");
    await userEvent.click(within(runs).getByRole("button", { name: "7일" }));
    expect(await within(runs).findByText("일주일")).toBeInTheDocument();
    expect(within(runs).getByRole("button", { name: "7일" })).toHaveAttribute("aria-pressed", "true");
    expect(server.count("GET", "/api/v1/ops/runs?days=7")).toBe(1);
  });

  it("채널 이름을 누르면 그 채널로 간다", async () => {
    stubOpsServer({ runs: (days) => runsOf({ days, byChannel: [CHANNEL] }) });
    renderOps();
    const link = await within(await region("런")).findByRole("link", { name: "general" });
    expect(link).toHaveAttribute("href", `/c/${uid(1)}`);
  });

  it("usage 를 믿는 제공자가 없으면(OpenClaw 만 붙은 서버) 토큰·금액 열이 없고 「측정 불가」 한 줄", async () => {
    stubOpsServer({ runs: (days) => runsOf({ days, byChannel: [CHANNEL], usageTrustedProviders: [] }) });
    renderOps();
    const runs = await region("런");
    const table = await within(runs).findByRole("table", { name: "채널별" });
    expect(within(table).queryByRole("columnheader", { name: "토큰" })).not.toBeInTheDocument();
    expect(within(runs).getByText(/측정 불가/)).toBeInTheDocument();
  });

  it("usage 를 믿는 제공자가 있으면 토큰·금액 열", async () => {
    stubOpsServer({
      runs: (days) =>
        runsOf({
          days,
          usageTrustedProviders: ["claude"],
          byChannel: [{ ...CHANNEL, tokens: 12_345, costUsd: 0.5 }],
        }),
    });
    renderOps();
    const runs = await region("런");
    const table = await within(runs).findByRole("table", { name: "채널별" });
    expect(within(table).getByRole("columnheader", { name: "토큰" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "금액" })).toBeInTheDocument();
    expect(table).toHaveTextContent("12,345");
    expect(table).toHaveTextContent("$0.50");
    expect(within(runs).queryByText(/측정 불가/)).not.toBeInTheDocument();
  });

  it("믿는 제공자(claude)의 에이전트 행은 금액을 — 구독 환산이 들었으면 「환산 포함」, 그 밖의 행은 「측정 불가」", async () => {
    stubOpsServer({
      runs: (days) =>
        runsOf({
          days,
          usageTrustedProviders: ["claude"],
          byAgent: [
            rowOf(21, {
              name: "coder",
              runs: 3,
              measuredRuns: 3,
              tokens: 1_500,
              costUsd: 0.3,
              costEstimated: true,
            }),
            rowOf(22, {
              name: "writer",
              runs: 2,
              measuredRuns: 2,
              tokens: 100,
              costUsd: 0.25,
              costEstimated: false,
            }),
            rowOf(23, { name: "dev", runs: 5 }),
          ],
        }),
    });
    renderOps();
    const runs = await region("런");
    const table = await within(runs).findByRole("table", { name: "에이전트별" });
    const rowNamed = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(rowNamed("coder")).toHaveTextContent("1,500");
    expect(rowNamed("coder")).toHaveTextContent("$0.30");
    expect(rowNamed("coder")).toHaveTextContent("환산 포함");
    expect(rowNamed("writer")).toHaveTextContent("$0.25");
    expect(rowNamed("writer")).not.toHaveTextContent("환산");
    expect(within(rowNamed("dev")).getAllByText("측정 불가")).toHaveLength(2);
    expect(rowNamed("coder")).not.toHaveTextContent("측정 불가");
    // 「환산 포함」이 무엇인지 한 줄 — api 로 청구된 몫과 섞일 수 있어 환산한 몫만 청구액이 아니라고 말한다
    expect(runs).toHaveTextContent(
      "「환산 포함」 금액에는 구독 로그인으로 돈 런을 공시 단가로 환산한 몫이 들어 있습니다 — 그 몫은 청구액이 아닙니다.",
    );
    // 모든 런을 더한 행뿐이라 부분합 표시·각주가 없다
    expect(runs).not.toHaveTextContent(/개만/);
    expect(runs).not.toHaveTextContent("부분합");
  });

  it("믿는 런만 더한 행(OpenClaw·Claude 런이 섞인 채널)은 토큰·금액에 「런 m/n개만」, 표 아래 부분합 한 줄", async () => {
    stubOpsServer({
      runs: (days) =>
        runsOf({
          days,
          usageTrustedProviders: ["claude"],
          byChannel: [
            rowOf(1, { name: "general", runs: 5, measuredRuns: 2, tokens: 10, costUsd: 0.125 }),
            rowOf(2, { name: "random", runs: 2, measuredRuns: 2, tokens: 4, costUsd: 0.5 }),
          ],
        }),
    });
    renderOps();
    const runs = await region("런");
    const table = await within(runs).findByRole("table", { name: "채널별" });
    const rowNamed = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(rowNamed("general")).getAllByText("런 2/5개만")).toHaveLength(2);
    expect(rowNamed("general")).toHaveTextContent("$0.13");
    expect(rowNamed("random")).not.toHaveTextContent(/개만/);
    expect(runs).toHaveTextContent(
      "「런 m/n개만」은 사용량을 믿을 수 있는 런만 더한 부분합입니다 — 나머지 런의 토큰·금액은 측정 불가입니다.",
    );
    expect(runs).not.toHaveTextContent("환산 포함");
  });

  it("좁은 화면 카드에도 「환산 포함」·「런 m/n개만」·「측정 불가」", async () => {
    narrow(true);
    stubOpsServer({
      runs: (days) =>
        runsOf({
          days,
          usageTrustedProviders: ["claude"],
          byAgent: [
            rowOf(21, {
              name: "coder",
              runs: 3,
              measuredRuns: 1,
              tokens: 1,
              costUsd: 0.3,
              costEstimated: true,
            }),
            rowOf(23, { name: "dev", runs: 5 }),
          ],
        }),
    });
    renderOps();
    const list = await within(await region("런")).findByRole("list", { name: "에이전트별" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("환산 포함");
    expect(within(items[0]!).getAllByText("런 1/3개만")).toHaveLength(2);
    expect(items[1]).toHaveTextContent("측정 불가");
  });

  it("런이 없으면 「런이 없습니다」", async () => {
    stubOpsServer();
    renderOps();
    expect(await within(await region("런")).findAllByText("이 기간에 런이 없습니다")).toHaveLength(2);
  });

  it("좁은 화면(390px)에서는 표 대신 카드 목록 — 가로 스크롤 표가 없다", async () => {
    narrow(true);
    stubOpsServer({ runs: (days) => runsOf({ days, byChannel: [CHANNEL], byAgent: [AGENT_ROW] }) });
    renderOps();
    const runs = await region("런");
    const list = await within(runs).findByRole("list", { name: "채널별" });
    expect(within(runs).queryByRole("table")).not.toBeInTheDocument();
    const card = within(list).getByRole("listitem");
    expect(within(card).getByRole("link", { name: "general" })).toBeInTheDocument();
    expect(card).toHaveTextContent(/런\s*9/);
    expect(card).toHaveTextContent(/차단\s*3/);
    expect(within(runs).getByRole("list", { name: "에이전트별" })).toHaveTextContent("Dev");
  });
});

describe("한도", () => {
  const input = async () => within(await region("한도")).findByLabelText("워크스페이스 일일 런 상한");

  it("지금 값과 오늘 사용량 막대", async () => {
    stubOpsServer({ status: opsStatusOf({ runsToday: 12, dailyRunLimit: 300 }) });
    renderOps();
    expect(await input()).toHaveValue("300");
    const bar = within(await region("한도")).getByRole("progressbar", { name: "오늘 사용량" });
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemax", "300");
  });

  it("값을 바꿔 저장하면 PATCH ops/settings", async () => {
    const server = stubOpsServer();
    renderOps();
    const field = await input();
    await userEvent.clear(field);
    await userEvent.type(field, "50");
    await userEvent.click(within(await region("한도")).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([
        { method: "PATCH", url: "/api/v1/ops/settings", body: { dailyRunLimit: 50 } },
      ]),
    );
    expect(await within(await region("한도")).findByText("저장했습니다")).toBeInTheDocument();
  });

  it("비우고 저장하면 무제한(null) — 막대 대신 「무제한」", async () => {
    const server = stubOpsServer();
    renderOps();
    await userEvent.clear(await input());
    await userEvent.click(within(await region("한도")).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.calls.find((c) => c.method === "PATCH")?.body).toEqual({ dailyRunLimit: null }),
    );
    const limit = await region("한도");
    expect(await within(limit).findByText("오늘 12회 · 무제한")).toBeInTheDocument();
    await waitFor(() => expect(within(limit).queryByRole("progressbar")).not.toBeInTheDocument());
  });

  it.each(["0", "10001", "1.5", "abc"])("범위 밖(%s)이면 오류 문구 — 보내지 않는다", async (value) => {
    const server = stubOpsServer();
    renderOps();
    const field = await input();
    await userEvent.clear(field);
    await userEvent.type(field, value);
    await userEvent.click(within(await region("한도")).getByRole("button", { name: "저장" }));
    expect(await within(await region("한도")).findByText(/1~10000 사이 정수/)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("저장이 끝나기 전에 다시 눌러도 PATCH 는 1건 — 버튼은 「저장 중…」·비활성", async () => {
    let release!: (r: Response) => void;
    const server = stubOpsServer({ patch: () => new Promise<Response>((r) => (release = r)) });
    renderOps();
    const field = await input();
    await userEvent.clear(field);
    await userEvent.type(field, "50");
    const limit = await region("한도");
    await userEvent.click(within(limit).getByRole("button", { name: "저장" }));
    const pending = await within(limit).findByRole("button", { name: "저장 중…" });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);
    // 버튼을 거치지 않는 제출(엔터 등)도 막힌다
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    release(json(200, { dailyRunLimit: 50 }));
    expect(await within(limit).findByText("저장했습니다")).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("서버가 거절하면 그 사유를 보인다", async () => {
    stubOpsServer({ patch: () => json(400, { code: "VALIDATION", message: "dailyRunLimit 범위" }) });
    renderOps();
    const field = await input();
    await userEvent.clear(field);
    await userEvent.type(field, "20");
    await userEvent.click(within(await region("한도")).getByRole("button", { name: "저장" }));
    expect(await within(await region("한도")).findByText(/저장하지 못했습니다/)).toBeInTheDocument();
  });

  it("오늘 워크스페이스 상한으로 막힌 수와 채널별 한도 안내", async () => {
    stubOpsServer({ status: opsStatusOf({ blockedToday: 4 }) });
    renderOps();
    const limit = await region("한도");
    expect(await within(limit).findByText(/막힌 런 4회/)).toBeInTheDocument();
    expect(limit).toHaveTextContent("채널별 한도는 각 채널 설정");
  });
});

describe("최근 사건", () => {
  const FAILED = eventOf(1, { kind: "run_failed", severity: "warn", detail: { code: "TIMEOUT" }, count: 3 });
  const CRASH = eventOf(2, { kind: "crash_rejection", severity: "error", key: "process", detail: {} });
  const UNTESTED = eventOf(3, {
    kind: "gateway_version_untested",
    severity: "info",
    key: "gateway:00000000-0000-4000-8000-0000000000a1:2026.9.5",
    detail: { gatewayName: "사무실", version: "2026.9.5" },
  });
  const list = async () => within(await region("최근 사건")).findByRole("list", { name: "사건" });

  it("한 줄 = 심각도 + 고정 문구 + ×n + 시각", async () => {
    stubOpsServer({ pages: [[FAILED, CRASH]] });
    renderOps();
    const items = within(await list()).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("런 실패 (TIMEOUT) ×3");
    expect(within(items[0] as HTMLElement).getByRole("img", { name: "주의" })).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByRole("img", { name: "오류" })).toBeInTheDocument();
    expect(items[0]?.querySelector("time")).toHaveAttribute("datetime", FAILED.lastAt);
  });

  it("끊김 줄의 시각은 끊긴 때(firstAt - thresholdMs)", async () => {
    const down = eventOf(4, {
      kind: "plugin_down",
      key: "plugin",
      detail: { thresholdMs: 60_000 },
      firstAt: "2026-09-25T01:01:00.000Z",
      lastAt: "2026-09-25T01:01:00.000Z",
    });
    stubOpsServer({ pages: [[down]] });
    renderOps();
    const item = within(await list()).getByRole("listitem");
    expect(item).toHaveTextContent("플러그인 연결 끊김 (지금도)");
    expect(item.querySelector("time")).toHaveAttribute("datetime", "2026-09-25T01:00:00.000Z");
  });

  it("Gateway 사건에는 Gateway 이름 — 지금 이름을 key 의 id 로 찾고, 못 찾으면 사건이 남긴 이름", async () => {
    const down = eventOf(5, {
      kind: "gateway_down",
      key: `gateway:${TEST_GATEWAY.id}`,
      detail: { thresholdMs: 60_000, gatewayName: "옛 이름" },
    });
    const plugin = eventOf(6, {
      kind: "plugin_down",
      key: "gateway:01a00000-0000-7000-8000-0000000000ff",
      detail: { thresholdMs: 60_000, gatewayName: "지운 Gateway" },
      resolvedAt: "2026-09-25T01:05:00.000Z",
    });
    const changed = eventOf(7, {
      kind: "gateway_version_changed",
      severity: "info",
      key: `gateway:${TEST_GATEWAY.id}`,
      detail: { from: "2026.9.4", to: "2026.9.5", gatewayName: "사무실" },
    });
    stubOpsServer({ pages: [[down, plugin, changed]] });
    renderOps();
    const items = within(await list()).getAllByRole("listitem");
    await waitFor(() => expect(items[0]).toHaveTextContent("Gateway 「사무실」 연결 끊김 (지금도)"));
    expect(items[1]).toHaveTextContent("Gateway 「지운 Gateway」 플러그인 연결 끊김");
    expect(items[2]).toHaveTextContent("Gateway 「사무실」 버전이 바뀜 (2026.9.4 → 2026.9.5)");
  });

  it("심각도 필터 — 「오류」면 severity=error 로 부른다", async () => {
    const server = stubOpsServer({ pages: [[FAILED, CRASH, UNTESTED]] });
    renderOps();
    const items = within(await list()).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent("Gateway 「사무실」 검증 안 된 버전 (2026.9.5)");
    const events = await region("최근 사건");
    await userEvent.click(within(events).getByRole("button", { name: "오류" }));
    await waitFor(() => expect(within(events).getAllByRole("listitem")).toHaveLength(1));
    expect(within(events).getByRole("listitem")).toHaveTextContent("처리 안 된 오류");
    expect(within(events).getByRole("button", { name: "오류" })).toHaveAttribute("aria-pressed", "true");
    expect(server.calls.some((c) => c.url === "/api/v1/ops/events?severity=error")).toBe(true);
  });

  it("「더 보기」는 다음 커서로 이어 붙이고, 끝이면 사라진다", async () => {
    const server = stubOpsServer({ pages: [[FAILED], [CRASH]] });
    renderOps();
    const events = await region("최근 사건");
    await within(events).findByText(/런 실패/);
    await userEvent.click(within(events).getByRole("button", { name: "더 보기" }));
    await waitFor(() => expect(within(events).getAllByRole("listitem")).toHaveLength(2));
    expect(server.calls.some((c) => c.url === "/api/v1/ops/events?cursor=1")).toBe(true);
    expect(within(events).queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("모르는 kind·severity(이 웹보다 새 서버)가 와도 그 줄만 일반 문구 — 나머지 섹션은 그대로", async () => {
    const future = { ...FAILED, id: uid(799), kind: "future_kind", severity: "critical" };
    stubOpsServer({ rawEvents: [future, CRASH] });
    renderOps();
    const items = within(await list()).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("알 수 없는 사건 (future_kind) ×3");
    expect(within(items[0] as HTMLElement).getByRole("img", { name: "critical" })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("처리 안 된 오류");
    for (const name of ["상태", "런", "한도"]) expect(await region(name)).toBeInTheDocument();
  });

  it("run_limit 줄은 범위를 붙인다 — 채널 이름은 채널 목록 캐시에서", async () => {
    const ws = eventOf(5, { kind: "run_limit", key: "workspace", detail: { limit: 2 }, count: 2 });
    const ch = eventOf(6, { kind: "run_limit", key: `channel:${uid(21)}`, detail: { limit: 1 } });
    const gone = eventOf(7, { kind: "run_limit", key: `channel:${uid(22)}`, detail: { limit: 1 } });
    stubOpsServer({ pages: [[ws, ch, gone]], channels: [channelOf(uid(21), { name: "limit" })] });
    renderOps();
    const items = within(await list()).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("런 한도 도달 (워크스페이스) ×2");
    await waitFor(() => expect(items[1]).toHaveTextContent("런 한도 도달 (#limit)"));
    expect(items[2]).toHaveTextContent("런 한도 도달 (채널)");
  });

  it("확인한 줄은 흐리게 — 확인 안 한 줄(굵게)과 모양이 다르다", async () => {
    const acked = eventOf(8, { ackedAt: "2026-09-25T02:00:00.000Z" });
    stubOpsServer({ pages: [[FAILED, acked]] });
    renderOps();
    const [fresh, seen] = within(await list()).getAllByRole("listitem") as HTMLElement[];
    const text = (li: HTMLElement | undefined) => within(li as HTMLElement).getByText(/런 실패/);
    expect(fresh).not.toHaveAttribute("data-acked");
    expect(text(fresh)).toHaveClass("font-medium");
    expect(text(fresh)).not.toHaveClass("text-muted-foreground");
    expect(seen).toHaveAttribute("data-acked");
    expect(text(seen)).not.toHaveClass("font-medium");
    expect(text(seen)).toHaveClass("text-muted-foreground");
  });

  it("사건이 없으면 「사건이 없습니다」", async () => {
    stubOpsServer();
    renderOps();
    expect(await within(await region("최근 사건")).findByText("사건이 없습니다")).toBeInTheDocument();
  });

  it("「모두 확인」 → POST ack, 확인 안 한 수가 0 이 된다", async () => {
    const server = stubOpsServer({
      status: opsStatusOf({ unacked: { warn: 2, error: 1 } }),
      pages: [[FAILED]],
    });
    const { qc } = renderOps();
    const events = await region("최근 사건");
    await within(events).findByText(/런 실패/);
    await userEvent.click(within(events).getByRole("button", { name: "모두 확인" }));
    await waitFor(() => expect(server.count("POST", "/api/v1/ops/events/ack")).toBe(1));
    await waitFor(() =>
      expect(qc.getQueryData<{ unacked: unknown }>(qk.opsStatus)?.unacked).toEqual({ warn: 0, error: 0 }),
    );
  });

  it("「모두 확인」 도중에 새 사건이 오면 0 으로 덮지 않고 서버가 준 수를 쓴다", async () => {
    let release!: (r: Response) => void;
    const server = stubOpsServer({
      status: opsStatusOf({ unacked: { warn: 2, error: 1 } }),
      pages: [[FAILED]],
      ack: () => new Promise<Response>((r) => (release = r)),
    });
    const { qc } = renderOps();
    const events = await region("최근 사건");
    await within(events).findByText(/런 실패/);
    await userEvent.click(within(events).getByRole("button", { name: "모두 확인" }));
    await waitFor(() => expect(server.count("POST", "/api/v1/ops/events/ack")).toBe(1));
    // ack 가 떠 있는 동안 새 warn 사건(ops.event) — 서버는 ack 뒤에도 그 한 줄을 확인 안 한 것으로 센다
    act(() => {
      qc.setQueryData(qk.opsStatus, opsStatusOf({ unacked: { warn: 3, error: 1 } }));
    });
    server.setStatus(opsStatusOf({ unacked: { warn: 1, error: 0 } }));
    release(json(200, { acked: 3 }));
    await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBe(2));
    await waitFor(() =>
      expect(qc.getQueryData<{ unacked: unknown }>(qk.opsStatus)?.unacked).toEqual({ warn: 1, error: 0 }),
    );
  });
});
