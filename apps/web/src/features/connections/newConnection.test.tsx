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

// 연결 추가(연결 탭 통합 스펙 3.3) — Gateway 는 폼 → 그 상세, 러너는 드러나는 것 넷 → 토큰 발급 → 그 상세. 1단계는 owner 만

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderNew = (me: unknown = OWNER) => renderConnection(me, undefined, "/settings/connection/new");
/** Gateway 갈래(처음 고른 것)의 폼 */
const openAdd = () => screen.findByRole("form", { name: "Gateway 추가" });

describe("권한", () => {
  it.each(["admin", "member"])("non-owner sees no access in stage 1 — %s", async (role) => {
    const server = stubSetupServer();
    renderNew({ ...ME, role });
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Gateway 추가" })).toBeNull();
    expect(server.setupCalls()).toEqual([]);
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
  it("issuing a runner token shows the token once, the four exposure lines, then opens the runner detail", async () => {
    const server = stubSetupServer();
    const qc = renderNew();
    await userEvent.click(await screen.findByRole("radio", { name: "러너" }));
    // 발급 전에 「드러나는 것」 네 줄 전부가 펼친 채
    const note = await screen.findByRole("note");
    expect(within(note).getAllByRole("listitem")).toHaveLength(4);
    await userEvent.click(await screen.findByRole("button", { name: "새 러너 토큰 발급" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("라벨"), " 맥북 ");
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));

    expect(await within(dialog).findByText(RAW_RUNNER_TOKEN)).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === "POST")).toMatchObject({
      url: "/api/v1/setup/runner-tokens",
      body: { label: "맥북" },
    });
    const config = JSON.parse(within(dialog).getByTestId("runner-config").textContent ?? "");
    // 러너 RunnerConfig 꼴 — 에이전트는 앱에서 만든다(agents 키가 있으면 러너가 거절한다), 루트 label 을 적는 예
    expect(config).toEqual({
      serverUrl: RUNNER_SERVER_URL,
      tokenFile: "~/.dodok-runner/token",
      maxConcurrentRuns: 3,
      roots: [{ id: "src", path: "~/src", label: "내 저장소들" }],
      browse: true,
      programs: {
        claude: {
          maxPermissionMode: "default",
          disallowedTools: [],
          allowedToolsCeiling: null,
        },
      },
    });
    // 기본은 평소 claude 로그인 — 예시에 configDir 이 없다(적으면 전용 로그인)
    expect("configDir" in config.programs.claude).toBe(false);
    // 설정 파일에는 원문을 두지 않는다 — tokenFile 에 둔다
    expect(JSON.stringify(config)).not.toContain("drn_");
    expect(dialog).toHaveTextContent("~/.dodok-runner/token");
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
});
