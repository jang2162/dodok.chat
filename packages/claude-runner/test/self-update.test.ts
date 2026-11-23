import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUSY_MESSAGE,
  DISABLED_MESSAGE,
  nodeRunner,
  npmBesideNode,
  npmEnv,
  RunFailure,
  type Runner,
  selfUpdate,
  type SelfUpdateOptions,
  UNSUPPORTED_MESSAGE,
} from "../src/self-update";

// 원격 업데이트(원격 업데이트 스펙 U3) — npm 과 다시 띄우기는 가짜로. 마지막 시험만 가짜 npm 실행 파일을 execFile 로 실제로 부른다

const ROOT = "/g/lib/node_modules";
const ENTRY = `${ROOT}/@dodok/runner/dist/main.js`;

type Calls = {
  npm: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>;
  spawn: unknown[][];
  exit: number[];
  order: string[];
};

function harness(over: Partial<SelfUpdateOptions> = {}, npm?: Runner) {
  const calls: Calls = { npm: [], spawn: [], exit: [], order: [] };
  const fakeNpm: Runner = async (file, args, opts) => {
    calls.npm.push({ file, args, env: opts.env });
    calls.order.push(`npm ${args[0]}`);
    if (args[0] === "root") return { stdout: `${ROOT}\n` };
    return { stdout: "" };
  };
  const opts: SelfUpdateOptions = {
    version: "0.9.0",
    currentVersion: "0.8.0",
    busy: () => false,
    enabled: true,
    argv: ["/usr/bin/node", "/g/bin/dodok-runner", "--config", "/c.json"],
    execPath: "/usr/bin/node",
    execArgv: ["--enable-source-maps"],
    env: { PATH: "/usr/bin", DODOK_RUNNER_TOKEN: "drn_x", ANTHROPIC_API_KEY: "k", HOME: "/h" },
    npm: npm ?? fakeNpm,
    npmPath: "npm",
    // npm 이 실패했을 때 그 자리에 깔린 판 — 기본은 지금 판 그대로
    installedVersion: () => "0.8.0",
    // 전역 bin 링크는 패키지 안 main.js 로 풀린다
    realpath: (p) => (p === "/g/bin/dodok-runner" ? ENTRY : p),
    spawn: (...args) => {
      calls.spawn.push(args);
      calls.order.push("spawn");
    },
    exit: (code) => {
      calls.exit.push(code);
      calls.order.push("exit");
    },
    beforeRestart: async () => {
      calls.order.push("beforeRestart");
    },
    ...over,
  };
  return { opts, calls };
}

