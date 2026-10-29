import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json } from "../../../test/shellApi";
import {
  RAW_REISSUED_TOKEN,
  RAW_RUNNER_TOKEN,
  RUNNER_SERVER_URL,
  SHA_B,
  SHA_FILE,
  SHA_A,
  cacheDump,
  renderConnection,
  runnerOf,
  statusOf,
  stubSetupServer,
  tokenId,
  tokenOf,
} from "../../../test/setupServer";
import { ME } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runnerRegion = () => screen.findByRole("region", { name: "러너" });

describe("러너 블록 — 권한", () => {
  it("owner 가 아니면 러너 블록이 없고 러너 API 를 부르지 않는다", async () => {
    const server = stubSetupServer();
    renderConnection({ ...ME, role: "admin" });
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "러너" })).not.toBeInTheDocument();
    expect(server.calls.filter((c) => c.url.includes("runner"))).toEqual([]);
  });

  it("owner 는 러너 블록과 드러나는 것 넷을 본다 [최종 리뷰 M5·러너 일반화 스펙 7장]", async () => {
    stubSetupServer();
    renderConnection();
    const block = await runnerRegion();
    const note = within(block).getByRole("note");
    expect(within(note).getAllByRole("listitem")).toHaveLength(4);
    expect(note).toHaveTextContent("러너 계정의 이메일이 에이전트 문맥에 들어갑니다");
    expect(note).toHaveTextContent("끌 방법이 없습니다");
    expect(note).toHaveTextContent(
      "채널 멤버는 에이전트를 통해 러너 작업 디렉터리 안의 파일을 읽을 수 있습니다",
    );
    expect(note).toHaveTextContent("토큰 하나가 그 러너의 모든 에이전트를 맡습니다");
    expect(note).toHaveTextContent(
      "서버 쪽 admin(과 서버를 손에 넣은 사람)은 루트 안 아무 디렉터리에서, 권한 상한까지의 도구로 에이전트를 돌릴 수 있습니다. 루트는 좁게, 상한은 낮게 둡니다.",
    );
    expect(note).not.toHaveTextContent("이 러너로 묶기");
  });
});

