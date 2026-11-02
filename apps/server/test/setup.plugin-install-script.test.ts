/**
 * `plugin-install.sh`(설치 한 줄 명령 스펙 2절)를 가짜 `openclaw`·`curl` 위에서 bash 로 그대로 돌린다 — 실행은 `bash < 본문` 이라
 * `curl … | bash` 와 같은 조건(bash 의 표준 입력이 본문)이다. 가짜 둘은 받은 인자를 `$LOG` 에 한 줄씩 남긴다
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_INSTALL_SCRIPT_PATH } from "@dodok/shared";
import { renderPluginInstallScript } from "../src/modules/setup/plugin-install-script";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const ORIGIN = "https://chat.example.com";
const BRIDGE_URL = "wss://chat.example.com/bridge";
const TOKEN = `dbt_${"x7".repeat(21)}Q`;
const TGZ = Buffer.from("가짜 tgz 바이트\n");
const BUNDLE = Buffer.from("export const dodok = 1;\n");

const script = (over: { sha256?: string; bundleSha256?: string } = {}) =>
  renderPluginInstallScript({
    origin: ORIGIN,
    bridgeUrl: BRIDGE_URL,
    plugin: { sha256: over.sha256 ?? sha(TGZ), bundleSha256: over.bundleSha256 ?? sha(BUNDLE) },
  });

const stub = (path: string, body: string[]) =>
  writeFileSync(path, ["#!/bin/sh", 'printf "%s %s\\n" "${0##*/}" "$*" >> "$LOG"', ...body, ""].join("\n"), {
    mode: 0o755,
  });