describe("selfUpdate", () => {
  it("성공 — 정확한 판을 전역 설치하고, 연결을 닫은 뒤 같은 argv·env 로 분리된 자식을 띄우고 끝난다", async () => {
    const { opts, calls } = harness();
    expect(await selfUpdate(opts)).toEqual({ ok: true });
    // prefix 는 진입 파일의 실제 자리에서 — npm 출력은 읽지 않는다
    expect(calls.npm.map((c) => c.args)).toEqual([
      ["install", "--global", "--prefix", "/g", "@dodok/runner@0.9.0"],
    ]);
    expect(calls.order).toEqual(["npm install", "beforeRestart", "spawn", "exit"]);
    expect(calls.spawn).toEqual([
      [
        "/usr/bin/node",
        ["--enable-source-maps", "/g/bin/dodok-runner", "--config", "/c.json"],
        { env: opts.env },
      ],
    ]);
    expect(calls.exit).toEqual([0]);
    // npm 에는 러너 토큰·모델 자격 증명을 넘기지 않는다 — 다시 띄운 러너는 같은 env 를 받는다
    for (const c of calls.npm) {
      expect(c.env.DODOK_RUNNER_TOKEN).toBeUndefined();
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(c.env.PATH).toBe("/usr/bin");
    }
  });

  // Review Focus 1 — 서버가 무엇을 보내도 npm 에는 정확한 semver 만 간다
  it.each([
    "latest",
    "^0.9.0",
    ">=0.9.0",
    "0.9",
    "../x",
    "0.9.0/../../evil",
    "https://evil.example/r.tgz",
    "file:/tmp/r.tgz",
    "github:evil/runner",
    "0.9.0 --registry=https://evil.example",
    "",
  ])("판 %j 은 invalid_version — npm 을 부르지 않는다", async (version) => {
    const { opts, calls } = harness({ version });
    const result = await selfUpdate(opts);
    expect(result).toMatchObject({ ok: false, reason: "invalid_version" });
    expect(calls.npm).toEqual([]);
    expect(calls.spawn).toEqual([]);
  });

  it.each([
    ["0.8.0", "같은 판"],
    ["0.7.9", "낮은 판"],
    ["0.8.0-rc.1", "지금 판의 프리릴리스"],
  ])("%s(%s)은 invalid_version — 판 내리기 없음", async (version) => {
    const { opts, calls } = harness({ version });
    expect(await selfUpdate(opts)).toMatchObject({ ok: false, reason: "invalid_version" });
    expect(calls.npm).toEqual([]);
  });

  // Review Focus 2 — 끈 머신은 서버가 보내도 하지 않는다
  it("remoteUpdate: false 면 disabled — npm 도 다시 띄우기도 없다", async () => {
    const { opts, calls } = harness({ enabled: false });
    expect(await selfUpdate(opts)).toEqual({ ok: false, reason: "disabled", message: DISABLED_MESSAGE });
    expect(calls.npm).toEqual([]);
    expect(calls.spawn).toEqual([]);
    expect(calls.exit).toEqual([]);
  });

  it("런이 있으면 busy — 「런이 끝난 뒤 다시 시도하세요」", async () => {
    const { opts, calls } = harness({ busy: () => true });
    expect(await selfUpdate(opts)).toEqual({ ok: false, reason: "busy", message: BUSY_MESSAGE });
    expect(calls.npm).toEqual([]);
  });

  it("npm 전역 자리 밖(소스·tgz 풀기)이면 unsupported — 설치하지 않는다", async () => {
    const { opts, calls } = harness({
      realpath: (p) => (p === "/g/bin/dodok-runner" ? "/src/dodok/main.js" : p),
    });
    expect(await selfUpdate(opts)).toEqual({
      ok: false,
      reason: "unsupported",
      message: UNSUPPORTED_MESSAGE,
    });
    expect(calls.npm).toEqual([]);
    expect(calls.spawn).toEqual([]);
  });

  it("이름만 비슷한 이웃 패키지(@dodok/runner-x)는 전역 설치가 아니다", async () => {
    const { opts } = harness({
      realpath: (p) => (p === "/g/bin/dodok-runner" ? `${ROOT}/@dodok/runner-x/dist/main.js` : p),
    });
    expect(await selfUpdate(opts)).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("소스 실행(판 dev)은 unsupported", async () => {
    const { opts, calls } = harness({ currentVersion: "dev" });
    expect(await selfUpdate(opts)).toMatchObject({ ok: false, reason: "unsupported" });
    expect(calls.npm).toEqual([]);
  });

  it("npm 설치 실패 → failed(npm 오류 코드만, 경로 없음) — 다시 띄우지 않고 끝나지 않는다", async () => {
    const { opts, calls } = harness({}, async (_file, args) => {
      if (args[0] === "root") return { stdout: ROOT };
      throw new RunFailure(
        1,
        "npm error code E404\nnpm error 404 Not Found - GET https://registry/x\nnpm error /h/.npm/_logs/x.log",
      );
    });
    const result = await selfUpdate(opts);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(result.ok === false && result.message).toContain("E404");
    expect(JSON.stringify(result)).not.toContain("/h/");
    expect(calls.order).not.toContain("beforeRestart");
    expect(calls.spawn).toEqual([]);
    expect(calls.exit).toEqual([]);
  });

  it("npm 이 0 이 아니게 끝나도 그 자리에 목표 판이 깔렸으면 성공(npm 감싸개의 reshim 실패 — 손 확인 결함)", async () => {
    const { opts, calls } = harness({ installedVersion: () => "0.9.0" }, async () => {
      throw new RunFailure(127, "added 1 package\nmise: command not found");
    });
    expect(await selfUpdate(opts)).toEqual({ ok: true });
    expect(calls.order).toEqual(["beforeRestart", "spawn", "exit"]);
  });

  it("npm 을 찾지 못하면 failed — 다시 띄우지 않는다", async () => {
    const { opts, calls } = harness({}, async () => {
      throw new RunFailure(null, "spawn npm ENOENT");
    });
    expect(await selfUpdate(opts)).toMatchObject({ ok: false, reason: "failed" });
    expect(calls.spawn).toEqual([]);
  });

  it("경로에 UUID 꼴 글자가 있어도 그 prefix 에 설치한다(npm 은 출력에서 그런 글자를 가린다 — 손 확인 결함)", async () => {
    const prefix = "/tmp/x-4242c930-469c-485e-bd53-b8a948707e30/prefix";
    const { opts, calls } = harness({
      realpath: (p) =>
        p === "/g/bin/dodok-runner" ? `${prefix}/lib/node_modules/@dodok/runner/dist/main.js` : p,
    });
    expect(await selfUpdate(opts)).toEqual({ ok: true });
    expect(calls.npm.map((c) => c.args)).toEqual([
      ["install", "--global", "--prefix", prefix, "@dodok/runner@0.9.0"],
    ]);
  });
});

describe("도우미", () => {
  it("npmEnv 는 러너 토큰·ANTHROPIC_*·CLAUDE_* 를 뺀다", () => {
    expect(
      npmEnv({ A: "1", DODOK_RUNNER_TOKEN: "t", ANTHROPIC_BASE_URL: "u", CLAUDE_CONFIG_DIR: "c" }),
    ).toEqual({
      A: "1",
    });
  });
  it("npmBesideNode — node 옆에 npm 이 있으면 그것, 없으면 PATH 의 npm", () => {
    expect(npmBesideNode("/opt/node/bin/node", (p) => p === "/opt/node/bin/npm")).toBe("/opt/node/bin/npm");
    expect(npmBesideNode("/opt/node/bin/node", () => false)).toBe("npm");
  });
});

describe("가짜 npm 실행 파일로 실제 execFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("npm root -g 아래의 러너면 설치 인자가 그대로 넘어간다 — 비밀 env 는 가지 않는다", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-self-update-")));
    dirs.push(base);
    const root = join(base, "lib", "node_modules");
    const entry = join(root, "@dodok", "runner", "dist", "main.js");
    mkdirSync(join(root, "@dodok", "runner", "dist"), { recursive: true });
    writeFileSync(entry, "");
    const log = join(base, "npm.log");
    const npm = join(base, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "\${DODOK_RUNNER_TOKEN:-none}" "\${ANTHROPIC_API_KEY:-none}" >> '${log}'\nif [ "$1" = root ]; then echo '${root}'; fi\n`,
    );
    chmodSync(npm, 0o755);
    const spawned: unknown[] = [];
    const result = await selfUpdate({
      version: "0.9.0",
      currentVersion: "0.8.0",
      busy: () => false,
      enabled: true,
      argv: [process.execPath, entry],
      execPath: process.execPath,
      env: {
        PATH: process.env.PATH ?? "/usr/bin",
        DODOK_RUNNER_TOKEN: "drn_secret",
        ANTHROPIC_API_KEY: "sk",
      },
      npm: nodeRunner,
      npmPath: npm,
      spawn: (...a) => void spawned.push(a),
      exit: () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      `install --global --prefix ${base} @dodok/runner@0.9.0|none|none`,
    ]);
    expect(spawned).toHaveLength(1);
  });
});
