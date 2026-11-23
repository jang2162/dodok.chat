/**
 * 원격 업데이트(원격 업데이트 스펙 U5) — 서버의 `plugin.update` 를 받으면 Gateway 밖으로 분리된 bash 스크립트를 띄운다. 스크립트는
 * 서버에서 이 플러그인의 브리지 토큰으로 plugin.tgz 를 받고, 파일 sha256 이 서버가 알려 준 값과 같을 때만 Gateway 를 내리고
 * (`openclaw gateway stop`) 설치하고(`openclaw plugins install … --force --accept-capabilities`) 다시 올린다. 설정·토큰은 건드리지
 * 않는다. Gateway 를 내린 뒤 어느 단계에서 실패해도 Gateway 를 다시 올린다(옛 플러그인 그대로). 결과는 상태 디렉터리의
 * `dodok-update/last.json` 에 남고, 다시 붙은 플러그인이 hello 의 lastUpdate 로 싣는다.
 *
 * 스크립트 본문은 이 플러그인 코드가 만든다 — 서버가 보내는 것은 sha256 하나다(서버가 Gateway 호스트에 임의 명령을 돌리게 하지 않는다).
 * 받는 자리·내리기·설치 명령은 서버의 설치 스크립트(apps/server/src/modules/setup/plugin-install-script.ts)와 같다. 토큰은 env 로만
 * 넘기고 curl 에는 표준 입력(`-K -`)으로 — 어떤 명령의 argv 에도 싣지 않는다. `openclaw` 를 import 하지 않는다 — 단위 시험 대상
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
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
/** 앞 업데이트의 잠금 파일이 이보다 오래됐으면 죽은 것으로 본다 — 서버 상한(5분)보다 길게 */
export const LOCK_STALE_MS = 10 * 60_000;

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

