import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json } from "../../../test/shellApi";
import { agentOf } from "../../../test/settingsServer";
import {
  GATEWAY_ID,
  gatewayId,
  gatewayOf,
  renderConnection,
  statusOf,
  stubSetupServer,
  tokenOf,
  tokensPath,
} from "../../../test/setupServer";

// 연결 페이지의 Gateway 카드 목록(멀티 Gateway 스펙 「웹」 절의 「연결 페이지」)

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const region = (name: string, root: HTMLElement = document.body) =>
  within(root).findByRole("region", { name });
const block = () => region("OpenClaw Gateway");

/** 「사무실」(첫 Gateway, 플러그인 접속)과 「집」(페어링 대기) */
const TWO = statusOf({
  moreGateways: [
    gatewayOf(2, {
      name: "집",
      url: "ws://home.lan:18789",
      gateway: {
        state: "reconnecting",
        host: "home.lan",
        pairing: { requestId: "req-home", since: new Date().toISOString() },
      },
    }),
  ],
});

async function openAdd() {
  await userEvent.click(within(await block()).getByRole("button", { name: "Gateway 추가" }));
  return screen.findByRole("dialog");
}

describe("Gateway 추가", () => {
  it("빈 상태에서도 「Gateway 추가」 — 이름·주소·토큰을 보내고, 대화상자를 닫고 상태를 다시 받는다", async () => {
    const server = stubSetupServer({ status: statusOf({ noGateway: true, plugin: null }) });
    renderConnection();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), " 집 ");
    await userEvent.type(within(dialog).getByLabelText("주소"), " wss://home.example.com ");
    await userEvent.type(within(dialog).getByLabelText("토큰"), " gw-secret ");
    await userEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      url: "/api/v1/gateways",
      body: { name: "집", url: "wss://home.example.com", token: "gw-secret" },
    });
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBe(2));
  });

  it("비운 칸은 칸마다 고정 문구, 보내지 않는다", async () => {
    const server = stubSetupServer();
    renderConnection();
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
    renderConnection();
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
    renderConnection();
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
    renderConnection();
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
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("두 번 보내지 않기(태스크 6 리뷰 Minor 1)", () => {
  it("「추가」를 같은 틱에 두 번 내도 POST 는 한 번 — 둘째가 409 로 대화상자를 붙잡지 않게", async () => {
    const server = stubSetupServer();
    renderConnection();
    const dialog = await openAdd();
    await userEvent.type(within(dialog).getByLabelText("이름"), "집");
    await userEvent.type(within(dialog).getByLabelText("주소"), "wss://home.example.com");
    await userEvent.type(within(dialog).getByLabelText("토큰"), "t");
    const form = dialog.querySelector("form");
    if (!form) throw new Error("form 이 없다");
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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
    renderConnection();
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
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.count("POST", "/api/v1/gateways")).toBe(2);
  });
});

describe("카드 목록", () => {
  it("Gateway 마다 카드 하나 — 같은 블록(상태·플러그인·브리지 토큰·메뉴)이 카드마다", async () => {
    stubSetupServer({ status: TWO });
    renderConnection();
    const office = await region("사무실");
    const home = await region("집");
    for (const card of [office, home]) {
      expect(await region("플러그인", card)).toBeInTheDocument();
      expect(await region("브리지 토큰", card)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "새 토큰 발급" })).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: /수정$/ })).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: /끄기$/ })).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: /삭제$/ })).toBeInTheDocument();
    }
    expect(office).toHaveTextContent("연결됨");
    expect(office).toHaveTextContent("gateway.example.com");
    expect(within(await region("플러그인", office)).getByText("서버와 같은 빌드입니다")).toBeInTheDocument();
    expect(home).toHaveTextContent("페어링 대기");
    expect(home).toHaveTextContent("home.lan");
    expect(
      within(await region("플러그인", home)).getByText(/접속한 플러그인이 없습니다/),
    ).toBeInTheDocument();
    // 플러그인 받기는 카드가 아니라 블록 머리에 하나
    expect(screen.getAllByRole("button", { name: "플러그인 받기" })).toHaveLength(1);
  });

  it("페어링 대기 카드는 그 Gateway 의 요청 id 로 승인 명령을 복사한다", async () => {
    stubSetupServer({ status: TWO });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderConnection();
    const home = await region("집");
    expect(within(home).getByText("openclaw devices approve req-home")).toBeInTheDocument();
    expect(within(await region("사무실")).queryByText(/devices approve/)).not.toBeInTheDocument();
    await userEvent.click(within(home).getByRole("button", { name: "승인 명령 복사" }));
    expect(writeText).toHaveBeenCalledWith("openclaw devices approve req-home");
  });

  it("브리지 토큰 목록·발급은 그 카드의 Gateway 경로로", async () => {
    const server = stubSetupServer({
      status: TWO,
      tokens: [tokenOf(1, { label: "사무실-토큰", connected: true })],
      gatewayTokens: { [gatewayId(2)]: [tokenOf(2, { label: "집-토큰" })] },
    });
    renderConnection();
    const home = await region("집");
    const homeTokens = await region("브리지 토큰", home);
    expect(await within(homeTokens).findByRole("listitem", { name: "집-토큰" })).toBeInTheDocument();
    expect(within(homeTokens).queryByRole("listitem", { name: "사무실-토큰" })).not.toBeInTheDocument();

    await userEvent.click(within(homeTokens).getByRole("button", { name: "새 토큰 발급" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("라벨"), "집 호스트");
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
    await within(dialog).findByRole("button", { name: "복사했습니다" });
    expect(server.calls.filter((c) => c.method === "POST")).toEqual([
      { method: "POST", url: tokensPath(gatewayId(2)), body: { label: "집 호스트" } },
    ]);
  });
});

