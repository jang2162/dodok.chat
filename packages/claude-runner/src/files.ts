import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { OUTSIDE_WORKDIR } from "./mask";

// `mcp__dodok__post` 의 files 검사(러너 스펙 4.4, Review Focus 2). 모델이 준 경로는 작업 디렉터리 안 파일만 보낸다 —
// 글자로 한 번(`..`·절대 경로), realpath 로 한 번(심볼릭 링크) 본다. 거절 문구는 모델에게 가는 도구 결과라 호스트 경로를
// 싣지 않는다: 작업 디렉터리 상대 경로, 밖이면 `<작업 디렉터리 밖>`. 읽기는 경로 글자가 아니라 검사한 그 파일(dev·ino)에서 한다 —
// 검사와 읽기 사이(앞 파일 올리기)에 중간 디렉터리를 밖 링크로 바꿔도 밖 파일을 읽지 않게

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
  /** 없으면 던진다 */
  realpath(path: string): string;
  stat(path: string): FileStat;
  /** 읽기 전용 fd — 마지막 성분이 링크면 던지고(O_NOFOLLOW), FIFO 에서 막히지 않는다(O_NONBLOCK) */
  open(path: string): number;
  fstat(fd: number): FileStat;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
};

export const nodeFilesFs: FilesFs = {
  realpath: (p) => realpathSync(p),
  stat: (p) => statSync(p),
  open: (p) => openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  close: (fd) => closeSync(fd),
};

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
