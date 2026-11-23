import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  type CommandRunner,
  DISABLED_MESSAGE,
  type Fetcher,
  LAUNCH_FAILED_MESSAGE,
  type LaunchSpec,
  launchCommand,
  LOCK_STALE_MS,
  nodeLauncher,
  NOT_SERVICE_MESSAGE,
  readLastUpdate,
  renderPluginUpdateScript,
  startPluginUpdate,
  updatePaths,
} from "../src/self-update";

// 원격 업데이트(원격 업데이트 스펙 U5, Review Focus 3) — 받기·sha·서비스 확인은 Gateway 프로세스 안(startPluginUpdate, 리뷰 M2), 내리기·
// 설치·올리기는 스크립트. 스크립트는 가짜 openclaw 위에서 bash 로 그대로 돌린다

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

type Fail = "stop" | "install" | "start";

/** 가짜 bin — openclaw 는 받은 인자를 log 에 한 줄씩 */
function fakeBin(base: string, fail?: Fail) {
  const bin = join(base, "bin");
  mkdirSync(bin);
  const log = join(base, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "openclaw"),
    `#!/bin/sh
printf 'openclaw %s\\n' "$*" >> '${log}'
case "$1 $2" in
  "gateway stop") ${fail === "stop" ? "exit 1" : "true"} ;;
  "plugins install") ${fail === "install" ? "exit 1" : "true"} ;;
  "gateway start") ${fail === "start" ? "exit 1" : "true"} ;;
esac
`,
  );
  chmodSync(join(bin, "openclaw"), 0o755);
  return { bin, log };
}

function runScript(fail?: Fail, opts: { noTgz?: boolean } = {}) {
  const base = temp();
  const state = join(base, "state");
  const paths = updatePaths(state);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.lock, "1\n");
  const tmpDir = mkdtempSync(join(paths.dir, "download-"));
  const tgz = join(tmpDir, "dodok-openclaw-plugin.tgz");
  if (!opts.noTgz) writeFileSync(tgz, TGZ);
  const fake = fakeBin(base, fail);
  writeFileSync(paths.script, renderPluginUpdateScript({ tgz, tmpDir, paths, stopDelaySeconds: 0 }));
  const result = spawnSync("bash", [paths.script], {
    env: { PATH: `${fake.bin}:/usr/bin:/bin:${process.env.PATH ?? ""}`, HOME: base },
    encoding: "utf8",
  });
  const openclaw = readFileSync(fake.log, "utf8")
    .trim()
    .split("\n")
    .filter((c) => c.startsWith("openclaw "))
    .map((c) => c.slice("openclaw ".length));
  return { result, openclaw, paths, state, tgz, tmpDir };
}

