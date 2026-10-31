import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunnerConfig } from "../../../packages/claude-runner/src/config";
import { DodokAccountConfig } from "../../../packages/openclaw-plugin/src/config";
import { llmsHandoffLine } from "../../web/src/features/setup/llms";
import { runnerConfigExample } from "../../web/src/features/setup/runnerConfig";
import type { App } from "../src/app";
import { RUNNER_BUNDLE_ENTRY } from "../src/modules/runners/runner-file";
import { issueRunnerToken, revokeRunnerToken } from "../src/modules/runners/tokens";
import { renderLlmsTxt, RUNNER_PKG_DIR } from "../src/modules/setup/llms";
import { PLUGIN_BUNDLE_ENTRY } from "../src/modules/setup/plugin-file";
import { issueBridgeToken, revokeBridgeToken } from "../src/modules/setup/tokens";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** entry 하나만 든 tgz(ustar 한 블록 — 체크섬은 읽는 쪽이 보지 않는다) */
function tinyTgz(entry: string, bundle: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry, 0);
  header.write(`${bundle.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const body = Buffer.alloc(Math.ceil(bundle.length / 512) * 512);
  bundle.copy(body);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

/** 본문에서 「## <제목>」 절 하나(다음 「## 」 앞까지) */
function section(body: string, title: string): string {
  const start = body.indexOf(`\n## ${title}\n`);
  if (start === -1) throw new Error(`절 「${title}」이 없다`);
  const end = body.indexOf("\n## ", start + 1);
  return body.slice(start, end === -1 ? undefined : end);
}

/** 절 안의 ```bash 블록들 — 번호 목록의 들여쓰기를 걷은 본문 */
function bashBlocks(text: string): string[] {
  return [...text.matchAll(/^( *)```bash\n([\s\S]*?)\n *```/gm)].map(([, indent = "", body = ""]) =>
    body
      .split("\n")
      .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
      .join("\n"),
  );
}

/** 블록 가운데 needle 을 품은 하나 */
function blockWith(blocks: string[], needle: string): string {
  const found = blocks.filter((b) => b.includes(needle));
  expect(found, needle).toHaveLength(1);
  return found[0] ?? "";
}

