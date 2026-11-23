/**
 * 첨부 블롭 저장소(S3 스펙 4장) — 서비스·라우트·정리는 경로·fs 대신 이것만 쓴다. 로컬 디스크(`<dir>/<sha 앞 2자>/<sha>`)와
 * S3 호환 저장소(s3-store.ts) 두 구현이 같은 시험 묶음(test/blob-store.test.ts)을 지난다
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "../../config";

export type OpenedBlob = {
  size: number;
  stream: NodeJS.ReadableStream;
  /** 다 보내기 전에 그만둘 때 — 파일 핸들·S3 응답 소켓을 놓는다. 여러 번 불러도 된다 */
  close(): void;
};

/** 정리가 훑는 항목 — temp 는 로컬의 죽은 쓰기 잔재(`<sha>.<uuid>.tmp`), key 는 removeTemp 에 넘기는 그 이름 */
export type BlobEntry = { sha: string; modifiedAt: Date; temp?: boolean; key: string };

export interface BlobStore {
  readonly kind: "local" | "s3";
  /** 없을 때만 쓴다. 있으면 아무것도 안 한다 */
  put(sha: string, bytes: Uint8Array): Promise<void>;
  /** 없으면 undefined */
  open(sha: string): Promise<OpenedBlob | undefined>;
  remove(sha: string): Promise<void>;
  /** 로컬 임시 파일 하나를 지운다(list 가 준 key). S3 에는 임시 객체가 없다 */
  removeTemp(key: string): Promise<void>;
  /** 정리용 — 로컬은 디렉터리 훑기(임시 파일 포함), S3 는 목록(prefix). 각 항목의 sha·수정 시각 */
  list(): AsyncIterable<BlobEntry>;
  /** 부팅 확인 — 로컬은 디렉터리 만들기, S3 는 HeadBucket */
  check(): Promise<void>;
}

/** 부팅 확인 실패 — 문구에는 실패 종류(오류 이름·HTTP 상태)만, 키·시크릿·버킷 안 경로는 싣지 않는다. main 이 한 줄로 찍고 끝낸다 */
export class BlobStoreCheckError extends Error {
  override readonly name = "BlobStoreCheckError";
}

const SHA_NAME = /^[0-9a-f]{64}$/;
/** 임시 파일 이름은 `<sha>.<uuid>.tmp` — 정리가 이름에서 sha 를 읽어 같은 잠금을 잡는다 */
const TMP_SUFFIX = ".tmp";

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** 로컬 블롭 파일 자리 `<dir>/<sha 앞 2자>/<sha>` — 시험이 디스크를 직접 볼 때도 쓴다 */
export const localBlobPath = (dir: string, sha: string): string => join(dir, sha.slice(0, 2), sha);

/** 로컬 디스크 — 임시 파일에 쓰고 rename 해서 반쯤 쓴 파일이 보이지 않게 한다 */
export function createLocalBlobStore(dir: string): BlobStore {
  const pathOf = (sha: string) => localBlobPath(dir, sha);
  return {
    kind: "local",
    async put(sha, bytes) {
      const path = pathOf(sha);
      if (existsSync(path)) return;
      await mkdir(join(dir, sha.slice(0, 2)), { recursive: true });
      const tmp = `${path}.${randomUUID()}${TMP_SUFFIX}`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, path);
    },
    async open(sha) {
      const handle = await open(pathOf(sha), "r").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return undefined;
        throw err;
      });
      if (!handle) return undefined;
      let size: number;
      try {
        size = (await handle.stat()).size;
      } catch (err) {
        await handle.close();
        throw err;
      }
      // autoClose — 다 읽거나 destroy 되면 핸들을 닫는다. 읽지 않고 그만두면 close() 가 destroy 한다
      const stream = handle.createReadStream();
      return { size, stream, close: () => stream.destroy() };
    },
    async remove(sha) {
      await rm(pathOf(sha), { force: true });
    },
    async removeTemp(key) {
      const sha = key.slice(0, 64);
      if (!SHA_NAME.test(sha) || !key.endsWith(TMP_SUFFIX) || key.includes("/")) return;
      await rm(join(dir, sha.slice(0, 2), key), { force: true });
    },
    async *list() {
      for (const prefix of await listDir(dir)) {
        // 블롭 하위 디렉터리는 sha 앞 2자(hex)뿐이다 — 맨 위의 다른 항목(.DS_Store·사람이 둔 파일)은 건너뛴다
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
        const sub = join(dir, prefix);
        for (const name of await listDir(sub)) {
          const sha = name.slice(0, 64);
          if (!SHA_NAME.test(sha)) continue;
          const temp = name !== sha;
          if (temp && !name.endsWith(TMP_SUFFIX)) continue;
          // 훑는 사이 지워진(정리·rename) 것은 건너뛴다
          const st = await stat(join(sub, name)).catch(() => undefined);
          if (!st) continue;
          yield { sha, modifiedAt: st.mtime, key: name, ...(temp ? { temp: true } : {}) };
        }
      }
    },
    async check() {
      await mkdir(dir, { recursive: true });
    },
  };
}

/**
 * S3 저장소를 처음 쓸 때 읽는다 — local 모드 부팅은 S3 SDK 를 적재하지 않는다. 부를 쪽(createApp)이 동기로 받으므로 메서드마다 같은
 * 적재를 기다린다(번들에서는 esbuild 가 같은 파일 안의 지연 초기화로 바꾼다)
 */
function lazyS3BlobStore(s3: NonNullable<ServerConfig["s3"]>): BlobStore {
  let loaded: Promise<BlobStore> | undefined;
  const real = () => (loaded ??= import("./s3-store").then((m) => m.createS3BlobStore(s3)));
  return {
    kind: "s3",
    put: async (sha, bytes) => (await real()).put(sha, bytes),
    open: async (sha) => (await real()).open(sha),
    remove: async (sha) => (await real()).remove(sha),
    removeTemp: async (key) => (await real()).removeTemp(key),
    async *list() {
      yield* (await real()).list();
    },
    check: async () => (await real()).check(),
  };
}

/** 설정의 모드(S1)대로 고른다 */
export function createBlobStore(config: ServerConfig): BlobStore {
  if (config.attachmentsStorage === "s3") {
    if (!config.s3) throw new Error("설정 오류: ATTACHMENTS_STORAGE=s3 인데 S3 설정이 없다");
    return lazyS3BlobStore(config.s3);
  }
  return createLocalBlobStore(config.attachmentsDir);
}
