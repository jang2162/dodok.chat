import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerRunStart, type RunnerProgram, type RunnerRunAgent } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCeiling, resolveBot } from "../src/ceiling";
import { loadRunnerConfig, type ResolvedRunnerConfig } from "../src/config";
import { runStart } from "./helpers/fixtures";

// 천장 검사(러너 일반화 스펙 3장·Review Focus 1~3) — 실제 디렉터리·심볼릭 링크로 본다

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-ceiling-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "repo", "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "file.txt"), "x");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(root, "repo"), join(root, "alias"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function cfg(over: Partial<NonNullable<ResolvedRunnerConfig["programs"]["claude"]>> = {}) {
  return {
    roots: [{ id: "src", path: root, label: "src" }],
    botsDir: join(base, "bots"),
    programs: {
      claude: {
        configDir: "/c",
        maxPermissionMode: "acceptEdits",
        disallowedTools: [],
        allowedToolsCeiling: null,
        ...over,
      },
    },
  } satisfies Pick<ResolvedRunnerConfig, "roots" | "programs" | "botsDir">;
}

const agent = (over: Partial<RunnerRunAgent> = {}): RunnerRunAgent => ({
  program: "claude",
  project: { rootId: "src", relPath: "repo" },
  model: null,
  permissionMode: "default",
  allowedTools: null,
  disallowedTools: [],
  ...over,
});
const always = () => true;