/** 절 안의 ```json 블록들 */
function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n\s*```/g)].map((m) => JSON.parse(m[1] ?? ""));
}

const PLUGIN_BUNDLE = Buffer.from("export const dodok = 1;\n");
const RUNNER_BUNDLE = Buffer.from("#!/usr/bin/env node\n");
const OTHER_GATEWAY = "비밀사무실게이트웨이";
const MEMBER_EMAIL = "bee@dodok.local";

describe("GET /llms.txt — 노드 설치 안내서", () => {
  let app: App;
  let dir: string;
  let pluginTgz: Buffer;
  let runnerTgz: Buffer;
  let bridgeToken: string;
  let runnerToken: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-llms-"));
    pluginTgz = tinyTgz(PLUGIN_BUNDLE_ENTRY, PLUGIN_BUNDLE);
    runnerTgz = tinyTgz(RUNNER_BUNDLE_ENTRY, RUNNER_BUNDLE);
    writeFileSync(join(dir, "dodok-openclaw-plugin-0.0.0.tgz"), pluginTgz);
    const runnerDir = join(dir, "runner");
    mkdirSync(runnerDir);
    writeFileSync(join(runnerDir, "dodok-claude-runner-0.0.0.tgz"), runnerTgz);
    app = await bootTestApp(
      { APP_ORIGIN: "https://chat.example.com" },
      { adapters: [new FakeAdapter()], pluginDirs: [dir], runnerDirs: [runnerDir] },
    );
    // 토큰·다른 Gateway·사람이 있는 상태에서도 본문에 실리지 않아야 한다
    bridgeToken = issueBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, "gw").token;
    runnerToken = issueRunnerToken(app.db, app.workspaceId, "mac").token;
    insertGateway(app.db, app.workspaceId, { id: uuid(), name: OTHER_GATEWAY, enabled: true });
    await userWithRole(app, "bee", "member");
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (remoteAddress = "10.0.0.1") =>
    app.fastify.inject({ method: "GET", url: "/llms.txt", remoteAddress });

  it("로그인 없이 200 text/plain — 공개 오리진·bridgeUrl·두 파일의 sha·두 절 제목·AI 규칙 네 줄", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    const body = res.body;
    expect(body).toContain("https://chat.example.com");
    expect(body).toContain("wss://chat.example.com/bridge");
    expect(body).toContain(sha(pluginTgz));
    expect(body).toContain(sha(PLUGIN_BUNDLE));
    expect(body).toContain(sha(runnerTgz));
    expect(body).toContain(sha(RUNNER_BUNDLE));
    expect(body).toContain("\n## OpenClaw Gateway 호스트\n");
    expect(body).toContain("\n## 러너 머신\n");
    for (const rule of [
      "토큰을 화면·로그·명령 줄 인자에 찍지 않는다 — 파일(0600)이나 표준 입력으로 넘긴다.",
      "토큰은 이 안내서가 지정한 자리에만 둔다.",
      "사람이 할 단계(Claude 로그인, 기기 페어링 승인 확인)에서는 멈추고 사람에게 묻는다.",
      "받은 파일은 이 안내서의 sha256 과 대조하고, 다르면 멈춘다.",
    ])
      expect(body).toContain(rule);
  });

  it("토큰·Gateway 이름·사람 이메일을 싣지 않는다", async () => {
    const body = (await get()).body;
    expect(body).not.toContain("dbt_");
    expect(body).not.toContain("drn_");
    expect(body).not.toContain(bridgeToken);
    expect(body).not.toContain(runnerToken);
    expect(body).not.toContain(OTHER_GATEWAY);
    expect(body).not.toContain("가짜 Gateway");
    expect(body).not.toContain(MEMBER_EMAIL);
    expect(body).not.toContain("owner@dodok.local");
    expect(body).not.toContain(dir); // 서버 안 파일 경로
  });

  it("같은 IP 31번째 요청은 429, 다른 IP 는 그대로", async () => {
    for (let i = 0; i < 30; i++) expect((await get("10.0.0.31")).statusCode, `요청 ${i + 1}`).toBe(200);
    expect((await get("10.0.0.31")).statusCode).toBe(429);
    expect((await get("10.0.0.32")).statusCode).toBe(200);
  });

  // 계획 판정 PS6 — 안내서의 명령·키가 플러그인·러너 코드와 어긋나면 노드의 AI 가 망가진 설정을 만든다
  it("대조: 플러그인 계정 키는 플러그인 설정 스키마, 러너 설정은 RunnerConfig 를 그대로 지난다", async () => {
    const body = (await get("10.0.0.2")).body;
    const gateway = section(body, "OpenClaw Gateway 호스트");
    const [patch] = jsonBlocks(gateway) as Array<{
      channels: { dodok: { accounts: { default: Record<string, unknown> } } };
    }>;
    const account = patch?.channels.dodok.accounts.default;
    expect(Object.keys(account ?? {}).sort()).toEqual(["bridgeUrl", "token"]);
    expect(DodokAccountConfig.safeParse(account).success).toBe(true);
    expect(account?.bridgeUrl).toBe("wss://chat.example.com/bridge");
    // 패치를 만드는 명령도 같은 키를 쓴다
    expect(gateway).toContain(
      `{"channels":{"dodok":{"accounts":{"default":{"bridgeUrl":"%s","token":"%s"}}}}}`,
    );
    expect(gateway).toContain("https://chat.example.com/api/v1/setup/plugin.tgz");

    const runner = section(body, "러너 머신");
    const [config] = jsonBlocks(runner);
    const parsed = RunnerConfig.safeParse(config);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(Object.keys(config as object)).toEqual(
      expect.arrayContaining(["serverUrl", "tokenFile", "roots", "programs"]),
    );
    expect((config as { serverUrl: string }).serverUrl).toBe("https://chat.example.com");
    expect(runner).toContain("https://chat.example.com/api/v1/setup/runner.tgz");
  });

  it("대조: 웹 발급 대화상자의 「AI 에게 맡기기」 줄이 부르는 주소·절 제목이 본문에 있다", async () => {
    const body = (await get("10.0.0.4")).body;
    for (const kind of ["bridge", "runner", "runner-reissue"] as const) {
      const line = llmsHandoffLine(kind, "https://chat.example.com", "<토큰>");
      expect(line.startsWith("https://chat.example.com/llms.txt ")).toBe(true);
      const title = /「([^」]+)」 절대로/.exec(line)?.[1];
      expect(body, kind).toContain(`\n## ${title}\n`);
    }
  });

  it("대조: 안내서가 부르는 설치 경로는 이 서버에 있다(owner 로 200)", async () => {
    const { headers } = await login(app);
    for (const path of ["/api/v1/setup/plugin.tgz", "/api/v1/setup/runner.tgz"]) {
      expect((await get("10.0.0.3")).body).toContain(path);
      expect((await app.fastify.inject({ method: "GET", url: path, headers })).statusCode, path).toBe(200);
    }
  });
});

