/** 첨부 블롭(스펙 4.1). `<dir>/<sha 앞 2자>/<sha>` 에 한 번만 쓴다 — 임시 파일에 쓰고 rename 해서 반쯤 쓴 파일이 보이지 않게 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const blobPath = (dir: string, sha: string): string => join(dir, sha.slice(0, 2), sha);

export async function writeBlob(dir: string, bytes: Uint8Array): Promise<string> {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const path = blobPath(dir, sha);
  if (existsSync(path)) return sha;
  await mkdir(join(dir, sha.slice(0, 2)), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path);
  return sha;
}

export async function removeBlob(dir: string, sha: string): Promise<void> {
  await rm(blobPath(dir, sha), { force: true });
}
