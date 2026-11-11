import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER,
  RAW_RUNNER_TOKEN,
  RUNNER_SERVER_URL,
  cacheDump,
  gatewayDetailPath,
  gatewayId,
  gatewayOf,
  renderConnection,
  runnerDetailPath,
  statusOf,
  stubSetupServer,
  tokenId,
} from "../../../test/setupServer";
import { ME, json } from "../../../test/shellApi";
import { llmsHandoffLine } from "../setup/llms";

// 연결 추가(연결 탭 통합 스펙 3.3·5.2) — Gateway 는 폼 → 그 상세, 러너는 드러나는 것 넷 → 토큰 발급 → 그 상세. 멤버 누구나(member 의 Gateway 는 승인 대기)

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderNew = (me: unknown = OWNER) => renderConnection(me, undefined, "/settings/connection/new");
/** Gateway 갈래(처음 고른 것)의 폼 */
const openAdd = () => screen.findByRole("form", { name: "Gateway 추가" });

describe("권한", () => {
  it.each(["admin", "member"])("member and admin can add a connection — %s 도 고르기와 폼", async (role) => {
    stubSetupServer({ me: { ...ME, role } });
    renderNew({ ...ME, role });
    expect(await screen.findByRole("heading", { level: 1, name: "연결 추가" })).toBeInTheDocument();
    expect(await openAdd()).toBeInTheDocument();
    expect(screen.queryByText(/권한이 없습니다/)).toBeNull();
  });

  it("member's new gateway shows pending approval — 저장하면 그 상세에 「승인 대기」 한 줄", async () => {
    const ME_ID = "0190a000-0000-7000-8000-0000000000d1";
    const MEMBER = { ...ME, user: { ...ME.user, id: ME_ID }, role: "member" };
    let created = false;
    const mine = gatewayOf(7, { name: "집", approved: false, gateway: { state: "disabled" } });
    stubSetupServer({
      me: MEMBER,
      status: () => ({ ...statusOf({ noGateway: true, plugin: null }), gateways: created ? [mine] : [] }),
      connections: () => ({
        gateways: created
          ? [{ id: mine.id, name: "집", enabled: true, approved: false, owner: { id: ME_ID, name: "나" } }]
          : [],
        runners: [],
        projects: [],
      }),
      createGateway: (body) => {
        created = true;
        return json(201, {
          ...mine,
          ...(body as object),
          tokenSet: true,
          ownerUserId: ME_ID,
          approved: false,
        });
      },
    });
    const { router } = renderNew(MEMBER);
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "집");
    await userEvent.type(within(dialog).getByLabelText("주소"), "wss://home.example.com");
    await userEvent.type(within(dialog).getByLabelText("토큰"), "gw-secret");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(gatewayDetailPath(gatewayId(7))));
    expect(
      await within(await screen.findByTestId("gateway-detail")).findByText("승인 대기"),
    ).toBeInTheDocument();
  });

  it("「연결 추가」 머리와 고르기 — 처음은 OpenClaw Gateway", async () => {
    stubSetupServer();
    renderNew();
    expect(await screen.findByRole("heading", { level: 1, name: "연결 추가" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "OpenClaw Gateway" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "러너" })).not.toBeChecked();
  });
});

