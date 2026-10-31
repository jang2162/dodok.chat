import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { OUTSIDE_WORKDIR } from "./mask";

// `mcp__dodok__post` 의 files 검사(러너 스펙 4.4, Review Focus 2). 모델이 준 경로는 작업 디렉터리 안 파일만 보낸다 —
// 글자로 한 번(`..`·절대 경로), realpath 로 한 번(심볼릭 링크) 본다. 거절 문구는 모델에게 가는 도구 결과라 호스트 경로를
// 싣지 않는다: 작업 디렉터리 상대 경로, 밖이면 `<작업 디렉터리 밖>`. 읽기는 경로 글자가 아니라 검사한 그 파일(dev·ino)에서 한다 —
// 검사와 읽기 사이(앞 파일 올리기)에 중간 디렉터리를 밖 링크로 바꿔도 밖 파일을 읽지 않게. 경로로 하는 검사는 호출마다 경로를
// 새로 풀어 원자 교체 경합에 뚫리므로(realpath 와 stat 사이에 바꾸면 기준값부터 밖 파일), 연 fd 가 realpath 그대로의 경로 —
// 어느 성분도 링크가 아닌 — 에서 열렸는지를 연 쪽에서 본다(createNodeFilesFs). 하드 링크는 막지 않는다: 작업 디렉터리 안의
// 항목이고, 만들 수 있는 모델은 복사도 할 수 있다

export const POST_FILES_MAX = ATTACHMENT_LIMITS.perMessage;
export const POST_FILE_MAX_BYTES = ATTACHMENT_LIMITS.agentFileMaxBytes;
const LABEL_MAX = 200;

export type FileCheck =
  | { ok: true; abs: string; rel: string; bytes: number; dev: number; ino: number }
  | {
      ok: false;
      rel: string;
      reason: "outside_workdir" | "not_found" | "not_a_file" | "too_large" | "changed";
    };
type PassedCheck = Extract<FileCheck, { ok: true }>;

export type FileStat = { isFile(): boolean; size: number; dev: number; ino: number };

export type FilesFs = {
  /** false 면 open 이 아래 약속을 지킬 수 없는 플랫폼 — files 를 받지 않는다 */
  supported: boolean;
  /** 없으면 던진다 */
  realpath(path: string): string;
  stat(path: string): FileStat;
  /**
   * 읽기 전용 fd — path(realpath 결과)의 어느 성분이든 링크면 열지 않고 던진다. FIFO 에서 막히지 않는다(O_NONBLOCK)
   */
  open(path: string): number;
  fstat(fd: number): FileStat;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
};

export const POST_FILES_UNSUPPORTED =
  "파일을 보내지 않았습니다 — 이 플랫폼에서는 파일 보내기를 지원하지 않습니다";

// macOS 11+ 의 open 플래그 — 경로의 어느 성분이든 링크면 ELOOP. fs.constants 에 없어 숫자로 준다. O_NOFOLLOW 와 함께 주면 EINVAL
const O_NOFOLLOW_ANY = 0x20000000;

export function createNodeFilesFs(
  platform: NodeJS.Platform = process.platform,
  // 테스트가 바꿔 끼운다 — Linux 가 아닌 곳에서 Linux 갈래를 돌리려고
  deps: { fdPath?: (fd: number) => string; close?: (fd: number) => void } = {},
): FilesFs {
  const close = deps.close ?? closeSync;
  const fdPath = deps.fdPath ?? ((fd: number) => readlinkSync(`/proc/self/fd/${fd}`));
  let open: (path: string) => number;
  if (platform === "darwin") {
    open = (p) => openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
  } else if (platform === "linux") {
    // 여는 플래그로는 중간 성분을 막을 수 없다 — 연 뒤 fd 가 가리키는 실제 경로가 연 경로(realpath) 그대로인지 본다
    open = (p) => {
      const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let actual: string | undefined;
      try {
        actual = fdPath(fd);
      } catch {
        // 못 읽으면 다른 것으로 본다
      }
      if (actual === p) return fd;
      close(fd);
      throw new Error("opened file is not at the checked path");
    };
  } else {
    open = () => {
      throw new Error(`no-follow open is not supported on ${platform}`);
    };
  }
  return {
    supported: platform === "darwin" || platform === "linux",
    // native — 대소문자만 틀린 이름도 실제 이름으로 푼다(루트·작업 디렉터리·둘러보기와 같게). JS 판은 받은 글자를 그대로 둬
    // 대소문자만 다른 경로를 가리키는 링크가 작업 디렉터리 밖으로 보였다
    realpath: (p) => realpathSync.native(p),
    stat: (p) => statSync(p),
    open,
    fstat: (fd) => fstatSync(fd),
    read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    close,
  };
}

export const nodeFilesFs: FilesFs = createNodeFilesFs();

