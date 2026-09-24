/**
 * 설정 마법사 스펙 결정 5 — 서버가 품은 플러그인 파일과 같은 빌드인지 번들 파일 sha256 으로 가른다
 * (package.json 버전은 늘 0.0.0 이고, 빌드 산출물에 자기 해시를 박으면 순환이 생긴다).
 * ADR 0004 대로 Gateway 가 세대마다 다른 임시 경로에서 번들을 평가해도 내용이 같으니 해시도 같다.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 읽을 수 없으면 undefined — hello 에서 필드를 빼고 접속은 계속한다(서버는 「빌드를 알 수 없습니다」로 보인다) */
export function computeBundleSha256(
  fileUrl: string,
  read: (p: string) => Buffer = readFileSync,
): string | undefined {
  try {
    if (!fileUrl.startsWith("file:")) return undefined;
    return createHash("sha256")
      .update(read(fileURLToPath(fileUrl)))
      .digest("hex");
  } catch {
    return undefined;
  }
}
