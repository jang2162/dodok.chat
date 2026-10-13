/**
 * 개인 토큰(PAT) 저장소(제어 MCP 스펙 「개인 토큰(PAT)」 절) — 브리지·러너 토큰(modules/setup/tokens.ts·modules/runners/tokens.ts)과
 * 같은 규칙. 원문 dpt_… 은 발급 결과에만 있고 DB 에는 sha256 hex 만 둔다. 토큰은 사람에게 묶이고 그 사람만 보고 폐기한다
 */
import {
  PERSONAL_TOKENS_MAX,
  PersonalTokenCreate,
  type PersonalTokenIssued,
  type PersonalTokenSummary,
} from "@dodok/shared";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { personalTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

/** lastUsedAt 갱신 간격 — 도구 호출마다 쓰기가 나지 않게 */
export const PERSONAL_TOKEN_LAST_USED_INTERVAL_MS = 60_000;

const TOKEN_PREFIX = "dpt_";

type Row = typeof personalTokens.$inferSelect;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

function toSummary(row: Row): PersonalTokenSummary {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt.toISOString() }),
  };
}

/**
 * 새 토큰. 라벨은 trim 뒤 1~40자(아니면 VALIDATION), 살아 있는 토큰이 이미 PERSONAL_TOKENS_MAX 개면 CONFLICT.
 * 세기와 넣기는 한 트랜잭션이라 동시에 눌러도 상한을 넘지 않는다. 원문은 이 반환값에만 있다
 */
export function issuePersonalToken(
  db: Db,
  userId: string,
  label: string,
  now = new Date(),
): PersonalTokenIssued {
  const input = PersonalTokenCreate.safeParse({ label });
  if (!input.success) throw apiError("VALIDATION", "이름은 1~40자여야 한다", { field: "label" });
  const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row: Row = {
    id: uuidv7(),
    userId,
    label: input.data.label,
    hash: hashOf(raw),
    prefix: raw.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  db.transaction((tx) => {
    const active =
      tx
        .select({ n: count() })
        .from(personalTokens)
        .where(and(eq(personalTokens.userId, userId), isNull(personalTokens.revokedAt)))
        .get()?.n ?? 0;
    if (active >= PERSONAL_TOKENS_MAX)
      throw apiError("CONFLICT", `토큰은 ${PERSONAL_TOKENS_MAX}개까지 — 쓰지 않는 것을 폐기한 뒤 만든다`);
    tx.insert(personalTokens).values(row).run();
  });
  return { token: toSummary(row), raw };
}

/** 그 사람의 살아 있는 토큰, 새것부터 — 폐기한 것은 다시 쓸 수 없으니 보이지 않는다 */
export function listPersonalTokens(db: DbOrTx, userId: string): PersonalTokenSummary[] {
  return db
    .select()
    .from(personalTokens)
    .where(and(eq(personalTokens.userId, userId), isNull(personalTokens.revokedAt)))
    .orderBy(desc(personalTokens.createdAt), desc(personalTokens.id))
    .all()
    .map(toSummary);
}

/** 폐기한다. 그 사람의 토큰이 아니면 NOT_FOUND(남의 토큰이 있는지 드러내지 않는다). 이미 폐기됐으면 처음 revokedAt 을 지킨다 */
export function revokePersonalToken(db: DbOrTx, userId: string, id: string, now = new Date()): void {
  const where = and(eq(personalTokens.id, id), eq(personalTokens.userId, userId));
  const row = db.select({ revokedAt: personalTokens.revokedAt }).from(personalTokens).where(where).get();
  if (!row) throw apiError("NOT_FOUND", "token not found");
  if (row.revokedAt === null) db.update(personalTokens).set({ revokedAt: now }).where(where).run();
}

/** 그 사람의 살아 있는 토큰을 모두 폐기한다 — 멤버 비활성화(members/service.ts deactivateMember)가 같은 트랜잭션에서 부른다 */
export function revokeAllPersonalTokens(db: DbOrTx, userId: string, now: Date): void {
  db.update(personalTokens)
    .set({ revokedAt: now })
    .where(and(eq(personalTokens.userId, userId), isNull(personalTokens.revokedAt)))
    .run();
}

/**
 * `/mcp` 의 검증 함수. 제시된 값(외부 입력 그대로)과 해시가 같은 살아 있는 토큰이면 그 id·주인, 아니면 undefined.
 * 원문끼리 비교하지 않는다 — 해시로 행을 찾은 뒤 해시 버퍼끼리 timingSafeEqual. 통과하면 lastUsedAt 을 채운다(1분에 한 번까지).
 * 주인의 역할·비활성 여부는 보지 않는다 — 부르는 쪽이 roleOf 로 그때 읽는다
 */
export function verifyPersonalToken(
  db: Db,
  presented: unknown,
  now = new Date(),
): { tokenId: string; userId: string } | undefined {
  if (typeof presented !== "string" || !presented.startsWith(TOKEN_PREFIX)) return undefined;
  const hash = hashOf(presented);
  const row = db
    .select()
    .from(personalTokens)
    .where(and(eq(personalTokens.hash, hash), isNull(personalTokens.revokedAt)))
    .get();
  if (!row || !timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex"))) return undefined;
  const last = row.lastUsedAt?.getTime();
  if (last === undefined || now.getTime() - last >= PERSONAL_TOKEN_LAST_USED_INTERVAL_MS) {
    db.update(personalTokens).set({ lastUsedAt: now }).where(eq(personalTokens.id, row.id)).run();
  }
  return { tokenId: row.id, userId: row.userId };
}
