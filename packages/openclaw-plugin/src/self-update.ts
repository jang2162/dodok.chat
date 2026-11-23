/**
 * 원격 업데이트(원격 업데이트 스펙 U5) — 서버의 `plugin.update` 를 받으면 Gateway 프로세스 안에서 먼저 서버의 plugin.tgz 를 이 플러그인의
 * 브리지 토큰으로 받고, 파일 sha256 을 서버가 알려 준 값과 대조하고, Gateway 가 서비스(`openclaw gateway status`)인지 본다. 여기까지의
 * 실패는 Gateway 를 건드리지 않으므로 다시 붙는 일이 없다 — 그래서 `plugin.update` ack 로 사유를 곧바로 답한다(리뷰 M2). 통과하면 검증된
 * tgz 경로만 Gateway 밖으로 분리된 bash 스크립트에 넘긴다. 스크립트는 Gateway 를 내리고(`openclaw gateway stop`) 설치하고
 * (`openclaw plugins install … --force --accept-capabilities`) 다시 올린다. 설정·토큰은 건드리지 않는다. Gateway 를 내린 뒤 어느 단계에서
 * 실패해도 Gateway 를 다시 올린다(옛 플러그인 그대로). 그 결과는 상태 디렉터리의 `dodok-update/last.json` 에 남고, 다시 붙은 플러그인이
 * hello 의 lastUpdate 로 싣는다.
 *
 * 스크립트 본문은 이 플러그인 코드가 만든다 — 서버가 보내는 것은 sha256 하나다(서버가 Gateway 호스트에 임의 명령을 돌리게 하지 않는다).
 * 받는 자리·내리기·설치 명령은 서버의 설치 스크립트(apps/server/src/modules/setup/plugin-install-script.ts)와 같다. 토큰은 이 프로세스의
 * fetch 헤더로만 — 스크립트·어떤 명령의 argv·env 에도 싣지 않는다. `openclaw` 를 import 하지 않는다 — 단위 시험 대상
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { RemoteUpdateOutcome, Sha256Hex, type PluginUpdateResult } from "@dodok/shared";

export const UPDATE_DIR_NAME = "dodok-update";
export const DISABLED_MESSAGE =
  "이 Gateway 의 dodok 채널 설정에서 원격 업데이트를 껐습니다(channels.dodok.remoteUpdate: false)";
export const ALREADY_UPDATING_MESSAGE = "이미 업데이트하는 중입니다";
export const LAUNCH_FAILED_MESSAGE = "업데이트 스크립트를 띄우지 못했습니다 — Gateway 는 그대로입니다";
export const NOT_SERVICE_MESSAGE =
  "이 Gateway 는 서비스(systemd·launchd)로 깔려 있지 않아 원격 업데이트를 할 수 없습니다 — 설치 한 줄을 그 호스트에서 돌리세요";
/** 앞 업데이트의 잠금 파일이 이보다 오래됐으면 죽은 것으로 본다 — 서버 상한(5분)보다 길게 */
export const LOCK_STALE_MS = 10 * 60_000;
/**
 * 받기·상태 확인의 상한 — 둘을 더해도 서버의 브리지 ack 상한(openclaw-adapter bridge/server.ts 기본 15초)보다 짧게. 넘으면 서버는 답을
 * 놓치고 상한(5분) 뒤 「응답이 없습니다」로만 보인다
 */
export const FETCH_TIMEOUT_MS = 8_000;
export const STATUS_TIMEOUT_MS = 5_000;
/** 띄운 뒤 이만큼 지켜본다 — systemd-run 이 user 버스에 닿지 못하면 곧바로 0 이 아니게 끝난다 */
export const LAUNCH_SETTLE_MS = 1_000;
/**
 * 스크립트가 Gateway 를 내리기 전에 기다리는 초 — 이 프로세스의 ok ack 가 서버에 닿을 틈(LAUNCH_SETTLE_MS 보다 길게). 내리면 이 프로세스도
 * 끝난다
 */
export const STOP_DELAY_SECONDS = 3;

export type UpdatePaths = { dir: string; script: string; log: string; result: string; lock: string };

export function updatePaths(stateDir: string): UpdatePaths {
  const dir = join(stateDir, UPDATE_DIR_NAME);
  return {
    dir,
    script: join(dir, "update.sh"),
    log: join(dir, "update.log"),
    result: join(dir, "last.json"),
    lock: join(dir, "running.lock"),
  };
}