describe("checkCeiling", () => {
  it("루트 안 디렉터리면 통과 — 작업 디렉터리는 realpath", () => {
    expect(checkCeiling(cfg(), agent(), always)).toEqual({ ok: true, workdir: join(root, "repo") });
    expect(checkCeiling(cfg(), agent({ project: { rootId: "src", relPath: "" } }), always)).toEqual({
      ok: true,
      workdir: root,
    });
  });

  it("루트 안을 가리키는 링크는 통과 — 풀린 자리에서 돈다", () => {
    expect(checkCeiling(cfg(), agent({ project: { rootId: "src", relPath: "alias/sub" } }), always)).toEqual({
      ok: true,
      workdir: join(root, "repo", "sub"),
    });
  });

  it("root — 설정에 없는 루트 id(머신 주인이 지우거나 바꿈, Review Focus 2)", () => {
    expect(checkCeiling(cfg(), agent({ project: { rootId: "gone", relPath: "repo" } }), always)).toEqual({
      ok: false,
      item: "root",
    });
  });

  it("path — 없는 디렉터리·파일", () => {
    for (const relPath of ["nope", "file.txt"]) {
      expect(checkCeiling(cfg(), agent({ project: { rootId: "src", relPath } }), always)).toEqual({
        ok: false,
        item: "path",
      });
    }
  });

  it("path — 루트 안의 링크가 밖을 가리킨다(Review Focus 1)", () => {
    expect(checkCeiling(cfg(), agent({ project: { rootId: "src", relPath: "escape" } }), always)).toEqual({
      ok: false,
      item: "path",
    });
  });

  it("path — 저장한 프로젝트 디렉터리가 나중에 밖을 가리키는 링크로 바뀌었다(Review Focus 1)", () => {
    expect(checkCeiling(cfg(), agent(), always).ok).toBe(true);
    rmSync(join(root, "repo"), { recursive: true });
    symlinkSync(outside, join(root, "repo"));
    expect(checkCeiling(cfg(), agent(), always)).toEqual({ ok: false, item: "path" });
  });

  it("path — 루트 이름을 접두로 가진 형제(`…/root` 옆 `…/root-secret`)를 가리키는 링크 [태스크 2 리뷰 L1]", () => {
    mkdirSync(join(base, "root-secret"));
    symlinkSync(join(base, "root-secret"), join(root, "sib"));
    expect(checkCeiling(cfg(), agent({ project: { rootId: "src", relPath: "sib" } }), always)).toEqual({
      ok: false,
      item: "path",
    });
  });

  it("path — 루트 디렉터리 자신이 나중에 밖을 가리키는 링크로 바뀌었다 [태스크 2 리뷰 L1]", () => {
    mkdirSync(join(outside, "repo"));
    expect(checkCeiling(cfg(), agent(), always).ok).toBe(true);
    rmSync(root, { recursive: true });
    symlinkSync(outside, root);
    for (const relPath of ["repo", ""]) {
      expect(checkCeiling(cfg(), agent({ project: { rootId: "src", relPath } }), always)).toEqual({
        ok: false,
        item: "path",
      });
    }
  });

  // 대소문자를 가리지 않는 볼륨(macOS 기본 APFS)에서만 뜻이 있다 — 가리는 볼륨이면 `ROOT` 가 없어 설정이 거절되므로 건너뛴다
  it("대소문자만 다른 설정 루트·relPath 도 디스크의 이름으로 푼다 — 같은 디렉터리가 하나의 작업 디렉터리 [태스크 2 리뷰 L3]", (ctx) => {
    mkdirSync(join(base, "Mixed", "repo"), { recursive: true });
    if (!existsSync(join(base, "MIXED"))) ctx.skip();
    const configPath = join(base, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        serverUrl: "http://127.0.0.1:1/",
        roots: [{ id: "src", path: join(base, "MIXED"), label: "src" }],
        programs: { claude: { configDir: "/c" } },
      }),
    );
    const { config } = loadRunnerConfig(configPath, { HOME: base, DODOK_RUNNER_TOKEN: "drn_x" });
    expect(config.roots[0]!.path).toBe(join(base, "Mixed"));
    expect(checkCeiling(config, agent({ project: { rootId: "src", relPath: "REPO" } }), always)).toEqual({
      ok: true,
      workdir: join(base, "Mixed", "repo"),
    });
  });

  it("`..` 꼴은 스키마가 먼저 거른다 — run.start 가 파싱되지 않는다", () => {
    const start = runStart();
    for (const relPath of ["..", "repo/../../outside", "/etc"]) {
      expect(
        RunnerRunStart.safeParse({
          ...start,
          agent: { ...start.agent, project: { rootId: "src", relPath } },
        }).success,
      ).toBe(false);
    }
  });

  it("program — 설정에 없는 프로그램·드라이버가 없거나 못 쓰는 프로그램", () => {
    expect(checkCeiling(cfg(), agent({ program: "codex" }), always)).toEqual({ ok: false, item: "program" });
    expect(checkCeiling(cfg(), agent(), (p: RunnerProgram) => p !== "claude")).toEqual({
      ok: false,
      item: "program",
    });
  });

  it("permissionMode — 상한 위는 거절, 같거나 아래는 통과(Review Focus 3)", () => {
    const lowered = cfg({ maxPermissionMode: "default" });
    expect(checkCeiling(lowered, agent({ permissionMode: "acceptEdits" }), always)).toEqual({
      ok: false,
      item: "permissionMode",
    });
    for (const permissionMode of ["plan", "dontAsk", "default"] as const) {
      expect(checkCeiling(lowered, agent({ permissionMode }), always).ok).toBe(true);
    }
    expect(
      checkCeiling(cfg({ maxPermissionMode: "plan" }), agent({ permissionMode: "dontAsk" }), always),
    ).toEqual({
      ok: false,
      item: "permissionMode",
    });
  });

  it("permissionMode — 상한 acceptEdits 는 auto·bypassPermissions 를 거절, 상한 bypassPermissions 는 모두 통과", () => {
    for (const permissionMode of ["auto", "bypassPermissions"] as const)
      expect(
        checkCeiling(cfg({ maxPermissionMode: "acceptEdits" }), agent({ permissionMode }), always),
        permissionMode,
      ).toEqual({ ok: false, item: "permissionMode" });
    expect(
      checkCeiling(
        cfg({ maxPermissionMode: "auto" }),
        agent({ permissionMode: "bypassPermissions" }),
        always,
      ),
    ).toEqual({ ok: false, item: "permissionMode" });
    for (const permissionMode of [
      "plan",
      "dontAsk",
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
    ] as const)
      expect(
        checkCeiling(cfg({ maxPermissionMode: "bypassPermissions" }), agent({ permissionMode }), always).ok,
        permissionMode,
      ).toBe(true);
  });

  it("allowedTools — 상한의 부분집합만(글자 그대로), null 은 어느 상한에도 든다", () => {
    const capped = cfg({ allowedToolsCeiling: ["Read", "Bash"] });
    expect(checkCeiling(capped, agent({ allowedTools: ["Read"] }), always).ok).toBe(true);
    expect(checkCeiling(capped, agent({ allowedTools: null }), always).ok).toBe(true);
    expect(checkCeiling(capped, agent({ allowedTools: ["Read", "Write"] }), always)).toEqual({
      ok: false,
      item: "allowedTools",
    });
    expect(checkCeiling(capped, agent({ allowedTools: ["Bash(git status)"] }), always)).toEqual({
      ok: false,
      item: "allowedTools",
    });
    expect(checkCeiling(cfg(), agent({ allowedTools: ["Write", "Bash"] }), always).ok).toBe(true);
  });

  it("outsideWorkdir — 작업 디렉터리 밖 허용은 상한 allowOutsideWorkdir 이 true 일 때만, 꺼진 에이전트는 어느 상한에도 든다", () => {
    const on = agent({ allowOutsideWorkdir: true });
    // 적지 않으면 막는다(fail-safe) — 이 머신의 사람이 적어야만 열린다
    expect(checkCeiling(cfg(), on, always)).toEqual({ ok: false, item: "outsideWorkdir" });
    expect(checkCeiling(cfg({ allowOutsideWorkdir: false }), on, always)).toEqual({
      ok: false,
      item: "outsideWorkdir",
    });
    expect(checkCeiling(cfg({ allowOutsideWorkdir: true }), on, always)).toEqual({
      ok: true,
      workdir: join(root, "repo"),
    });
    expect(checkCeiling(cfg(), agent({ allowOutsideWorkdir: false }), always).ok).toBe(true);
    expect(checkCeiling(cfg(), agent(), always).ok).toBe(true);
  });

  it("먼저 걸린 항목 하나만 — root 가 없으면 나머지는 보지 않는다", () => {
    const bad = agent({
      project: { rootId: "gone", relPath: "repo" },
      program: "codex",
      permissionMode: "acceptEdits",
    });
    expect(checkCeiling(cfg({ maxPermissionMode: "plan" }), bad, always)).toEqual({
      ok: false,
      item: "root",
    });
  });
});