let root: string;
let bin: string;
let home: string;
let tmp: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dodok-install-sh-"));
  bin = join(root, "bin");
  home = join(root, "home");
  tmp = join(root, "tmp");
  log = join(root, "log");
  for (const d of [bin, home, tmp]) mkdirSync(d);
  writeFileSync(join(root, "plugin.tgz"), TGZ);
  writeFileSync(join(root, "bundle.js"), BUNDLE);
  // 가짜 curl — -K - 의 표준 입력을 남기고, -o 자리에 품은 tgz 를 쓰고, -w 가 있으면 상태 코드를 찍는다
  stub(join(bin, "curl"), [
    'out=""; w=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; -w) w=1;; esac; shift; done',
    'cat > "$STUB_DIR/curl.stdin"',
    '[ -n "$out" ] && cp "$STUB_TGZ" "$out"',
    '[ -n "$w" ] && printf "%s" "${STUB_HTTP:-200}"',
    "exit 0",
  ]);
  stub(join(bin, "openclaw"), [
    'case "$1 $2" in',
    '  "gateway stop") [ -n "$STUB_STOP_FAIL" ] && exit 1; exit 0;;',
    '  "gateway start") exit 0;;',
    '  "plugins install")',
    '    [ -n "$STUB_INSTALL_FAIL" ] && exit 1',
    '    [ -f "$3" ] || exit 2',
    '    d="${STUB_ROOTDIR:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/dodok}/dist"',
    '    mkdir -p "$d" && cp "$STUB_BUNDLE" "$d/index.js"; exit 0;;',
    '  "plugins inspect")',
    '    [ -n "$STUB_ROOTDIR" ] && r=",\\"rootDir\\":\\"$STUB_ROOTDIR\\"" || r=""',
    '    printf \'%s\\n\' "{\\"plugin\\":{\\"status\\":\\"${STUB_STATUS:-loaded}\\",\\"channelIds\\":[\\"dodok\\"]$r}}"; exit 0;;',
    '  "config patch") cat > "$STUB_DIR/patch.json"; [ -n "$STUB_PATCH_FAIL" ] && exit 1; exit 0;;',
    "esac",
    "exit 64",
  ]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(body: string, env: Record<string, string> = {}, path = `${bin}:${process.env.PATH}`) {
  const file = join(root, "install.sh");
  writeFileSync(file, body);
  return spawnSync("/bin/bash", ["-c", 'bash < "$SCRIPT"'], {
    encoding: "utf8",
    env: {
      PATH: path,
      HOME: home,
      TMPDIR: tmp,
      LOG: log,
      STUB_DIR: root,
      STUB_TGZ: join(root, "plugin.tgz"),
      STUB_BUNDLE: join(root, "bundle.js"),
      SCRIPT: file,
      DODOK_BRIDGE_TOKEN: TOKEN,
      ...env,
    },
  });
}
const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const openclawCalls = () =>
  logText()
    .split("\n")
    .filter((l) => l.startsWith("openclaw "));

describe("plugin-install.sh", () => {
  it("경로 상수", () => {
    expect(PLUGIN_INSTALL_SCRIPT_PATH).toBe("/api/v1/setup/plugin-install.sh");
  });

  it("bash -n 으로 문법이 맞다", () => {
    const file = join(root, "syntax.sh");
    writeFileSync(file, script());
    const res = spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
  });

  it("정상 — stop → install → inspect → patch → start 순서, 끝 코드 0", () => {
    const res = run(script());
    expect(res.status, res.stderr).toBe(0);
    const calls = openclawCalls();
    expect(calls).toHaveLength(5);
    expect(calls[0]).toBe("openclaw gateway stop --force");
    expect(calls[1]).toMatch(
      new RegExp(`^openclaw plugins install ${tmp}/[^ ]+\\.tgz --force --accept-capabilities$`),
    );
    expect(calls.slice(2)).toEqual([
      "openclaw plugins inspect dodok --json",
      "openclaw config patch --stdin",
      "openclaw gateway start",
    ]);
    expect(logText()).toContain(`${ORIGIN}/api/v1/setup/plugin.tgz`);
    expect(JSON.parse(readFileSync(join(root, "patch.json"), "utf8"))).toEqual({
      channels: { dodok: { accounts: { default: { bridgeUrl: BRIDGE_URL, token: TOKEN } } } },
    });
    expect(readFileSync(join(root, "curl.stdin"), "utf8")).toContain(`Authorization: Bearer ${TOKEN}`);
    // 받은 tgz 를 둔 임시 디렉터리는 끝나면 지운다
    expect(readdirSync(tmp)).toEqual([]);
    expect(res.stdout + res.stderr).not.toContain(TOKEN);
  });

  it("토큰은 어떤 argv 에도 없다", () => {
    const res = run(script());
    expect(res.status, res.stderr).toBe(0);
    expect(logText()).not.toBe("");
    expect(logText()).not.toContain(TOKEN);
  });

  it("파일 sha 가 다르면 gateway 를 건드리지 않고 멈춘다", () => {
    const res = run(script({ sha256: "0".repeat(64) }));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("sha256");
    expect(logText()).toContain("curl ");
    expect(logText()).not.toContain("gateway");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("401·404·409 면 알아볼 문구로 멈추고 gateway 를 건드리지 않는다", () => {
    for (const [code, needle] of [
      ["401", "새로 발급"],
      ["404", "PLUGIN_FILE_MISSING"],
      ["409", "재시작"],
    ] as const) {
      rmSync(log, { force: true });
      const res = run(script(), { STUB_HTTP: code });
      expect(res.status, code).not.toBe(0);
      expect(res.stderr, code).toContain(needle);
      expect(logText(), code).toContain("curl ");
      expect(logText(), code).not.toContain("gateway");
    }
  });

  it("gateway stop 이 실패하면 설치하지 않고 DODOK_GATEWAY_SERVICE=0 을 알린다", () => {
    const res = run(script(), { STUB_STOP_FAIL: "1" });
    expect(res.status).not.toBe(0);
    expect(openclawCalls()).toEqual(["openclaw gateway stop --force"]);
    expect(res.stderr).toContain("DODOK_GATEWAY_SERVICE=0");
  });

  it("DODOK_GATEWAY_SERVICE=0 이면 stop·start 없이 설치·patch 하고 직접 올리라고 알린다", () => {
    const res = run(script(), { DODOK_GATEWAY_SERVICE: "0" });
    expect(res.status, res.stderr).toBe(0);
    const calls = openclawCalls();
    expect(calls.some((c) => c.includes("gateway"))).toBe(false);
    expect(calls.map((c) => c.split(" ").slice(0, 3).join(" "))).toEqual([
      "openclaw plugins install",
      "openclaw plugins inspect",
      "openclaw config patch",
    ]);
    expect(res.stdout + res.stderr).toContain("직접 올리");
  });

  it("설치가 실패하면 gateway start 를 다시 부르고 실패로 끝난다", () => {
    const res = run(script(), { STUB_INSTALL_FAIL: "1" });
    expect(res.status).not.toBe(0);
    const calls = openclawCalls();
    expect(calls[0]).toBe("openclaw gateway stop --force");
    expect(calls.at(-1)).toBe("openclaw gateway start");
    expect(calls.some((c) => c.startsWith("openclaw config patch"))).toBe(false);
  });

  it("번들 sha 가 다르면 gateway 를 다시 올리고 실패로 끝난다", () => {
    const res = run(script({ bundleSha256: "0".repeat(64) }));
    expect(res.status).not.toBe(0);
    const calls = openclawCalls();
    expect(calls.at(-1)).toBe("openclaw gateway start");
    expect(calls.some((c) => c.startsWith("openclaw config patch"))).toBe(false);
    expect(res.stderr).toContain("sha256");
  });

  it("patch 가 실패하면 gateway 를 다시 올리고 토큰 폐기를 안내한다", () => {
    const res = run(script(), { STUB_PATCH_FAIL: "1" });
    expect(res.status).not.toBe(0);
    expect(openclawCalls().at(-1)).toBe("openclaw gateway start");
    expect(res.stderr).toContain("폐기");
  });

  it("OPENCLAW_STATE_DIR 의 번들을 대조한다", () => {
    const state = join(root, "state");
    const res = run(script(), { OPENCLAW_STATE_DIR: state });
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(state, "extensions/dodok/dist/index.js"))).toBe(true);
    expect(existsSync(join(home, ".openclaw"))).toBe(false);

    // 기본 자리에 옛 번들이 있어도 그 파일로 「같다」고 판정하지 않는다
    rmSync(log, { force: true });
    const oldDefault = join(home, ".openclaw/extensions/dodok/dist");
    mkdirSync(oldDefault, { recursive: true });
    writeFileSync(join(oldDefault, "index.js"), BUNDLE);
    const mismatch = run(script(), {
      OPENCLAW_STATE_DIR: state,
      STUB_BUNDLE: join(root, "plugin.tgz"), // 설치되는 번들이 기대와 다르다
    });
    expect(mismatch.status).not.toBe(0);
  });

  it("inspect 가 rootDir 을 주면 그 자리의 번들을 대조한다", () => {
    const rootDir = join(root, "elsewhere", "dodok");
    const res = run(script(), { STUB_ROOTDIR: rootDir });
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(rootDir, "dist/index.js"))).toBe(true);
    expect(existsSync(join(home, ".openclaw"))).toBe(false);
  });

  it("플러그인이 로드되지 않으면 gateway 를 다시 올리고 실패로 끝난다", () => {
    const res = run(script(), { STUB_STATUS: "error" });
    expect(res.status).not.toBe(0);
    expect(openclawCalls().at(-1)).toBe("openclaw gateway start");
    expect(openclawCalls().some((c) => c.startsWith("openclaw config patch"))).toBe(false);
  });

  const shasum = spawnSync("/bin/sh", ["-c", "command -v shasum"], { encoding: "utf8" }).stdout.trim();
  it.skipIf(!shasum)("sha256sum 이 없으면 shasum -a 256 으로 대조한다", () => {
    const only = join(root, "only");
    mkdirSync(only);
    // 가짜 둘 + 스크립트·가짜가 쓰는 도구만 — sha256sum 은 넣지 않는다
    symlinkSync(join(bin, "curl"), join(only, "curl"));
    symlinkSync(join(bin, "openclaw"), join(only, "openclaw"));
    symlinkSync(shasum, join(only, "shasum"));
    symlinkSync(process.execPath, join(only, "node"));
    for (const tool of ["bash", "mktemp", "rm", "cp", "mkdir", "cat", "perl"]) {
      const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(only, tool));
    }
    const res = run(script(), {}, only);
    expect(res.status, res.stderr).toBe(0);
    expect(openclawCalls().at(-1)).toBe("openclaw gateway start");
    // 같은 PATH 에서 sha 가 어긋나면 멈춘다 — shasum 으로 실제로 쟀다
    rmSync(log, { force: true });
    const bad = run(script({ sha256: "0".repeat(64) }), {}, only);
    expect(bad.status).not.toBe(0);
    expect(logText()).not.toContain("gateway");
  });

  it("토큰이 없거나 꼴이 다르면 아무것도 부르지 않는다", () => {
    for (const token of ["", "dbt_short", `drn_${"x".repeat(43)}`, `dbt_${"x".repeat(42)};`]) {
      const res = run(script(), { DODOK_BRIDGE_TOKEN: token });
      expect(res.status, token).not.toBe(0);
      expect(res.stderr, token).toContain("DODOK_BRIDGE_TOKEN");
      expect(logText(), token).toBe("");
    }
  });

  it("잘린 본문은 아무것도 하지 않는다", () => {
    const lines = script().trimEnd().split("\n");
    const res = run(lines.slice(0, -1).join("\n"));
    expect(logText()).toBe("");
    expect(res.stdout).toBe("");
  });

  it("렌더 값에 작은따옴표가 있으면 던진다", () => {
    expect(() =>
      renderPluginInstallScript({
        origin: "https://x.example/'; rm -rf ~; '",
        bridgeUrl: BRIDGE_URL,
        plugin: { sha256: sha(TGZ), bundleSha256: sha(BUNDLE) },
      }),
    ).toThrow();
  });
});
