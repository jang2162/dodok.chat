/**
 * 초대·재설정 링크 토큰(팀 스펙 3.1·7장). 원문은 발급 결과에만 있고 DB 에는 sha256 hex 만 둔다 — 브리지 토큰(setup/tokens.ts)과 같은 방식.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = { invite: "dit_", reset: "drt_" } as const;

export function newToken(kind: "invite" | "reset"): { token: string; hash: string; prefix: string } {
  const token = `${PREFIX[kind]}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 해시 유일 인덱스로 찾은 행을 상수 시간으로 한 번 더 대조한다 — 스펙 7장 */
export function sameHash(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(presented, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