describe("수정", () => {
  async function openEdit(name: string) {
    const card = await region(name);
    await userEvent.click(within(card).getByRole("button", { name: `${name} 수정` }));
    return screen.findByRole("dialog");
  }

  it("지금 이름·주소로 열리고, 토큰 칸은 비어 「바꾸려면 입력」 — 비워 두면 본문에 토큰이 없다", async () => {
    const server = stubSetupServer({ status: TWO });
    renderConnection();
    const dialog = await openEdit("집");
    expect(within(dialog).getByLabelText("이름")).toHaveValue("집");
    expect(within(dialog).getByLabelText("주소")).toHaveValue("ws://home.lan:18789");
    const token = within(dialog).getByLabelText("토큰");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("placeholder", "바꾸려면 입력");
    await userEvent.clear(within(dialog).getByLabelText("이름"));
    await userEvent.type(within(dialog).getByLabelText("이름"), "본가");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const patch = server.calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe(`/api/v1/gateways/${gatewayId(2)}`);
    // 이름만 — 주소·토큰을 싣지 않아 어댑터가 다시 붙지 않는다(Review Focus 1)
    expect(patch?.body).toEqual({ name: "본가" });
  });

  it("토큰을 입력하면 그것만 싣는다", async () => {
    const server = stubSetupServer({ status: TWO });
    renderConnection();
    const dialog = await openEdit("집");
    await userEvent.type(within(dialog).getByLabelText("토큰"), " new-secret ");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.count("PATCH", `/api/v1/gateways/${gatewayId(2)}`)).toBe(1));
    expect(server.calls.find((c) => c.method === "PATCH")?.body).toEqual({ token: "new-secret" });
  });

  it("수정에서도 http:// 주소는 거절한다", async () => {
    const server = stubSetupServer({ status: TWO });
    renderConnection();
    const dialog = await openEdit("집");
    await userEvent.clear(within(dialog).getByLabelText("주소"));
    await userEvent.type(within(dialog).getByLabelText("주소"), "http://home.lan");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(within(dialog).getByLabelText("주소")).toHaveAccessibleDescription(
      "ws:// 또는 wss:// 로 시작하는 주소를 입력하세요.",
    );
    expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("바꾼 것이 없으면 보내지 않고 닫는다", async () => {
    const server = stubSetupServer({ status: TWO });
    renderConnection();
    const dialog = await openEdit("집");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });
});

describe("끄기·켜기", () => {
  it("켜진 Gateway 는 「끄기」, 꺼진 Gateway 는 「켜기」 — enabled 만 보낸다", async () => {
    const server = stubSetupServer({
      status: statusOf({
        moreGateways: [
          gatewayOf(2, { name: "집", enabled: false, gateway: { state: "disabled", version: null } }),
        ],
      }),
    });
    renderConnection();
    const office = await region("사무실");
    const home = await region("집");
    expect(within(home).getByText("꺼짐")).toBeInTheDocument();
    expect(within(home).queryByRole("button", { name: "집 끄기" })).not.toBeInTheDocument();

    await userEvent.click(within(office).getByRole("button", { name: "사무실 끄기" }));
    await userEvent.click(within(home).getByRole("button", { name: "집 켜기" }));
    await waitFor(() => expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", url: `/api/v1/gateways/${GATEWAY_ID}`, body: { enabled: false } },
      { method: "PATCH", url: `/api/v1/gateways/${gatewayId(2)}`, body: { enabled: true } },
    ]);
  });
});

