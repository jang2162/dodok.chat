import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRemoteUpdate } from "../src/config";
import {
  ALREADY_UPDATING_MESSAGE,
  DISABLED_MESSAGE,
  type LaunchSpec,
  launchCommand,
  LOCK_STALE_MS,
  readLastUpdate,
  renderPluginUpdateScript,
  startPluginUpdate,
  updatePaths,
} from "../src/self-update";

// 원격 업데이트 스크립트(원격 업데이트 스펙 U5, Review Focus 3) — 가짜 openclaw·curl 위에서 bash 로 그대로 돌린다

const TOKEN = "dbt_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const TGZ = "fake plugin tgz bytes\n";
const SHA = createHash("sha256").update(TGZ).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "dodok-plugin-update-")));
  dirs.push(d);
  return d;
}

type Fail = "curl" | "http" | "status" | "not-service" | "stop" | "install" | "start" | "sha";

/** 가짜 bin — openclaw 는 받은 인자를 log 에 한 줄씩, curl 은 -K - 의 표준 입력을 따로 남기고 -o 자리에 TGZ 를 쓴다 */
function fakeBin(base: string, fail?: Fail) {
  const bin = join(base, "bin");
  mkdirSync(bin);
  const log = join(base, "calls.log");
  const curlStdin = join(base, "curl-stdin.txt");
  writeFileSync(
    join(bin, "openclaw"),
    `#!/bin/sh
printf 'openclaw %s\\n' "$*" >> '${log}'
case "$1 $2" in
  "gateway status") ${fail === "status" ? "exit 1" : fail === "not-service" ? `echo '{"service":{"loaded":false}}'` : `echo 'warn: x'; echo '{"service":{"loaded":true}}'`} ;;
  "gateway stop") ${fail === "stop" ? "exit 1" : "true"} ;;
  "plugins install") ${fail === "install" ? "exit 1" : "true"} ;;
  "gateway start") ${fail === "start" ? "exit 1" : "true"} ;;
esac
`,
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
printf 'curl %s\\n' "$*" >> '${log}'
cat > '${curlStdin}'
${fail === "curl" ? "exit 6" : ""}
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then out="$2"; shift; fi
  shift
done
printf '%s' '${fail === "sha" ? "tampered" : TGZ.trimEnd()}' > "$out"
${fail === "sha" ? "" : `printf '\\n' >> "$out"`}
printf '%s' '${fail === "http" ? "401" : "200"}'
`,
  );
  chmodSync(join(bin, "openclaw"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  return { bin, log, curlStdin };
}

function runScript(fail?: Fail) {
  const base = temp();
  const state = join(base, "state");
  const paths = updatePaths(state);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.lock, "1\n");
  const fake = fakeBin(base, fail);
  writeFileSync(
    paths.script,
    renderPluginUpdateScript({ origin: "https://chat.example", sha256: SHA, paths }),
  );
  const result = spawnSync("bash", [paths.script], {
    env: {
      PATH: `${fake.bin}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      DODOK_BRIDGE_TOKEN: TOKEN,
      HOME: base,
    },
    encoding: "utf8",
  });
  const calls = readFileSync(fake.log, "utf8").trim().split("\n");
  const openclaw = calls.filter((c) => c.startsWith("openclaw ")).map((c) => c.slice("openclaw ".length));
  return { result, calls, openclaw, paths, state, fake };
}

