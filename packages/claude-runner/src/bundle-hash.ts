// openclaw-plugin 의 src/bundle-hash.ts 와 같은 방식(설정 마법사 스펙 결정 5) — 서버가 「같은 빌드인가」를 번들 파일
// sha256 으로 가른다. package.json 버전은 늘 0.0.0 이고, 산출물에 자기 해시를 박으면 순환이 생긴다
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 읽을 수 없으면 null — hello 는 null 로 싣고 접속은 계속한다 */
export function computeBundleSha256(
  fileUrl: string,
  read: (p: string) => Buffer = readFileSync,
): string | null {
  try {
    if (!fileUrl.startsWith("file:")) return null;
    return createHash("sha256")
      .update(read(fileURLToPath(fileUrl)))
      .digest("hex");
  } catch {
    return null;
  }
}