describe("업데이트 스크립트 — 가짜 openclaw", () => {
  it("성공 — 내리기 → 받은 파일 설치 → 결과 → 올리기, 끝나면 받은 파일·잠금을 치운다", () => {
    const { result, openclaw, paths, state, tgz, tmpDir } = runScript();
    expect(result.status).toBe(0);
    expect(openclaw).toEqual([
      "gateway stop --force",
      `plugins install ${tgz} --force --accept-capabilities`,
      "gateway start",
    ]);
    // 설정·토큰을 건드리는 명령(config patch 등)이 없다
    expect(openclaw.some((c) => c.startsWith("config"))).toBe(false);
    expect(readLastUpdate(state)).toEqual({ ok: true, at: expect.any(String) });
    expect(existsSync(paths.lock)).toBe(false);
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("받은 파일이 없으면 Gateway 를 내리지 않는다", () => {
    const { result, openclaw, state } = runScript(undefined, { noTgz: true });
    expect(result.status).toBe(1);
    expect(openclaw).toEqual([]);
    expect(readLastUpdate(state)).toMatchObject({
      ok: false,
      message: expect.stringContaining("파일이 없습니다"),
    });
  });

  // Review Focus 3 — 내린 뒤 어느 단계에서 실패해도 Gateway 가 내려간 채로 남지 않는다
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

  it("셸에 넣을 수 없는 경로면 렌더를 멈춘다", () => {
    const paths = updatePaths("/s");
    expect(() => renderPluginUpdateScript({ tgz: "/x'; rm -rf /", tmpDir: "/x", paths })).toThrow();
    expect(() => renderPluginUpdateScript({ tgz: "/x", tmpDir: "/x\n", paths })).toThrow();
  });
});

describe("startPluginUpdate — 내리기 전 단계는 이 프로세스에서(리뷰 M2)", () => {
  type Seen = {
    fetch: Array<{ url: string; headers: Record<string, string> }>;
    run: string[][];
    launched: LaunchSpec[];
  };
  const okFetch =
    (seen: Seen, body = TGZ, status = 200): Fetcher =>
    async (url, init) => {
      seen.fetch.push({ url, headers: init.headers });
      return { status, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
    };
  const statusRun =
    (seen: Seen, stdout = 'warn: x\n{"service":{"loaded":true}}'): CommandRunner =>
    async (file, args) => {
      seen.run.push([file, ...args]);
      return { stdout };
    };
  const base = (over: (seen: Seen) => Partial<Parameters<typeof startPluginUpdate>[0]> = () => ({})) => {
    const state = join(temp(), "state");
    const seen: Seen = { fetch: [], run: [], launched: [] };
    return {
      state,
      seen,
      opts: {
        sha256: SHA,
        enabled: true,
        bridgeOrigin: "https://chat.example",
        token: TOKEN,
        stateDir: state,
        env: { PATH: "/usr/bin", HOME: "/h", DODOK_BRIDGE_TOKEN: "stale" },
        openclawNode: "/usr/bin/node",
        openclawEntry: "/opt/openclaw/openclaw.mjs",
        fetch: okFetch(seen),
        run: statusRun(seen),
        launch: async (spec: LaunchSpec) => void seen.launched.push(spec),
        platform: "darwin" as const,
        now: () => 1_000_000,
        exists: () => false,
        ...over(seen),
      },
    };
  };
  /** 실패 뒤 — 잠금도 받은 파일도 남지 않는다 */
  const expectCleaned = (state: string) => {
    const paths = updatePaths(state);
    expect(existsSync(paths.lock)).toBe(false);
    expect(readdirSync(paths.dir).filter((n) => n.startsWith("download-"))).toEqual([]);
  };

  it("받기(토큰은 fetch 헤더로만) → sha 대조 → 서비스 확인 → 받은 파일 경로만 스크립트에 넘겨 bash 로 띄운다", async () => {
    const { opts, seen, state } = base();
    expect(await startPluginUpdate(opts)).toEqual({ ok: true });
    expect(seen.fetch).toEqual([
      { url: "https://chat.example/api/v1/setup/plugin.tgz", headers: { authorization: `Bearer ${TOKEN}` } },
    ]);
    // PATH 에 openclaw 가 없으면 Gateway 를 돌리던 node·진입 파일로
    expect(seen.run).toEqual([
      ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway", "status", "--json", "--no-probe"],
    ]);
    const paths = updatePaths(state);
    expect(seen.launched).toHaveLength(1);
    expect(seen.launched[0]).toMatchObject({ file: "bash", args: [paths.script], logPath: paths.log });
    // 토큰은 스크립트·env·argv 어디에도 없다
    expect(seen.launched[0]!.env.DODOK_BRIDGE_TOKEN).toBeUndefined();
    expect(JSON.stringify(seen.launched[0])).not.toContain(TOKEN);
    const script = readFileSync(paths.script, "utf8");
    expect(script).not.toContain(TOKEN);
    expect(script).not.toContain("curl");
    const [download] = readdirSync(paths.dir).filter((n) => n.startsWith("download-"));
    const tgz = join(paths.dir, download!, "dodok-openclaw-plugin.tgz");
    expect(readFileSync(tgz, "utf8")).toBe(TGZ);
    expect(script).toContain(`dodok_tgz='${tgz}'`);
    expect(existsSync(paths.lock)).toBe(true);
  });

  it.each([
    [
      "HTTP 401",
      (seen: Seen) => ({ fetch: okFetch(seen, TGZ, 401) }),
      "플러그인을 받지 못했습니다(HTTP 401)",
    ],
    [
      "연결 실패",
      () => ({
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as Fetcher,
      }),
      "플러그인을 받지 못했습니다(연결 실패)",
    ],
    [
      "sha 불일치",
      (seen: Seen) => ({ fetch: okFetch(seen, "tampered") }),
      "sha256 이 서버가 알린 값과 다릅니다",
    ],
    [
      "상태 읽기 실패",
      () => ({
        run: (async () => {
          throw new Error("exit 1");
        }) as CommandRunner,
      }),
      "Gateway 서비스 상태를 읽지 못했습니다",
    ],
    [
      "서비스 아님",
      (seen: Seen) => ({ run: statusRun(seen, '{"service":{"loaded":false}}') }),
      NOT_SERVICE_MESSAGE,
    ],
    [
      "띄우기 실패(systemd-run 이 곧바로 0 이 아님)",
      () => ({
        launch: (async () => {
          throw new Error("systemd-run exit 1");
        }) as (spec: LaunchSpec) => Promise<void>,
      }),
      LAUNCH_FAILED_MESSAGE,
    ],
  ] as const)("%s — ack 로 사유, 띄우지 않고 잠금·받은 파일을 치운다", async (_name, over, message) => {
    const { opts, seen, state } = base(over);
    const result = await startPluginUpdate(opts);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(result.ok === false && result.message).toContain(message);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (!message.startsWith("업데이트 스크립트")) expect(seen.launched).toEqual([]);
    expectCleaned(state);
    // 잠금이 풀렸으니 바로 다시 받는다
    const again = base();
    expect(await startPluginUpdate({ ...again.opts, stateDir: state })).toEqual({ ok: true });
  });

  it("PATH 에 openclaw 가 있으면 그것으로 상태를 본다", async () => {
    const { opts, seen } = base(() => ({ exists: (p: string) => p === "/usr/bin/openclaw" }));
    expect(await startPluginUpdate(opts)).toEqual({ ok: true });
    expect(seen.run).toEqual([["/usr/bin/openclaw", "gateway", "status", "--json", "--no-probe"]]);
  });

  // Review Focus 2 — 끈 Gateway 는 서버가 보내도 하지 않는다
  it("remoteUpdate 가 꺼졌으면 disabled — 받지도 쓰지도 띄우지도 않는다", async () => {
    const { opts, seen, state } = base(() => ({ enabled: false }));
    expect(await startPluginUpdate(opts)).toEqual({
      ok: false,
      reason: "disabled",
      message: DISABLED_MESSAGE,
    });
    expect(seen.fetch).toEqual([]);
    expect(seen.launched).toEqual([]);
    expect(existsSync(updatePaths(state).dir)).toBe(false);
  });

  // Review Focus 4 — 연타는 한 번만
  it("두 번째 요청은 앞 스크립트의 잠금이 살아 있는 동안 busy", async () => {
    const { opts, seen } = base();
    expect(await startPluginUpdate(opts)).toEqual({ ok: true });
    expect(await startPluginUpdate(opts)).toEqual({
      ok: false,
      reason: "busy",
      message: ALREADY_UPDATING_MESSAGE,
    });
    expect(seen.launched).toHaveLength(1);
    expect(seen.fetch).toHaveLength(1);
  });

  it("오래된 잠금(죽은 스크립트)은 넘긴다", async () => {
    const { opts, seen, state } = base();
    const paths = updatePaths(state);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, "0\n");
    const old = (1_000_000 - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(paths.lock, old, old);
    expect(await startPluginUpdate(opts)).toEqual({ ok: true });
    expect(seen.launched).toHaveLength(1);
  });

  it("오래된 잠금을 넘길 때 죽은 스크립트가 남긴 download-* 도 지운다", async () => {
    const { opts, state } = base();
    const paths = updatePaths(state);
    mkdirSync(join(paths.dir, "download-DEAD01"), { recursive: true });
    writeFileSync(join(paths.dir, "download-DEAD01", "x.tgz"), "x");
    writeFileSync(paths.lock, "0\n");
    const old = (1_000_000 - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(paths.lock, old, old);
    expect(await startPluginUpdate(opts)).toEqual({ ok: true });
    expect(existsSync(join(paths.dir, "download-DEAD01"))).toBe(false);
  });

  it("살아 있는 잠금(busy)이면 download-* 를 건드리지 않는다", async () => {
    const { opts, state } = base();
    const paths = updatePaths(state);
    mkdirSync(join(paths.dir, "download-LIVE01"), { recursive: true });
    writeFileSync(paths.lock, "0\n");
    const fresh = 1_000_000 / 1000;
    utimesSync(paths.lock, fresh, fresh);
    expect((await startPluginUpdate(opts)).ok).toBe(false);
    expect(existsSync(join(paths.dir, "download-LIVE01"))).toBe(true);
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

describe("nodeLauncher — 실제 spawn", () => {
  const spec = (file: string, args: string[]): LaunchSpec => ({
    file,
    args,
    env: { PATH: "/usr/bin:/bin" },
    logPath: join(temp(), "update.log"),
  });
  it("곧바로 0 이 아니게 끝나면 거절한다(systemd-run 이 scope 를 못 만든 경우)", async () => {
    await expect(nodeLauncher(spec("/bin/sh", ["-c", "exit 3"]))).rejects.toThrow("exit 3");
  });
  it("실행 파일이 없으면 거절한다", async () => {
    await expect(nodeLauncher(spec("/nonexistent/dodok-x", []))).rejects.toThrow();
  });
  it("지켜보는 동안 살아 있으면 띄운 것으로 친다", async () => {
    await expect(nodeLauncher(spec("/bin/sh", ["-c", "sleep 3"]))).resolves.toBeUndefined();
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
