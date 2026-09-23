/** 첨부 블롭(스펙 4.1). `<dir>/<sha 앞 2자>/<sha>` 에 한 번만 쓴다 — 임시 파일에 쓰고 rename 해서 반쯤 쓴 파일이 보이지 않게 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const blobPath = (dir: string, sha: string): string => join(dir, sha.slice(0, 2), sha);
export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 임시 파일 이름은 `<sha>.<uuid>.tmp` — 정리가 이름에서 sha 를 읽어 같은 잠금을 잡는다 */
export const TMP_SUFFIX = ".tmp";

export async function writeBlob(dir: string, sha: string, bytes: Uint8Array): Promise<void> {
  const path = blobPath(dir, sha);
  if (existsSync(path)) return;
  await mkdir(join(dir, sha.slice(0, 2)), { recursive: true });
  const tmp = `${path}.${randomUUID()}${TMP_SUFFIX}`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path);
}

export async function removeBlob(dir: string, sha: string): Promise<void> {
  await rm(blobPath(dir, sha), { force: true });
}

/**
 * sha 별 직렬화 잠금(promise 체인). 업로드의 「블롭 쓰기 + 행 넣기」와 정리의 「행이 없음을 확인 + 블롭 지우기」를
 * 같은 키로 감싸, 정리가 지우는 사이 같은 바이트 업로드가 「이미 있다」고 보고 행만 넣는 일을 막는다.
 * 한 프로세스 안에서만 맞다 — 서버는 한 프로세스(SQLite)이고 ATTACHMENTS_DIR 을 다른 프로세스와 나누지 않는다
 */
export type BlobLocks = { run<T>(sha: string, fn: () => Promise<T> | T): Promise<T> };

export function createBlobLocks(): BlobLocks {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async run(sha, fn) {
      const prev = tails.get(sha) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      const tail = run.catch(() => {});
      tails.set(sha, tail);
      try {
        return await run;
      } finally {
        if (tails.get(sha) === tail) tails.delete(sha);
      }
    },
  };
}

/** 서버 배선이 쓰는 기본 잠금. 테스트는 AttachmentDeps.locks 로 따로 줄 수 있다 */
export const defaultBlobLocks: BlobLocks = createBlobLocks();
