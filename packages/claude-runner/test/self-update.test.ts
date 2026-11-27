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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_MESSAGE,
  DISABLED_MESSAGE,
  nodeRunner,
  nodeServiceRestarter,
  npmBesideNode,
  npmEnv,
  RunFailure,
  maskedSnippet,
  type Runner,
  selfUpdate,
  type SelfUpdateOptions,
  SERVICE_RESTART_TIMEOUT_MS,
  UNSUPPORTED_MESSAGE,
} from "../src/self-update";

// 원격 업데이트(원격 업데이트 스펙 U3) — npm 과 다시 띄우기는 가짜로. 마지막 시험만 가짜 npm 실행 파일을 execFile 로 실제로 부른다

const ROOT = "/g/lib/node_modules";
const ENTRY = `${ROOT}/@dodok/runner/dist/main.js`;

type Calls = {
  npm: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>;
  check: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }>;
  spawn: unknown[][];
  exit: number[];
  order: string[];
};

function harness(over: Partial<SelfUpdateOptions> = {}, npm?: Runner) {
  const calls: Calls = { npm: [], check: [], spawn: [], exit: [], order: [] };
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
    check: async (file, args, o) => {
      calls.check.push({ file, args, env: o.env, timeoutMs: o.timeoutMs });
      calls.order.push("check");
      return { stdout: "" };
    },
    // npm 이 실패했을 때 그 자리에 깔린 판 — 기본은 지금 판 그대로
    installedVersion: () => "0.8.0",
    // 전역 bin 링크는 패키지 안 main.js 로 풀린다
    realpath: (p) => (p === "/g/bin/dodok-runner" ? ENTRY : p),
    spawn: (...args) => {
      calls.spawn.push(args);
      calls.order.push("spawn");
    },
    serviceRestart: async (...args) => {
      calls.spawn.push(args);
      calls.order.push("restart");
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("성공 — 정확한 판을 전역 설치하고, 연결을 닫은 뒤 같은 argv·env 로 분리된 자식을 띄우고 끝난다", async () => {
    const { opts, calls } = harness();
    expect(await selfUpdate(opts)).toEqual({ ok: true });
    // prefix 는 진입 파일의 실제 자리에서 — npm 출력은 읽지 않는다
    expect(calls.npm.map((c) => c.args)).toEqual([
      ["install", "--global", "--prefix", "/g", "@dodok/runner@0.9.0"],
    ]);
    expect(calls.order).toEqual(["npm install", "check", "beforeRestart", "spawn", "exit"]);
    // 새 판 검사 — 같은 인자·같은 env 로 설정만 읽는 모드, 상한 20초
    expect(calls.check).toEqual([
      {
        file: "/usr/bin/node",
        args: ["--enable-source-maps", "/g/bin/dodok-runner", "--config", "/c.json", "--check-config"],
        env: opts.env,
        timeoutMs: 20_000,
      },
    ]);
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

  it.each([
    ["launchd", "launchctl", ["kickstart", "-k", "gui/501/chat.dodok.runner"]],
    ["systemd", "systemctl", ["--user", "--no-block", "restart", "dodok-runner"]],
  ] as const)(
    "서비스 모드(%s) — 분리된 러너 대신 서비스 관리자의 다시 시작을 띄우고 스스로 끝내지 않는다",
    async (service, file, args) => {
      vi.useFakeTimers();
      const env = { PATH: "/usr/bin", DODOK_RUNNER_SERVICE: service };
      const { opts, calls } = harness({ env, uid: 501 });
      let settled = false;
      const pending = selfUpdate(opts).finally(() => {
        settled = true;
      });
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(SERVICE_RESTART_TIMEOUT_MS - 1);
      // 관리자의 SIGTERM 을 기다린다 — 끝내지도, 풀리지도 않는다
      expect(settled).toBe(false);
      expect(calls.order).toEqual(["npm install", "check", "beforeRestart", "restart"]);
      expect(calls.spawn).toEqual([[file, args, { env }]]);
      expect(calls.exit).toEqual([]);
    },
  );

  it("서비스 모드 — 다시 시작 명령 뒤 60초 안에 끝나지 않으면 지금 판으로 다시 붙는다", async () => {
    vi.useFakeTimers();
    const { opts, calls } = harness({ env: { DODOK_RUNNER_SERVICE: "launchd" }, uid: 501 });
    const pending = selfUpdate(opts);
    const result = expect(pending).rejects.toThrow(
      /60초 안에 이 러너를 끝내지 않았습니다 — 새 판\(0\.9\.0\)은 깔렸으니 다음 다시 시작 때 새 판으로 뜹니다.*dodok-runner service restart/,
    );
    await vi.advanceTimersByTimeAsync(SERVICE_RESTART_TIMEOUT_MS);
    await result;
    expect(calls.order).toEqual(["npm install", "check", "beforeRestart", "restart"]);
    expect(calls.exit).toEqual([]);
  });

  it("서비스 모드 — 다시 시작 명령이 곧바로 실패하면 기다리지 않고 다시 붙는다", async () => {
    vi.useFakeTimers();
    const { opts, calls } = harness({
      env: { DODOK_RUNNER_SERVICE: "systemd" },
      serviceRestart: async () => {
        calls.order.push("restart");
        throw new RunFailure(5, "");
      },
    });
    // 시계를 돌리지 않는다 — 60초를 기다리면 이 await 가 풀리지 않는다
    await expect(selfUpdate(opts)).rejects.toThrow(
      /restart dodok-runner\)에 실패했습니다\(exit 5\).*다음 다시 시작 때 새 판으로 뜹니다.*dodok-runner service restart/,
    );
    expect(calls.order).toEqual(["npm install", "check", "beforeRestart", "restart"]);
    expect(calls.exit).toEqual([]);
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
    expect(calls.order).toEqual(["check", "beforeRestart", "spawn", "exit"]);
  });

  // 리뷰 M1 — 새 판이 지금 설정을 거절하면(옛 agents 키 같은 일) 다시 띄우지 않고 옛 판으로 되돌린다
  it("새 판 검사 실패 → 옛 판으로 되돌려 깔고 failed(출력 앞 200자, 경로 가림) — 연결을 닫지 않는다", async () => {
    const { opts, calls } = harness({
      check: async () => {
        calls.order.push("check");
        throw new RunFailure(
          1,
          `dodok-runner: /h/.dodok-runner/config.json: 옛 agents 키는 받지 않습니다 ${"x".repeat(400)}`,
        );
      },
    });
    const result = await selfUpdate(opts);
    expect(calls.npm.map((c) => c.args)).toEqual([
      ["install", "--global", "--prefix", "/g", "@dodok/runner@0.9.0"],
      ["install", "--global", "--prefix", "/g", "@dodok/runner@0.8.0"],
    ]);
    expect(calls.order).toEqual(["npm install", "check", "npm install"]);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    const message = result.ok === false ? (result.message ?? "") : "";
    expect(message).toContain(
      "새 판(0.9.0) 검사에 실패했습니다 — dodok-runner: <경로>: 옛 agents 키는 받지 않습니다",
    );
    expect(message).toContain("0.8.0 로 되돌렸습니다");
    expect(message).not.toContain("/h/");
    expect(message.length).toBeLessThanOrEqual(400);
    // 되돌리기 npm 에도 비밀 env 는 가지 않는다
    expect(calls.npm[1]!.env.DODOK_RUNNER_TOKEN).toBeUndefined();
    expect(calls.spawn).toEqual([]);
    expect(calls.exit).toEqual([]);
  });

  it("검사 실패 뒤 되돌리기도 실패하면 그 머신에서 돌릴 명령을 싣는다", async () => {
    const { opts, calls } = harness(
      {
        check: async () => {
          throw new RunFailure(null, "");
        },
        installedVersion: () => "0.9.0",
      },
      async (_file, args) => {
        if (args.at(-1) === "@dodok/runner@0.8.0") throw new RunFailure(1, "npm error code E404");
        return { stdout: "" };
      },
    );
    const result = await selfUpdate(opts);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(result.ok === false && result.message).toBe(
      "새 판(0.9.0) 검사에 실패했습니다 · 0.8.0 로 되돌리지 못했습니다 — 그 머신에서 npm i -g @dodok/runner@0.8.0 을 돌려 보세요",
    );
    expect(calls.spawn).toEqual([]);
  });

  it("spawn 이 던지면 그대로 던진다 — 부르는 쪽이 연결을 되살린다", async () => {
    const { opts, calls } = harness({
      spawn: () => {
        throw new Error("spawn EAGAIN");
      },
    });
    await expect(selfUpdate(opts)).rejects.toThrow("spawn EAGAIN");
    expect(calls.exit).toEqual([]);
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
  it("maskedSnippet 는 절대·홈 경로를 가리고 공백을 접어 200자로 자른다", () => {
    expect(maskedSnippet("a /x/y.json:\n  b ~/c (d /e)")).toBe("a <경로>: b <경로> (d <경로>)");
    expect(maskedSnippet("y".repeat(300))).toHaveLength(200);
  });
  it("npmBesideNode — node 옆에 npm 이 있으면 그것, 없으면 PATH 의 npm", () => {
    expect(npmBesideNode("/opt/node/bin/node", (p) => p === "/opt/node/bin/npm")).toBe("/opt/node/bin/npm");
    expect(npmBesideNode("/opt/node/bin/node", () => false)).toBe("npm");
  });
});

describe("nodeServiceRestarter — 실제 프로세스", () => {
  const env = { PATH: process.env.PATH ?? "/usr/bin" };
  it("0 으로 끝나면 풀린다", async () => {
    await expect(nodeServiceRestarter("true", [], { env })).resolves.toBeUndefined();
  });
  it("0 이 아니게 끝나면·띄우지 못하면 거절한다", async () => {
    await expect(nodeServiceRestarter("false", [], { env })).rejects.toThrow("exit 1");
    await expect(nodeServiceRestarter("/nonexistent/dodok-x", [], { env })).rejects.toThrow(/ENOENT/);
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