describe("러너 블록 — 토큰·설치 안내만", () => {
  it("러너 카드(판본·에이전트)·「이 러너로 묶기」가 없고, 상태·프로젝트는 러너 탭 링크로", async () => {
    stubSetupServer({
      status: statusOf({ runners: { list: [runnerOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", prefix: "mac123", connected: true })],
    });
    renderConnection();
    const block = await runnerRegion();
    await within(block).findByRole("listitem", { name: "맥북" });
    expect(within(block).queryByRole("article")).not.toBeInTheDocument();
    expect(block).not.toHaveTextContent("2.1.283");
    expect(within(block).queryByRole("button", { name: /이 러너로 묶기/ })).not.toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "러너 탭" })).toHaveAttribute("href", "/settings/runners");
  });

  it("붙은 토큰 줄에 같은 빌드인지 — 다른 빌드면 다시 설치하라는 경고", async () => {
    stubSetupServer({
      status: statusOf({
        runners: {
          list: [runnerOf(1, { label: "맥북" }), runnerOf(2, { label: "데스크톱", bundleSha256: SHA_B })],
          runnerFile: { available: true, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 2048 },
        },
      }),
      runnerTokens: [
        tokenOf(1, { label: "맥북" }),
        tokenOf(2, { label: "데스크톱" }),
        tokenOf(3, { label: "끊긴" }),
      ],
    });
    renderConnection();
    const block = await runnerRegion();
    expect(await within(block).findByRole("listitem", { name: "맥북" })).toHaveTextContent(
      "서버와 같은 빌드입니다",
    );
    expect(within(block).getByRole("listitem", { name: "데스크톱" })).toHaveTextContent("다른 빌드입니다");
    expect(within(block).getByRole("listitem", { name: "끊긴" })).not.toHaveTextContent("빌드");
  });
});

describe("러너 토큰", () => {
  it("목록 — 라벨·drn_ 앞 6자·마지막 사용·연결 여부(setup.status 를 믿는다)·폐기됨", async () => {
    stubSetupServer({
      status: statusOf({ runners: { list: [runnerOf(2)] } }),
      runnerTokens: [
        // 목록 응답의 connected 는 낡았을 수 있다 — 상태가 먼저 옳다
        tokenOf(1, { label: "맥북", prefix: "mac123", connected: true }),
        tokenOf(2, { label: "데스크톱", prefix: "dsk456", lastUsedAt: "2026-09-26T00:00:00.000Z" }),
        tokenOf(3, { label: "옛것", prefix: "old000", revokedAt: "2026-09-24T00:00:00.000Z" }),
      ],
    });
    renderConnection();
    const block = await runnerRegion();
    const mac = await within(block).findByRole("listitem", { name: "맥북" });
    expect(mac).toHaveTextContent("drn_mac123…");
    expect(mac).not.toHaveTextContent("지금 접속 중");
    expect(mac).toHaveTextContent("마지막 사용 없음");
    const desk = within(block).getByRole("listitem", { name: "데스크톱" });
    expect(desk).toHaveTextContent("지금 접속 중");
    expect(desk).not.toHaveTextContent("마지막 사용 없음");
    const old = within(block).getByRole("listitem", { name: "옛것" });
    expect(old).toHaveTextContent("폐기됨");
    expect(within(old).queryByRole("button", { name: /폐기/ })).not.toBeInTheDocument();
  });

  it("발급 — 원문과 설정 파일 예시가 대화상자에 한 번, 닫으면 목록에는 prefix 만, 캐시에도 원문이 없다", async () => {
    const server = stubSetupServer();
    const qc = renderConnection();
    const block = await runnerRegion();
    await userEvent.click(await within(block).findByRole("button", { name: "새 러너 토큰 발급" }));
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
          configDir: "~/.dodok-runner/claude",
          maxPermissionMode: "default",
          disallowedTools: [],
          allowedToolsCeiling: null,
        },
      },
    });
    // 설정 파일에는 원문을 두지 않는다 — tokenFile 에 둔다
    expect(JSON.stringify(config)).not.toContain("drn_");
    expect(dialog).toHaveTextContent("~/.dodok-runner/token");
    expect(cacheDump(qc)).not.toContain("drn_");

    // 원문이 보이는 동안은 Esc 로 닫히지 않는다
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const row = await within(block).findByRole("listitem", { name: "맥북" });
    expect(row).toHaveTextContent(`drn_${RAW_RUNNER_TOKEN.slice(4, 10)}…`);
    expect(document.body).not.toHaveTextContent(RAW_RUNNER_TOKEN);
    expect(cacheDump(qc)).not.toContain(RAW_RUNNER_TOKEN);

    // 다시 열면 라벨 입력부터 — 옛 원문이 되살아나지 않는다(브리지 대화상자와 같은 본체)
    await userEvent.click(within(block).getByRole("button", { name: "새 러너 토큰 발급" }));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByLabelText("라벨")).toHaveValue("");
    expect(document.body).not.toHaveTextContent(RAW_RUNNER_TOKEN);
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
    expect(confirm).toHaveTextContent(/지금 이 토큰으로 러너가 붙어 있습니다/);
    expect(server.count("DELETE", `/api/v1/setup/runner-tokens/${tokenId(1)}`)).toBe(0);
    await userEvent.click(within(confirm).getByRole("button", { name: "폐기" }));
    await waitFor(() => expect(server.count("DELETE", `/api/v1/setup/runner-tokens/${tokenId(1)}`)).toBe(1));
    expect(await within(block).findByText("폐기됨")).toBeInTheDocument();
  });
});

describe("러너 토큰 다시 발급", () => {
  it("확인을 거쳐 새 원문을 한 번 — 붙어 있으면 끊긴다고, 프로젝트·에이전트는 남는다고 알린다. 캐시에 원문이 없다", async () => {
    const server = stubSetupServer({
      status: statusOf({ runners: { list: [runnerOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", prefix: "mac123" })],
    });
    const qc = renderConnection();
    const block = await runnerRegion();
    const row = await within(block).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 다시 발급" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("지금 이 토큰으로 러너가 붙어 있습니다");
    expect(dialog).toHaveTextContent("프로젝트·에이전트는 그대로 남습니다");
    expect(server.count("POST", `/api/v1/setup/runner-tokens/${tokenId(1)}/reissue`)).toBe(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "다시 발급" }));
    expect(await within(dialog).findByText(RAW_REISSUED_TOKEN)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("「맥북」 토큰을 다시 발급했습니다");
    expect(dialog).toHaveTextContent("~/.dodok-runner/token");
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
  it("tgz 받기(서버가 준 이름) → 전용 로그인 → 설정 파일 → dodok-runner", async () => {
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
    expect(
      await within(block).findByText("pnpm -F @dodok/claude-runner run pack:runner"),
    ).toBeInTheDocument();
    expect(within(block).queryByRole("button", { name: "러너 받기" })).not.toBeInTheDocument();
  });
});