/** 셸 작은따옴표 값 — 경로. 따옴표·줄바꿈이 있으면 스크립트를 깨뜨리므로 쓰지 않는다 */
function quote(name: string, value: string): string {
  if (/['\n\r\0]/.test(value)) throw new Error(`dodok update: ${name} 에 셸에 넣을 수 없는 글자가 있다`);
  return `'${value}'`;
}

export type UpdateScriptInput = {
  /** 이 프로세스가 받아 sha256 까지 대조한 plugin.tgz */
  tgz: string;
  /** tgz 를 담은 임시 디렉터리 — 스크립트가 끝나면 지운다 */
  tmpDir: string;
  paths: UpdatePaths;
  /** 내리기 전 기다리는 초(시험은 0) */
  stopDelaySeconds?: number;
};

/**
 * 업데이트 스크립트 본문 — 받기·sha·서비스 확인은 이미 끝났다(startPluginUpdate). 결과 파일은 Gateway 를 올리기 **전에** 쓴다 — 새
 * 플러그인이 올라오자마자 결과를 읽어 hello 에 싣는다. bash 3.2(macOS 기본)에서도 돌게 `[[ =~ ]]`·연관 배열을 쓰지 않는다
 */
export function renderPluginUpdateScript(input: UpdateScriptInput): string {
  const { tgz, tmpDir, paths } = input;
  const delay = input.stopDelaySeconds ?? STOP_DELAY_SECONDS;
  if (!Number.isInteger(delay) || delay < 0) throw new Error("dodok update: 기다리는 초는 0 이상의 정수다");
  return `#!/usr/bin/env bash
# dodok — 원격 업데이트(웹의 「업데이트」). dodok 플러그인이 만들어 Gateway 밖에서 돌린다 — 손으로 돌리지 않는다.
dodok_plugin_update() {
  set -u
  dodok_tgz=${quote("tgz", tgz)}
  dodok_dir=${quote("tmpDir", tmpDir)}
  dodok_result=${quote("result", paths.result)}
  dodok_lock=${quote("lock", paths.lock)}
  dodok_stopped=0

  dodok_say() { printf '%s dodok: %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
  # openclaw — PATH 에 없으면 Gateway 를 돌리던 node·진입 파일로(서비스 관리자의 PATH 는 좁을 수 있다)
  dodok_openclaw() {
    if command -v openclaw >/dev/null 2>&1; then
      openclaw "$@" </dev/null
    elif [ -n "\${DODOK_OPENCLAW_NODE:-}" ] && [ -n "\${DODOK_OPENCLAW_ENTRY:-}" ]; then
      "$DODOK_OPENCLAW_NODE" "$DODOK_OPENCLAW_ENTRY" "$@" </dev/null
    else
      dodok_say "openclaw 명령을 찾지 못했습니다"
      return 127
    fi
  }
  # 결과 파일 — JSON 이스케이프는 node 가(메시지는 env 로 넘긴다). node 는 Gateway 를 돌리던 것 우선
  dodok_node="\${DODOK_OPENCLAW_NODE:-node}"
  dodok_write_result() {
    DODOK_RESULT_OK="$1" DODOK_RESULT_MESSAGE="$2" DODOK_RESULT_FILE="$dodok_result" "$dodok_node" -e '
const fs = require("fs");
const out = { ok: process.env.DODOK_RESULT_OK === "1", at: new Date().toISOString() };
if (process.env.DODOK_RESULT_MESSAGE) out.message = process.env.DODOK_RESULT_MESSAGE.slice(0, 400);
fs.writeFileSync(process.env.DODOK_RESULT_FILE + ".tmp", JSON.stringify(out) + "\\n");
fs.renameSync(process.env.DODOK_RESULT_FILE + ".tmp", process.env.DODOK_RESULT_FILE);
' </dev/null || dodok_say "결과 파일을 쓰지 못했습니다"
  }
  # 실패 — 결과를 먼저 쓰고, 이 스크립트가 Gateway 를 내렸으면 다시 올린다(옛 플러그인 그대로)
  dodok_fail() {
    dodok_say "실패: $1"
    dodok_write_result 0 "$1"
    if [ "$dodok_stopped" = 1 ]; then
      dodok_stopped=0
      dodok_say "Gateway 를 다시 올립니다(openclaw gateway start)."
      dodok_openclaw gateway start || dodok_say "Gateway 를 올리지 못했습니다 — openclaw gateway start 를 직접 돌리세요."
    fi
    exit 1
  }
  dodok_cleanup() {
    rm -rf "$dodok_dir"
    rm -f "$dodok_lock"
  }
  trap dodok_cleanup EXIT
  trap 'dodok_fail "업데이트 스크립트가 중단됐습니다"' INT TERM HUP

  [ -f "$dodok_tgz" ] || dodok_fail "받은 플러그인 파일이 없습니다 — Gateway 는 그대로입니다"
  # 플러그인이 ok 를 서버에 답할 틈 — Gateway 를 내리면 플러그인도 끝난다
  sleep ${delay}

  # 1. 내리기 — 실패해도 반쯤 내려갔을 수 있어 내린 것으로 친다(dodok_fail 이 다시 올린다)
  dodok_say "Gateway 를 내립니다(openclaw gateway stop)."
  dodok_stopped=1
  dodok_openclaw gateway stop --force || dodok_fail "Gateway 를 내리지 못했습니다(openclaw gateway stop)"

  # 2. 설치 — 설정·토큰은 그대로
  dodok_say "플러그인을 설치합니다(openclaw plugins install)."
  dodok_openclaw plugins install "$dodok_tgz" --force --accept-capabilities ||
    dodok_fail "플러그인 설치에 실패했습니다(openclaw plugins install) — 옛 플러그인으로 Gateway 를 다시 올렸습니다"

  # 3. 결과를 먼저 쓰고 올린다
  dodok_write_result 1 ""
  dodok_say "Gateway 를 올립니다(openclaw gateway start)."
  dodok_stopped=0
  if ! dodok_openclaw gateway start; then
    dodok_write_result 0 "설치는 끝났지만 Gateway 를 올리지 못했습니다 — openclaw gateway start 를 직접 돌리세요"
    exit 1
  fi
  dodok_say "끝."
}

dodok_plugin_update "$@"
`;
}

/** 지난 업데이트의 결과 — 없거나 꼴이 틀리면 undefined(hello 에 싣지 않는다) */
export function readLastUpdate(stateDir: string): RemoteUpdateOutcome | undefined {
  try {
    const parsed = RemoteUpdateOutcome.safeParse(
      JSON.parse(readFileSync(updatePaths(stateDir).result, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type LaunchSpec = { file: string; args: string[]; env: NodeJS.ProcessEnv; logPath: string };
/** 띄우기 — 띄우지 못했거나 곧바로 0 이 아니게 끝나면 거절한다 */
export type Launcher = (spec: LaunchSpec) => Promise<void>;

/**
 * 분리된 자식 — 새 세션(프로세스 그룹)이라 launchd 가 Gateway 를 내릴 때 함께 죽지 않는다. 출력은 로그 파일에. LAUNCH_SETTLE_MS 안에
 * 0 이 아니게 끝나면(systemd-run 이 scope 를 못 만듦 등) 거절한다
 */
export const nodeLauncher: Launcher = (spec) =>
  new Promise((resolve, reject) => {
    const fd = openSync(spec.logPath, "a", 0o600);
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = spawn(spec.file, spec.args, {
        env: spec.env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.once("error", (error) => settle(error));
      child.once("exit", (code, signal) => {
        if (code === 0) settle();
        else settle(new Error(`${spec.file} exit ${code ?? signal ?? "?"}`));
      });
      child.once("spawn", () => {
        timer = setTimeout(() => {
          child.removeAllListeners("exit");
          child.unref();
          settle();
        }, LAUNCH_SETTLE_MS);
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    } finally {
      closeSync(fd);
    }
  });

function findOnPath(name: string, path: string | undefined, exists: (p: string) => boolean): string | null {
  for (const dir of [...(path ?? "").split(delimiter), "/usr/bin", "/bin"]) {
    if (dir && exists(join(dir, name))) return join(dir, name);
  }
  return null;
}

/**
 * 띄울 명령 — systemd 서비스(INVOCATION_ID) 아래면 Gateway 를 내릴 때 같은 cgroup 의 자식까지 죽으므로 `systemd-run --user --scope`
 * 로 따로 띄운다(OpenClaw 의 업데이트 handoff 와 같은 길). 그 밖에는 bash 를 분리된 자식으로
 */
export function launchCommand(opts: {
  script: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  now: number;
  exists?: (p: string) => boolean;
}): { file: string; args: string[] } {
  const exists = opts.exists ?? existsSync;
  if (opts.platform === "linux" && opts.env.INVOCATION_ID) {
    const systemdRun = findOnPath("systemd-run", opts.env.PATH, exists);
    if (systemdRun)
      return {
        file: systemdRun,
        args: [
          "--user",
          "--scope",
          "--collect",
          "--quiet",
          `--unit=dodok-plugin-update-${opts.now}.scope`,
          "bash",
          opts.script,
        ],
      };
  }
  return { file: "bash", args: [opts.script] };
}

/** 받기 — fetch 와 같은 꼴(시험이 바꾼다) */
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
/** 명령 실행 — 0 이 아니면 거절(시험이 바꾼다) */
export type CommandRunner = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;

export const nodeCommandRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      },
    );
  });

export type StartPluginUpdateOptions = {
  sha256: string;
  /** channels.dodok.remoteUpdate(기본 true) */
  enabled: boolean;
  bridgeOrigin: string;
  token: string;
  stateDir: string;
  /** 플러그인을 띄운 Gateway 프로세스의 env — 스크립트의 openclaw 가 같은 상태 디렉터리·서비스를 본다 */
  env: NodeJS.ProcessEnv;
  /** Gateway 를 돌리는 node·진입 파일 — PATH 에 openclaw 가 없을 때 */
  openclawNode?: string;
  openclawEntry?: string;
  fetch?: Fetcher;
  run?: CommandRunner;
  launch?: Launcher;
  platform?: NodeJS.Platform;
  now?: () => number;
  exists?: (p: string) => boolean;
  /** 스크립트가 내리기 전 기다리는 초(시험은 0) */
  stopDelaySeconds?: number;
};

/** 내리기 전 단계의 실패 — 사유는 그대로 ack 의 message 로 간다 */
class PrepareError extends Error {}

/** openclaw 를 부를 길 — PATH 의 openclaw, 없으면 Gateway 를 돌리던 node·진입 파일 */
function openclawCommand(
  opts: StartPluginUpdateOptions,
  exists: (p: string) => boolean,
): { file: string; prefix: string[] } {
  const onPath = findOnPath("openclaw", opts.env.PATH, exists);
  if (onPath) return { file: onPath, prefix: [] };
  if (opts.openclawNode && opts.openclawEntry)
    return { file: opts.openclawNode, prefix: [opts.openclawEntry] };
  throw new PrepareError("openclaw 명령을 찾지 못했습니다 — Gateway 는 그대로입니다");
}

/** 1·2. 받기와 sha256 대조 — 토큰은 이 fetch 의 헤더로만 */
async function downloadVerified(opts: StartPluginUpdateOptions, tgz: string): Promise<void> {
  const url = `${opts.bridgeOrigin}/api/v1/setup/plugin.tgz`;
  let response: Awaited<ReturnType<Fetcher>>;
  let body: Buffer;
  try {
    response = await (opts.fetch ?? (fetch as unknown as Fetcher))(url, {
      headers: { authorization: `Bearer ${opts.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200)
      throw new PrepareError(`플러그인을 받지 못했습니다(HTTP ${response.status}) — Gateway 는 그대로입니다`);
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    const name = error instanceof Error ? error.name : "";
    throw new PrepareError(
      name === "TimeoutError"
        ? "플러그인을 받지 못했습니다(시간 초과) — Gateway 는 그대로입니다"
        : "플러그인을 받지 못했습니다(연결 실패) — Gateway 는 그대로입니다",
    );
  }
  if (createHash("sha256").update(body).digest("hex") !== opts.sha256)
    throw new PrepareError(
      "받은 파일의 sha256 이 서버가 알린 값과 다릅니다 — 설치하지 않았습니다(Gateway 는 그대로)",
    );
  writeFileSync(tgz, body, { mode: 0o600 });
}

/** 3. Gateway 가 서비스인가 — 아니면 내린 뒤 gateway start 로 다시 올릴 수 없다 */
async function ensureService(opts: StartPluginUpdateOptions, exists: (p: string) => boolean): Promise<void> {
  const { file, prefix } = openclawCommand(opts, exists);
  let stdout: string;
  try {
    ({ stdout } = await (opts.run ?? nodeCommandRunner)(
      file,
      [...prefix, "gateway", "status", "--json", "--no-probe"],
      { env: opts.env, timeoutMs: STATUS_TIMEOUT_MS },
    ));
  } catch {
    throw new PrepareError(
      "Gateway 서비스 상태를 읽지 못했습니다(openclaw gateway status) — Gateway 는 그대로입니다",
    );
  }
  let loaded = false;
  try {
    const status = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { service?: { loaded?: unknown } };
    loaded = status.service?.loaded === true;
  } catch {
    loaded = false;
  }
  if (!loaded) throw new PrepareError(NOT_SERVICE_MESSAGE);
}

/**
 * plugin.update 하나 — 꺼졌으면 disabled, 앞 업데이트의 잠금이 살아 있으면 busy. 아니면 받기·sha256 대조·서비스 확인을 이 프로세스에서
 * 하고(실패면 그 사유로 failed — Gateway 는 그대로), 통과하면 스크립트를 쓰고 띄운 뒤 ok. 어느 실패든 잠금과 받은 파일을 치운다. 띄운
 * 다음은 스크립트의 몫이다(결과는 last.json 으로)
 */
export async function startPluginUpdate(opts: StartPluginUpdateOptions): Promise<PluginUpdateResult> {
  if (!opts.enabled) return { ok: false, reason: "disabled", message: DISABLED_MESSAGE };
  if (!Sha256Hex.safeParse(opts.sha256).success)
    return { ok: false, reason: "invalid_version", message: "sha256 꼴이 아닙니다" };
  const now = (opts.now ?? Date.now)();
  const exists = opts.exists ?? existsSync;
  const paths = updatePaths(opts.stateDir);
  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    // 잠금 — 두 번 눌러도 한 번만 돈다. 스크립트가 끝나면 지운다. 오래된 잠금(죽은 스크립트)은 넘긴다
    if (existsSync(paths.lock)) {
      const age = now - statSync(paths.lock).mtimeMs;
      if (age < LOCK_STALE_MS) return { ok: false, reason: "busy", message: ALREADY_UPDATING_MESSAGE };
      rmSync(paths.lock, { force: true });
    }
    writeFileSync(paths.lock, `${now}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { ok: false, reason: "busy", message: ALREADY_UPDATING_MESSAGE };
    return { ok: false, reason: "failed", message: "업데이트 자리(상태 디렉터리)를 만들지 못했습니다" };
  }
  let tmpDir: string | undefined;
  try {
    // 받은 파일은 상태 디렉터리 안 0700 임시 디렉터리에 — 스크립트가 끝나면 지운다
    tmpDir = mkdtempSync(join(paths.dir, "download-"));
    const tgz = join(tmpDir, "dodok-openclaw-plugin.tgz");
    await downloadVerified(opts, tgz);
    await ensureService(opts, exists);
    writeFileSync(
      paths.script,
      renderPluginUpdateScript({
        tgz,
        tmpDir,
        paths,
        ...(opts.stopDelaySeconds === undefined ? {} : { stopDelaySeconds: opts.stopDelaySeconds }),
      }),
      { mode: 0o700 },
    );
    // 토큰은 넘기지 않는다 — 스크립트는 이미 받은 파일만 깐다
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      ...(opts.openclawNode ? { DODOK_OPENCLAW_NODE: opts.openclawNode } : {}),
      ...(opts.openclawEntry ? { DODOK_OPENCLAW_ENTRY: opts.openclawEntry } : {}),
    };
    delete env.DODOK_BRIDGE_TOKEN;
    const command = launchCommand({
      script: paths.script,
      env,
      platform: opts.platform ?? process.platform,
      now,
      exists,
    });
    try {
      await (opts.launch ?? nodeLauncher)({ ...command, env, logPath: paths.log });
    } catch {
      throw new PrepareError(LAUNCH_FAILED_MESSAGE);
    }
    return { ok: true };
  } catch (error) {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    rmSync(paths.lock, { force: true });
    return {
      ok: false,
      reason: "failed",
      message: error instanceof PrepareError ? error.message : "업데이트를 준비하지 못했습니다",
    };
  }
}
