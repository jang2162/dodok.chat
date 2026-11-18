import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerFsListResult } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProject, listDirectory } from "../src/fs-browse";

// 둘러보기·프로젝트 확인(러너 일반화 스펙 3장) — 실제 디렉터리·링크로 본다

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-browse-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "beta", ".git"), { recursive: true });
  mkdirSync(join(root, "alpha", "inner"), { recursive: true });
  // 워크트리·서브모듈은 .git 이 파일이다
  mkdirSync(join(root, "wt"));
  writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere");
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "notes.txt"), "x");
  mkdirSync(outside);
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(root, "beta"), join(root, "link-in"));
  symlinkSync(join(root, "notes.txt"), join(root, "file-link"));
  symlinkSync(join(root, "missing"), join(root, "dangling"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const cfg = (browse = true) => ({ roots: [{ id: "src", path: root, label: "src" }], browse });

describe("listDirectory (fs.list)", () => {
  it("디렉터리만, 숨김 빼고, 루트 밖 링크 빼고, 이름순 — git 여부", () => {
    const result = listDirectory(cfg(), { rootId: "src", relPath: "" });
    expect(result).toEqual({
      ok: true,
      entries: [
        { name: "alpha", isGitRepo: false },
        { name: "beta", isGitRepo: true },
        { name: "link-in", isGitRepo: true },
        { name: "wt", isGitRepo: true },
      ],
      truncated: false,
    });
    expect(RunnerFsListResult.safeParse(result).success).toBe(true);
  });

  it("루트 이름을 접두로 가진 형제(`…/root-secret`)를 가리키는 링크는 목록에 없고 그 안도 NOT_FOUND [태스크 2 리뷰 L1]", () => {
    mkdirSync(join(base, "root-secret"));
    symlinkSync(join(base, "root-secret"), join(root, "sib"));
    const result = listDirectory(cfg(), { rootId: "src", relPath: "" });
    expect(result.ok && result.entries.map((e) => e.name)).not.toContain("sib");
    expect(listDirectory(cfg(), { rootId: "src", relPath: "sib" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("루트 디렉터리 자신이 밖을 가리키는 링크로 바뀌면 NOT_FOUND [태스크 2 리뷰 L1]", () => {
    rmSync(root, { recursive: true });
    symlinkSync(outside, root);
    expect(listDirectory(cfg(), { rootId: "src", relPath: "" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("하위 디렉터리", () => {
    expect(listDirectory(cfg(), { rootId: "src", relPath: "alpha" })).toEqual({
      ok: true,
      entries: [{ name: "inner", isGitRepo: false }],
      truncated: false,
    });
  });

  it("500개에서 자르고 truncated", () => {
    const many = join(root, "many");
    mkdirSync(many);
    for (let i = 0; i < 501; i += 1) mkdirSync(join(many, `d${String(i).padStart(3, "0")}`));
    const result = listDirectory(cfg(), { rootId: "src", relPath: "many" });
    if (!result.ok) throw new Error("ok 가 아니다");
    expect(result.entries).toHaveLength(500);
    expect(result.entries[0]!.name).toBe("d000");
    expect(result.entries.at(-1)!.name).toBe("d499");
    expect(result.truncated).toBe(true);
    expect(RunnerFsListResult.safeParse(result).success).toBe(true);
    rmSync(join(many, "d500"), { recursive: true });
    expect(listDirectory(cfg(), { rootId: "src", relPath: "many" })).toMatchObject({ truncated: false });
  });

  it("browse: false 면 FORBIDDEN", () => {
    expect(listDirectory(cfg(false), { rootId: "src", relPath: "" })).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
  });

  it("없는 루트·없는 디렉터리·파일·루트 밖 링크는 모두 NOT_FOUND", () => {
    for (const ref of [
      { rootId: "gone", relPath: "" },
      { rootId: "src", relPath: "nope" },
      { rootId: "src", relPath: "notes.txt" },
      { rootId: "src", relPath: "escape" },
    ]) {
      expect(listDirectory(cfg(), ref)).toEqual({ ok: false, code: "NOT_FOUND" });
    }
  });
});

describe("checkProject (project.check)", () => {
  it("ok — git 여부", async () => {
    expect(await checkProject(cfg(), { rootId: "src", relPath: "beta" })).toEqual({
      ok: true,
      isGitRepo: true,
      isGitTop: false,
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "alpha" })).toEqual({
      ok: true,
      isGitRepo: false,
      isGitTop: false,
    });
  });

  it("사유 넷", async () => {
    expect(await checkProject(cfg(), { rootId: "gone", relPath: "" })).toEqual({
      ok: false,
      reason: "root_missing",
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "nope" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "dangling" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "notes.txt" })).toEqual({
      ok: false,
      reason: "not_directory",
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "escape" })).toEqual({
      ok: false,
      reason: "outside_root",
    });
  });

  it("둘러보기를 꺼도 확인은 된다 — 경로를 직접 적어 더하는 길", async () => {
    expect(await checkProject({ roots: cfg(false).roots }, { rootId: "src", relPath: "beta" })).toEqual({
      ok: true,
      isGitRepo: true,
      isGitTop: false,
    });
  });

  it("checkProject isGitTop true for repo top, false for subdir and worktree", async () => {
    const run = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "ignore",
      });
    const repo = join(root, "real");
    mkdirSync(join(repo, "sub"), { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "sub", "f"), "x");
    run(repo, "add", "sub/f");
    run(repo, "commit", "-q", "-m", "init");
    run(repo, "worktree", "add", "-q", "-b", "w", "--", join(root, "real-wt"), "HEAD");
    expect(await checkProject(cfg(), { rootId: "src", relPath: "real" })).toEqual({
      ok: true,
      isGitRepo: true,
      isGitTop: true,
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "real/sub" })).toEqual({
      ok: true,
      isGitRepo: false,
      isGitTop: false,
    });
    expect(await checkProject(cfg(), { rootId: "src", relPath: "real-wt" })).toEqual({
      ok: true,
      isGitRepo: true,
      isGitTop: false,
    });
  });
});