/** 셸 작은따옴표 값 — 오리진·hex·경로. 따옴표·줄바꿈이 있으면 스크립트를 깨뜨리므로 쓰지 않는다 */
function quote(name: string, value: string): string {
  if (/['\n\r\0]/.test(value)) throw new Error(`dodok update: ${name} 에 셸에 넣을 수 없는 글자가 있다`);
  return `'${value}'`;
}

export type UpdateScriptInput = {
  /** 서버 오리진(`https://…`) — 브리지 주소에서 */
  origin: string;
  /** 서버가 알려 준 plugin.tgz 파일 sha256 */
  sha256: string;
  paths: UpdatePaths;
};

/**
 * 업데이트 스크립트 본문. 결과 파일은 Gateway 를 올리기 **전에** 쓴다 — 새 플러그인이 올라오자마자 결과를 읽어 hello 에 싣는다.
 * bash 3.2(macOS 기본)에서도 돌게 `[[ =~ ]]`·연관 배열을 쓰지 않는다
 */
export function renderPluginUpdateScript(input: UpdateScriptInput): string {
  const { origin, sha256, paths } = input;
  if (!Sha256Hex.safeParse(sha256).success) throw new Error("dodok update: sha256 꼴이 아니다");
  return `#!/usr/bin/env bash
# dodok — 원격 업데이트(웹의 「업데이트」). dodok 플러그인이 만들어 Gateway 밖에서 돌린다 — 손으로 돌리지 않는다.
dodok_plugin_update() {
  set -u
  dodok_origin=${quote("origin", origin)}
  dodok_file_sha=${quote("sha256", sha256)}
  dodok_result=${quote("result", paths.result)}
  dodok_lock=${quote("lock", paths.lock)}
  dodok_stopped=0
  dodok_dir=""

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
  # 결과 파일 — JSON 이스케이프는 node 가(메시지는 env 로 넘긴다)
  dodok_write_result() {
    DODOK_RESULT_OK="$1" DODOK_RESULT_MESSAGE="$2" DODOK_RESULT_FILE="$dodok_result" node -e '
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
    if [ -n "$dodok_dir" ]; then rm -rf "$dodok_dir"; fi
    rm -f "$dodok_lock"
  }
  trap dodok_cleanup EXIT
  trap 'dodok_fail "업데이트 스크립트가 중단됐습니다"' INT TERM HUP

  dodok_token="\${DODOK_BRIDGE_TOKEN:-}"
  unset DODOK_BRIDGE_TOKEN
  [ -n "$dodok_token" ] || dodok_fail "브리지 토큰이 없습니다"
  for dodok_tool in curl node mktemp; do
    command -v "$dodok_tool" >/dev/null 2>&1 || dodok_fail "$dodok_tool 명령이 없습니다"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    dodok_sha_tool="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    dodok_sha_tool="shasum -a 256"
  else
    dodok_fail "sha256sum 도 shasum 도 없습니다"
  fi

  dodok_dir="$(mktemp -d "\${TMPDIR:-/tmp}/dodok-update.XXXXXX")" || dodok_fail "임시 디렉터리를 만들지 못했습니다"
  dodok_tgz="$dodok_dir/dodok-openclaw-plugin.tgz"

  # 1. 받기 — 토큰은 curl 의 표준 입력(-K -)으로만
  dodok_say "플러그인을 받습니다: $dodok_origin/api/v1/setup/plugin.tgz"
  dodok_code="$(printf 'header = "Authorization: Bearer %s"\\n' "$dodok_token" |
    curl -sS -o "$dodok_tgz" -w '%{http_code}' -K - "$dodok_origin/api/v1/setup/plugin.tgz")" ||
    dodok_fail "플러그인을 받지 못했습니다(curl) — Gateway 는 그대로입니다"
  dodok_token=""
  [ "$dodok_code" = 200 ] || dodok_fail "플러그인을 받지 못했습니다(HTTP $dodok_code) — Gateway 는 그대로입니다"

  # 2. 파일 sha256 — 서버가 알려 준 값과 다르면 Gateway 를 건드리지 않는다
  dodok_got="$($dodok_sha_tool "$dodok_tgz" </dev/null)" || dodok_fail "받은 파일의 sha256 을 재지 못했습니다"
  dodok_got="\${dodok_got%% *}"
  [ "$dodok_got" = "$dodok_file_sha" ] ||
    dodok_fail "받은 파일의 sha256 이 서버가 알린 값과 다릅니다 — 설치하지 않았습니다(Gateway 는 그대로)"

  # 3. Gateway 가 서비스인가 — 아니면 내린 뒤 gateway start 로 다시 올릴 수 없다
  dodok_status="$(dodok_openclaw gateway status --json --no-probe)" ||
    dodok_fail "Gateway 서비스 상태를 읽지 못했습니다(openclaw gateway status) — Gateway 는 그대로입니다"
  printf '%s' "$dodok_status" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  try {
    const j = JSON.parse(s.slice(s.indexOf("{")));
    process.exit(j.service && j.service.loaded === true ? 0 : 1);
  } catch {
    process.exit(1);
  }
});' || dodok_fail "이 Gateway 는 서비스(systemd·launchd)로 깔려 있지 않아 원격 업데이트를 할 수 없습니다 — 설치 한 줄을 그 호스트에서 돌리세요"

  # 4. 내리기 — 실패해도 반쯤 내려갔을 수 있어 내린 것으로 친다(dodok_fail 이 다시 올린다)
  dodok_say "Gateway 를 내립니다(openclaw gateway stop)."
  dodok_stopped=1
  dodok_openclaw gateway stop --force || dodok_fail "Gateway 를 내리지 못했습니다(openclaw gateway stop)"

  # 5. 설치 — 설정·토큰은 그대로
  dodok_say "플러그인을 설치합니다(openclaw plugins install)."
  dodok_openclaw plugins install "$dodok_tgz" --force --accept-capabilities ||
    dodok_fail "플러그인 설치에 실패했습니다(openclaw plugins install) — 옛 플러그인으로 Gateway 를 다시 올렸습니다"

  # 6. 결과를 먼저 쓰고 올린다
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
export type Launcher = (spec: LaunchSpec) => void;

/** 분리된 자식 — 새 세션(프로세스 그룹)이라 launchd 가 Gateway 를 내릴 때 함께 죽지 않는다. 출력은 로그 파일에 */
export const nodeLauncher: Launcher = (spec) => {
  const fd = openSync(spec.logPath, "a", 0o600);
  try {
    const child = spawn(spec.file, spec.args, {
      env: spec.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
};

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
  launch?: Launcher;
  platform?: NodeJS.Platform;
  now?: () => number;
};

/**
 * plugin.update 하나 — 꺼졌으면 disabled, 앞 업데이트의 잠금이 살아 있으면 busy, 아니면 스크립트를 쓰고 띄운 뒤 ok. 띄운 다음은
 * 스크립트의 몫이다(결과는 last.json 으로)
 */
export function startPluginUpdate(opts: StartPluginUpdateOptions): PluginUpdateResult {
  if (!opts.enabled) return { ok: false, reason: "disabled", message: DISABLED_MESSAGE };
  if (!Sha256Hex.safeParse(opts.sha256).success)
    return { ok: false, reason: "invalid_version", message: "sha256 꼴이 아닙니다" };
  const now = (opts.now ?? Date.now)();
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
  try {
    writeFileSync(
      paths.script,
      renderPluginUpdateScript({ origin: opts.bridgeOrigin, sha256: opts.sha256, paths }),
      {
        mode: 0o700,
      },
    );
    const env: NodeJS.ProcessEnv = {
      ...opts.env,
      DODOK_BRIDGE_TOKEN: opts.token,
      ...(opts.openclawNode ? { DODOK_OPENCLAW_NODE: opts.openclawNode } : {}),
      ...(opts.openclawEntry ? { DODOK_OPENCLAW_ENTRY: opts.openclawEntry } : {}),
    };
    const command = launchCommand({
      script: paths.script,
      env,
      platform: opts.platform ?? process.platform,
      now,
    });
    (opts.launch ?? nodeLauncher)({ ...command, env, logPath: paths.log });
    return { ok: true };
  } catch {
    rmSync(paths.lock, { force: true });
    return { ok: false, reason: "failed", message: "업데이트 스크립트를 띄우지 못했습니다" };
  }
}
