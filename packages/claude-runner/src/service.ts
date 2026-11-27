import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { loadRunnerConfig, resolveConfigPath, RunnerConfigError } from "./config";

// `dodok-runner service …` — 러너를 OS 서비스 관리자(macOS launchd 사용자 LaunchAgent · Linux systemd 사용자 서비스)에 등록·조작한다
// (docs/superpowers/specs/2026-11-27-runner-service-command-design.md). 생성 파일의 값은 docs/guides/docker-deploy.md 「백그라운드로
// 띄우기」의 손으로 쓰는 plist·unit 과 같다. OS 명령은 deps 로 받아 시험이 실제 launchctl·systemctl 을 부르지 않는다

export const SERVICE_ACTIONS = [
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export type ServiceKind = "launchd" | "systemd";

export const LAUNCHD_LABEL = "chat.dodok.runner";
export const SYSTEMD_UNIT = "dodok-runner";
/** 서비스로 뜬 러너가 받는 env — 원격 업데이트가 다시 시작을 서비스 관리자에게 맡긴다(self-update.ts) */
export const SERVICE_ENV = "DODOK_RUNNER_SERVICE";

export const UNSUPPORTED_OS_MESSAGE = "dodok-runner service 는 macOS(launchd)·Linux(systemd)에서만 됩니다";
export const NOT_REGISTERED = "서비스로 등록돼 있지 않습니다";
export const NOT_INSTALLED_MESSAGE = `${NOT_REGISTERED} — 먼저 dodok-runner service install`;
export const NO_CONFIG_MESSAGE =
  "설정 파일이 없습니다 — 먼저 터미널에서 dodok-runner 를 띄워 설정을 만드세요(서비스로 뜬 러너는 설정을 묻지 못합니다)";
export const ENV_TOKEN_MESSAGE =
  "서비스에는 env DODOK_RUNNER_TOKEN 을 넘기지 않습니다 — 설정에 tokenFile 을 적고 토큰을 그 파일(0600)에 두세요(dodok-runner setup 이 그렇게 만듭니다)";
/** install 이 만든 파일의 표지 — 없으면 손으로 쓴 파일이라 덮기 전에 .bak 으로 남긴다 */
export const GENERATED_MARK = "dodok-runner service install 이 만든 파일";
export const EXIT_2_HINT = "토큰이나 판본 문제 — 로그 마지막 줄을 보세요";

export function serviceKindFor(platform: NodeJS.Platform): ServiceKind | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/** 원격 업데이트의 서비스 모드 다시 시작 명령 — env 값이 서비스가 아니면 null(터미널 모드: 분리된 자식으로 다시 띄운다) */
export function serviceRestartCommand(
  service: string | undefined,
  uid: number | undefined,
): { file: string; args: string[] } | null {
  if (service === "launchd" && uid !== undefined)
    return { file: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`] };
  if (service === "systemd")
    return { file: "systemctl", args: ["--user", "--no-block", "restart", SYSTEMD_UNIT] };
  return null;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unxml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

export function renderLaunchdPlist(o: { programArguments: string[]; path: string; logPath: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <!-- ${GENERATED_MARK} — 손으로 고치면 다음 install 이 .bak 으로 남기고 덮는다 -->`,
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...o.programArguments.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>PATH</key><string>${xml(o.path)}</string>`,
    `    <key>${SERVICE_ENV}</key><string>launchd</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <!-- 비정상 종료(신호로 죽음)만 다시 띄운다 — 코드 1·2 는 사람이 본다 -->",
    "  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>",
    "  <key>ExitTimeOut</key><integer>30</integer>",
    `  <key>StandardOutPath</key><string>${xml(o.logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(o.logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** plist 의 로그 자리 — status·logs 가 install 때의 --config 를 몰라도 같은 파일을 본다 */
export function logPathFromPlist(text: string): string | null {
  const m = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return m ? unxml(m[1]!) : null;
}

/** systemd 의 따옴표 문자열 — `\`·`"` 는 escape, `%` 는 지정자라 `%%` */
const systemdQuoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
/** ExecStart 인자 — `$` 는 변수 치환이라 `$$`, 공백·따옴표가 있으면 따옴표로 */
const systemdArg = (s: string) =>
  /[\s"'\\]/.test(s) || s === ""
    ? systemdQuoted(s).replace(/\$/g, "$$$$")
    : s.replace(/%/g, "%%").replace(/\$/g, "$$$$");

export function renderSystemdUnit(o: { execStart: string[]; path: string }): string {
  return [
    `# ${GENERATED_MARK} — 손으로 고치면 다음 install 이 .bak 으로 남기고 덮는다`,
    "[Unit]",
    "Description=dodok runner",
    "After=network-online.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    `ExecStart=${o.execStart.map(systemdArg).join(" ")}`,
    `Environment=${systemdQuoted(`PATH=${o.path}`)}`,
    `Environment=${SERVICE_ENV}=systemd`,
    "# 코드 1·비정상 종료는 다시 띄우고, 2(토큰·프로토콜)는 다시 띄우지 않는다",
    "Restart=on-failure",
    "RestartPreventExitStatus=2",
    "RestartSec=10",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * install 전 설정 검사 — --check-config 와 같은 로더. tokenFile 이 없으면(env 토큰) 거절한다. env 토큰 자리에 자리표시 값을 넣어
 * 읽는다 — 그래야 tokenFile 없는 설정이 「러너 토큰이 없습니다」 대신 tokenFile 안내로 끝난다(tokenFile 이 있으면 로더가 env 를 보지 않는다)
 */
export function checkServiceConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): { ok: true } | { ok: false; message: string } {
  if (!exists(configPath)) return { ok: false, message: NO_CONFIG_MESSAGE };
  let loaded;
  try {
    loaded = loadRunnerConfig(configPath, { ...env, DODOK_RUNNER_TOKEN: "service-check" });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof RunnerConfigError ? error.message : "설정을 읽지 못했습니다",
    };
  }
  if (loaded.config.tokenFile === undefined) return { ok: false, message: ENV_TOKEN_MESSAGE };
  return { ok: true };
}

export type CmdResult = { code: number; stdout: string; stderr: string };

export type ServiceDeps = {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  user: string;
  /** process.execPath — 서비스는 node 를 PATH 에서 찾지 않는다 */
  execPath: string;
  /** 러너 진입 파일의 실제 경로(realpath(process.argv[1])) */
  entry: () => string;
  /** 지금 셸의 PATH — 설치본 claude·npm 을 찾는 데 쓴다 */
  path: string | undefined;
  run: (file: string, args: string[]) => Promise<CmdResult>;
  /** 출력을 이 터미널로 잇는다(logs) — 종료 코드 */
  runInherit: (file: string, args: string[]) => Promise<number>;
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
  writeFile: (p: string, text: string) => void;
  mkdir: (p: string) => void;
  remove: (p: string) => void;
  checkConfig: (configPath: string) => { ok: true } | { ok: false; message: string };
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
};

export type ServiceOptions = { configPath: string; follow?: boolean };

/** 서비스 명령 하나 — 종료 코드를 돌려준다 */
export async function runServiceCommand(
  action: ServiceAction,
  opts: ServiceOptions,
  deps: ServiceDeps,
): Promise<number> {
  const kind = serviceKindFor(deps.platform);
  if (!kind) {
    deps.err(`dodok-runner: ${UNSUPPORTED_OS_MESSAGE}`);
    return 1;
  }
  return kind === "launchd" ? launchd(action, opts, deps) : systemd(action, opts, deps);
}

/** install 이 짓는 실행 줄 — node 절대 경로 + 진입 파일 실제 경로 + (기본 자리가 아니면) --config 절대 경로 */
export function serviceProgramArguments(
  configPath: string,
  deps: Pick<ServiceDeps, "execPath" | "entry" | "home">,
) {
  const isDefault = configPath === resolveConfigPath(undefined, deps.home);
  return [deps.execPath, deps.entry(), ...(isDefault ? [] : ["--config", configPath])];
}

function preflight(opts: ServiceOptions, deps: ServiceDeps): boolean {
  const checked = deps.checkConfig(opts.configPath);
  if (!checked.ok) {
    deps.err(`dodok-runner: ${checked.message}`);
    return false;
  }
  return true;
}

const TERMINAL_NOTE =
  "터미널에서 같은 설정의 러너가 돌고 있으면 끄세요 — 같은 토큰이면 서비스 쪽이 붙고 터미널 쪽은 코드 2 로 끝납니다";

/** 손으로 쓴(표지 없는) 서비스 파일은 덮기 전에 <경로>.bak 으로 남기고 알린다 */
function backupHandWritten(deps: ServiceDeps, path: string): void {
  if (!deps.exists(path)) return;
  const text = deps.readFile(path);
  if (text.includes(GENERATED_MARK)) return;
  deps.writeFile(`${path}.bak`, text);
  deps.out(`손으로 쓴 서비스 파일을 덮습니다 — 옛 파일은 ${path}.bak`);
}

function fail(deps: ServiceDeps, what: string, r: CmdResult): number {
  const detail = (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? "";
  deps.err(`dodok-runner: ${what}에 실패했습니다(코드 ${r.code})${detail ? ` — ${detail}` : ""}`);
  return 1;
}

// ── launchd ────────────────────────────────────────────────────────────────────────────────────────────────

type LaunchdState = { loaded: boolean; running: boolean; pid: number | null; lastExit: number | null };

export function parseLaunchctlPrint(r: CmdResult): LaunchdState {
  if (r.code !== 0) return { loaded: false, running: false, pid: null, lastExit: null };
  const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
  const lastExit = /^\s*last exit code = (-?\d+)/m.exec(r.stdout)?.[1];
  return {
    loaded: true,
    running: state === "running",
    pid: pid === undefined ? null : Number(pid),
    lastExit: lastExit === undefined ? null : Number(lastExit),
  };
}

async function launchd(action: ServiceAction, opts: ServiceOptions, deps: ServiceDeps): Promise<number> {
  const plistPath = join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const state = async () => parseLaunchctlPrint(await deps.run("launchctl", ["print", target]));
  const installed = deps.exists(plistPath);
  const logPath = () =>
    (installed ? logPathFromPlist(deps.readFile(plistPath)) : null) ??
    join(dirname(opts.configPath), "logs", "runner.log");

  // bootout 직후에는 launchd 가 그 잡을 다 치우기 전이라 bootstrap 이 「5: Input/output error」로 실패할 수 있다 — 잠깐 기다려 다시
  const bootstrap = async (): Promise<CmdResult> => {
    let r: CmdResult = { code: 1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await deps.sleep(1000);
      r = await deps.run("launchctl", ["bootstrap", domain, plistPath]);
      if (r.code === 0) return r;
    }
    return r;
  };

  switch (action) {
    case "install": {
      if (!preflight(opts, deps)) return 1;
      const log = join(dirname(opts.configPath), "logs", "runner.log");
      deps.mkdir(dirname(log));
      deps.mkdir(dirname(plistPath));
      const before = await state();
      if (before.loaded) {
        const out = await deps.run("launchctl", ["bootout", target]);
        if (out.code !== 0) return fail(deps, "기존 서비스 내리기(launchctl bootout)", out);
      }
      backupHandWritten(deps, plistPath);
      deps.writeFile(
        plistPath,
        renderLaunchdPlist({
          programArguments: serviceProgramArguments(opts.configPath, deps),
          path: deps.path ?? "/usr/bin:/bin:/usr/sbin:/sbin",
          logPath: log,
        }),
      );
      // launchctl disable 로 꺼 둔 적이 있으면 bootstrap 이 실패한다 — 켜 둔다(결과는 보지 않는다)
      await deps.run("launchctl", ["enable", target]);
      const r = await bootstrap();
      if (r.code !== 0) return fail(deps, "서비스 등록(launchctl bootstrap)", r);
      deps.out(
        `서비스를 ${before.loaded || installed ? "다시 " : ""}등록하고 띄웠습니다 — launchd ${LAUNCHD_LABEL} (${plistPath})`,
      );
      deps.out(`로그: ${log} — dodok-runner service logs -f 로 「연결됨」을 보세요`);
      deps.out(TERMINAL_NOTE);
      return 0;
    }
    case "uninstall": {
      const s = await state();
      if (!installed && !s.loaded) {
        deps.out(NOT_REGISTERED);
        return 0;
      }
      if (s.loaded) {
        const r = await deps.run("launchctl", ["bootout", target]);
        if (r.code !== 0) return fail(deps, "서비스 내리기(launchctl bootout)", r);
      }
      const log = logPath();
      if (installed) deps.remove(plistPath);
      deps.out(`서비스를 해제했습니다 — 설정·토큰·로그(${log})는 그대로 둡니다`);
      return 0;
    }
    case "start":
    case "restart": {
      if (!installed) {
        deps.err(`dodok-runner: ${NOT_INSTALLED_MESSAGE}`);
        return 1;
      }
      const s = await state();
      if (!s.loaded) {
        const r = await bootstrap();
        if (r.code !== 0) return fail(deps, "서비스 올리기(launchctl bootstrap)", r);
        deps.out("서비스를 띄웠습니다");
        return 0;
      }
      if (action === "start" && s.running) {
        deps.out(`이미 실행 중입니다${s.pid ? ` (pid ${s.pid})` : ""}`);
        return 0;
      }
      const r = await deps.run("launchctl", ["kickstart", ...(action === "restart" ? ["-k"] : []), target]);
      if (r.code !== 0)
        return fail(deps, `서비스 ${action === "restart" ? "다시 시작" : "시작"}(launchctl kickstart)`, r);
      deps.out(action === "restart" ? "서비스를 다시 시작했습니다" : "서비스를 시작했습니다");
      return 0;
    }
    case "stop": {
      if (!installed) {
        deps.err(`dodok-runner: ${NOT_INSTALLED_MESSAGE}`);
        return 1;
      }
      const s = await state();
      if (!s.running) {
        deps.out("실행 중이 아닙니다");
        return 0;
      }
      // SIGTERM — Ctrl+C 와 같은 정상 종료라 KeepAlive(Crashed)가 다시 띄우지 않는다. 다음 로그인에는 다시 뜬다
      const r = await deps.run("launchctl", ["kill", "TERM", target]);
      if (r.code !== 0) return fail(deps, "서비스 멈추기(launchctl kill TERM)", r);
      deps.out("멈추는 중 — 도는 런을 멈추고 끝냅니다(최대 약 11초)");
      for (let waited = 0; waited < 35_000; waited += 500) {
        await deps.sleep(500);
        if (!(await state()).running) {
          deps.out("멈췄습니다 — 다음 로그인에 다시 뜹니다(dodok-runner service start 로 지금 띄웁니다)");
          return 0;
        }
      }
      deps.err("dodok-runner: 아직 끝나지 않았습니다 — dodok-runner service status 로 다시 보세요");
      return 1;
    }
    case "status": {
      const s = await state();
      if (!installed && !s.loaded) {
        deps.out(`등록: 아니오 — dodok-runner service install 로 등록합니다`);
        return 1;
      }
      deps.out(
        `등록: 예 — launchd ${LAUNCHD_LABEL} (${plistPath})${s.loaded ? "" : " · 올라가 있지 않음(start 로 띄웁니다)"}`,
      );
      deps.out(`상태: ${s.running ? `실행 중${s.pid ? ` (pid ${s.pid})` : ""}` : "멈춤"}`);
      if (s.lastExit !== null)
        deps.out(`마지막 종료 코드: ${s.lastExit}${s.lastExit === 2 ? ` — ${EXIT_2_HINT}` : ""}`);
      deps.out(`로그: ${logPath()}`);
      return 0;
    }
    case "logs": {
      const log = logPath();
      if (!deps.exists(log)) {
        deps.err(`dodok-runner: 로그가 아직 없습니다 — ${log}`);
        return 1;
      }
      return deps.runInherit("tail", ["-n", "200", ...(opts.follow ? ["-f"] : []), log]);
    }
  }
}

// ── systemd ────────────────────────────────────────────────────────────────────────────────────────────────

export function parseSystemctlShow(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function systemd(action: ServiceAction, opts: ServiceOptions, deps: ServiceDeps): Promise<number> {
  const unitPath = join(deps.home, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
  const ctl = (...args: string[]) => deps.run("systemctl", ["--user", ...args]);
  const installed = deps.exists(unitPath);
  const journal = `journalctl --user -u ${SYSTEMD_UNIT}`;
  const needInstalled = () => {
    if (installed) return true;
    deps.err(`dodok-runner: ${NOT_INSTALLED_MESSAGE}`);
    return false;
  };

  switch (action) {
    case "install": {
      if (!preflight(opts, deps)) return 1;
      deps.mkdir(dirname(unitPath));
      backupHandWritten(deps, unitPath);
      deps.writeFile(
        unitPath,
        renderSystemdUnit({
          execStart: serviceProgramArguments(opts.configPath, deps),
          path: deps.path ?? "/usr/local/bin:/usr/bin:/bin",
        }),
      );
      let r = await ctl("daemon-reload");
      if (r.code !== 0) return fail(deps, "systemctl --user daemon-reload", r);
      r = await ctl("enable", "--now", SYSTEMD_UNIT);
      if (r.code !== 0) return fail(deps, "서비스 등록(systemctl --user enable --now)", r);
      // 이미 돌던 서비스는 enable --now 가 다시 띄우지 않는다 — 새 파일로 다시 시작
      if (installed) {
        r = await ctl("restart", SYSTEMD_UNIT);
        if (r.code !== 0) return fail(deps, "서비스 다시 시작(systemctl --user restart)", r);
      }
      deps.out(
        `서비스를 ${installed ? "다시 " : ""}등록하고 띄웠습니다 — systemd 사용자 서비스 ${SYSTEMD_UNIT} (${unitPath})`,
      );
      const linger = await deps.run("loginctl", ["enable-linger", deps.user]);
      if (linger.code !== 0)
        deps.out(
          `로그아웃하면 러너도 멈춥니다 — 계속 돌게 하려면 sudo loginctl enable-linger ${deps.user} 를 한 번 돌리세요`,
        );
      deps.out(`로그: ${journal} — dodok-runner service logs -f 로 「연결됨」을 보세요`);
      deps.out(TERMINAL_NOTE);
      return 0;
    }
    case "uninstall": {
      if (!installed) {
        deps.out(NOT_REGISTERED);
        return 0;
      }
      const r = await ctl("disable", "--now", SYSTEMD_UNIT);
      if (r.code !== 0) return fail(deps, "서비스 내리기(systemctl --user disable --now)", r);
      deps.remove(unitPath);
      await ctl("daemon-reload");
      deps.out("서비스를 해제했습니다 — 설정·토큰·로그(journal)는 그대로 둡니다");
      return 0;
    }
    case "start":
    case "stop":
    case "restart": {
      if (!needInstalled()) return 1;
      if (action === "stop") deps.out("멈추는 중 — 도는 런을 멈추고 끝냅니다(최대 약 11초)");
      const r = await ctl(action, SYSTEMD_UNIT);
      if (r.code !== 0) return fail(deps, `systemctl --user ${action}`, r);
      deps.out(
        action === "stop"
          ? "멈췄습니다 — 다음 로그인(linger 면 다음 부팅)에 다시 뜹니다"
          : action === "restart"
            ? "서비스를 다시 시작했습니다"
            : "서비스를 시작했습니다",
      );
      return 0;
    }
    case "status": {
      if (!installed) {
        deps.out(`등록: 아니오 — dodok-runner service install 로 등록합니다`);
        return 1;
      }
      const r = await ctl(
        "show",
        SYSTEMD_UNIT,
        "-p",
        "ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus,Result",
      );
      const p = parseSystemctlShow(r.stdout);
      deps.out(`등록: 예 — systemd 사용자 서비스 ${SYSTEMD_UNIT} (${unitPath})`);
      const pid = Number(p.MainPID ?? "0");
      deps.out(
        `상태: ${p.ActiveState === "active" ? `실행 중${pid > 0 ? ` (pid ${pid})` : ""}` : `멈춤(${p.ActiveState ?? "알 수 없음"}${p.SubState ? `/${p.SubState}` : ""})`}`,
      );
      // ExecMainCode 1 = 스스로 끝남(CLD_EXITED) — 그때만 ExecMainStatus 가 종료 코드다
      if (p.ActiveState !== "active" && p.ExecMainCode === "1" && p.ExecMainStatus !== undefined) {
        const code = Number(p.ExecMainStatus);
        deps.out(`마지막 종료 코드: ${code}${code === 2 ? ` — ${EXIT_2_HINT}` : ""}`);
      }
      deps.out(`로그: ${journal}`);
      return 0;
    }
    case "logs":
      return deps.runInherit("journalctl", [
        "--user",
        "-u",
        SYSTEMD_UNIT,
        "-n",
        "200",
        "--no-pager",
        ...(opts.follow ? ["-f"] : []),
      ]);
  }
}

// ── 실제 deps ──────────────────────────────────────────────────────────────────────────────────────────────

export function nodeServiceDeps(o: { home: string; env: NodeJS.ProcessEnv; argv: string[] }): ServiceDeps {
  return {
    platform: process.platform,
    home: o.home,
    uid: process.getuid?.() ?? 0,
    user: o.env.USER || userInfo().username,
    execPath: process.execPath,
    entry: () => realpathSync(o.argv[1] ?? ""),
    path: o.env.PATH,
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { env: o.env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    runInherit: (file, args) =>
      new Promise((resolve) => {
        const child = spawn(file, args, { env: o.env, stdio: "inherit" });
        child.on("error", () => resolve(127));
        child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
      }),
    exists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, text) => writeFileSync(p, text, { mode: 0o644 }),
    mkdir: (p) => mkdirSync(p, { recursive: true, mode: 0o700 }),
    remove: (p) => rmSync(p, { force: true }),
    checkConfig: (configPath) => checkServiceConfig(configPath, o.env),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}
