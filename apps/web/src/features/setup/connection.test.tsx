import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SetupStatus } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { ME, json } from "../../../test/shellApi";
import {
  PUBLIC_URL,
  SHA_A,
  SHA_B,
  SHA_FILE,
  renderConnection,
  statusOf,
  stubSetupServer,
  tokenId,
  tokenOf,
} from "../../../test/setupServer";
import { installCommands } from "./sections";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const region = (name: string) => screen.findByRole("region", { name });

describe("권한", () => {
  it("owner 가 아니면 「권한이 없습니다」 — setup API 를 부르지 않는다", async () => {
    const server = stubSetupServer();
    renderConnection({ ...ME, role: "member" });
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Gateway" })).not.toBeInTheDocument();
    expect(server.setupCalls()).toEqual([]);
  });

  it("role 이 없는 옛 me 도 owner 가 아닌 것으로 본다", async () => {
    const server = stubSetupServer();
    renderConnection(ME);
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(server.setupCalls()).toEqual([]);
  });
});

describe("서버·Gateway", () => {
  it("서버 버전, Gateway 상태·호스트·버전", async () => {
    stubSetupServer({ status: statusOf({ server: { version: "1.2.3" } }) });
    renderConnection();
    expect(await within(await region("서버")).findByText(/1\.2\.3/)).toBeInTheDocument();
    const gw = await region("Gateway");
    expect(within(gw).getByText("연결됨")).toBeInTheDocument();
    expect(within(gw).getByText("gateway.example.com")).toBeInTheDocument();
    expect(within(gw).getByText(/2026\.9\.5/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "연결" })).toBeInTheDocument();
  });

  it("down 이면 .env 의 Gateway URL·토큰과 서버 로그를 보라고 안내한다", async () => {
    stubSetupServer({ status: statusOf({ gateway: { state: "down", version: null } }) });
    renderConnection();
    const gw = await region("Gateway");
    expect(await within(gw).findByText("연결 안 됨")).toBeInTheDocument();
    expect(gw).toHaveTextContent("OPENCLAW_GATEWAY_URL");
    expect(gw).toHaveTextContent("OPENCLAW_GATEWAY_TOKEN");
    expect(gw).toHaveTextContent("서버 로그");
  });

  it.each(["connected", "reconnecting"] as const)(
    "%s 이면(페어링 대기도 아니면) .env·서버 로그 안내가 없다",
    async (state) => {
      stubSetupServer({ status: statusOf({ gateway: { state } }) });
      renderConnection();
      const gw = await region("Gateway");
      expect(
        await within(gw).findByText(state === "connected" ? "연결됨" : "다시 연결하는 중"),
      ).toBeInTheDocument();
      expect(gw).not.toHaveTextContent("OPENCLAW_GATEWAY_URL");
      expect(gw).not.toHaveTextContent("서버 로그");
    },
  );

  it("페어링 대기 — 요청 id 와 승인 명령을 복사한다, 5분 전에는 강조하지 않는다", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    stubSetupServer({
      status: statusOf({ gateway: { state: "reconnecting", pairing: { requestId: "req-123", since } } }),
    });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderConnection();
    const gw = await region("Gateway");
    expect(await within(gw).findByText("openclaw devices approve req-123")).toBeInTheDocument();
    expect(gw).toHaveTextContent("req-123");
    expect(within(gw).queryByText(/5분 넘게/)).not.toBeInTheDocument();
    await userEvent.click(within(gw).getByRole("button", { name: "승인 명령 복사" }));
    expect(writeText).toHaveBeenCalledWith("openclaw devices approve req-123");
    expect(await within(gw).findByText("복사됨")).toBeInTheDocument();
  });

  it("페어링 대기가 5분을 넘으면 강조한다", async () => {
    const since = new Date(Date.now() - 6 * 60_000).toISOString();
    stubSetupServer({
      status: statusOf({ gateway: { state: "reconnecting", pairing: { requestId: "req-123", since } } }),
    });
    renderConnection();
    const gw = await region("Gateway");
    expect(await within(gw).findByText(/5분 넘게 승인을 기다리고 있습니다/)).toBeInTheDocument();
  });

  it("요청 id 를 받지 못했으면 approve 명령 대신 devices list 로 찾으라고 한다", async () => {
    stubSetupServer({
      status: statusOf({
        gateway: { state: "reconnecting", pairing: { requestId: "", since: new Date().toISOString() } },
      }),
    });
    renderConnection();
    const gw = await region("Gateway");
    expect(await within(gw).findByText(/요청 id 를 받지 못했습니다/)).toBeInTheDocument();
    expect(within(gw).getByText("openclaw devices list")).toBeInTheDocument();
    expect(gw).not.toHaveTextContent("devices approve");
  });

  it("복사가 실패하면 직접 선택해 복사하라고 알린다", async () => {
    stubSetupServer({
      status: statusOf({
        gateway: { state: "reconnecting", pairing: { requestId: "req-9", since: new Date().toISOString() } },
      }),
    });
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    renderConnection();
    const gw = await region("Gateway");
    await userEvent.click(await within(gw).findByRole("button", { name: "승인 명령 복사" }));
    expect(await within(gw).findByText(/직접 선택해 복사하세요/)).toBeInTheDocument();
  });
});