describe("업데이트 스크립트 — 가짜 openclaw·curl", () => {
  it("성공 — 받기 → sha 대조 → 서비스 확인 → 내리기 → 설치 → 결과 → 올리기, 토큰은 argv 에 없다", () => {
    const { result, calls, openclaw, paths, state, fake } = runScript();
    expect(result.status).toBe(0);
    expect(openclaw).toEqual([
      "gateway status --json --no-probe",
      "gateway stop --force",
      expect.stringMatching(/^plugins install \S+dodok-openclaw-plugin\.tgz --force --accept-capabilities$/),
      "gateway start",
    ]);
    // 설정·토큰을 건드리는 명령(config patch 등)이 없다
    expect(openclaw.some((c) => c.startsWith("config"))).toBe(false);
    expect(calls.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(fake.curlStdin, "utf8")).toBe(`header = "Authorization: Bearer ${TOKEN}"\n`);
    expect(calls.find((c) => c.startsWith("curl "))).toContain(
      "https://chat.example/api/v1/setup/plugin.tgz",
    );
    expect(readLastUpdate(state)).toEqual({ ok: true, at: expect.any(String) });
    expect(existsSync(paths.lock)).toBe(false);
  });

  // Review Focus 3 — 어느 단계에서 실패해도 Gateway 가 내려간 채로 남지 않는다
  it.each([
    ["curl", "플러그인을 받지 못했습니다(curl)"],
    ["http", "HTTP 401"],
    ["sha", "sha256 이 서버가 알린 값과 다릅니다"],
    ["status", "서비스 상태를 읽지 못했습니다"],
    ["not-service", "서비스(systemd·launchd)로 깔려 있지 않아"],
  ] as const)("%s 실패 — Gateway 를 내리지 않는다", (fail, message) => {
    const { result, openclaw, paths, state } = runScript(fail);
    expect(result.status).toBe(1);
    expect(openclaw).not.toContain("gateway stop --force");
    expect(openclaw.some((c) => c.startsWith("plugins install"))).toBe(false);
    expect(readLastUpdate(state)).toMatchObject({ ok: false, message: expect.stringContaining(message) });
    expect(existsSync(paths.lock)).toBe(false);
  });

  it.each([
    ["stop", "Gateway 를 내리지 못했습니다"],
    ["install", "플러그인 설치에 실패했습니다"],
  ] as const)("%s 실패 — 내린 뒤라 Gateway 를 다시 올린다", (fail, message) => {
    const { result, openclaw, state } = runScript(fail);
    expect(result.status).toBe(1);
    expect(openclaw.at(-1)).toBe("gateway start");
    expect(openclaw.filter((c) => c === "gateway start")).toHaveLength(1);
    expect(readLastUpdate(state)).toMatchObject({ ok: false, message: expect.stringContaining(message) });
  });

  it("설치 뒤 올리기가 실패하면 결과를 실패로 바꾼다", () => {
    const { result, openclaw, state } = runScript("start");
    expect(result.status).toBe(1);
    expect(openclaw.at(-1)).toBe("gateway start");
    expect(readLastUpdate(state)).toMatchObject({
      ok: false,
      message: expect.stringContaining("올리지 못했습니다"),
    });
  });

  it("셸에 넣을 수 없는 값·sha256 이 아닌 값이면 렌더를 멈춘다", () => {
    const paths = updatePaths("/s");
    expect(() => renderPluginUpdateScript({ origin: "https://x'; rm -rf /", sha256: SHA, paths })).toThrow();
    expect(() => renderPluginUpdateScript({ origin: "https://x", sha256: "nope", paths })).toThrow();
  });
});