describe("지워진 Gateway·서버 실패 문구(태스크 6 리뷰 Minor 2)", () => {
  it("끄기가 404 면 「이미 삭제된 Gateway 입니다」 — 서버 문구는 보이지 않고 상태를 다시 받는다", async () => {
    const toastError = vi.spyOn(toast, "error");
    const server = stubSetupServer({
      status: TWO,
      updateGateway: () => json(404, { code: "NOT_FOUND", message: "gateway not found" }),
    });
    renderConnection();
    await userEvent.click(within(await region("집")).getByRole("button", { name: "집 끄기" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("이미 삭제된 Gateway 입니다"));
    expect(toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBe(2));
  });

  it("그 밖의 서버 실패도 서버 문구 대신 고정 문구", async () => {
    const toastError = vi.spyOn(toast, "error");
    stubSetupServer({
      status: TWO,
      updateGateway: () => json(500, { code: "INTERNAL", message: "sqlite busy" }),
    });
    renderConnection();
    await userEvent.click(within(await region("집")).getByRole("button", { name: "집 끄기" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Gateway 를 바꾸지 못했습니다. 다시 시도해 주세요."),
    );
    expect(toastError).not.toHaveBeenCalledWith("sqlite busy");
  });
});

describe("삭제", () => {
  const AGENTS = [
    agentOf("0190a000-0000-7000-8000-0000000000b1", "main-home", {
      gateway: { id: gatewayId(2), name: "집" },
    }),
    agentOf("0190a000-0000-7000-8000-0000000000b2", "dev-home", {
      gateway: { id: gatewayId(2), name: "집" },
    }),
    agentOf("0190a000-0000-7000-8000-0000000000b3", "main-office", {
      gateway: { id: GATEWAY_ID, name: "사무실" },
    }),
    agentOf("0190a000-0000-7000-8000-0000000000b4", "orphan", { gateway: null }),
  ];
  const HOME_TOKENS = [tokenOf(2), tokenOf(3), tokenOf(4, { revokedAt: "2026-09-24T00:00:00.000Z" })];

  async function openDelete() {
    const home = await region("집");
    await userEvent.click(within(home).getByRole("button", { name: "집 삭제" }));
    return { home, confirm: await within(home).findByRole("group", { name: "「집」 Gateway 삭제" }) };
  }

  it("페이지 안에서 한 번 더 묻는다 — 그 Gateway 의 에이전트 N개·브리지 토큰 M개(폐기된 것 포함)", async () => {
    const server = stubSetupServer({
      status: TWO,
      agents: AGENTS,
      gatewayTokens: { [gatewayId(2)]: HOME_TOKENS },
    });
    renderConnection();
    const { home, confirm } = await openDelete();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const menu = within(home).getByRole("button", { name: "집 삭제" });
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(menu).toHaveAttribute("aria-controls", confirm.id);
    await waitFor(() =>
      expect(confirm).toHaveTextContent(
        "이 Gateway 의 에이전트 2개는 남고 연결이 비어 옮기기를 기다립니다 · 브리지 토큰 3개가 지워집니다",
      ),
    );
    expect(within(confirm).getByRole("button", { name: "취소" })).toHaveFocus();
    expect(server.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("취소하면 보내지 않고 확인을 접고, 초점은 「삭제」 메뉴로 돌아간다", async () => {
    const server = stubSetupServer({ status: TWO, gatewayTokens: { [gatewayId(2)]: HOME_TOKENS } });
    renderConnection();
    const { home, confirm } = await openDelete();
    await userEvent.click(within(confirm).getByRole("button", { name: "취소" }));
    expect(within(home).queryByRole("group", { name: "「집」 Gateway 삭제" })).not.toBeInTheDocument();
    expect(within(home).getByRole("button", { name: "집 삭제" })).toHaveFocus();
    // 접힌 동안에는 가리킬 영역이 없다
    expect(within(home).getByRole("button", { name: "집 삭제" })).not.toHaveAttribute("aria-controls");
    expect(server.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("「삭제」를 같은 틱에 두 번 눌러도 DELETE 는 한 번", async () => {
    let deleted = false;
    const server = stubSetupServer({
      status: () => (deleted ? statusOf() : TWO),
      gatewayTokens: { [gatewayId(2)]: HOME_TOKENS },
      deleteGateway: () => {
        deleted = true;
        return json(200, { unboundAgents: 0, deletedTokens: 3 });
      },
    });
    renderConnection();
    const { confirm } = await openDelete();
    const del = within(confirm).getByRole("button", { name: "삭제" });
    await waitFor(() => expect(del).toBeEnabled());
    act(() => {
      fireEvent.click(del);
      fireEvent.click(del);
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "집" })).not.toBeInTheDocument());
    expect(server.count("DELETE", `/api/v1/gateways/${gatewayId(2)}`)).toBe(1);
  });

  it("그새 다른 곳에서 지워졌으면(404) 서버 문구 대신 「이미 삭제된 Gateway 입니다」 — 카드를 걷는다", async () => {
    const toastError = vi.spyOn(toast, "error");
    let gone = false;
    stubSetupServer({
      // 서버에는 이미 없다 — 다시 받은 상태에도 없다
      status: () => (gone ? statusOf() : TWO),
      gatewayTokens: { [gatewayId(2)]: HOME_TOKENS },
      deleteGateway: () => {
        gone = true;
        return json(404, { code: "NOT_FOUND", message: "gateway not found" });
      },
    });
    renderConnection();
    const { confirm } = await openDelete();
    const del = within(confirm).getByRole("button", { name: "삭제" });
    await waitFor(() => expect(del).toBeEnabled());
    await userEvent.click(del);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("이미 삭제된 Gateway 입니다"));
    expect(toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("region", { name: "집" })).not.toBeInTheDocument());
  });

  it("다시 받기를 기다리지 않고 카드를 걷는다 — 응답이 늦어도 지운 카드가 남지 않는다", async () => {
    let deleted = false;
    let release: (r: Response) => void = () => {};
    stubSetupServer({
      status: () => (deleted ? new Promise<Response>((resolve) => (release = resolve)) : TWO),
      gatewayTokens: { [gatewayId(2)]: HOME_TOKENS },
      deleteGateway: () => {
        deleted = true;
        return json(200, { unboundAgents: 0, deletedTokens: 3 });
      },
    });
    renderConnection();
    const { confirm } = await openDelete();
    const del = within(confirm).getByRole("button", { name: "삭제" });
    await waitFor(() => expect(del).toBeEnabled());
    await userEvent.click(del);
    await waitFor(() => expect(screen.queryByRole("region", { name: "집" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "사무실" })).toBeInTheDocument();
    release(json(200, statusOf()));
  });

  it("「삭제」를 누르면 DELETE 한 번 — 카드를 곧바로 걷어 지운 Gateway 를 다시 부르지 않고, 「Gateway 추가」로 초점을 옮긴다", async () => {
    let deleted = false;
    const server = stubSetupServer({
      status: () => (deleted ? statusOf() : TWO),
      agents: AGENTS,
      gatewayTokens: { [gatewayId(2)]: HOME_TOKENS },
      deleteGateway: () => {
        deleted = true;
        return json(200, { unboundAgents: 2, deletedTokens: 3 });
      },
    });
    renderConnection();
    const { confirm } = await openDelete();
    const del = within(confirm).getByRole("button", { name: "삭제" });
    await waitFor(() => expect(del).toBeEnabled());
    const agentsBefore = server.count("GET", "/api/v1/agents");
    const tokensBefore = server.count("GET", tokensPath(gatewayId(2)));
    await userEvent.click(del);
    await waitFor(() => expect(server.count("DELETE", `/api/v1/gateways/${gatewayId(2)}`)).toBe(1));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "OpenClaw Gateway" })).getByRole("button", {
          name: "Gateway 추가",
        }),
      ).toHaveFocus(),
    );
    expect(await block()).toHaveTextContent("「집」 Gateway 를 삭제했습니다");
    expect(screen.queryByRole("region", { name: "집" })).not.toBeInTheDocument();
    expect(server.count("GET", "/api/v1/setup/status")).toBeGreaterThanOrEqual(2);
    expect(server.count("GET", "/api/v1/agents")).toBeGreaterThan(agentsBefore);
    // 지운 Gateway 의 토큰 목록을 다시 부르면 404 가 전역 토스트(서버 문구)로 뜬다
    expect(server.count("GET", tokensPath(gatewayId(2)))).toBe(tokensBefore);
  });
});
