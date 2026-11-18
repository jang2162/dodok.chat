import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerWorktreeCreateResult, RunnerWorktreeRemoveResult } from "@dodok/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, execGit, type GitRunner, isGitTop, removeWorktree } from "../src/worktrees";

// git 워크트리(워크트리 스펙 5.3) — 실제 git 으로 임시 저장소를 만들어 본다. 머신의 git 설정(전역 훅·서명 등)에 기대지 않게
// 전역·시스템 설정을 끈다

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let base: string;
let root: string;
let repo: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-wt-")));
  root = join(base, "root");
  repo = join(root, "app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const cfg = () => ({ roots: [{ id: "src", path: root, label: "src" }] });
const REPO = { rootId: "src", relPath: "app" };
const at = (relPath: string) => ({ rootId: "src", relPath });
const branches = () => git(repo, "branch", "--format=%(refname:short)").split("\n").sort();
const excludeLines = () =>
  readFileSync(join(repo, ".git", "info", "exclude"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));

describe("createWorktree", () => {
  it("creates new branch at default location and excludes /.worktrees/ once", async () => {
    const r = await createWorktree(cfg(), {
      repo: REPO,
      target: at("app/.worktrees/feat"),
      branch: "dodok/feat",
    });
    expect(RunnerWorktreeCreateResult.parse(r)).toEqual({
      ok: true,
      created: true,
      adopted: false,
      base: git(repo, "rev-parse", "--short", "HEAD"),
    });
    expect(existsSync(join(repo, ".worktrees", "feat", "README.md"))).toBe(true);
    expect(git(join(repo, ".worktrees", "feat"), "branch", "--show-current")).toBe("dodok/feat");
    expect(excludeLines()).toEqual(["/.worktrees/"]);
    // 저장소의 추적 파일이 바뀌지 않고, 워크트리 폴더가 추적 안 된 파일로 보이지 않는다
    expect(git(repo, "status", "--porcelain")).toBe("");

    const again = await createWorktree(cfg(), {
      repo: REPO,
      target: at("app/.worktrees/second"),
      branch: "dodok/second",
    });
    expect(again.ok).toBe(true);
    expect(excludeLines()).toEqual(["/.worktrees/"]);
  });

  it("existing branch is checked out (created:false)", async () => {
    git(repo, "branch", "topic");
    const r = await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/t"), branch: "topic" });
    expect(r).toMatchObject({ ok: true, created: false, adopted: false });
    expect(git(join(repo, ".worktrees", "t"), "branch", "--show-current")).toBe("topic");
  });

  it("branch used by another worktree → branch_in_use", async () => {
    const r = await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/m"), branch: "main" });
    expect(r).toMatchObject({ ok: false, reason: "branch_in_use" });
    expect(existsSync(join(repo, ".worktrees", "m"))).toBe(false);
  });

  it('branch "-x" and "a;rm -rf b" → invalid_branch, no folder, no branch', async () => {
    for (const branch of ["-x", "a;rm -rf b", "--orphan", "$(touch pwned)"]) {
      const r = await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/x"), branch });
      expect(r, branch).toMatchObject({ ok: false, reason: "invalid_branch" });
    }
    expect(existsSync(join(repo, ".worktrees"))).toBe(false);
    expect(existsSync(join(repo, "pwned"))).toBe(false);
    expect(branches()).toEqual(["main"]);
  });

  it("git argv: option-like branch never reaches git, paths follow --", async () => {
    // 이 판의 git 은 `-` 시작 이름을 스스로 거절하지만, 옛 git·다른 하위 명령이 옵션으로 읽지 않게 러너가 먼저 거르고
    // 경로는 언제나 `--` 뒤에 둔다(Review Focus 1)
    const calls: string[][] = [];
    const recording: GitRunner = (args, cwd) => {
      calls.push(args);
      return execGit(args, cwd);
    };
    for (const branch of ["-x", "--orphan"]) {
      const r = await createWorktree(
        cfg(),
        { repo: REPO, target: at("app/.worktrees/x"), branch },
        { git: recording },
      );
      expect(r).toMatchObject({ ok: false, reason: "invalid_branch" });
    }
    expect(calls.some((a) => a.includes("-x") || a.includes("--orphan"))).toBe(false);

    calls.length = 0;
    git(repo, "branch", "topic");
    const target = join(repo, ".worktrees");
    for (const [name, branch] of [
      ["n", "dodok/n"],
      ["t", "topic"],
    ] as const) {
      const r = await createWorktree(
        cfg(),
        { repo: REPO, target: at(`app/.worktrees/${name}`), branch },
        { git: recording },
      );
      expect(r.ok).toBe(true);
    }
    await removeWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/t") }, { git: recording });
    const pathCalls = calls.filter((a) => a[0] === "worktree" && (a[1] === "add" || a[1] === "remove"));
    expect(pathCalls).toHaveLength(3);
    for (const a of pathCalls) {
      const i = a.findIndex((x) => x.startsWith(target));
      expect(i, a.join(" ")).toBeGreaterThan(0);
      expect(a[i - 1], a.join(" ")).toBe("--");
    }
  });

  it("shell characters without spaces become the branch name verbatim", async () => {
    const r = await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/semi"), branch: "a;b" });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(branches()).toEqual(["a;b", "main"]);
  });

  it("target outside root → outside_root", async () => {
    mkdirSync(join(base, "outside"));
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(base, "outside"), join(root, "escape"));
    const r = await createWorktree(cfg(), { repo: REPO, target: at("escape/wt"), branch: "dodok/e" });
    expect(r).toMatchObject({ ok: false, reason: "outside_root" });
    expect(existsSync(join(base, "outside", "wt"))).toBe(false);
    expect(branches()).toEqual(["main"]);
  });

  it("missing root → root_missing", async () => {
    const r = await createWorktree(cfg(), {
      repo: { rootId: "gone", relPath: "app" },
      target: at("app/.worktrees/x"),
      branch: "dodok/x",
    });
    expect(r).toMatchObject({ ok: false, reason: "root_missing" });
  });

  it("target with files → target_exists", async () => {
    mkdirSync(join(repo, ".worktrees", "busy"), { recursive: true });
    writeFileSync(join(repo, ".worktrees", "busy", "keep.txt"), "x");
    const r = await createWorktree(cfg(), {
      repo: REPO,
      target: at("app/.worktrees/busy"),
      branch: "dodok/busy",
    });
    expect(r).toMatchObject({ ok: false, reason: "target_exists" });
    expect(readFileSync(join(repo, ".worktrees", "busy", "keep.txt"), "utf8")).toBe("x");
    expect(branches()).toEqual(["main"]);
  });

  it("empty target directory is used", async () => {
    mkdirSync(join(repo, ".worktrees", "empty"), { recursive: true });
    const r = await createWorktree(cfg(), {
      repo: REPO,
      target: at("app/.worktrees/empty"),
      branch: "dodok/empty",
    });
    expect(r).toMatchObject({ ok: true, created: true });
  });

  it("registered worktree same branch → adopted", async () => {
    const req = { repo: REPO, target: at("app/.worktrees/feat"), branch: "dodok/feat" };
    expect(await createWorktree(cfg(), req)).toMatchObject({ ok: true, created: true });
    const again = await createWorktree(cfg(), req);
    expect(again).toMatchObject({ ok: true, created: false, adopted: true });
    const other = await createWorktree(cfg(), { ...req, branch: "dodok/other" });
    expect(other).toMatchObject({ ok: false, reason: "target_exists" });
  });

  it("already ignored by .gitignore → exclude untouched", async () => {
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore");
    const before = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    const r = await createWorktree(cfg(), {
      repo: REPO,
      target: at("app/.worktrees/feat"),
      branch: "dodok/feat",
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("custom location inside the repo is excluded by its own path", async () => {
    const r = await createWorktree(cfg(), { repo: REPO, target: at("app/wt/feat"), branch: "dodok/feat" });
    expect(r.ok).toBe(true);
    expect(excludeLines()).toEqual(["/wt/feat/"]);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("custom location outside the repo leaves exclude alone", async () => {
    const before = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    const r = await createWorktree(cfg(), { repo: REPO, target: at("trees/feat"), branch: "dodok/feat" });
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, "trees", "feat", "README.md"))).toBe(true);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(before);
  });

  it("repo is itself a worktree → is_worktree", async () => {
    await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/feat"), branch: "dodok/feat" });
    const r = await createWorktree(cfg(), {
      repo: at("app/.worktrees/feat"),
      target: at("app/.worktrees/feat/.worktrees/n"),
      branch: "dodok/n",
    });
    expect(r).toMatchObject({ ok: false, reason: "is_worktree" });
  });

  it("subdirectory of a repo → not_git", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "f"), "x");
    const r = await createWorktree(cfg(), {
      repo: at("app/sub"),
      target: at("app/sub/.worktrees/n"),
      branch: "dodok/n",
    });
    expect(r).toMatchObject({ ok: false, reason: "not_git" });
  });

  it("git missing (ENOENT GitRunner) → git_failed with message", async () => {
    const missing: GitRunner = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const r = await createWorktree(
      cfg(),
      { repo: REPO, target: at("app/.worktrees/x"), branch: "dodok/x" },
      { git: missing },
    );
    expect(r).toEqual({ ok: false, reason: "git_failed", message: "러너 머신에 git 이 없습니다" });
    const rm = await removeWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/x") }, { git: missing });
    expect(rm).toEqual({ ok: false, reason: "git_failed", message: "러너 머신에 git 이 없습니다" });
  });

  it("stderr paths are masked", async () => {
    await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/a"), branch: "dodok/a" });
    const r = await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/b"), branch: "dodok/a" });
    expect(r).toMatchObject({ ok: false, reason: "branch_in_use" });
    const message = r.ok ? "" : (r.message ?? "");
    expect(message).toContain("dodok/a");
    expect(message).not.toContain(base);
    expect(message.length).toBeLessThanOrEqual(200);
  });
});