describe("resolveBot — 봇 폴더(러너 봇 스펙 B1) [Review Focus 1]", () => {
  const BOT = "r-0123456789";

  it("없으면 botsDir·봇 폴더를 0700 으로 만들고 그 realpath 를 돌려준다", () => {
    const botsDir = join(base, "nested", "bots");
    expect(resolveBot(botsDir, BOT)).toEqual({ ok: true, path: join(botsDir, BOT) });
    expect(statSync(join(botsDir, BOT)).mode & 0o777).toBe(0o700);
    // 이미 있으면 그대로
    expect(resolveBot(botsDir, BOT)).toEqual({ ok: true, path: join(botsDir, BOT) });
  });

  it.each([
    "../x",
    "r-0123456789/../..",
    "r-../../etc",
    "R-0123456789",
    "r-ABCDEF0123",
    "r-012345678",
    "",
    ".",
    "..",
  ])("id 가 r-hex10 이 아니면 거절하고 아무것도 만들지 않는다 — %j", (id) => {
    const botsDir = join(base, "bots");
    expect(resolveBot(botsDir, id)).toEqual({ ok: false });
    expect(existsSync(botsDir)).toBe(false);
  });

  it("봇 폴더가 심볼릭 링크면 거절 — 봇 자리 밖을 가리켜도 거기서 돌지 않는다", () => {
    const botsDir = join(base, "bots");
    mkdirSync(botsDir);
    symlinkSync(outside, join(botsDir, BOT));
    expect(resolveBot(botsDir, BOT)).toEqual({ ok: false });
    // 링크 안쪽(봇 자리 안을 가리켜도) 역시 거절
    const inner = join(botsDir, "r-aaaaaaaaaa");
    mkdirSync(inner);
    symlinkSync(inner, join(botsDir, "r-bbbbbbbbbb"));
    expect(resolveBot(botsDir, "r-bbbbbbbbbb")).toEqual({ ok: false });
    expect(lstatSync(join(botsDir, BOT)).isSymbolicLink()).toBe(true);
  });

  it("봇 자리에 파일이 있으면 거절", () => {
    const botsDir = join(base, "bots");
    mkdirSync(botsDir);
    writeFileSync(join(botsDir, BOT), "x");
    expect(resolveBot(botsDir, BOT)).toEqual({ ok: false });
  });

  it("botsDir 자체가 링크면 링크를 푼 자리 아래에 둔다", () => {
    const real = join(base, "real-bots");
    mkdirSync(real);
    symlinkSync(real, join(base, "bots"));
    expect(resolveBot(join(base, "bots"), BOT)).toEqual({ ok: true, path: join(real, BOT) });
  });
});

describe("checkCeiling — 봇 런", () => {
  const { project: _, ...noProject } = agent();
  const bot = (id = "r-0123456789"): RunnerRunAgent => ({ ...noProject, bot: { id, soul: "# 봇\n" } });

  it("루트가 없어도(roots: []) 봇 런은 통과 — 작업 디렉터리는 봇 폴더", () => {
    expect(checkCeiling({ ...cfg(), roots: [] }, bot(), always)).toEqual({
      ok: true,
      workdir: join(base, "bots", "r-0123456789"),
    });
  });

  it("봇 자리가 링크·잘못된 id 면 천장 항목 bot", () => {
    mkdirSync(join(base, "bots"));
    symlinkSync(outside, join(base, "bots", "r-0123456789"));
    expect(checkCeiling(cfg(), bot(), always)).toEqual({ ok: false, item: "bot" });
    expect(checkCeiling(cfg(), bot("../escape"), always)).toEqual({ ok: false, item: "bot" });
  });

  it("봇 런도 프로그램·권한 상한은 그대로 본다", () => {
    expect(checkCeiling(cfg({ maxPermissionMode: "plan" }), bot(), always)).toEqual({
      ok: false,
      item: "permissionMode",
    });
    expect(checkCeiling(cfg(), bot(), () => false)).toEqual({ ok: false, item: "program" });
  });
});
