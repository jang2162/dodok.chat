/**
 * 웹훅 토큰(자동화 스펙 「웹훅」 절) — 브리지 토큰(modules/setup/tokens.ts)과 같은 규칙. 원문 whk_… 은 발급 결과에만 있고 DB 에는
 * sha256 hex(token_hash)와 whk_ 뒤 6자(token_prefix)만 둔다. 검증은 해시로 행을 찾은 뒤 해시 버퍼끼리 timingSafeEqual.
 */
import { eq } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbOrTx } from "../../db/client";
import { automations } from "../../db/schema.sqlite";
import type { AutomationRow } from "./store";

const TOKEN_PREFIX = "whk_";

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** 새 토큰. raw 는 응답의 webhookUrl 에 한 번만 싣고 저장하지 않는다 — 행에는 hash·prefix 를 넣는다 */
export function issueWebhookToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashOf(raw), prefix: raw.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6) };
}

/**
 * 제시된 원문(URL 경로 그대로)의 행. 꺼졌는지·종류는 보지 않는다 — 웹훅 경로가 가른다(어느 경우든 404 로 같게 답한다).
 * 없으면 undefined — 웹훅 경로가 실패 카운터를 올린다
 */
export function findWebhookByToken(db: DbOrTx, raw: string): AutomationRow | undefined {
  if (raw === "") return undefined;
  const hash = hashOf(raw);
  const row = db.select().from(automations).where(eq(automations.tokenHash, hash)).get();
  if (!row?.tokenHash) return undefined;
  return timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(hash, "hex")) ? row : undefined;
}