describe("renderLlmsTxt — 웹·서버 오리진이 갈릴 때(dev)", () => {
  it("연결 페이지 확인 주소만 웹 오리진이고, 설치 파일·serverUrl 은 공개 오리진 그대로", () => {
    const file = { sha256: "a".repeat(64), bundleSha256: "b".repeat(64) };
    const body = renderLlmsTxt({
      origin: "http://localhost:3000",
      webOrigin: "http://localhost:5173",
      bridgeUrl: "ws://localhost:3000/bridge",
      plugin: file,
      runner: file,
    });
    const gateway = section(body, "OpenClaw Gateway 호스트");
    expect(gateway).toContain("dodok 연결 페이지(http://localhost:5173/settings/connection)");
    expect(gateway).not.toContain("http://localhost:3000/settings/connection");
    expect(gateway).toContain("http://localhost:3000/api/v1/setup/plugin.tgz");
    expect(section(body, "러너 머신")).toContain('"serverUrl": "http://localhost:3000"');
  });
});

describe("GET /llms.txt — 앱이 웹 오리진(APP_ORIGIN)을 넘긴다", () => {
  it("BRIDGE_PUBLIC_URL 로 서버가 갈려도 연결 페이지는 APP_ORIGIN 위", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-llms-web-"));
    writeFileSync(join(dir, "dodok-openclaw-plugin-0.0.0.tgz"), tinyTgz(PLUGIN_BUNDLE_ENTRY, PLUGIN_BUNDLE));
    const app = await bootTestApp(
      { APP_ORIGIN: "http://localhost:5173", BRIDGE_PUBLIC_URL: "ws://localhost:3000/bridge" },
      { pluginDirs: [dir], runnerDirs: [] },
    );
    try {
      const body = (await app.fastify.inject({ method: "GET", url: "/llms.txt" })).body;
      expect(body).toContain("dodok 연결 페이지(http://localhost:5173/settings/connection)");
      expect(body).toContain("http://localhost:3000/api/v1/setup/plugin.tgz");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderLlmsTxt — 파일이 없을 때", () => {
  it("파일이 없는 절은 「서버에 파일이 없습니다」, 있는 절은 sha 를 싣는다", () => {
    const file = { sha256: "a".repeat(64), bundleSha256: "b".repeat(64) };
    const noPlugin = renderLlmsTxt({
      origin: "https://x.example",
      webOrigin: "https://x.example",
      bridgeUrl: "wss://x.example/bridge",
      plugin: null,
      runner: file,
    });
    expect(section(noPlugin, "OpenClaw Gateway 호스트")).toContain("서버에 파일이 없습니다");
    expect(section(noPlugin, "OpenClaw Gateway 호스트")).not.toContain("plugin.tgz");
    expect(section(noPlugin, "러너 머신")).not.toContain("서버에 파일이 없습니다");
    expect(section(noPlugin, "러너 머신")).toContain("a".repeat(64));

    const noRunner = renderLlmsTxt({
      origin: "https://x.example",
      webOrigin: "https://x.example",
      bridgeUrl: "wss://x.example/bridge",
      plugin: file,
      runner: null,
    });
    expect(section(noRunner, "러너 머신")).toContain("서버에 파일이 없습니다");
    expect(section(noRunner, "OpenClaw Gateway 호스트")).toContain("b".repeat(64));
  });
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("renderLlmsTxt — 안내서 명령이 기대는 것", () => {
  const body = renderLlmsTxt({
    origin: "https://x.example",
    webOrigin: "https://x.example",
    bridgeUrl: "wss://x.example/bridge",
    plugin: { sha256: "a".repeat(64), bundleSha256: "b".repeat(64) },
    runner: { sha256: "c".repeat(64), bundleSha256: "d".repeat(64) },
  });
  const gateway = section(body, "OpenClaw Gateway 호스트");
  const runner = section(body, "러너 머신");

  it("러너 3번 — claude 가 없는 머신의 번들 CLI 줄은 docker-deploy.md 「러너 설치」와 같고 경로 성분이 러너 패키지와 맞다", () => {
    const runnerSteps = bashBlocks(runner);
    expect(blockWith(runnerSteps, "CLAUDE_CONFIG_DIR=")).toContain(
      "CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude\n",
    );
    const deploy = readFileSync(join(ROOT, "docs/guides/docker-deploy.md"), "utf8");
    const line = deploy
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes("/claude-agent-sdk-$("));
    expect(line).toBeDefined();
    expect(runner).toContain(line);

    const pkg = JSON.parse(readFileSync(join(ROOT, "packages/claude-runner/package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const sdk = "@anthropic-ai/claude-agent-sdk";
    expect(pkg.dependencies).toHaveProperty(sdk);
    expect(line).toContain(
      `"${RUNNER_PKG_DIR}/node_modules/${sdk}-$(node -p 'process.platform+"-"+process.arch')/claude"`,
    );
    // 패키지 디렉터리 식은 bin 링크를 풀어 두 단계 위로 간다 — bin 대상이 패키지 안 두 단계 깊이여야 맞다
    expect(RUNNER_PKG_DIR).toContain('"$(command -v dodok-runner)"');
    expect(pkg.bin["dodok-runner"]?.split("/")).toHaveLength(2);
    // 플랫폼별 번들 CLI 패키지 이름이 <SDK>-<platform>-<arch> 꼴이다(이 머신의 판으로)
    const sdkPkg = JSON.parse(
      readFileSync(join(ROOT, "packages/claude-runner/node_modules", sdk, "package.json"), "utf8"),
    ) as { optionalDependencies: Record<string, string> };
    expect(Object.keys(sdkPkg.optionalDependencies)).toContain(`${sdk}-${process.platform}-${process.arch}`);
  });

  it("러너 2·3번 — npm root -g 를 쓰지 않고(npm 11.19 가 경로를 가려 찍는다) 설치된 dodok-runner 링크를 풀어 패키지 디렉터리를 찾는다", () => {
    expect(runner).not.toContain("npm root -g");
    expect(readFileSync(join(ROOT, "docs/guides/docker-deploy.md"), "utf8")).not.toContain("npm root -g");
    // npm -g 설치와 같은 꼴: <prefix>/bin/dodok-runner → ../lib/node_modules/@dodok/claude-runner/dist/main.js
    const prefix = mkdtempSync(join(tmpdir(), "dodok-llms-prefix-"));
    try {
      const pkgDir = join(prefix, "lib", "node_modules", "@dodok", "claude-runner");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      // 실행 권한이 없으면 command -v 가 건너뛰고 PATH 뒤쪽의 다른 설치를 고른다
      writeFileSync(join(pkgDir, "dist", "main.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
      mkdirSync(join(prefix, "bin"));
      symlinkSync(
        "../lib/node_modules/@dodok/claude-runner/dist/main.js",
        join(prefix, "bin", "dodok-runner"),
      );
      const res = spawnSync("bash", ["-c", `printf '%s' "${RUNNER_PKG_DIR}"`], {
        encoding: "utf8",
        env: { PATH: `${join(prefix, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin` },
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe(realpathSync(pkgDir));
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("토큰은 어떤 외부 명령의 argv 에도 실리지 않는다 — 토큰을 받는 명령은 셸 내장(printf·[)이나 대입뿐", () => {
    const TOKEN_REFS = ['"$(cat ~/.dodok-bridge-token)"', '"$(cat ~/.dodok-runner/token)"', '"$token"'];
    const consumers: string[] = [];
    for (const block of [...bashBlocks(gateway), ...bashBlocks(runner)]) {
      let text = block.replace(/\\\n\s*/g, " "); // 줄 잇기
      for (const ref of TOKEN_REFS) text = text.replaceAll(ref, "TOKENREF");
      text = text.replace(/'[^']*'/g, "'Q'"); // 작은따옴표 안의 괄호·구분자를 걷는다
      for (let prev = ""; prev !== text;) [prev, text] = [text, text.replace(/\$\([^()]*\)/g, "SUBST")];
      for (const command of text.split(/\|\||&&|[|;()\n]/)) {
        if (!command.includes("TOKENREF")) continue;
        const words = command.trim().split(/\s+/);
        consumers.push(words[0] ?? "");
        const builtin = words[0] === "printf" || words[0] === "[";
        const onlyAssignments = words.every((w) => /^[A-Za-z_]\w*=/.test(w));
        expect(builtin || onlyAssignments, command.trim()).toBe(true);
      }
    }
    // 두 받기(printf)·패치 파일(printf)·빈 토큰 검사([)·토큰 읽기(대입) — 규칙이 빈 집합에 대해 참이 되지 않게
    expect(consumers.sort()).toEqual(["[", "printf", "printf", "printf", "token=TOKENREF"]);
  });

  it("러너 5번 — 끝나지 않는 명령이라 「연결됨」을 보면 사람에게 넘긴다(러너가 실제로 찍는 말)", () => {
    const step5 = runner.slice(runner.indexOf("\n5. "));
    expect(step5).toContain("`연결됨`");
    expect(step5).toContain("사람에게 넘기");
    expect(step5).toContain("Ctrl+C");
    expect(readFileSync(join(ROOT, "packages/claude-runner/src/connection.ts"), "utf8")).toContain(
      "dodok-runner: 연결됨(",
    );
  });

  describe("설치 파일 받기·설치 명령을 bash 로 그대로 돌린다 — mktemp 자리에 받고 설치한 뒤 지운다", () => {
    let root: string;
    let tmp: string;
    let log: string;
    const fake = (bin: string, name: string, body: string[]) => {
      writeFileSync(join(bin, name), ["#!/bin/sh", ...body, ""].join("\n"), { mode: 0o755 });
    };

    /** 가짜 curl(-o 자리에 쓰고 그 경로를 남긴다)·openclaw·npm(받은 파일이 아직 있는지 남긴다)·shasum·jq 와 설치된 러너 링크 */
    const setup = () => {
      root = mkdtempSync(join(tmpdir(), "dodok-llms-dl-"));
      tmp = join(root, "tmp");
      mkdirSync(tmp);
      log = join(root, "log");
      const bin = join(root, "bin");
      mkdirSync(bin);
      fake(bin, "curl", [
        'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done',
        'cat > /dev/null; printf tgz > "$out"; printf "curl %s\\n" "$out" >> "$LOG"',
      ]);
      fake(bin, "shasum", ['printf "shasum %s\\n" "$3" >> "$LOG"']);
      fake(bin, "jq", ["cat > /dev/null"]);
      fake(bin, "openclaw", [
        '[ "$1 $2" = "plugins install" ] && { [ -f "$3" ] && printf "install %s\\n" "$3" >> "$LOG"; }',
        "exit 0",
      ]);
      fake(bin, "npm", [
        '[ "$1 $2" = "install -g" ] && [ -f "$3" ] && printf "install %s\\n" "$3" >> "$LOG"',
      ]);
      const pkgDir = join(root, "lib", "node_modules", "@dodok", "claude-runner");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      writeFileSync(join(pkgDir, "dist", "main.js"), "", { mode: 0o755 });
      symlinkSync("../lib/node_modules/@dodok/claude-runner/dist/main.js", join(bin, "dodok-runner"));
      mkdirSync(join(root, "home", ".dodok-runner"), { recursive: true });
      writeFileSync(join(root, "home", ".dodok-bridge-token"), "dbt_secret\n", { mode: 0o600 });
      writeFileSync(join(root, "home", ".dodok-runner", "token"), "drn_secret\n", { mode: 0o600 });
      return { bin, pkgDir };
    };
    const run = (bin: string, script: string) =>
      spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          HOME: join(root, "home"),
          TMPDIR: tmp,
          LOG: log,
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
    const logLines = () => readFileSync(log, "utf8").trim().split("\n");

    it("Gateway 2·3번 — 같은 셸에서 이어 돌리면 받은 파일을 설치하고 임시 디렉터리가 남지 않는다", () => {
      const { bin } = setup();
      try {
        const steps = bashBlocks(gateway);
        const res = run(
          bin,
          [blockWith(steps, "setup/plugin.tgz"), blockWith(steps, "plugins install")].join("\n"),
        );
        expect(res.status, res.stderr).toBe(0);
        const [got = "", sum = "", install = ""] = logLines();
        const file = got.replace(/^curl /, "");
        expect(file.startsWith(`${tmp}/`), file).toBe(true);
        expect(file.endsWith("/dodok-openclaw-plugin.tgz")).toBe(true);
        expect(sum).toBe(`shasum ${file}`);
        expect(install).toBe(`install ${file}`);
        expect(readdirSync(tmp)).toEqual([]);
        expect(gateway).not.toContain("/tmp/dodok-openclaw-plugin.tgz");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("러너 2번 — 받은 파일을 설치한 뒤 지우고, 번들 sha 는 설치된 패키지에서 잰다", () => {
      const { bin, pkgDir } = setup();
      try {
        const res = run(bin, blockWith(bashBlocks(runner), "setup/runner.tgz"));
        expect(res.status, res.stderr).toBe(0);
        const [got = "", sum = "", install = "", bundle = ""] = logLines();
        const file = got.replace(/^curl /, "");
        expect(file.startsWith(`${tmp}/`), file).toBe(true);
        expect(sum).toBe(`shasum ${file}`);
        expect(install).toBe(`install ${file}`);
        expect(bundle).toBe(`shasum ${realpathSync(pkgDir)}/dist/main.js`);
        expect(readdirSync(tmp)).toEqual([]);
        expect(runner).not.toContain("/tmp/dodok-claude-runner.tgz");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("토큰·패치 파일 명령을 bash 로 그대로 돌린다", () => {
    let home: string;
    let tmp: string;
    let bin: string;
    let log: string;

    beforeAll(() => {
      bin = mkdtempSync(join(tmpdir(), "dodok-llms-bin-"));
      // 가짜 openclaw — 패치 파일의 경로·권한·본문을 한 줄씩 남기고 OPENCLAW_EXIT 로 끝난다
      writeFileSync(
        join(bin, "openclaw"),
        [
          "#!/bin/sh",
          '[ "$1 $2 $3" = "config patch --file" ] || exit 64',
          'printf "%s\\n" "$4" > "$OPENCLAW_LOG"',
          'ls -l "$4" | cut -c1-10 >> "$OPENCLAW_LOG"',
          'cat "$4" >> "$OPENCLAW_LOG"',
          'exit "${OPENCLAW_EXIT:-0}"',
          "",
        ].join("\n"),
      );
      chmodSync(join(bin, "openclaw"), 0o755);
    });
    afterAll(() => rmSync(bin, { recursive: true, force: true }));

    const fresh = () => {
      home = mkdtempSync(join(tmpdir(), "dodok-llms-home-"));
      tmp = join(home, "tmp");
      mkdirSync(tmp);
      log = join(home, "openclaw.log");
    };
    const run = (script: string, opts: { input?: string; exit?: number } = {}) =>
      spawnSync("bash", ["-c", script], {
        input: opts.input ?? "",
        encoding: "utf8",
        env: {
          HOME: home,
          TMPDIR: tmp,
          PATH: `${bin}:/usr/bin:/bin`,
          OPENCLAW_LOG: log,
          OPENCLAW_EXIT: String(opts.exit ?? 0),
        },
      });
    const mode = (path: string) => statSync(path).mode & 0o777;

    it("토큰 파일 두기는 이미 있는 파일(0644)도 0600 으로 좁히고 새 토큰으로 바꾼다 — Gateway·러너 1번", () => {
      for (const [section_, file] of [
        [gateway, ".dodok-bridge-token"],
        [runner, ".dodok-runner/token"],
      ] as const) {
        fresh();
        mkdirSync(join(home, ".dodok-runner"));
        writeFileSync(join(home, file), "old\n", { mode: 0o644 });
        chmodSync(join(home, file), 0o644);
        const res = run(blockWith(bashBlocks(section_), "cat >"), { input: "dbt_new\n" });
        expect(res.status, res.stderr).toBe(0);
        expect(readFileSync(join(home, file), "utf8"), file).toBe("dbt_new\n");
        expect(mode(join(home, file)), file).toBe(0o600);
      }
    });

    it("Gateway 4번 — 패치 파일은 mktemp 자리의 0600 이고, 적용이 끝나면 패치·토큰 파일이 모두 사라진다", () => {
      fresh();
      writeFileSync(join(home, ".dodok-bridge-token"), "dbt_secret\n", { mode: 0o600 });
      const res = run(blockWith(bashBlocks(gateway), "openclaw config patch"));
      expect(res.status, res.stderr).toBe(0);
      const [path = "", perm, patch = ""] = readFileSync(log, "utf8").split("\n");
      expect(path.startsWith(`${tmp}/`), path).toBe(true); // mktemp 자리 — 고정 /tmp 경로가 아니다
      expect(perm).toBe("-rw-------");
      expect(JSON.parse(patch)).toEqual({
        channels: {
          dodok: { accounts: { default: { bridgeUrl: "wss://x.example/bridge", token: "dbt_secret" } } },
        },
      });
      expect(existsSync(join(home, ".dodok-bridge-token"))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
      expect(gateway).not.toContain("/tmp/dodok.patch");
    });

    it("Gateway 4번 — 적용이 실패해도 패치·토큰 파일을 지우고 실패 코드를 그대로 낸다", () => {
      fresh();
      writeFileSync(join(home, ".dodok-bridge-token"), "dbt_secret\n", { mode: 0o600 });
      const res = run(blockWith(bashBlocks(gateway), "openclaw config patch"), { exit: 3 });
      expect(res.status).toBe(3);
      expect(existsSync(log)).toBe(true);
      expect(existsSync(join(home, ".dodok-bridge-token"))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
    });

    it("Gateway 4번 — 토큰 파일이 없거나 비면 빈 토큰으로 패치하지 않는다", () => {
      for (const token of [null, ""]) {
        fresh();
        if (token !== null) writeFileSync(join(home, ".dodok-bridge-token"), token, { mode: 0o600 });
        const res = run(blockWith(bashBlocks(gateway), "openclaw config patch"));
        expect(res.status, String(token)).not.toBe(0);
        expect(existsSync(log), String(token)).toBe(false);
        expect(readdirSync(tmp)).toEqual([]);
      }
    });
  });
});

describe("설치 파일을 발급 토큰으로 받기 [Review Focus 5]", () => {
  let app: App;
  let dir: string;
  let pluginTgz: Buffer;
  let runnerTgz: Buffer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-installer-"));
    pluginTgz = tinyTgz(PLUGIN_BUNDLE_ENTRY, PLUGIN_BUNDLE);
    runnerTgz = tinyTgz(RUNNER_BUNDLE_ENTRY, RUNNER_BUNDLE);
    writeFileSync(join(dir, "dodok-openclaw-plugin-0.0.0.tgz"), pluginTgz);
    const runnerDir = join(dir, "runner");
    mkdirSync(runnerDir);
    writeFileSync(join(runnerDir, "dodok-claude-runner-0.0.0.tgz"), runnerTgz);
    app = await bootTestApp(
      {},
      {
        adapters: [new FakeAdapter()],
        pluginDirs: [dir],
        runnerDirs: [runnerDir],
        // 두 번째 실패에서 막힌다 — 한 번 센 것과 안 센 것을 가른다
        limits: { bridgeFail: { maxFailures: 2, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 } },
      },
    );
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 주소마다 실패 카운터가 따로라 시험마다 다른 주소를 쓴다 */
  let nextIp = 1;
  const freshIp = () => `10.1.0.${nextIp++}`;
  const download = (file: "plugin.tgz" | "runner.tgz", token: string | undefined, remoteAddress: string) =>
    app.fastify.inject({
      method: "GET",
      url: `/api/v1/setup/${file}`,
      remoteAddress,
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });
  const bridge = () => issueBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, "gw");
  const runner = () => issueRunnerToken(app.db, app.workspaceId, "mac");

  it("owner 세션은 둘 다 200, member 세션은 403", async () => {
    const { headers } = await login(app);
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };
    for (const file of ["plugin.tgz", "runner.tgz"]) {
      const url = `/api/v1/setup/${file}`;
      expect((await app.fastify.inject({ method: "GET", url, headers })).statusCode, file).toBe(200);
      expect((await app.fastify.inject({ method: "GET", url, headers: member })).statusCode, file).toBe(403);
    }
  });

  it("plugin.tgz — 유효한 브리지 토큰이면 파일 그대로", async () => {
    const res = await download("plugin.tgz", bridge().token, freshIp());
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(pluginTgz)).toBe(true);
    expect(res.headers["content-type"]).toBe("application/gzip");
  });

  it("runner.tgz — 유효한 러너 토큰이면 파일 그대로", async () => {
    const res = await download("runner.tgz", runner().token, freshIp());
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(runnerTgz)).toBe(true);
  });

  it("plugin.tgz — 폐기한 브리지 토큰 401, 그 실패를 센다(두 번째에 막혀 유효한 토큰도 429)", async () => {
    const ip = freshIp();
    const revoked = bridge();
    revokeBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, revoked.record.id);
    expect((await download("plugin.tgz", revoked.token, ip)).statusCode).toBe(401);
    expect((await download("plugin.tgz", bridge().token, ip)).statusCode).toBe(200);
    expect((await download("plugin.tgz", revoked.token, ip)).statusCode).toBe(401);
    expect((await download("plugin.tgz", bridge().token, ip)).statusCode).toBe(429);
  });

  it("plugin.tgz — 꺼진 Gateway 의 토큰은 401 이되 세지 않는다", async () => {
    const ip = freshIp();
    const off = insertGateway(app.db, app.workspaceId, { id: uuid(), name: "꺼짐", enabled: false });
    const offToken = issueBridgeToken(app.db, app.workspaceId, off.id, "off").token;
    for (let i = 0; i < 3; i++) expect((await download("plugin.tgz", offToken, ip)).statusCode).toBe(401);
    expect((await download("plugin.tgz", bridge().token, ip)).statusCode).toBe(200);
  });

  it("plugin.tgz — 러너 토큰 401, runner.tgz — 브리지 토큰 401(경로마다 자기 토큰만)", async () => {
    expect((await download("plugin.tgz", runner().token, freshIp())).statusCode).toBe(401);
    expect((await download("runner.tgz", bridge().token, freshIp())).statusCode).toBe(401);
  });

  it("runner.tgz — 폐기한 러너 토큰 401", async () => {
    const revoked = runner();
    revokeRunnerToken(app.db, app.workspaceId, revoked.record.id);
    expect((await download("runner.tgz", revoked.token, freshIp())).statusCode).toBe(401);
  });

  it("틀린 토큰은 401 이고 한 번 센다 — 두 번째에 막혀 유효한 토큰도 429", async () => {
    for (const file of ["plugin.tgz", "runner.tgz"] as const) {
      const ip = freshIp();
      const valid = () => (file === "plugin.tgz" ? bridge().token : runner().token);
      const wrong = await download(file, "nope", ip);
      expect(wrong.statusCode, file).toBe(401);
      expect(wrong.json().code).toBe("UNAUTHORIZED");
      expect((await download(file, valid(), ip)).statusCode, file).toBe(200);
      expect((await download(file, "nope", ip)).statusCode, file).toBe(401);
      expect((await download(file, valid(), ip)).statusCode, file).toBe(429);
    }
  });

  it("토큰도 세션도 없으면 401 이고 세지 않는다(맞혀 보는 시도가 아니다)", async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) expect((await download("plugin.tgz", undefined, ip)).statusCode).toBe(401);
    expect((await download("plugin.tgz", bridge().token, ip)).statusCode).toBe(200);
  });
});

// 웹 연결 페이지·발급 대화상자의 설정 예시도 같은 스키마를 지나야 한다 — 러너 스키마(strict)가 바뀌면 조용히 어긋나지 않게
describe("웹 러너 설정 예시", () => {
  it("runnerConfigExample 의 결과가 러너 RunnerConfig 를 그대로 지난다", () => {
    const config: unknown = JSON.parse(
      runnerConfigExample({ serverUrl: "https://chat.example.com", tokenFile: "~/.dodok-runner/token" }),
    );
    const parsed = RunnerConfig.safeParse(config);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.roots[0]?.label).toBe("내 저장소들");
  });
});
