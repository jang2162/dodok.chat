import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPostFiles,
  createNodeFilesFs,
  describePostFileRejections,
  nodeFilesFs,
  openCheckedFile,
  POST_FILE_MAX_BYTES,
  readCheckedFile,
} from "../src/files";
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
    const id = (p: string) => {
      const st = statSync(p);
      return { dev: st.dev, ino: st.ino };
    };
    expect(checks).toEqual([
      {
        ok: true,
        abs: realpathSync(join(workdir, "a.txt")),
        rel: "a.txt",
        bytes: 5,
        ...id(join(workdir, "a.txt")),
      },
      {
        ok: true,
        abs: realpathSync(join(workdir, "sub", "b.txt")),
        rel: "sub/b.txt",
        bytes: 3,
        ...id(join(workdir, "sub", "b.txt")),
      },
      {
        ok: true,
        abs: realpathSync(join(workdir, "a.txt")),
        rel: "a.txt",
        bytes: 5,
        ...id(join(workdir, "a.txt")),
      },
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

  it("「..」 로 시작하는 이름(..cache/x·..foo)은 안이다 — 부모 디렉터리가 아니다", () => {
    mkdirSync(join(workdir, "..cache"));
    writeFileSync(join(workdir, "..cache", "x"), "c");
    writeFileSync(join(workdir, "..foo"), "f");
    const { checks } = checkPostFiles(workdir, ["..cache/x", "..foo", join(workdir, "..foo")]);
    expect(checks.map((c) => (c.ok ? `ok:${c.rel}` : c.reason))).toEqual([
      "ok:..cache/x",
      "ok:..foo",
      "ok:..foo",
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

describe("openCheckedFile·readCheckedFile — 검사한 그 파일에서만 읽는다", () => {
  const passed = (path: string) => {
    const [check] = checkPostFiles(workdir, [path]).checks;
    if (!check?.ok) throw new Error("check failed");
    return check;
  };

  it("검사한 그대로면 fd 를 열고 검사한 크기만큼 읽는다", () => {
    const check = passed("a.txt");
    const o = openCheckedFile(check);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    try {
      expect(readCheckedFile(o.fd, check)?.toString()).toBe("hello");
    } finally {
      closeSync(o.fd);
    }
  });

  it("같은 크기의 다른 파일로 바뀌면(ino 다름) changed", () => {
    const check = passed("a.txt");
    rmSync(join(workdir, "a.txt"));
    writeFileSync(join(workdir, "a.txt"), "HELLO");
    expect(openCheckedFile(check)).toEqual({ ok: false, rel: "a.txt", reason: "changed" });
  });

  it("같은 파일이라도 크기가 바뀌었으면 changed, 파일이 사라졌으면 changed", () => {
    const check = passed("a.txt");
    writeFileSync(join(workdir, "a.txt"), "hello!");
    expect(openCheckedFile(check)).toMatchObject({ ok: false, reason: "changed" });
    const b = passed("sub/b.txt");
    rmSync(join(workdir, "sub", "b.txt"));
    expect(openCheckedFile(b)).toMatchObject({ ok: false, reason: "changed" });
  });

  it("검사 뒤 파일 자리가 링크가 되면 같은 파일을 가리켜도 열지 않는다(O_NOFOLLOW — 링크 너머 장치 파일 등을 열지 않게)", () => {
    const check = passed("a.txt");
    renameSync(join(workdir, "a.txt"), join(workdir, "a-moved.txt"));
    symlinkSync(join(workdir, "a-moved.txt"), join(workdir, "a.txt"));
    expect(openCheckedFile(check)).toEqual({ ok: false, rel: "a.txt", reason: "changed" });
  });

  it("다른 기기(dev)의 같은 ino 도 다른 파일이다", () => {
    const check = passed("a.txt");
    expect(openCheckedFile({ ...check, dev: check.dev + 1 })).toMatchObject({ ok: false, reason: "changed" });
  });

  it("연 뒤 줄었거나 늘었으면 읽기가 undefined", () => {
    const check = passed("a.txt");
    const o = openCheckedFile(check);
    if (!o.ok) throw new Error("open failed");
    try {
      truncateSync(join(workdir, "a.txt"), 2);
      expect(readCheckedFile(o.fd, check)).toBeUndefined();
      writeFileSync(join(workdir, "a.txt"), "hello world");
      expect(readCheckedFile(o.fd, check)).toBeUndefined();
    } finally {
      closeSync(o.fd);
    }
  });

  it("크기는 그대로인데 읽기가 일찍 끝나면(0 바이트) undefined — 0 으로 채운 버퍼를 올리지 않는다", () => {
    const check = passed("a.txt");
    const fs = { ...nodeFilesFs, read: () => 0 };
    const o = openCheckedFile(check, fs);
    if (!o.ok) throw new Error("open failed");
    try {
      expect(readCheckedFile(o.fd, check, fs)).toBeUndefined();
    } finally {
      closeSync(o.fd);
    }
  });

  it("changed 사유 문구", () => {
    expect(describePostFileRejections([{ ok: false, rel: "a.txt", reason: "changed" }], false)).toContain(
      "- a.txt: 검사한 뒤 바뀌었습니다",
    );
  });
});

describe("createNodeFilesFs — 연 fd 가 경로의 어느 성분도 링크가 아닌 그 파일일 때만(I1 잔여)", () => {
  it.skipIf(process.platform !== "darwin")(
    "macOS: 중간 성분이 링크면 열지 않는다(O_NOFOLLOW_ANY) — 링크 없는 경로는 연다",
    () => {
      const fs = createNodeFilesFs("darwin");
      expect(fs.supported).toBe(true);
      const real = realpathSync(join(workdir, "sub", "b.txt"));
      closeSync(fs.open(real));
      // evil-dir → secret. realpath 가 아닌 경로(링크 성분)로는 열지 않는다
      writeFileSync(join(outside, "b.txt"), "SECRET");
      expect(() => fs.open(join(realpathSync(workdir), "evil-dir", "b.txt"))).toThrow();
      // 마지막 성분이 링크여도
      expect(() => fs.open(join(realpathSync(workdir), "good-link"))).toThrow();
    },
  );

  it("Linux: 연 fd 의 실제 경로(/proc/self/fd)가 연 경로와 다르면 닫고 던진다", () => {
    const real = realpathSync(join(workdir, "a.txt"));
    const closed: number[] = [];
    let where = real;
    const fs = createNodeFilesFs("linux", {
      fdPath: () => where,
      close: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
    });
    expect(fs.supported).toBe(true);
    const fd = fs.open(real);
    closeSync(fd);
    where = join(realpathSync(outside), "id_rsa");
    expect(() => fs.open(real)).toThrow();
    expect(closed).toHaveLength(1);
    where = "";
    expect(() => fs.open(real)).toThrow();
    expect(closed).toHaveLength(2);
  });

  it("그 밖 플랫폼은 supported false — 열지 않는다", () => {
    const fs = createNodeFilesFs("win32");
    expect(fs.supported).toBe(false);
    expect(() => fs.open(realpathSync(join(workdir, "a.txt")))).toThrow();
    // 검사(realpath·stat)는 그대로 된다
    expect(checkPostFiles(workdir, ["a.txt"], fs).checks[0]).toMatchObject({ ok: true });
  });
});