describe("Gateway 추가", () => {
  it("빈 상태에서도 「Gateway 추가」 — 이름·주소·토큰을 보내고, 그 Gateway 상세로 가 상태를 다시 받는다", async () => {
    let created = false;
    const server = stubSetupServer({
      status: () =>
        created
          ? statusOf({ moreGateways: [gatewayOf(7, { name: "집" })] })
          : statusOf({ noGateway: true, plugin: null }),
      createGateway: (body) => {
        created = true;
        return json(201, { ...gatewayOf(7), ...(body as object), tokenSet: true, ownerUserId: null });
      },
    });
    const { router } = renderNew();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), " 집 ");
    await userEvent.type(within(dialog).getByLabelText("주소"), " wss://home.example.com ");
    await userEvent.type(within(dialog).getByLabelText("토큰"), " gw-secret ");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    // 저장하면 그 Gateway 상세로 — 플러그인 설치 상자가 펼쳐진 채
    await waitFor(() => expect(router.state.location.pathname).toBe(gatewayDetailPath(gatewayId(7))));
    expect(server.calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      url: "/api/v1/gateways",
      body: { name: "집", url: "wss://home.example.com", token: "gw-secret" },
    });
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBeGreaterThanOrEqual(2));
    const plugin = await screen.findByRole("region", { name: "플러그인" });
    expect(within(plugin).getByRole("group", { name: "플러그인 설치" })).toHaveAttribute("open");
  });

  it("비운 칸은 칸마다 고정 문구, 보내지 않는다", async () => {
    const server = stubSetupServer();
    renderNew();
    const dialog = await openAdd();
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    expect(within(dialog).getByLabelText("이름")).toHaveAccessibleDescription("이름은 1~32자로 적어 주세요.");
    expect(within(dialog).getByLabelText("주소")).toHaveAccessibleDescription(
      "ws:// 또는 wss:// 로 시작하는 주소를 입력하세요.",
    );
    expect(within(dialog).getByLabelText("토큰")).toHaveAccessibleDescription("Gateway 토큰을 입력하세요.");
    expect(server.count("POST", "/api/v1/gateways")).toBe(0);
  });

  it.each([
    ["http://", "http://gateway.example.com", "ws:// 또는 wss:// 로 시작하는 주소를 입력하세요."],
    ["사용자 정보", "wss://u:p@gateway.example.com", "주소에 사용자 이름·비밀번호를 넣을 수 없습니다."],
  ])("주소 — %s 는 거절한다", async (_name, url, message) => {
    const server = stubSetupServer();
    renderNew();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "집");
    await userEvent.type(within(dialog).getByLabelText("주소"), url);
    await userEvent.type(within(dialog).getByLabelText("토큰"), "t");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    expect(within(dialog).getByLabelText("주소")).toHaveAccessibleDescription(message);
    expect(within(dialog).getByLabelText("주소")).toHaveAttribute("aria-invalid", "true");
    expect(server.count("POST", "/api/v1/gateways")).toBe(0);
  });

  it("33자 이름은 거절한다", async () => {
    const server = stubSetupServer();
    renderNew();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "가".repeat(33));
    await userEvent.type(within(dialog).getByLabelText("주소"), "wss://a.example.com");
    await userEvent.type(within(dialog).getByLabelText("토큰"), "t");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    expect(within(dialog).getByLabelText("이름")).toHaveAccessibleDescription("이름은 1~32자로 적어 주세요.");
    expect(server.count("POST", "/api/v1/gateways")).toBe(0);
  });

  it("서버가 이름 겹침(409 field name)이면 이름 칸에 고정 문구 — 서버 문구는 보이지 않는다", async () => {
    stubSetupServer({
      createGateway: () =>
        json(409, {
          code: "CONFLICT",
          message: "gateway name is already used",
          details: { field: "name" },
        }),
    });
    renderNew();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "사무실");
    await userEvent.type(within(dialog).getByLabelText("주소"), "wss://a.example.com");
    await userEvent.type(within(dialog).getByLabelText("토큰"), "t");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText("이름")).toHaveAccessibleDescription(
        "이미 쓰이는 이름입니다 — 다른 이름을 입력하세요.",
      ),
    );
    expect(dialog).not.toHaveTextContent("already used");
    expect(screen.getByRole("form", { name: "Gateway 추가" })).toBeInTheDocument();
  });
});

describe("두 번 보내지 않기(태스크 6 리뷰 Minor 1)", () => {
  it("「추가」를 같은 틱에 두 번 내도 POST 는 한 번 — 둘째가 409 로 폼을 붙잡지 않게", async () => {
    const server = stubSetupServer();
    const { router } = renderNew();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "집");
    await userEvent.type(within(dialog).getByLabelText("주소"), "wss://home.example.com");
    await userEvent.type(within(dialog).getByLabelText("토큰"), "t");
    act(() => {
      fireEvent.submit(dialog);
      fireEvent.submit(dialog);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(gatewayDetailPath(gatewayId(7))));
    expect(server.count("POST", "/api/v1/gateways")).toBe(1);
  });

  it("실패한 뒤에는 다시 보낼 수 있다", async () => {
    let first = true;
    const server = stubSetupServer({
      createGateway: (body) => {
        if (!first) return json(201, { ...gatewayOf(2), ...(body as object) });
        first = false;
        return json(409, { code: "CONFLICT", message: "dup", details: { field: "name" } });
      },
    });
    const { router } = renderNew();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "집");
    await userEvent.type(within(dialog).getByLabelText("주소"), "wss://home.example.com");
    await userEvent.type(within(dialog).getByLabelText("토큰"), "t");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText("이름")).toHaveAccessibleDescription(
        "이미 쓰이는 이름입니다 — 다른 이름을 입력하세요.",
      ),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(gatewayDetailPath(gatewayId(2))));
    expect(server.count("POST", "/api/v1/gateways")).toBe(2);
  });
});