describe("removeWorktree", () => {
  const make = async (name: string) => {
    const r = await createWorktree(cfg(), {
      repo: REPO,
      target: at(`app/.worktrees/${name}`),
      branch: `dodok/${name}`,
    });
    expect(r.ok).toBe(true);
    return join(repo, ".worktrees", name);
  };

  it("remove clean → folder gone, branch kept", async () => {
    const dir = await make("feat");
    // 무시된 파일은 git 기본대로 함께 지워진다(W7)
    writeFileSync(join(repo, ".git", "info", "exclude"), "/.worktrees/\nnode_modules/\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    const r = await removeWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/feat") });
    expect(RunnerWorktreeRemoveResult.parse(r)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
    expect(branches()).toEqual(["dodok/feat", "main"]);
  });

  it("remove with untracked file → dirty, folder kept", async () => {
    const dir = await make("feat");
    writeFileSync(join(dir, "new.txt"), "work");
    const r = await removeWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/feat") });
    expect(r).toMatchObject({ ok: false, reason: "dirty" });
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("work");
    expect(r.ok ? "" : (r.message ?? "")).not.toContain(base);
  });

  it("remove with modified tracked file → dirty", async () => {
    const dir = await make("feat");
    writeFileSync(join(dir, "README.md"), "changed\n");
    const r = await removeWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/feat") });
    expect(r).toMatchObject({ ok: false, reason: "dirty" });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("changed\n");
  });

  it("remove missing folder → prune ok", async () => {
    const dir = await make("feat");
    rmSync(dir, { recursive: true, force: true });
    const r = await removeWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/feat") });
    expect(r).toEqual({ ok: true });
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("feat");
    expect(branches()).toEqual(["dodok/feat", "main"]);
  });

  it("plain directory or the repo itself → not_worktree", async () => {
    mkdirSync(join(repo, "plain"));
    expect(await removeWorktree(cfg(), { repo: REPO, target: at("app/plain") })).toMatchObject({
      ok: false,
      reason: "not_worktree",
    });
    expect(await removeWorktree(cfg(), { repo: REPO, target: REPO })).toMatchObject({
      ok: false,
      reason: "not_worktree",
    });
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  });
});

describe("isGitTop", () => {
  it("true only for the main working tree top", async () => {
    expect(await isGitTop(repo)).toBe(true);
    mkdirSync(join(repo, "sub"));
    expect(await isGitTop(join(repo, "sub"))).toBe(false);
    await createWorktree(cfg(), { repo: REPO, target: at("app/.worktrees/feat"), branch: "dodok/feat" });
    expect(await isGitTop(join(repo, ".worktrees", "feat"))).toBe(false);
    mkdirSync(join(root, "plain"));
    expect(await isGitTop(join(root, "plain"))).toBe(false);
  });
});
