/**
 * 러너 토큰 저장소(러너 스펙 5장) — 브리지 토큰(modules/setup/tokens.ts)과 같은 규칙. 원문 drn_… 은 발급 결과에만 있고
 * DB 에는 sha256 hex 만 둔다. `/runner` 핸드셰이크와 러너 첨부 HTTP 가 같은 검증 함수를 쓴다.
 * `.env` 이어받기는 없다 — 러너 토큰은 처음부터 「연결」 탭에서만 만든다
 */
import { IssueRunnerTokenInput, type RunnerTokenRecord } from "@dodok/shared";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../../db/client";
import { runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

/** lastUsedAt 갱신 간격 — 재접속·첨부마다 쓰기가 나지 않게 */
export const RUNNER_TOKEN_LAST_USED_INTERVAL_MS = 60_000;

const TOKEN_PREFIX = "drn_";

type Row = typeof runnerTokens.$inferSelect;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

function toRecord(row: Row, connected: boolean): RunnerTokenRecord {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    connected,
    ownerUserId: row.ownerUserId,
  };
}

/** 제시된 값(외부 입력 그대로)과 해시가 같은 활성 행 */
function findActive(db: Db, presented: unknown): Row | undefined {
  if (typeof presented !== "string" || presented === "") return undefined;
  const hash = hashOf(presented);
  const row = db
    .select()
    .from(runnerTokens)
    .where(and(eq(runnerTokens.hash, hash), isNull(runnerTokens.revokedAt)))
    .get();
  if (!row) return undefined;
  return timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex")) ? row : undefined;
}

/**
 * 새 토큰을 만든다. 라벨(러너 머신 이름)은 trim 뒤 1~60자(아니면 VALIDATION). 원문은 이 반환값에만 있다. ownerUserId 는 그 러너의
 * 주인 — 발급한 사람(연결 탭 통합 스펙 5.1)
 */
export function issueRunnerToken(
  db: Db,
  workspaceId: string,
  label: string,
  ownerUserId: string | null,
  now = new Date(),
): { token: string; record: RunnerTokenRecord } {
  const input = IssueRunnerTokenInput.safeParse({ label });
  if (!input.success) throw apiError("VALIDATION", "라벨은 1~60자여야 한다");
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row: Row = {
    id: uuidv7(),
    workspaceId,
    label: input.data.label,
    hash: hashOf(token),
    prefix: token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6),
    ownerUserId,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  db.insert(runnerTokens).values(row).run();
  return { token, record: toRecord(row, false) };
}

/**
 * 다시 발급(러너 일반화 계획 판정 PR7) — 같은 행의 해시·접두사만 바꾼다. 러너의 정체는 행 id 라 프로젝트·에이전트·세션은 그대로
 * 남고, 옛 원문은 곧바로 안 통한다(그 연결을 끊는 것은 호출자 — 폐기와 같은 길). 행이 없으면 NOT_FOUND, 폐기한 러너는 CONFLICT —
 * 폐기는 되돌리지 않는다
 */
export function reissueRunnerToken(
  db: Db,
  workspaceId: string,
  id: string,
): { token: string; record: RunnerTokenRecord } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const where = and(eq(runnerTokens.id, id), eq(runnerTokens.workspaceId, workspaceId));
  return db.transaction((tx) => {
    const row = tx.select().from(runnerTokens).where(where).get();
    if (!row) throw apiError("NOT_FOUND", "runner token not found");
    if (row.revokedAt !== null) throw apiError("CONFLICT", "runner token is revoked");
    const next = tx
      .update(runnerTokens)
      .set({ hash: hashOf(token), prefix: token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 6) })
      .where(where)
      .returning()
      .get();
    if (!next) throw apiError("NOT_FOUND", "runner token not found");
    return { token, record: toRecord(next, false) };
  });
}

/**
 * 핸드셰이크·첨부 HTTP 의 검증 함수. 활성 토큰이면 그 id·라벨(러너 연결의 이름), 아니면 null.
 * 통과하면 lastUsedAt 을 채운다(1분에 한 번까지). DB 오류는 던진다 — 부르는 쪽이 거절로 본다
 */
export function verifyRunnerTokenDb(
  db: Db,
  presented: unknown,
  now = new Date(),
): { tokenId: string; label: string } | null {
  const row = findActive(db, presented);
  if (!row) return null;
  const last = row.lastUsedAt?.getTime();
  if (last === undefined || now.getTime() - last >= RUNNER_TOKEN_LAST_USED_INTERVAL_MS) {
    db.update(runnerTokens).set({ lastUsedAt: now }).where(eq(runnerTokens.id, row.id)).run();
  }
  return { tokenId: row.id, label: row.label };
}

/** 폐기된 것까지, 새것부터. connectedTokenIds 는 지금 붙은 러너들의 토큰 id */
export function listRunnerTokens(
  db: Db,
  workspaceId: string,
  connectedTokenIds: ReadonlySet<string>,
): RunnerTokenRecord[] {
  return db
    .select()
    .from(runnerTokens)
    .where(eq(runnerTokens.workspaceId, workspaceId))
    .orderBy(desc(runnerTokens.createdAt), desc(runnerTokens.id))
    .all()
    .map((row) => toRecord(row, connectedTokenIds.has(row.id)));
}

/** 폐기한다. 그 워크스페이스에 행이 없으면 false. 이미 폐기된 행은 처음 revokedAt 을 지키고 true */
export function revokeRunnerToken(db: Db, workspaceId: string, id: string, now = new Date()): boolean {
  const where = and(eq(runnerTokens.id, id), eq(runnerTokens.workspaceId, workspaceId));
  const row = db.select({ revokedAt: runnerTokens.revokedAt }).from(runnerTokens).where(where).get();
  if (!row) return false;
  if (row.revokedAt === null) db.update(runnerTokens).set({ revokedAt: now }).where(where).run();
  return true;
}

/** 폐기되지 않은 토큰 수 — 어댑터 상태의 runners.tokens */
export function activeRunnerTokenCount(db: Db, workspaceId: string): number {
  const row = db
    .select({ n: count() })
    .from(runnerTokens)
    .where(and(eq(runnerTokens.workspaceId, workspaceId), isNull(runnerTokens.revokedAt)))
    .get();
  return row?.n ?? 0;
}

/** 그 워크스페이스의 폐기되지 않은 토큰 id 인가 — runner_down 은 폐기된 토큰에 사건을 남기지 않는다 */
export function isActiveRunnerTokenId(db: Db, workspaceId: string, id: string): boolean {
  return (
    db
      .select({ id: runnerTokens.id })
      .from(runnerTokens)
      .where(
        and(
          eq(runnerTokens.id, id),
          eq(runnerTokens.workspaceId, workspaceId),
          isNull(runnerTokens.revokedAt),
        ),
      )
      .get() !== undefined
  );
}
