import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPostFiles, describePostFileRejections, POST_FILE_MAX_BYTES } from "../src/files";
import { OUTSIDE_WORKDIR } from "../src/mask";

let base: string;
let workdir: string;
let outside: string;

beforeEach(() => {
  // macOS 의 tmpdir 은 /var → /private/var 심볼릭 링크 아래라 설정 경로와 realpath 가 다르다 — 둘 다 가려야 한다
  base = mkdtempSync(join(tmpdir(), "dodok-files-"));
  workdir = join(base, "repo");
  outside = join(base, "secret");
  mkdirSync(join(workdir, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workdir, "a.txt"), "hello");
  writeFileSync(join(workdir, "sub", "b.txt"), "bee");
  writeFileSync(join(outside, "id_rsa"), "PRIVATE");
  symlinkSync(join(outside, "id_rsa"), join(workdir, "evil-link"));
  symlinkSync(join(workdir, "a.txt"), join(workdir, "good-link"));
  symlinkSync(outside, join(workdir, "evil-dir"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("checkPostFiles", () => {
  it("작업 디렉터리 안 상대 경로는 통과 — 절대 경로는 realpath, rel 은 상대", () => {
    const { checks, tooMany } = checkPostFiles(workdir, ["a.txt", "sub/b.txt", "./sub/../a.txt"]);
    expect(tooMany).toBe(false);
    expect(checks).toEqual([
      { ok: true, abs: realpathSync(join(workdir, "a.txt")), rel: "a.txt", bytes: 5 },
      { ok: true, abs: realpathSync(join(workdir, "sub", "b.txt")), rel: "sub/b.txt", bytes: 3 },
      { ok: true, abs: realpathSync(join(workdir, "a.txt")), rel: "a.txt", bytes: 5 },
    ]);
  });

  it("작업 디렉터리 안을 가리키는 심볼릭 링크는 통과", () => {
    const [check] = checkPostFiles(workdir, ["good-link"]).checks;
    expect(check).toMatchObject({ ok: true, rel: "good-link", abs: realpathSync(join(workdir, "a.txt")) });
  });

  it("작업 디렉터리 안의 절대 경로(설정 경로·realpath 둘 다)는 상대 경로로 통과 — CLI 도구는 절대 경로를 쓴다", () => {
    const { checks } = checkPostFiles(workdir, [
      join(workdir, "a.txt"),
      join(realpathSync(workdir), "sub/b.txt"),
    ]);
    expect(checks.map((c) => [c.ok, c.rel])).toEqual([
      [true, "a.txt"],
      [true, "sub/b.txt"],
    ]);
  });

  it("../x·/etc/passwd·밖을 가리키는 심볼릭 링크·링크 디렉터리 안 → outside_workdir", () => {
    const { checks } = checkPostFiles(workdir, [
      "../secret/id_rsa",
      "/etc/passwd",
      join(outside, "id_rsa"),
      "evil-link",
      "evil-dir/id_rsa",
      "sub/../../secret/id_rsa",
    ]);
    expect(checks.map((c) => (c.ok ? "ok" : c.reason))).toEqual(Array(6).fill("outside_workdir"));
    // 밖 경로의 원문은 표지로, 안쪽 이름(링크 자체)은 상대 경로로
    expect(checks.map((c) => c.rel)).toEqual([
      OUTSIDE_WORKDIR,
      OUTSIDE_WORKDIR,
      OUTSIDE_WORKDIR,
      "evil-link",
      "evil-dir/id_rsa",
      OUTSIDE_WORKDIR,
    ]);
  });

  it("없는 파일 → not_found, 디렉터리 → not_a_file", () => {
    const { checks } = checkPostFiles(workdir, ["missing.txt", "sub", "."]);
    expect(checks.map((c) => (c.ok ? "ok" : `${c.reason}:${c.rel}`))).toEqual([
      "not_found:missing.txt",
      "not_a_file:sub",
      "not_a_file:.",
    ]);
  });

  it("20 MiB 는 통과, 20 MiB + 1 → too_large", () => {
    writeFileSync(join(workdir, "max.bin"), "");
    truncateSync(join(workdir, "max.bin"), POST_FILE_MAX_BYTES);
    writeFileSync(join(workdir, "big.bin"), "");
    truncateSync(join(workdir, "big.bin"), POST_FILE_MAX_BYTES + 1);
    const { checks } = checkPostFiles(workdir, ["max.bin", "big.bin"]);
    expect(checks.map((c) => (c.ok ? "ok" : c.reason))).toEqual(["ok", "too_large"]);
    expect(POST_FILE_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it("11개면 tooMany, 10개는 아니다", () => {
    expect(checkPostFiles(workdir, Array(10).fill("a.txt")).tooMany).toBe(false);
    expect(checkPostFiles(workdir, Array(11).fill("a.txt")).tooMany).toBe(true);
  });

  it("거절 문구 어디에도 임시 디렉터리 절대 경로가 없다(Review Focus 2)", () => {
    const paths = [
      "../secret/id_rsa",
      "/etc/passwd",
      join(outside, "id_rsa"),
      "evil-link",
      "evil-dir/id_rsa",
      "missing.txt",
      "sub",
      join(workdir, "missing.txt"),
      join(realpathSync(workdir), "nope"),
    ];
    const { checks, tooMany } = checkPostFiles(workdir, paths);
    const text = describePostFileRejections(checks, tooMany);
    for (const raw of [base, realpathSync(base), "/etc/passwd", "secret/id_rsa", tmpdir()]) {
      expect(text).not.toContain(raw);
    }
    expect(text).toContain("evil-link");
    expect(text).toContain("missing.txt");
    expect(text).toContain(OUTSIDE_WORKDIR);
    expect(JSON.stringify(checks.filter((c) => !c.ok))).not.toContain(base);
  });

  it("거절 사유 문구 — 사유마다 한 줄, 너무 많으면 첫 줄에", () => {
    const { checks } = checkPostFiles(workdir, ["../x", "missing.txt", "sub"]);
    expect(describePostFileRejections(checks, false)).toBe(
      [
        "파일을 보내지 않았습니다 — 아래 파일을 보낼 수 없습니다(작업 디렉터리 안의 파일만, 하나에 20 MiB 까지):",
        `- ${OUTSIDE_WORKDIR}: 작업 디렉터리 밖을 가리킵니다`,
        "- missing.txt: 파일이 없습니다",
        "- sub: 파일이 아닙니다",
      ].join("\n"),
    );
    expect(describePostFileRejections([], true)).toBe(
      "파일을 보내지 않았습니다 — 파일은 한 번에 10개까지 보낼 수 있습니다",
    );
  });

  it("상대 경로 라벨의 제어 문자는 ? 로 — 줄을 끊어 사유를 흉내 내지 못한다", () => {
    const [check] = checkPostFiles(workdir, ["x\n- a.txt: ok"]).checks;
    expect(check).toMatchObject({ ok: false, reason: "not_found", rel: "x?- a.txt: ok" });
  });
});
