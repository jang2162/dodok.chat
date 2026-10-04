/**
 * 브리지 토큰 저장소(설정 마법사 스펙 2.1·2.2). 원문은 발급 결과에만 있고 DB 에는 sha256 hex 만 둔다.
 * 검증은 해시로 행을 찾은 뒤 해시 버퍼끼리 timingSafeEqual — 플러그인 핸드셰이크와 첨부 HTTP 가 같은 함수를 쓴다.
 * 토큰은 Gateway 하나에 묶인다(멀티 Gateway 스펙 「바뀌는 표」 절) — 플러그인은 토큰만 보내고 서버가 그 행으로 Gateway 를 안다.
 */
import { type BridgeTokenRecord, IssueBridgeTokenInput } from "@dodok/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { bridgeTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

/** lastUsedAt 갱신 간격 — 재접속·첨부마다 쓰기가 나지 않게 */
export const BRIDGE_TOKEN_LAST_USED_INTERVAL_MS = 60_000;
const TOKEN_PREFIX = "dbt_";

type Row = typeof bridgeTokens.$inferSelect;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

function toRecord(row: Row, connectedTokenIds: ReadonlySet<string>): BridgeTokenRecord {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    connected: connectedTokenIds.has(row.id),
  };
}

/** 제시된 값(외부 입력 그대로)과 해시가 같은 활성 행 */
function findActive(db: DbOrTx, presented: unknown): Row | undefined {
  if (typeof presented !== "string" || presented === "") return undefined;
  const hash = hashOf(presented);
  const row = db
    .select()
    .from(bridgeTokens)
    .where(and(eq(bridgeTokens.hash, hash), isNull(bridgeTokens.revokedAt)))
    .get();
  if (!row) return undefined;
  return timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex")) ? row : undefined;
}

/** 새 토큰을 그 Gateway 에 만든다. 라벨은 trim 뒤 1~60자(아니면 VALIDATION). 원문은 이 반환값에만 있다 */
export function issueBridgeToken(
  db: Db,
  workspaceId: string,
  gatewayId: string,
  label: string,
  now = new Date(),
): { token: string; record: BridgeTokenRecord } {
  const input = IssueBridgeTokenInput.safeParse({ label });
  if (!input.success) throw apiError("VALIDATION", "라벨은 1~60자여야 한다");
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row: Row = {
    id: uuidv7(),
    workspaceId,
    label: input.data.label,
    hash: hashOf(token),
    prefix: token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    gatewayId,
  };
  db.insert(bridgeTokens).values(row).run();
  return { token, record: toRecord(row, new Set()) };
}

/**
 * 핸드셰이크·첨부 HTTP 의 검증 함수. 활성 토큰이면 그 id 와 묶인 Gateway, 아니면 null. 통과하면 lastUsedAt 을 채운다(1분에 한
 * 번까지). Gateway 가 꺼졌는지는 보지 않는다 — 핸드셰이크는 어댑터가 가른다(꺼진 Gateway 의 토큰 거절). DB 오류는 던진다 —
 * 부르는 쪽(어댑터 브리지·requireBridge)이 거절로 본다
 */
export function verifyBridgeTokenDb(
  db: Db,
  presented: unknown,
  now = new Date(),
): { tokenId: string; gatewayId: string } | null {
  const row = findActive(db, presented);
  if (!row) return null;
  const last = row.lastUsedAt?.getTime();
  if (last === undefined || now.getTime() - last >= BRIDGE_TOKEN_LAST_USED_INTERVAL_MS) {
    db.update(bridgeTokens).set({ lastUsedAt: now }).where(eq(bridgeTokens.id, row.id)).run();
  }
  return { tokenId: row.id, gatewayId: row.gatewayId };
}

/** 그 Gateway 의 토큰을 폐기된 것까지, 새것부터. connectedTokenIds 는 지금 붙은 플러그인 세션의 토큰 id 들 */
export function listBridgeTokens(
  db: Db,
  workspaceId: string,
  gatewayId: string,
  connectedTokenIds: ReadonlySet<string>,
): BridgeTokenRecord[] {
  return db
    .select()
    .from(bridgeTokens)
    .where(and(eq(bridgeTokens.workspaceId, workspaceId), eq(bridgeTokens.gatewayId, gatewayId)))
    .orderBy(desc(bridgeTokens.createdAt), desc(bridgeTokens.id))
    .all()
    .map((row) => toRecord(row, connectedTokenIds));
}

/** 폐기한다. 그 Gateway 에 그 행이 없으면 false. 이미 폐기된 행은 처음 revokedAt 을 지키고 true */
export function revokeBridgeToken(
  db: Db,
  workspaceId: string,
  gatewayId: string,
  id: string,
  now = new Date(),
): boolean {
  const where = and(
    eq(bridgeTokens.id, id),
    eq(bridgeTokens.workspaceId, workspaceId),
    eq(bridgeTokens.gatewayId, gatewayId),
  );
  const row = db.select({ revokedAt: bridgeTokens.revokedAt }).from(bridgeTokens).where(where).get();
  if (!row) return false;
  if (row.revokedAt === null) db.update(bridgeTokens).set({ revokedAt: now }).where(where).run();
  return true;
}
