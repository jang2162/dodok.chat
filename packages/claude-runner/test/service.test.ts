import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkServiceConfig,
  ENV_TOKEN_MESSAGE,
  EXIT_2_HINT,
  logPathFromPlist,
  NO_CONFIG_MESSAGE,
  NOT_INSTALLED_MESSAGE,
  parseLaunchctlPrint,
  renderLaunchdPlist,
  renderSystemdUnit,
  runServiceCommand,
  serviceRestartCommand,
  UNSUPPORTED_OS_MESSAGE,
  type CmdResult,
  type ServiceAction,
  type ServiceDeps,
} from "../src/service";

// dodok-runner service — OS 명령·파일은 가짜로. 생성 파일 값은 docs/guides/docker-deploy.md 「백그라운드로 띄우기」와 같아야 한다

const HOME = "/Users/u";
const PLIST = `${HOME}/Library/LaunchAgents/chat.dodok.runner.plist`;
const UNIT = `${HOME}/.config/systemd/user/dodok-runner.service`;
const DEFAULT_CONFIG = `${HOME}/.dodok-runner/config.json`;
const ENTRY = "/g/lib/node_modules/@dodok/runner/dist/main.js";

const RUNNING = `gui/501/chat.dodok.runner = {
\tactive count = 1
\tpath = ${PLIST}
\tstate = running
\tpid = 4242
\tlast exit code = (never exited)
}`;
const EXITED_2 = `gui/501/chat.dodok.runner = {
\tstate = not running
\tlast exit code = 2
}`;

type Responder = (file: string, args: string[]) => CmdResult | undefined;

function harness(
  o: { platform?: NodeJS.Platform; files?: Record<string, string>; respond?: Responder } = {},
) {
  const files = new Map(Object.entries(o.files ?? {}));
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const ok = (stdout = ""): CmdResult => ({ code: 0, stdout, stderr: "" });
  const deps: ServiceDeps = {
    platform: o.platform ?? "darwin",
    home: HOME,
    uid: 501,
    user: "u",
    execPath: "/opt/node/bin/node",
    entry: () => ENTRY,
    path: "/opt/node/bin:/usr/bin:/bin",
    run: async (file, args) => {
      calls.push([file, ...args].join(" "));
      return o.respond?.(file, args) ?? ok();
    },
    runInherit: async (file, args) => {
      calls.push(`inherit ${[file, ...args].join(" ")}`);
      return 0;
    },
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? "",
    writeFile: (p, text) => void files.set(p, text),
    mkdir: (p) => void calls.push(`mkdir ${p}`),
    remove: (p) => void files.delete(p),
    checkConfig: () => ({ ok: true }),
    sleep: async () => {},
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
  };
  const run = (action: ServiceAction, configPath = DEFAULT_CONFIG, follow = false) =>
    runServiceCommand(action, { configPath, follow }, deps);
  return { deps, files, calls, out, err, run };
}

/** launchctl print — 등록돼 있으면 그 출력, 아니면 113 */
const launchd =
  (printed: string | null): Responder =>
  (file, args) =>
    file === "launchctl" && args[0] === "print"
      ? printed === null
        ? { code: 113, stdout: "", stderr: "Could not find service" }
        : { code: 0, stdout: printed, stderr: "" }
      : undefined;

describe("생성 파일 — docker-deploy.md 「백그라운드로 띄우기」와 같은 값", () => {
  it("plist — 라벨·RunAtLoad·KeepAlive(Crashed)·ExitTimeOut 30·로그, env 는 PATH 와 DODOK_RUNNER_SERVICE 뿐", () => {
    const text = renderLaunchdPlist({
      programArguments: ["/opt/node/bin/node", ENTRY, "--config", "/c/a&b.json"],
      path: "/opt/node/bin:/usr/bin",
      logPath: "/c/logs/runner.log",
    });
    expect(text).toContain("<key>Label</key><string>chat.dodok.runner</string>");
    expect(text).toContain(
      [
        "  <array>",
        "    <string>/opt/node/bin/node</string>",
        `    <string>${ENTRY}</string>`,
        "    <string>--config</string>",
        "    <string>/c/a&amp;b.json</string>",
        "  </array>",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        "  <dict>",
        "    <key>PATH</key><string>/opt/node/bin:/usr/bin</string>",
        "    <key>DODOK_RUNNER_SERVICE</key><string>launchd</string>",
        "  </dict>",
      ].join("\n"),
    );
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>");
    expect(text).toContain("<key>ExitTimeOut</key><integer>30</integer>");
    expect(text).toContain("<key>StandardOutPath</key><string>/c/logs/runner.log</string>");
    expect(text).toContain("<key>StandardErrorPath</key><string>/c/logs/runner.log</string>");
    expect(text).not.toMatch(/TOKEN|ANTHROPIC/);
    expect(logPathFromPlist(text)).toBe("/c/logs/runner.log");
  });

  it("unit — 코드 2 는 다시 띄우지 않고, 시작 한도·멈춤 대기·linger 대상", () => {
    const text = renderSystemdUnit({
      execStart: ["/opt/node/bin/node", ENTRY, "--config", "/h/my runner/50%.json"],
      path: "/opt/node/bin:/usr/bin",
    });
    expect(text.split("\n")).toEqual([
      "[Unit]",
      "Description=dodok runner",
      "After=network-online.target",
      "StartLimitIntervalSec=300",
      "StartLimitBurst=5",
      "",
      "[Service]",
      `ExecStart=/opt/node/bin/node ${ENTRY} --config "/h/my runner/50%%.json"`,
      'Environment="PATH=/opt/node/bin:/usr/bin"',
      "Environment=DODOK_RUNNER_SERVICE=systemd",
      "# 코드 1·비정상 종료는 다시 띄우고, 2(토큰·프로토콜)는 다시 띄우지 않는다",
      "Restart=on-failure",
      "RestartPreventExitStatus=2",
      "RestartSec=10",
      "TimeoutStopSec=30",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ]);
  });
});