describe("러너", () => {
  it("issuing a runner token shows the token once, then opens the runner detail", async () => {
    const server = stubSetupServer();
    const qc = renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "러너" }));
    // 「드러나는 것」 경고는 걷었다(2026-11-10 문구 걷기)
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "새 러너 토큰 발급" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("라벨"), " 맥북 ");
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));

    expect(await within(dialog).findByText(RAW_RUNNER_TOKEN)).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === "POST")).toMatchObject({
      url: "/api/v1/setup/runner-tokens",
      body: { label: "맥북" },
    });
    // 원문 아래에 설치·실행·서버 주소만 — 실행하면 러너가 서버 주소와 토큰을 묻는다(설정 파일 예시·토큰 파일 명령은 걷었다)
    expect([...dialog.querySelectorAll("pre")].map((pre) => pre.textContent)).toEqual([
      RAW_RUNNER_TOKEN,
      llmsHandoffLine("runner", RUNNER_SERVER_URL, RAW_RUNNER_TOKEN),
      "npm i -g @dodok/runner",
      "dodok-runner",
      RUNNER_SERVER_URL,
    ]);
    for (const name of ["설치 명령 복사", "실행 명령 복사", "서버 주소 복사"])
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("config.json");
    expect(dialog).not.toHaveTextContent("chmod");
    expect(cacheDump(qc)).not.toContain("drn_");

    // 원문이 보이는 동안은 Esc 로 닫히지 않는다
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // 그 러너 상세로 — 아직 붙은 적이 없어 설치 안내가 펼친 채, 토큰 줄에는 prefix 만
    await waitFor(() => expect(qc.router.state.location.pathname).toBe(runnerDetailPath(tokenId(8))));
    const detail = await screen.findByTestId("runner-detail");
    expect(within(detail).getByRole("group", { name: "설치 안내" })).toHaveAttribute("open");
    const row = await within(detail).findByRole("listitem", { name: "맥북" });
    expect(row).toHaveTextContent(`drn_${RAW_RUNNER_TOKEN.slice(4, 10)}…`);
    expect(document.body).not.toHaveTextContent(RAW_RUNNER_TOKEN);
    expect(cacheDump(qc)).not.toContain(RAW_RUNNER_TOKEN);
  });

  it("member 가 발급하면 그 러너 상세가 곧바로 관리 꼴이다 — 실시간 알림 없이도 연결 목록을 다시 받는다", async () => {
    const ME_ID = "0190a000-0000-7000-8000-0000000000d1";
    const MEMBER = { ...ME, user: { ...ME.user, id: ME_ID }, role: "member" };
    let issued = false;
    const server = stubSetupServer({
      me: MEMBER,
      connections: () => ({
        gateways: [],
        runners: issued
          ? [
              {
                id: tokenId(8),
                label: "맥북",
                connected: false,
                revoked: false,
                owner: { id: ME_ID, name: "나" },
              },
            ]
          : [],
        projects: [],
      }),
    });
    const qc = renderNew(MEMBER);
    // 발급 전에 연결 목록을 한 번 받아 둔다(트리)
    await waitFor(() => expect(server.count("GET", "/api/v1/connections")).toBeGreaterThan(0));
    await userEvent.click(await screen.findByRole("radio", { name: "러너" }));
    await userEvent.click(await screen.findByRole("button", { name: "새 러너 토큰 발급" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("라벨"), "맥북");
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
    await within(dialog).findByText(RAW_RUNNER_TOKEN);
    issued = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(qc.router.state.location.pathname).toBe(runnerDetailPath(tokenId(8))));
    const detail = await screen.findByTestId("runner-detail");
    expect(await within(detail).findByRole("group", { name: "설치 안내" })).toBeInTheDocument();
    expect(screen.queryByText("이 연결을 찾을 수 없습니다")).toBeNull();
  });
});
