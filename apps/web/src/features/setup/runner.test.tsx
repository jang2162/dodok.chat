import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json } from "../../../test/shellApi";
import {
  RAW_REISSUED_TOKEN,
  RUNNER_SERVER_URL,
  SHA_B,
  SHA_FILE,
  SHA_A,
  cacheDump,
  renderConnection as renderRunner,
  runnerDetailPath,
  runnerOf,
  statusOf,
  stubSetupServer as serve,
  tokenId,
  tokenOf,
} from "../../../test/setupServer";
import { ME } from "../../../test/shellApi";
import { llmsHandoffLine } from "./llms";
import {
  RUNNER_LOGIN_BUNDLED_COMMAND,
  RUNNER_LOGIN_COMMAND,
  RUNNER_NPM_INSTALL_COMMAND,
} from "./RunnerSection";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 러너 토큰·설치 안내는 「연결」 탭의 러너 상세(러너 하나 = 러너 토큰 하나)에 있다(연결 탭 통합 스펙 3.3)

/** 토큰을 주지 않은 시험은 러너 「맥북」(토큰 1) 하나 */
const stubSetupServer = (opts: Parameters<typeof serve>[0] = {}) =>
  serve({ ...opts, runnerTokens: opts.runnerTokens ?? [tokenOf(1, { label: "맥북" })] });
/** 러너 상세를 띄운다 — 기본은 토큰 1 */
const renderConnection = (me: unknown = { ...ME, role: "owner" }, n = 1) =>
  renderRunner(me, undefined, runnerDetailPath(tokenId(n)));
const runnerRegion = () => screen.findByTestId("runner-detail");

describe("러너 상세 — 권한·경고", () => {
  it("남의 러너를 연 member 에게는 러너 토큰·설치 안내가 없고 setup API 를 부르지 않는다(연결 탭 통합 스펙 5.2)", async () => {
    const server = stubSetupServer({
      me: { ...ME, role: "member" },
      connections: {
        gateways: [],
        runners: [
          {
            id: tokenId(1),
            label: "맥북",
            connected: false,
            revoked: false,
            owner: { id: "0190a000-0000-7000-8000-0000000000d2", name: "mia" },
          },
        ],
        projects: [],
      },
    });
    renderConnection({ ...ME, role: "member" });
    const block = await runnerRegion();
    expect(within(block).getByRole("heading", { level: 1, name: "맥북" })).toBeInTheDocument();
    expect(within(block).queryByRole("region", { name: "러너 토큰" })).not.toBeInTheDocument();
    expect(within(block).queryByRole("group", { name: "설치 안내" })).not.toBeInTheDocument();
    expect(server.calls.filter((c) => c.url.startsWith("/api/v1/setup"))).toEqual([]);
  });

  it("경고 줄·「?」 펼침은 없다(2026-11-10 문구 걷기)", async () => {
    stubSetupServer();
    renderConnection();
    const block = await runnerRegion();
    expect(within(block).queryByRole("note")).toBeNull();
    expect(block).not.toHaveTextContent("루트는 좁게, 상한은 낮게");
  });
});

describe("러너 토큰 — 이 러너의 토큰 한 줄", () => {
  it("러너 토큰 섹션에는 이 러너의 토큰만 — 다른 러너의 토큰은 그 러너 상세에", async () => {
    stubSetupServer({
      status: statusOf({ runners: { list: [runnerOf(1, { label: "맥북" })] } }),
      runnerTokens: [
        tokenOf(1, { label: "맥북", prefix: "mac123", connected: true }),
        tokenOf(2, { label: "데스크톱" }),
      ],
    });
    renderConnection();
    const tokens = await within(await runnerRegion()).findByRole("region", { name: "러너 토큰" });
    expect(await within(tokens).findByRole("listitem", { name: "맥북" })).toBeInTheDocument();
    expect(within(tokens).getAllByRole("listitem")).toHaveLength(1);
    expect(within(tokens).queryByRole("button", { name: /이 러너로 묶기/ })).not.toBeInTheDocument();
  });

  it("붙은 토큰 줄에 같은 빌드인지 — 다른 빌드는 경고가 아니라 정보(npm 판이면 정상일 수 있다)", async () => {
    const opts = {
      status: statusOf({
        runners: {
          list: [runnerOf(1, { label: "맥북" }), runnerOf(2, { label: "데스크톱", bundleSha256: SHA_B })],
          runnerFile: { available: true as const, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 2048 },
        },
      }),
      runnerTokens: [
        tokenOf(1, { label: "맥북" }),
        tokenOf(2, { label: "데스크톱" }),
        tokenOf(3, { label: "끊긴" }),
      ],
    };
    stubSetupServer(opts);
    renderConnection(undefined, 1);
    expect(await within(await runnerRegion()).findByRole("listitem", { name: "맥북" })).toHaveTextContent(
      "서버와 같은 빌드입니다",
    );
    cleanup();
    stubSetupServer(opts);
    renderConnection(undefined, 2);
    const desk = await within(await runnerRegion()).findByRole("listitem", { name: "데스크톱" });
    expect(desk).toHaveTextContent("서버와 다른 빌드입니다 — npm 판이면 정상입니다.");
    expect(desk).not.toHaveTextContent("다시 설치하세요");
    expect(within(desk).queryByRole("alert")).not.toBeInTheDocument();
    cleanup();
    stubSetupServer(opts);
    renderConnection(undefined, 3);
    expect(await within(await runnerRegion()).findByRole("listitem", { name: "끊긴" })).not.toHaveTextContent(
      "빌드",
    );
  });
});