describe("serviceRestartCommand — 원격 업데이트의 서비스 모드 다시 시작", () => {
  it("launchd 는 kickstart -k, systemd 는 --no-block restart, 그 밖은 null", () => {
    expect(serviceRestartCommand("launchd", 501)).toEqual({
      file: "launchctl",
      args: ["kickstart", "-k", "gui/501/chat.dodok.runner"],
    });
    expect(serviceRestartCommand("systemd", 1000)).toEqual({
      file: "systemctl",
      args: ["--user", "--no-block", "restart", "dodok-runner"],
    });
    expect(serviceRestartCommand(undefined, 501)).toBeNull();
    expect(serviceRestartCommand("1", 501)).toBeNull();
  });
});

describe("checkServiceConfig — install 전 설정 검사", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = (token = true) => {
    dir = mkdtempSync(join(tmpdir(), "svc-"));
    mkdirSync(join(dir, "src"));
    if (token) {
      writeFileSync(join(dir, "token"), "drn_x\n");
      chmodSync(join(dir, "token"), 0o600);
    }
    return join(dir, "config.json");
  };
  const base = () => ({
    serverUrl: "https://dodok.example",
    roots: [{ id: "src", path: join(dir, "src") }],
    programs: { claude: {} },
  });

  it("tokenFile 이 있는 유효한 설정이면 통과", () => {
    const path = setup();
    writeFileSync(path, JSON.stringify({ ...base(), tokenFile: join(dir, "token") }));
    expect(checkServiceConfig(path, {})).toEqual({ ok: true });
  });

  it("env DODOK_RUNNER_TOKEN 으로만 토큰을 주는 설정은 거절 — env 에 토큰이 있어도", () => {
    const path = setup(false);
    writeFileSync(path, JSON.stringify(base()));
    expect(checkServiceConfig(path, { DODOK_RUNNER_TOKEN: "drn_x" })).toEqual({
      ok: false,
      message: ENV_TOKEN_MESSAGE,
    });
    expect(checkServiceConfig(path, {})).toEqual({ ok: false, message: ENV_TOKEN_MESSAGE });
  });

  it("설정 파일이 없으면 터미널에서 먼저 만들라고, 깨졌으면 로더의 사유", () => {
    const path = setup();
    expect(checkServiceConfig(path, {})).toEqual({ ok: false, message: NO_CONFIG_MESSAGE });
    writeFileSync(path, "{");
    expect(checkServiceConfig(path, {})).toEqual({ ok: false, message: "설정 파일이 JSON 형식이 아닙니다" });
  });
});