describe("플러그인", () => {
  it("접속·SDK·Gateway 버전, 같은 빌드, 받기(sha256)와 설치 명령", async () => {
    stubSetupServer();
    renderConnection();
    const pl = await region("플러그인");
    expect(await within(pl).findByText("서버와 같은 빌드입니다")).toBeInTheDocument();
    expect(pl).toHaveTextContent("2026.9.4");
    expect(pl).toHaveTextContent("2026.9.5");
    expect(pl).toHaveTextContent(SHA_FILE);
    expect(within(pl).getByRole("button", { name: "플러그인 받기" })).toBeInTheDocument();
    // 받은 파일 이름·번들 sha256(파일 sha 가 아니다)을 넣은 deploy.md [B] 줄들 — 대조는 아래 테스트
    const cmd = within(pl).getByTestId("plugin-install-commands").textContent ?? "";
    expect(cmd).toBe(installCommands("dodok-openclaw-plugin-ffffffffffff.tgz", SHA_A));
    expect(cmd).toContain("openclaw plugins install /tmp/dodok-openclaw-plugin-ffffffffffff.tgz ");
    expect(cmd).not.toContain(SHA_FILE);
    // 명령은 줄 구조를 지키고 넘치는 폭은 제 상자 안에서 스크롤한다(줄을 바꾸면 한 명령이 두 줄로 읽힌다)
    const block = within(pl).getByTestId("plugin-install-commands");
    expect(block).toHaveClass("whitespace-pre", "overflow-x-auto");
    expect(block.parentElement).toHaveClass("min-w-0");
  });

  it("설치 명령은 deploy.md [B] 블록과 글자 그대로 같다 — 계정 설정 패치 줄만 빼고, 파일 이름과 대조할 sha 만 다르다", () => {
    const doc = readFileSync(resolve(import.meta.dirname, "../../../../../docs/guides/deploy.md"), "utf8");
    const from = doc.indexOf("[B] — **Gateway 를 먼저 내리고**");
    expect(from).toBeGreaterThan(-1);
    const block = /```bash\n([\s\S]*?)```/.exec(doc.slice(from))?.[1] ?? "";
    const docLines = block.trimEnd().split("\n");
    const patch = docLines.filter((l) => l.startsWith("openclaw config patch "));
    expect(patch).toHaveLength(1);
    const expected = docLines.filter((l) => !patch.includes(l));
    // deploy.md 가 옮기는 파일 이름을 넣으면 설치 줄까지 글자 그대로 같아야 한다
    const web = installCommands("dodok-openclaw-plugin-0.0.0.tgz", SHA_A).split("\n");
    expect(web).toHaveLength(expected.length);
    web.forEach((line, i) => {
      const want = expected[i] ?? "";
      if (!want.startsWith("sha256sum ")) return expect(line).toBe(want);
      // 명령과 「기본 상태 디렉터리일 때」 단서는 그대로, 대조할 값만 [PC] 에서 잰 값 대신 서버가 품은 번들의 sha
      const [command, comment] = want.split("# ");
      expect(comment?.startsWith("기본 상태 디렉터리일 때. ")).toBe(true);
      expect(line.startsWith(`${command}# 기본 상태 디렉터리일 때. ${SHA_A} 이어야 한다`)).toBe(true);
    });
  });

  it("다른 빌드면 「받아서 다시 설치」 경고", async () => {
    stubSetupServer({ status: statusOf({ plugin: { bundleSha256: SHA_B }, pluginMatches: false }) });
    renderConnection();
    const pl = await region("플러그인");
    expect(await within(pl).findByText(/다른 빌드입니다 — 받아서 다시 설치하세요/)).toBeInTheDocument();
    expect(within(pl).queryByText("서버와 같은 빌드입니다")).not.toBeInTheDocument();
  });

  it("옛 플러그인(bundleSha256 없음)이면 「빌드를 알 수 없습니다」", async () => {
    stubSetupServer({ status: statusOf({ plugin: { bundleSha256: null }, pluginMatches: null }) });
    renderConnection();
    const pl = await region("플러그인");
    expect(await within(pl).findByText(/빌드를 알 수 없습니다 — 새로 받아 설치하세요/)).toBeInTheDocument();
    expect(within(pl).queryByText(/다른 빌드/)).not.toBeInTheDocument();
    expect(within(pl).queryByText("서버와 같은 빌드입니다")).not.toBeInTheDocument();
  });

  it("접속한 플러그인이 없으면 그렇게 말하고 빌드 비교 문구는 없다", async () => {
    stubSetupServer({ status: statusOf({ plugin: null, pluginMatches: null }) });
    renderConnection();
    const pl = await region("플러그인");
    expect(await within(pl).findByText(/접속한 플러그인이 없습니다/)).toBeInTheDocument();
    expect(within(pl).queryByText(/빌드를 알 수 없습니다/)).not.toBeInTheDocument();
    expect(within(pl).queryByText(/같은 빌드/)).not.toBeInTheDocument();
  });

  it("서버에 플러그인 파일이 없으면 받기 대신 만드는 법", async () => {
    stubSetupServer({ status: statusOf({ pluginFile: { available: false }, pluginMatches: null }) });
    renderConnection();
    const pl = await region("플러그인");
    expect(await within(pl).findByText("pnpm -F @dodok/openclaw-plugin run pack:plugin")).toBeInTheDocument();
    expect(within(pl).queryByRole("button", { name: "플러그인 받기" })).not.toBeInTheDocument();
    // 번들 sha 를 보낸 플러그인이어도 서버 쪽을 모르면 「새로 받아」라고 하지 않는다
    expect(within(pl).queryByText(/새로 받아 설치하세요/)).not.toBeInTheDocument();
  });

  it("받기는 파일을 내려받는다 — 서버가 준 이름으로", async () => {
    const server = stubSetupServer();
    const createObjectURL = vi.fn(() => "blob:plugin");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.download}|${this.getAttribute("href")}`);
    });
    renderConnection();
    const pl = await region("플러그인");
    await userEvent.click(await within(pl).findByRole("button", { name: "플러그인 받기" }));
    await waitFor(() => expect(clicks).toEqual(["dodok-openclaw-plugin-ffffffffffff.tgz|blob:plugin"]));
    expect(server.count("GET", "/api/v1/setup/plugin.tgz")).toBe(1);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:plugin"));
  });

  it("받기 404 PLUGIN_FILE_MISSING 이면 만드는 법을, 409 PLUGIN_FILE_CHANGED 면 재시작을 안내한다", async () => {
    let reply = () => json(404, { code: "NOT_FOUND", message: "PLUGIN_FILE_MISSING" });
    stubSetupServer({ plugin: () => reply() });
    renderConnection();
    const pl = await region("플러그인");
    const button = await within(pl).findByRole("button", { name: "플러그인 받기" });
    await userEvent.click(button);
    expect(await within(pl).findByRole("alert")).toHaveTextContent(
      /서버에서 플러그인 파일을 찾지 못했습니다/,
    );
    expect(within(pl).getByRole("alert")).toHaveTextContent("pack:plugin");

    reply = () =>
      json(409, {
        code: "CONFLICT",
        message: "PLUGIN_FILE_CHANGED: restart the server to serve the rebuilt plugin",
      });
    await userEvent.click(button);
    await waitFor(() =>
      expect(within(pl).getByRole("alert")).toHaveTextContent(/다시 빌드됐습니다 — 서버를 재시작/),
    );
  });
});

describe("브리지 토큰", () => {
  it("목록 — 라벨·dbt_ 앞 6자·지금 접속 중·폐기됨, 이어받은 env 줄은 prefix 대신 「.env 에서 이어받음」", async () => {
    stubSetupServer({
      tokens: [
        tokenOf(1, { label: "env", prefix: "abc123", connected: true }),
        tokenOf(2, { label: "노트북", prefix: "xyz789" }),
        tokenOf(3, { label: "옛것", prefix: "old000", revokedAt: "2026-09-24T00:00:00.000Z" }),
      ],
    });
    renderConnection();
    const br = await region("브리지 토큰");
    const envRow = await within(br).findByRole("listitem", { name: "env" });
    expect(envRow).toHaveTextContent(".env 에서 이어받음");
    expect(envRow).not.toHaveTextContent("abc123");
    expect(envRow).toHaveTextContent("지금 접속 중");
    const row2 = within(br).getByRole("listitem", { name: "노트북" });
    expect(row2).toHaveTextContent("dbt_xyz789…");
    expect(row2).not.toHaveTextContent("지금 접속 중");
    const row3 = within(br).getByRole("listitem", { name: "옛것" });
    expect(row3).toHaveTextContent("폐기됨");
    expect(within(row3).queryByRole("button", { name: /폐기/ })).not.toBeInTheDocument();
    expect(br).toHaveTextContent(PUBLIC_URL);
  });

  it("라벨이 env 와 정확히 같을 때만 이어받은 줄이다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { label: "env2", prefix: "abc123" })] });
    renderConnection();
    const br = await region("브리지 토큰");
    const row = await within(br).findByRole("listitem", { name: "env2" });
    expect(row).toHaveTextContent("dbt_abc123…");
    expect(row).not.toHaveTextContent(".env 에서 이어받음");
  });

  it("활성 토큰이 0개면 「토큰이 없습니다 — 발급하세요」", async () => {
    stubSetupServer({
      status: statusOf({ plugin: null, pluginMatches: null }),
      tokens: [tokenOf(1, { revokedAt: "2026-09-24T00:00:00.000Z" })],
    });
    renderConnection();
    const br = await region("브리지 토큰");
    expect(await within(br).findByText("토큰이 없습니다 — 발급하세요")).toBeInTheDocument();
  });

  it("폐기된 줄이 있어도 활성 토큰이 하나라도 있으면 「토큰이 없습니다」가 없다", async () => {
    stubSetupServer({
      status: statusOf({ plugin: { tokenId: tokenId(2) } }),
      tokens: [tokenOf(1, { revokedAt: "2026-09-24T00:00:00.000Z" }), tokenOf(2, { connected: true })],
    });
    renderConnection();
    const br = await region("브리지 토큰");
    await within(br).findByRole("listitem", { name: "토큰-2" });
    expect(br).not.toHaveTextContent("토큰이 없습니다");
  });

  it("envTokenIgnored 면 .env 의 BRIDGE_TOKEN 은 더 이상 쓰지 않는다고 한 줄", async () => {
    stubSetupServer({ status: statusOf({ envTokenIgnored: true }), tokens: [tokenOf(1)] });
    renderConnection();
    const br = await region("브리지 토큰");
    expect(
      await within(br).findByText(
        ".env 의 BRIDGE_TOKEN 은 더 이상 쓰지 않습니다 — 연결 페이지에서 발급하세요",
      ),
    ).toBeInTheDocument();
  });

  it("envTokenIgnored 가 거짓이면 그 줄이 없다", async () => {
    stubSetupServer({ tokens: [tokenOf(1)] });
    renderConnection();
    const br = await region("브리지 토큰");
    await within(br).findByRole("listitem", { name: "토큰-1" });
    expect(within(br).queryByText(/BRIDGE_TOKEN/)).not.toBeInTheDocument();
  });

  it("교체 — setup.status 로 접속 토큰이 새 것으로 옮겨 가면 「지금 접속 중」이 옮고 옛 줄에 「이제 폐기해도 됩니다」", async () => {
    stubSetupServer({
      status: statusOf({ plugin: { tokenId: tokenId(1) } }),
      tokens: [tokenOf(1, { connected: true }), tokenOf(2)],
    });
    const qc = renderConnection();
    const br = await region("브리지 토큰");
    const oldRow = await within(br).findByRole("listitem", { name: "토큰-1" });
    const newRow = within(br).getByRole("listitem", { name: "토큰-2" });
    await waitFor(() => expect(oldRow).toHaveTextContent("지금 접속 중"));
    // 새 토큰을 막 발급했을 뿐이면 어느 쪽도 폐기 권유가 없다
    expect(br).not.toHaveTextContent("이제 폐기해도 됩니다");

    act(() => {
      qc.setQueryData<SetupStatus>(qk.setupStatus, statusOf({ plugin: { tokenId: tokenId(2) } }));
    });
    await waitFor(() => expect(newRow).toHaveTextContent("지금 접속 중"));
    expect(oldRow).not.toHaveTextContent("지금 접속 중");
    expect(oldRow).toHaveTextContent("이제 폐기해도 됩니다");
    expect(newRow).not.toHaveTextContent("이제 폐기해도 됩니다");
  });

  it("이미 폐기한 옛 줄에는 「이제 폐기해도 됩니다」가 없다", async () => {
    stubSetupServer({
      status: statusOf({ plugin: { tokenId: tokenId(2) } }),
      tokens: [tokenOf(1, { revokedAt: "2026-09-24T00:00:00.000Z" }), tokenOf(2, { connected: true })],
    });
    renderConnection();
    const br = await region("브리지 토큰");
    const oldRow = await within(br).findByRole("listitem", { name: "토큰-1" });
    await waitFor(() =>
      expect(within(br).getByRole("listitem", { name: "토큰-2" })).toHaveTextContent("지금 접속 중"),
    );
    expect(oldRow).toHaveTextContent("폐기됨");
    expect(br).not.toHaveTextContent("이제 폐기해도 됩니다");
  });

  describe("폐기", () => {
    it("접속 중이 아닌 토큰 — 확인 한 번 뒤 DELETE, 목록을 다시 받는다", async () => {
      const server = stubSetupServer({
        status: statusOf({ plugin: { tokenId: tokenId(2) } }),
        tokens: [tokenOf(1), tokenOf(2, { connected: true })],
      });
      renderConnection();
      const br = await region("브리지 토큰");
      const row = await within(br).findByRole("listitem", { name: "토큰-1" });
      await userEvent.click(within(row).getByRole("button", { name: "토큰-1 폐기" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).not.toHaveTextContent("에이전트가 멈춥니다");
      await userEvent.click(within(dialog).getByRole("button", { name: "폐기" }));
      await waitFor(() => expect(row).toHaveTextContent("폐기됨"));
      expect(server.count("DELETE", `/api/v1/setup/bridge-tokens/${tokenId(1)}`)).toBe(1);
    });

    it("접속 중인 토큰 — 「에이전트가 멈춥니다」 확인, 다른 활성 토큰이 있으면 한 번으로 끝", async () => {
      const server = stubSetupServer({
        status: statusOf({ plugin: { tokenId: tokenId(1) } }),
        tokens: [tokenOf(1, { connected: true }), tokenOf(2)],
      });
      renderConnection();
      const br = await region("브리지 토큰");
      const row = await within(br).findByRole("listitem", { name: "토큰-1" });
      await userEvent.click(within(row).getByRole("button", { name: "토큰-1 폐기" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("에이전트가 멈춥니다");
      await userEvent.click(within(dialog).getByRole("button", { name: "폐기" }));
      await waitFor(() =>
        expect(server.count("DELETE", `/api/v1/setup/bridge-tokens/${tokenId(1)}`)).toBe(1),
      );
    });

    it("마지막 활성 토큰 — 두 번째 확인까지 가야 DELETE, 두 번째에서 취소하면 보내지 않는다", async () => {
      const server = stubSetupServer({
        status: statusOf({ plugin: { tokenId: tokenId(1) } }),
        tokens: [tokenOf(1, { connected: true }), tokenOf(2, { revokedAt: "2026-09-24T00:00:00.000Z" })],
      });
      renderConnection();
      const br = await region("브리지 토큰");
      const row = await within(br).findByRole("listitem", { name: "토큰-1" });
      const url = `/api/v1/setup/bridge-tokens/${tokenId(1)}`;

      await userEvent.click(within(row).getByRole("button", { name: "토큰-1 폐기" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "폐기" }));
      const second = await screen.findByRole("dialog");
      await waitFor(() => expect(second).toHaveTextContent("활성 토큰이 하나도 남지 않습니다"));
      expect(server.count("DELETE", url)).toBe(0);
      await userEvent.click(within(second).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(server.count("DELETE", url)).toBe(0);

      await userEvent.click(within(row).getByRole("button", { name: "토큰-1 폐기" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "폐기" }));
      await waitFor(() =>
        expect(screen.getByRole("dialog")).toHaveTextContent("활성 토큰이 하나도 남지 않습니다"),
      );
      const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "그래도 폐기" });
      await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 });
      await userEvent.click(confirm);
      await waitFor(() => expect(server.count("DELETE", url)).toBe(1));
    });

    describe("마지막 활성 토큰의 두 번째 확인은 첫 확인의 입력이 번지지 않는다", () => {
      const url = `/api/v1/setup/bridge-tokens/${tokenId(1)}`;
      async function openFirst() {
        const server = stubSetupServer({
          status: statusOf({ plugin: { tokenId: tokenId(1) } }),
          tokens: [tokenOf(1, { connected: true })],
        });
        renderConnection();
        const br = await region("브리지 토큰");
        const row = await within(br).findByRole("listitem", { name: "토큰-1" });
        await userEvent.click(within(row).getByRole("button", { name: "토큰-1 폐기" }));
        const dialog = await screen.findByRole("dialog");
        return { server, dialog, first: within(dialog).getByRole("button", { name: "폐기" }) };
      }

      it("두 번째 단계 — 확인 버튼은 새 요소로 취소의 반대편에, 잠깐 잠겨 있고, 초점은 취소", async () => {
        const { server, dialog, first } = await openFirst();
        const footer = first.parentElement;
        expect([...(footer?.children ?? [])].map((b) => b.textContent)).toEqual(["취소", "폐기"]);
        await userEvent.click(first);
        await waitFor(() => expect(dialog).toHaveTextContent("활성 토큰이 하나도 남지 않습니다"));
        const confirm = within(dialog).getByRole("button", { name: "그래도 폐기" });
        expect(confirm).not.toBe(first);
        expect([...(confirm.parentElement?.children ?? [])].map((b) => b.textContent)).toEqual([
          "그래도 폐기",
          "취소",
        ]);
        expect(confirm).toBeDisabled();
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus());
        // 새 제목을 알린다 — 열린 대화상자의 제목이 바뀌는 것만으로는 다시 읽히지 않는다
        expect(dialog.querySelector('[aria-live="assertive"]')).toHaveTextContent(
          "활성 토큰이 하나도 남지 않습니다",
        );
        await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 2000 });
        expect(server.count("DELETE", url)).toBe(0);
      });

      it("「폐기」 더블클릭은 DELETE 를 보내지 않는다", async () => {
        const { server, dialog, first } = await openFirst();
        await userEvent.dblClick(first);
        await waitFor(() => expect(dialog).toHaveTextContent("활성 토큰이 하나도 남지 않습니다"));
        expect(server.count("DELETE", url)).toBe(0);
      });

      it("잠긴 동안 「그래도 폐기」를 눌러도 보내지 않는다", async () => {
        const { server, dialog, first } = await openFirst();
        await userEvent.click(first);
        await userEvent.click(await within(dialog).findByRole("button", { name: "그래도 폐기" }));
        expect(server.count("DELETE", url)).toBe(0);
      });

      it.each([
        ["Enter 두 번", "{Enter}{Enter}"],
        ["Enter 키 반복", "{Enter>6}"],
        ["스페이스 두 번", "[Space][Space]"],
      ])("%s은 DELETE 를 보내지 않는다", async (_name, keys) => {
        const { server, first } = await openFirst();
        first.focus();
        await userEvent.keyboard(keys);
        await new Promise((r) => setTimeout(r, 50));
        expect(server.count("DELETE", url)).toBe(0);
      });
    });

    it("폐기한 뒤 초점은 아래 줄의 「폐기」로, 아래에 활성 줄이 없으면 「새 토큰 발급」으로", async () => {
      stubSetupServer({
        status: statusOf({ plugin: { tokenId: tokenId(1) } }),
        tokens: [
          tokenOf(1, { connected: true }),
          tokenOf(2),
          tokenOf(3, { revokedAt: "2026-09-24T00:00:00.000Z" }),
          tokenOf(4),
        ],
      });
      renderConnection();
      const br = await region("브리지 토큰");
      const revokeOf = (n: number) => within(br).getByRole("button", { name: `토큰-${n} 폐기` });
      await within(br).findByRole("listitem", { name: "토큰-2" });

      // 바로 아래(3)는 폐기된 줄이라 건너뛴다
      await userEvent.click(revokeOf(2));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "폐기" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(revokeOf(4)).toHaveFocus());

      await userEvent.click(revokeOf(4));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "폐기" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(within(br).getByRole("button", { name: "새 토큰 발급" })).toHaveFocus());
    });
  });
});