/** base 안이면 base 상대 경로(base 자신은 "."), 밖이면 undefined — 「..foo」 같은 이름은 안이다 */
function within(base: string, target: string): string | undefined {
  const r = relative(base, target);
  if (r === "") return ".";
  if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return undefined;
  return r;
}

// 제어 문자를 그대로 두면 모델이 경로에 줄바꿈을 넣어 거절 목록의 다른 줄을 흉내 낼 수 있다
const label = (rel: string): string =>
  Array.from(
    rel
      .split(sep)
      .join("/")
      .replace(/\p{Cc}/gu, "?"),
  )
    .slice(0, LABEL_MAX)
    .join("");

export function checkPostFiles(
  workdir: string,
  paths: readonly string[],
  fs: FilesFs = nodeFilesFs,
): { checks: FileCheck[]; tooMany: boolean } {
  let root: string;
  try {
    root = fs.realpath(workdir);
  } catch {
    root = workdir;
  }

  const checkOne = (path: string): FileCheck => {
    // 절대 경로도 작업 디렉터리 안이면 받는다 — CLI 의 파일 도구가 절대 경로를 쓰므로 모델도 그렇게 준다
    const lexical = resolve(workdir, path);
    const inside = within(workdir, lexical) ?? within(root, lexical);
    if (inside === undefined) return { ok: false, rel: OUTSIDE_WORKDIR, reason: "outside_workdir" };
    const rel = label(inside);
    let real: string;
    try {
      real = fs.realpath(lexical);
    } catch {
      // 끊긴 심볼릭 링크도 여기로 — 링크가 가리키던 자리는 싣지 않는다
      return { ok: false, rel, reason: "not_found" };
    }
    if (within(root, real) === undefined) return { ok: false, rel, reason: "outside_workdir" };
    let st: FileStat;
    try {
      st = fs.stat(real);
    } catch {
      return { ok: false, rel, reason: "not_found" };
    }
    if (!st.isFile()) return { ok: false, rel, reason: "not_a_file" };
    if (st.size > POST_FILE_MAX_BYTES) return { ok: false, rel, reason: "too_large" };
    return { ok: true, abs: real, rel, bytes: st.size, dev: st.dev, ino: st.ino };
  };

  return { checks: paths.map(checkOne), tooMany: paths.length > POST_FILES_MAX };
}

const sameFile = (st: FileStat, check: PassedCheck): boolean =>
  st.isFile() && st.dev === check.dev && st.ino === check.ino && st.size === check.bytes;

/** 검사를 통과한 파일을 연다 — 연 것이 검사한 그 파일(dev·ino·일반 파일·크기)일 때만 fd, 아니면 changed */
export function openCheckedFile(
  check: PassedCheck,
  fs: FilesFs = nodeFilesFs,
): { ok: true; fd: number } | Extract<FileCheck, { ok: false }> {
  const changed = { ok: false, rel: check.rel, reason: "changed" } as const;
  let fd: number;
  try {
    fd = fs.open(check.abs);
  } catch {
    return changed;
  }
  try {
    if (sameFile(fs.fstat(fd), check)) return { ok: true, fd };
  } catch {
    // fstat 이 실패해도 fd 는 닫는다
  }
  fs.close(fd);
  return changed;
}

/** openCheckedFile 로 연 fd 에서 검사한 크기만큼 — 읽는 사이 크기가 바뀌었으면 undefined */
export function readCheckedFile(
  fd: number,
  check: PassedCheck,
  fs: FilesFs = nodeFilesFs,
): Buffer | undefined {
  const buffer = Buffer.alloc(check.bytes);
  let offset = 0;
  while (offset < check.bytes) {
    const n = fs.read(fd, buffer, offset, check.bytes - offset, offset);
    if (n === 0) return undefined;
    offset += n;
  }
  return sameFile(fs.fstat(fd), check) ? buffer : undefined;
}

const REASON_TEXT: Record<Extract<FileCheck, { ok: false }>["reason"], string> = {
  outside_workdir: "작업 디렉터리 밖을 가리킵니다",
  not_found: "파일이 없습니다",
  not_a_file: "파일이 아닙니다",
  too_large: "20 MiB 를 넘습니다",
  changed: "검사한 뒤 바뀌었습니다",
};

/** 도구 결과로 모델에게 돌려줄 거절 사유 — 파일마다 한 줄 */
export function describePostFileRejections(checks: readonly FileCheck[], tooMany: boolean): string {
  if (tooMany) return `파일을 보내지 않았습니다 — 파일은 한 번에 ${POST_FILES_MAX}개까지 보낼 수 있습니다`;
  const lines = checks.flatMap((c) => (c.ok ? [] : [`- ${c.rel}: ${REASON_TEXT[c.reason]}`]));
  return [
    "파일을 보내지 않았습니다 — 아래 파일을 보낼 수 없습니다(작업 디렉터리 안의 파일만, 하나에 20 MiB 까지):",
    ...lines,
  ].join("\n");
}