describe("startPluginUpdate", () => {
  const base = (over: Partial<Parameters<typeof startPluginUpdate>[0]> = {}) => {
    const state = join(temp(), "state");
    const launched: LaunchSpec[] = [];
    return {
      state,
      launched,
      opts: {
        sha256: SHA,
        enabled: true,
        bridgeOrigin: "https://chat.example",
        token: TOKEN,
        stateDir: state,
        env: { PATH: "/usr/bin", HOME: "/h" },
        openclawNode: "/usr/bin/node",
        openclawEntry: "/opt/openclaw/openclaw.mjs",
        launch: (spec: LaunchSpec) => void launched.push(spec),
        platform: "darwin" as const,
        now: () => 1_000_000,
        ...over,
      },
    };
  };

  it("스크립트를 쓰고 bash 로 띄운다 — 토큰은 env 로만", () => {
    const { opts, launched, state } = base();
    expect(startPluginUpdate(opts)).toEqual({ ok: true });
    const paths = updatePaths(state);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ file: "bash", args: [paths.script], logPath: paths.log });
    expect(launched[0]!.env.DODOK_BRIDGE_TOKEN).toBe(TOKEN);
    expect(launched[0]!.env.DODOK_OPENCLAW_ENTRY).toBe("/opt/openclaw/openclaw.mjs");
    expect(launched[0]!.args.join(" ")).not.toContain(TOKEN);
    expect(readFileSync(paths.script, "utf8")).not.toContain(TOKEN);
    expect(readFileSync(paths.script, "utf8")).toContain(SHA);
  });

  // Review Focus 2 — 끈 Gateway 는 서버가 보내도 하지 않는다
  it("remoteUpdate 가 꺼졌으면 disabled — 아무것도 쓰거나 띄우지 않는다", () => {
    const { opts, launched, state } = base({ enabled: false });
    expect(startPluginUpdate(opts)).toEqual({ ok: false, reason: "disabled", message: DISABLED_MESSAGE });
    expect(launched).toEqual([]);
    expect(existsSync(updatePaths(state).dir)).toBe(false);
  });

  // Review Focus 4 — 연타는 한 번만
  it("두 번째 요청은 앞 스크립트의 잠금이 살아 있는 동안 busy", () => {
    const { opts, launched } = base();
    expect(startPluginUpdate(opts)).toEqual({ ok: true });
    expect(startPluginUpdate(opts)).toEqual({ ok: false, reason: "busy", message: ALREADY_UPDATING_MESSAGE });
    expect(launched).toHaveLength(1);
  });

  it("오래된 잠금(죽은 스크립트)은 넘긴다", () => {
    const { opts, launched, state } = base();
    const paths = updatePaths(state);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, "0\n");
    const old = (1_000_000 - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(paths.lock, old, old);
    expect(startPluginUpdate(opts)).toEqual({ ok: true });
    expect(launched).toHaveLength(1);
  });

  it("띄우기가 던지면 failed 이고 잠금을 푼다", () => {
    const { opts, state } = base({
      launch: () => {
        throw new Error("spawn bash ENOENT");
      },
    });
    expect(startPluginUpdate(opts)).toMatchObject({ ok: false, reason: "failed" });
    expect(existsSync(updatePaths(state).lock)).toBe(false);
  });

  it("systemd 서비스 아래(INVOCATION_ID)면 systemd-run --user --scope 로 띄운다", () => {
    expect(
      launchCommand({
        script: "/s/update.sh",
        env: { INVOCATION_ID: "x", PATH: "/usr/bin" },
        platform: "linux",
        now: 7,
        exists: (p) => p === "/usr/bin/systemd-run",
      }),
    ).toEqual({
      file: "/usr/bin/systemd-run",
      args: [
        "--user",
        "--scope",
        "--collect",
        "--quiet",
        "--unit=dodok-plugin-update-7.scope",
        "bash",
        "/s/update.sh",
      ],
    });
    expect(
      launchCommand({ script: "/s/u.sh", env: {}, platform: "linux", now: 7, exists: () => true }),
    ).toEqual({
      file: "bash",
      args: ["/s/u.sh"],
    });
  });
});

describe("설정과 마지막 결과", () => {
  it("remoteUpdate 는 기본 허용, false 면 끔, 설정이 틀렸으면 받지 않는다", () => {
    expect(resolveRemoteUpdate(undefined)).toBe(true);
    expect(resolveRemoteUpdate({ remoteUpdate: true })).toBe(true);
    expect(resolveRemoteUpdate({ remoteUpdate: false })).toBe(false);
    expect(resolveRemoteUpdate({ remoteUpdate: "no" })).toBe(false);
  });
  it("결과 파일이 없거나 꼴이 틀리면 undefined", () => {
    const state = join(temp(), "state");
    expect(readLastUpdate(state)).toBeUndefined();
    mkdirSync(updatePaths(state).dir, { recursive: true });
    writeFileSync(updatePaths(state).result, "{nope");
    expect(readLastUpdate(state)).toBeUndefined();
  });
});
