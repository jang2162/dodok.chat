import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createClaudeDriver } from "../src/drivers/claude";
import {
  findOnPath,
  isExecutableFile,
  parseClaudeVersion,
  readClaudeVersion,
  resolveClaudeExecutable,
  VERSION_TIMEOUT_MS,
} from "../src/drivers/claude/executable";
import { createFakeSdk } from "./helpers/fake-query";

const base = mkdtempSync(join(tmpdir(), "dodok-exe-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** 셸 조각 실행 파일 하나 — mode 를 주면 그 권한으로 */
function script(name: string, body: string, mode = 0o755): string {
  const dir = mkdtempSync(join(base, "bin-"));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

const only =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe("resolveClaudeExecutable", () => {
  it("설정 executable 이 실행 파일이면 그것 — PATH 보다 먼저", () => {
    expect(
      resolveClaudeExecutable(
        { executable: "/opt/c/claude" },
        { PATH: "/usr/local/bin" },
        only("/opt/c/claude", "/usr/local/bin/claude"),
      ),
    ).toEqual({ cli: "installed", path: "/opt/c/claude" });
  });

  it("설정이 없으면 PATH 의 첫 claude", () => {
    expect(resolveClaudeExecutable({}, { PATH: "/a:/b:/c" }, only("/b/claude", "/c/claude"))).toEqual({
      cli: "installed",
      path: "/b/claude",
    });
  });

  it("설정도 PATH 의 claude 도 없으면 번들", () => {
    expect(resolveClaudeExecutable({}, { PATH: "/a:/b" }, only())).toEqual({ cli: "bundled" });
    expect(resolveClaudeExecutable({}, {}, only())).toEqual({ cli: "bundled" });
  });

  it("설정 경로가 없거나 실행할 수 없으면 번들로 돌아가지 않고 못 쓴다 — 사유에 경로 원문이 없다", () => {
    const r = resolveClaudeExecutable(
      { executable: "/secret/home/claude" },
      { PATH: "/usr/local/bin" },
      only("/usr/local/bin/claude"),
    );
    expect(r.cli).toBe("unusable");
    expect(r.cli === "unusable" && r.reason).toContain("executable");
    expect(JSON.stringify(r)).not.toContain("/secret");
  });

  it("PATH 의 빈 항목·상대 경로는 건너뛴다", () => {
    expect(findOnPath("claude", ":bin:./x:/ok", only("bin/claude", "x/claude", "/ok/claude"))).toBe(
      "/ok/claude",
    );
  });

  it("실제 파일 검사 — x 비트 없는 파일·디렉터리·없는 파일은 실행 파일이 아니다", () => {
    const exe = script("claude", "exit 0");
    const plain = script("claude", "exit 0", 0o644);
    const dir = join(base, "dir-claude");
    mkdirSync(dir);
    expect(isExecutableFile(exe)).toBe(true);
    expect(isExecutableFile(plain)).toBe(false);
    expect(isExecutableFile(dir)).toBe(false);
    expect(isExecutableFile(join(base, "none"))).toBe(false);
  });
});

describe("parseClaudeVersion", () => {
  it("앞의 semver 를 읽는다", () => {
    expect(parseClaudeVersion("2.1.322 (Claude Code)\n")).toBe("2.1.322");
    expect(parseClaudeVersion("v2.2.0-beta.1 (Claude Code)")).toBe("2.2.0-beta.1");
  });
  it("못 읽으면 undefined", () => {
    expect(parseClaudeVersion("")).toBeUndefined();
    expect(parseClaudeVersion("Claude Code 2.1.322")).toBeUndefined();
    expect(parseClaudeVersion(`2.1.3-${"a".repeat(80)}`)).toBeUndefined();
  });
});

describe("readClaudeVersion", () => {
  it("--version 을 불러 판을 읽는다 — env 는 허용 목록만", async () => {
    const exe = script(
      "claude",
      '[ "$1" = "--version" ] || exit 9\n[ -z "$DODOK_RUNNER_TOKEN$ANTHROPIC_API_KEY" ] || exit 8\necho "2.1.322 (Claude Code)"',
    );
    expect(
      await readClaudeVersion(exe, {
        PATH: "/usr/bin:/bin",
        DODOK_RUNNER_TOKEN: "drn_x",
        ANTHROPIC_API_KEY: "sk-x",
      }),
    ).toBe("2.1.322");
  });

  it("실패·못 읽는 출력이면 undefined", async () => {
    expect(await readClaudeVersion(script("claude", "exit 1"), { PATH: "/usr/bin:/bin" })).toBeUndefined();
    expect(
      await readClaudeVersion(script("claude", "echo hello"), { PATH: "/usr/bin:/bin" }),
    ).toBeUndefined();
  });

  it(
    `시간 제한(${VERSION_TIMEOUT_MS}ms)을 넘으면 undefined`,
    { timeout: VERSION_TIMEOUT_MS + 5000 },
    async () => {
      const started = Date.now();
      // exec 로 sleep 자신이 되게 한다 — SIGKILL 이 손자 없이 바로 닿는다
      const slow = script("claude", "exec sleep 30");
      expect(await readClaudeVersion(slow, { PATH: "/usr/bin:/bin" })).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(VERSION_TIMEOUT_MS + 3000);
    },
  );
});

describe("createClaudeDriver detect — 고른 CLI", () => {
  const ceiling = {
    configDir: base,
    maxPermissionMode: "default" as const,
    disallowedTools: [],
    allowedToolsCeiling: null,
  };
  const driver = (isExecutable: (p: string) => boolean, version: string | null = "2.1.322") =>
    createClaudeDriver({
      sdk: createFakeSdk(),
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/local/bin", HOME: base },
      isExecutable,
      readVersion: async () => version ?? undefined,
    });

  it("PATH 의 claude 면 installed 와 그 --version 판", async () => {
    expect(await driver(only("/usr/local/bin/claude")).detect(ceiling)).toMatchObject({
      available: true,
      version: "2.1.322",
      cli: "installed",
    });
  });

  it("없으면 bundled 와 빌드가 구운 판", async () => {
    expect(await driver(only()).detect(ceiling)).toMatchObject({
      available: true,
      version: "2.1.283",
      cli: "bundled",
    });
  });

  it("설치본 판을 못 읽으면 version 을 비우고 쓸 수 있다", async () => {
    const d = await driver(only("/usr/local/bin/claude"), null).detect(ceiling);
    expect(d).toMatchObject({ available: true, cli: "installed" });
    expect("version" in d).toBe(false);
  });

  it("설정 executable 이 없으면 available false 와 사유(cli 없음)", async () => {
    const d = await driver(only("/usr/local/bin/claude")).detect({ ...ceiling, executable: "/nope/claude" });
    expect(d).toMatchObject({
      available: false,
      auth: "unknown",
      reason: expect.stringContaining("executable"),
    });
    expect("cli" in d).toBe(false);
    expect(JSON.stringify(d)).not.toContain("/nope");
  });
});