describe("runServiceCommand — launchd", () => {
  it("install — 설정 검사 → 로그 디렉터리 → plist → bootstrap, 기본 설정이면 --config 없이", async () => {
    const h = harness({ respond: launchd(null) });
    expect(await h.run("install")).toBe(0);
    expect(h.calls).toEqual([
      `mkdir ${HOME}/.dodok-runner/logs`,
      `mkdir ${HOME}/Library/LaunchAgents`,
      "launchctl print gui/501/chat.dodok.runner",
      "launchctl enable gui/501/chat.dodok.runner",
      `launchctl bootstrap gui/501 ${PLIST}`,
    ]);
    const plist = h.files.get(PLIST)!;
    expect(plist).toContain(`<string>/opt/node/bin/node</string>\n    <string>${ENTRY}</string>\n  </array>`);
    expect(plist).toContain("<key>PATH</key><string>/opt/node/bin:/usr/bin:/bin</string>");
    expect(logPathFromPlist(plist)).toBe(`${HOME}/.dodok-runner/logs/runner.log`);
    expect(h.out.join("\n")).toContain("코드 2 로 끝납니다");
  });

  it("install — 다른 설정 자리면 --config 절대 경로, 로그는 그 설정 옆", async () => {
    const h = harness({ respond: launchd(null) });
    expect(await h.run("install", "/srv/r2/config.json")).toBe(0);
    const plist = h.files.get(PLIST)!;
    expect(plist).toContain("<string>--config</string>\n    <string>/srv/r2/config.json</string>");
    expect(logPathFromPlist(plist)).toBe("/srv/r2/logs/runner.log");
  });

  it("install — 이미 올라가 있으면 bootout 뒤 새 파일로 다시, bootstrap 실패는 몇 번 다시 시도", async () => {
    let bootstraps = 0;
    const h = harness({
      files: { [PLIST]: "old" },
      respond: (file, args) => {
        if (args[0] === "print") return { code: 0, stdout: RUNNING, stderr: "" };
        if (args[0] === "bootstrap" && ++bootstraps < 3)
          return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        return undefined;
      },
    });
    expect(await h.run("install")).toBe(0);
    expect(h.calls.filter((c) => c.startsWith("launchctl"))).toEqual([
      "launchctl print gui/501/chat.dodok.runner",
      "launchctl bootout gui/501/chat.dodok.runner",
      "launchctl enable gui/501/chat.dodok.runner",
      `launchctl bootstrap gui/501 ${PLIST}`,
      `launchctl bootstrap gui/501 ${PLIST}`,
      `launchctl bootstrap gui/501 ${PLIST}`,
    ]);
    expect(h.files.get(PLIST)).not.toBe("old");
    expect(h.out[0]).toContain("다시 등록하고");
  });

  it("install — 설정 검사가 실패하면 아무것도 쓰지 않고 1", async () => {
    const h = harness({ respond: launchd(null) });
    h.deps.checkConfig = () => ({ ok: false, message: ENV_TOKEN_MESSAGE });
    expect(await h.run("install")).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.err).toEqual([`dodok-runner: ${ENV_TOKEN_MESSAGE}`]);
  });

  it("uninstall — bootout 뒤 plist 만 지운다(설정·로그는 남긴다)", async () => {
    const h = harness({ files: { [PLIST]: renderPlistAt("/c/logs/runner.log") }, respond: launchd(RUNNING) });
    expect(await h.run("uninstall")).toBe(0);
    expect(h.calls).toEqual([
      "launchctl print gui/501/chat.dodok.runner",
      "launchctl bootout gui/501/chat.dodok.runner",
    ]);
    expect(h.files.has(PLIST)).toBe(false);
    expect(h.out[0]).toContain("/c/logs/runner.log");
  });

  it("start·stop·restart — 등록돼 있지 않으면 install 먼저", async () => {
    for (const action of ["start", "stop", "restart"] as const) {
      const h = harness({ respond: launchd(null) });
      expect(await h.run(action)).toBe(1);
      expect(h.err).toEqual([`dodok-runner: ${NOT_INSTALLED_MESSAGE}`]);
    }
  });

  it("stop 은 SIGTERM 을 보내고 끝날 때까지 기다린다, restart 는 kickstart -k, start 는 kickstart", async () => {
    let running = true;
    const stop = harness({
      files: { [PLIST]: "x" },
      respond: (file, args) => {
        if (args[0] === "print") return { code: 0, stdout: running ? RUNNING : EXITED_2, stderr: "" };
        if (args[0] === "kill") running = false;
        return undefined;
      },
    });
    expect(await stop.run("stop")).toBe(0);
    expect(stop.calls).toContain("launchctl kill TERM gui/501/chat.dodok.runner");

    const restart = harness({ files: { [PLIST]: "x" }, respond: launchd(RUNNING) });
    expect(await restart.run("restart")).toBe(0);
    expect(restart.calls).toContain("launchctl kickstart -k gui/501/chat.dodok.runner");

    const start = harness({ files: { [PLIST]: "x" }, respond: launchd(EXITED_2) });
    expect(await start.run("start")).toBe(0);
    expect(start.calls).toContain("launchctl kickstart gui/501/chat.dodok.runner");

    // 올라가 있지 않으면(bootout 된 채) bootstrap 으로
    const boot = harness({ files: { [PLIST]: "x" }, respond: launchd(null) });
    expect(await boot.run("start")).toBe(0);
    expect(boot.calls).toContain(`launchctl bootstrap gui/501 ${PLIST}`);
  });

  it("status — pid·마지막 종료 코드·로그 자리, 코드 2 면 안내", async () => {
    const running = harness({
      files: { [PLIST]: renderPlistAt("/c/logs/runner.log") },
      respond: launchd(RUNNING),
    });
    expect(await running.run("status")).toBe(0);
    expect(running.out).toEqual([
      `등록: 예 — launchd chat.dodok.runner (${PLIST})`,
      "상태: 실행 중 (pid 4242)",
      "로그: /c/logs/runner.log",
    ]);
    const exited = harness({
      files: { [PLIST]: renderPlistAt("/c/logs/runner.log") },
      respond: launchd(EXITED_2),
    });
    expect(await exited.run("status")).toBe(0);
    expect(exited.out).toContain(`마지막 종료 코드: 2 — ${EXIT_2_HINT}`);
    const none = harness({ respond: launchd(null) });
    expect(await none.run("status")).toBe(1);
  });

  it("logs — 로그 파일 끝 200줄, -f 면 따라간다", async () => {
    const log = "/c/logs/runner.log";
    const h = harness({ files: { [PLIST]: renderPlistAt(log), [log]: "" }, respond: launchd(RUNNING) });
    expect(await h.run("logs", DEFAULT_CONFIG, true)).toBe(0);
    expect(h.calls).toContain(`inherit tail -n 200 -f ${log}`);
  });

  it("parseLaunchctlPrint — 첫 state 줄", () => {
    expect(parseLaunchctlPrint({ code: 0, stdout: RUNNING, stderr: "" })).toEqual({
      loaded: true,
      running: true,
      pid: 4242,
      lastExit: null,
    });
  });
});