describe("러너 토큰", () => {
  it("줄 — 라벨·drn_ 앞 6자·마지막 사용·연결 여부(setup.status 를 믿는다)·폐기됨", async () => {
    const opts = {
      status: statusOf({ runners: { list: [runnerOf(2)] } }),
      runnerTokens: [
        // 목록 응답의 connected 는 낡았을 수 있다 — 상태가 먼저 옳다
        tokenOf(1, { label: "맥북", prefix: "mac123", connected: true }),
        tokenOf(2, { label: "데스크톱", prefix: "dsk456", lastUsedAt: "2026-09-26T00:00:00.000Z" }),
        tokenOf(3, { label: "옛것", prefix: "old000", revokedAt: "2026-09-24T00:00:00.000Z" }),
      ],
    };
    stubSetupServer(opts);
    renderConnection(undefined, 1);
    const mac = await within(await runnerRegion()).findByRole("listitem", { name: "맥북" });
    expect(mac).toHaveTextContent("drn_mac123…");
    expect(mac).not.toHaveTextContent("지금 접속 중");
    expect(mac).toHaveTextContent("마지막 사용 없음");
    cleanup();
    stubSetupServer(opts);
    renderConnection(undefined, 2);
    const desk = await within(await runnerRegion()).findByRole("listitem", { name: "데스크톱" });
    expect(desk).toHaveTextContent("지금 접속 중");
    expect(desk).not.toHaveTextContent("마지막 사용 없음");
    cleanup();
    stubSetupServer(opts);
    renderConnection(undefined, 3);
    const old = await within(await runnerRegion()).findByRole("listitem", { name: "옛것" });
    expect(old).toHaveTextContent("폐기됨");
    expect(within(old).queryByRole("button", { name: /폐기/ })).not.toBeInTheDocument();
  });

  it("폐기 — 확인을 거치고, 연결 중이면 그 러너가 끊긴다고 알린다", async () => {
    const server = stubSetupServer({
      status: statusOf({ runners: { list: [runnerOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", prefix: "mac123", connected: true })],
    });
    renderConnection();
    const block = await runnerRegion();
    const row = await within(block).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 폐기" }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent("지금 붙은 러너가 곧바로 끊기고 그 러너의 에이전트가 멈춥니다.");
    expect(server.count("DELETE", `/api/v1/setup/runner-tokens/${tokenId(1)}`)).toBe(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "폐기" }));
    await waitFor(() => expect(server.count("DELETE", `/api/v1/setup/runner-tokens/${tokenId(1)}`)).toBe(1));
    expect(await within(row).findByText("폐기됨")).toBeInTheDocument();
  });
});

describe("러너 토큰 다시 발급", () => {
  it("확인을 거쳐 새 원문을 한 번 — 붙어 있으면 끊긴다고 알린다. 캐시에 원문이 없다", async () => {
    const server = stubSetupServer({
      status: statusOf({ runners: { list: [runnerOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", prefix: "mac123" })],
    });
    const qc = renderConnection();
    const block = await runnerRegion();
    const row = await within(block).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 다시 발급" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("옛 토큰은 곧바로 안 통하고 지금 붙은 러너가 끊깁니다.");
    expect(server.count("POST", `/api/v1/setup/runner-tokens/${tokenId(1)}/reissue`)).toBe(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "다시 발급" }));
    expect(await within(dialog).findByText(RAW_REISSUED_TOKEN)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("「맥북」 토큰을 다시 발급했습니다");
    expect(dialog).toHaveTextContent("~/.dodok-runner/token");
    // 「AI 에게 맡기기」는 설치가 아니라 토큰 교체·다시 띄우기(태스크 5 리뷰 L10)
    expect(within(dialog).getByTestId("llms-handoff")).toHaveTextContent(
      llmsHandoffLine("runner-reissue", RUNNER_SERVER_URL, RAW_REISSUED_TOKEN),
    );
    expect(cacheDump(qc)).not.toContain(RAW_REISSUED_TOKEN);
    // 원문이 보이는 동안은 Esc 로 닫히지 않는다
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent(RAW_REISSUED_TOKEN);
    expect(await within(block).findByText(`drn_${RAW_REISSUED_TOKEN.slice(4, 10)}…`)).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/setup/runner-tokens/${tokenId(1)}/reissue`)).toBe(1);
  });

  it("요청이 나가 있는 동안 막는다 — 두 번 눌러도 한 번만 보낸다 [태스크 4 리뷰 L5]", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const server = stubSetupServer({
      runnerTokens: [tokenOf(1, { label: "맥북" })],
      reissue: async () => {
        await held;
        return json(200, {
          token: RAW_REISSUED_TOKEN,
          record: tokenOf(1, { label: "맥북" }),
          runnerConfig: { serverUrl: RUNNER_SERVER_URL, tokenFile: "~/.dodok-runner/token" },
        });
      },
    });
    renderConnection();
    const row = await within(await runnerRegion()).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 다시 발급" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "다시 발급" });
    await userEvent.dblClick(confirm);
    expect(await within(dialog).findByRole("button", { name: "발급하는 중…" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    release();
    expect(await within(dialog).findByText(RAW_REISSUED_TOKEN)).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/setup/runner-tokens/${tokenId(1)}/reissue`)).toBe(1);
  });

  it("같은 틱의 두 번 누름도 한 번만 보낸다 — 버튼이 잠기기 전(다시 그리기 전)의 두 번째 클릭", async () => {
    const server = stubSetupServer({ runnerTokens: [tokenOf(1, { label: "맥북" })] });
    renderConnection();
    const row = await within(await runnerRegion()).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 다시 발급" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "다시 발급" });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(await within(dialog).findByText(RAW_REISSUED_TOKEN)).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/setup/runner-tokens/${tokenId(1)}/reissue`)).toBe(1);
  });

  it("폐기된 토큰(409)이면 대화상자에 고정 문구", async () => {
    stubSetupServer({
      runnerTokens: [tokenOf(1, { label: "맥북" })],
      reissue: () => json(409, { code: "CONFLICT", message: "runner token revoked" }),
    });
    renderConnection();
    const row = await within(await runnerRegion()).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 다시 발급" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "다시 발급" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "폐기한 토큰은 다시 발급할 수 없습니다",
    );
    expect(dialog).not.toHaveTextContent("runner token revoked");
  });

  it("폐기한 줄에는 「다시 발급」이 없다", async () => {
    stubSetupServer({ runnerTokens: [tokenOf(1, { label: "옛것", revokedAt: "2026-09-24T00:00:00.000Z" })] });
    renderConnection();
    const row = await within(await runnerRegion()).findByRole("listitem", { name: "옛것" });
    expect(within(row).queryByRole("button", { name: /다시 발급/ })).not.toBeInTheDocument();
  });
});

describe("러너 설치 안내", () => {
  it("npm 설치가 첫 단계 — 옛 이름을 먼저 걷고(`;`) @dodok/runner 를 깐다, tgz 받기는 접힌 대안 안에", async () => {
    stubSetupServer({
      status: statusOf({
        runners: {
          list: [],
          runnerFile: { available: true, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 2048 },
        },
      }),
    });
    renderConnection();
    const block = await runnerRegion();
    const command = await within(block).findByText(RUNNER_NPM_INSTALL_COMMAND);
    const first = command.closest("li") as HTMLElement;
    // 설치 목록의 첫 단계다
    expect(first.parentElement?.firstElementChild).toBe(first);
    expect(first.parentElement?.tagName).toBe("OL");
    expect(RUNNER_NPM_INSTALL_COMMAND).toBe("npm i -g @dodok/runner");
    expect(within(first).getByRole("button", { name: "설치 명령 복사" })).toBeInTheDocument();
    // 접힌 대안 — 펼치기 전에는 닫혀 있고, 받기 버튼·파일 설치 명령은 그 안에 있다
    const alt = first.querySelector("details");
    expect(alt).not.toBeNull();
    expect(alt?.open).toBe(false);
    expect(within(alt as HTMLElement).getByText("서버와 같은 빌드로 설치")).toBeInTheDocument();
    expect(within(alt as HTMLElement).getByRole("button", { name: "러너 받기" })).toBeInTheDocument();
    expect(alt).toHaveTextContent("npm install -g ./dodok-claude-runner-ffffffffffff.tgz");
    await userEvent.click(within(alt as HTMLElement).getByText("서버와 같은 빌드로 설치"));
    expect(alt?.open).toBe(true);
  });

  it("서버에 러너 파일이 없어도 npm 설치 명령은 그대로 보인다", async () => {
    stubSetupServer();
    renderConnection();
    const block = await runnerRegion();
    expect(await within(block).findByText(RUNNER_NPM_INSTALL_COMMAND)).toBeInTheDocument();
  });

  /** 설치 2단계(로그인) 줄 — 단계 이름으로 찾는다 */
  async function loginStep() {
    stubSetupServer();
    renderConnection();
    const block = await runnerRegion();
    const body = await within(block).findByText(/Claude Code 로그인/);
    return body.closest("li") as HTMLElement;
  }

  it("설치 2단계 — 평소 로그인을 쓰고 로그인돼 있으면 건너뛴다", async () => {
    const step = await loginStep();
    expect(step.parentElement?.children[1]).toBe(step);
    expect(step).toHaveTextContent("돼 있으면 건너뜀");
    expect(RUNNER_LOGIN_COMMAND).toBe("claude");
    // 단계는 모두 러너 상세의 「설치 안내」 펼침 안 — 그 안에서 또 접힌 안내(전용 로그인·같은 빌드)는 뺀다
    const outer = step.closest('details[aria-label="설치 안내"]');
    const blocks = [...step.querySelectorAll("pre")].filter((pre) => pre.closest("details") === outer);
    expect(blocks.map((pre) => pre.textContent)).toEqual([
      RUNNER_LOGIN_COMMAND,
      RUNNER_LOGIN_BUNDLED_COMMAND,
    ]);
    // 접힌 안내 밖에는 전용 로그인 디렉터리가 없다 — 번들 CLI 도 평소 자리에 로그인
    for (const pre of blocks) expect(pre.textContent).not.toContain("CLAUDE_CONFIG_DIR");
    expect(within(step).getByRole("button", { name: "로그인 명령 복사" })).toBeInTheDocument();
  });

  it("설치 2단계 — 전용 로그인은 접힌 안내 안에", async () => {
    const step = await loginStep();
    const details = step.querySelector(
      'details[aria-label="러너 전용 로그인을 따로 쓰려면"]',
    ) as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    await userEvent.click(within(details).getByText("러너 전용 로그인을 따로 쓰려면"));
    expect(details.open).toBe(true);
    expect(details).toHaveTextContent("CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude");
    expect(details).toHaveTextContent('"configDir": "~/.dodok-runner/claude"');
  });

  it("설치 2단계 — 이메일·--resume 경고는 걷었다(2026-11-10 문구 걷기)", async () => {
    const step = await loginStep();
    expect(step).not.toHaveTextContent("계정 이메일");
  });

  it("tgz 받기(서버가 준 이름) → 로그인 → 설정 파일 → dodok-runner", async () => {
    const server = stubSetupServer({
      status: statusOf({
        runners: {
          list: [],
          runnerFile: { available: true, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 2048 },
        },
      }),
    });
    const createObjectURL = vi.fn(() => "blob:runner");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    renderConnection();
    const block = await runnerRegion();
    const button = await within(block).findByRole("button", { name: "러너 받기" });
    expect(block).toHaveTextContent("CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude");
    expect(block).toHaveTextContent("dodok-runner");
    expect(block).toHaveTextContent("~/.dodok-runner/config.json");
    expect(block).toHaveTextContent(SHA_FILE);
    // 받은 파일 이름 그대로 설치한다
    expect(block).toHaveTextContent("npm install -g ./dodok-claude-runner-ffffffffffff.tgz");
    await userEvent.click(button);
    await waitFor(() => expect(clicks).toEqual(["dodok-claude-runner-ffffffffffff.tgz"]));
    expect(server.count("GET", "/api/v1/setup/runner.tgz")).toBe(1);
  });

  it("받기 404 RUNNER_FILE_MISSING 이면 만드는 법을 문구로, 서버에 파일이 없으면 받기 대신 만드는 명령", async () => {
    stubSetupServer({
      status: statusOf({
        runners: {
          list: [],
          runnerFile: { available: true, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 2048 },
        },
      }),
      runner: () => json(404, { code: "NOT_FOUND", message: "RUNNER_FILE_MISSING" }),
    });
    renderConnection();
    const block = await runnerRegion();
    await userEvent.click(await within(block).findByRole("button", { name: "러너 받기" }));
    const alert = await within(block).findByRole("alert");
    expect(alert).toHaveTextContent(/서버에서 러너 파일을 찾지 못했습니다/);
    expect(alert).toHaveTextContent("pack:runner");
    expect(alert).not.toHaveTextContent("RUNNER_FILE_MISSING");
  });

  it("서버에 러너 파일이 없으면 받기 버튼 대신 만드는 명령", async () => {
    stubSetupServer();
    renderConnection();
    const block = await runnerRegion();
    expect(await within(block).findByText("pnpm -F @dodok/runner run pack:runner")).toBeInTheDocument();
    expect(within(block).queryByRole("button", { name: "러너 받기" })).not.toBeInTheDocument();
  });
});
