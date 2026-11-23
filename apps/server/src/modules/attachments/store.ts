/** 첨부 블롭의 sha 와 sha 별 잠금(스펙 4.1). 블롭을 쓰고 읽고 지우는 것은 blob-store.ts(로컬·S3) */
import { createHash } from "node:crypto";

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * sha 별 직렬화 잠금(promise 체인). 업로드의 「블롭 쓰기 + 행 넣기」와 정리의 「행이 없음을 확인 + 블롭 지우기」를
 * 같은 키로 감싸, 정리가 지우는 사이 같은 바이트 업로드가 「이미 있다」고 보고 행만 넣는 일을 막는다.
 * 한 프로세스 안에서만 맞다 — 서버는 한 프로세스(SQLite)이고 ATTACHMENTS_DIR·S3 접두사를 다른 프로세스와 나누지 않는다
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