describe("runServiceCommand — systemd", () => {
  const show =
    (stdout: string): Responder =>
    (file, args) =>
      file === "systemctl" && args[1] === "show" ? { code: 0, stdout, stderr: "" } : undefined;

  it("install — unit 을 쓰고 daemon-reload → enable --now → linger, linger 실패는 안내", async () => {
    const h = harness({
      platform: "linux",
      respond: (file) => (file === "loginctl" ? { code: 1, stdout: "", stderr: "denied" } : undefined),
    });
    expect(await h.run("install")).toBe(0);
    expect(h.calls).toEqual([
      `mkdir ${HOME}/.config/systemd/user`,
      "systemctl --user daemon-reload",
      "systemctl --user enable --now dodok-runner",
      "loginctl enable-linger u",
    ]);
    expect(h.files.get(UNIT)).toContain(`ExecStart=/opt/node/bin/node ${ENTRY}\n`);
    expect(h.out.join("\n")).toContain("sudo loginctl enable-linger u");
  });

  it("install — 이미 있으면 새 파일로 restart", async () => {
    const h = harness({ platform: "linux", files: { [UNIT]: "old" } });
    expect(await h.run("install")).toBe(0);
    expect(h.calls).toContain("systemctl --user restart dodok-runner");
  });

  it("uninstall·start·stop·restart·logs", async () => {
    const h = harness({ platform: "linux", files: { [UNIT]: "x" } });
    for (const a of ["start", "stop", "restart"] as const) expect(await h.run(a)).toBe(0);
    expect(await h.run("logs", DEFAULT_CONFIG, true)).toBe(0);
    expect(await h.run("uninstall")).toBe(0);
    expect(h.calls).toEqual([
      "systemctl --user start dodok-runner",
      "systemctl --user stop dodok-runner",
      "systemctl --user restart dodok-runner",
      "inherit journalctl --user -u dodok-runner -n 200 --no-pager -f",
      "systemctl --user disable --now dodok-runner",
      "systemctl --user daemon-reload",
    ]);
    expect(h.files.has(UNIT)).toBe(false);
  });

  it("status — 스스로 코드 2 로 끝났으면 안내", async () => {
    const h = harness({
      platform: "linux",
      files: { [UNIT]: "x" },
      respond: show(
        "ActiveState=failed\nSubState=failed\nMainPID=0\nExecMainCode=1\nExecMainStatus=2\nResult=exit-code\n",
      ),
    });
    expect(await h.run("status")).toBe(0);
    expect(h.out).toContain("상태: 멈춤(failed/failed)");
    expect(h.out).toContain(`마지막 종료 코드: 2 — ${EXIT_2_HINT}`);
  });
});

it("지원하지 않는 OS 면 한 줄로 알리고 1", async () => {
  const h = harness({ platform: "win32" });
  expect(await h.run("install")).toBe(1);
  expect(h.err).toEqual([`dodok-runner: ${UNSUPPORTED_OS_MESSAGE}`]);
  expect(h.calls).toEqual([]);
});

function renderPlistAt(logPath: string): string {
  return renderLaunchdPlist({ programArguments: ["/n", ENTRY], path: "/usr/bin", logPath });
}
