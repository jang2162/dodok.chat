/**
 * OpenClaw Gateway 저장소(멀티 Gateway 스펙 「gateways (새 표)」·「Gateway API」 절). 주소·공유 토큰의 정본은 이 표다 — 어댑터는 부팅 때(`bootGateways`)와 저장할
 * 때마다(라우트) `upsertGateway` 로 따라온다. 공유 토큰은 평문으로 두고(스펙 결정 4) 이 모듈 밖으로는 어댑터 설정으로만 나간다 —
 * 응답(`GatewaySummary`)·로그에는 싣지 않는다.
 */
import type {
  CreateGatewayBody,
  DeleteGatewayResult,
  GatewaySummary,
  UpdateGatewayBody,
} from "@dodok/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { GatewayConnectionConfig, OpenClawGateways } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents, bridgeTokens, gateways } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

export type GatewayRow = typeof gateways.$inferSelect;

export function toGatewaySummary(row: GatewayRow): GatewaySummary {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    tokenSet: true,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 어댑터에 넘기는 연결 설정 — 공유 토큰이 들어가는 유일한 자리 */
export function gatewayConfig(row: GatewayRow): GatewayConnectionConfig {
  return { id: row.id, name: row.name, url: row.url, token: row.token, enabled: row.enabled };
}

/** 더한 차례(같은 시각이면 id — uuid v7 이라 만든 차례) */
export function listGatewayRows(db: DbOrTx, workspaceId: string): GatewayRow[] {
  return db
    .select()
    .from(gateways)
    .where(eq(gateways.workspaceId, workspaceId))
    .orderBy(asc(gateways.createdAt), asc(gateways.id))
    .all();
}

export function getGatewayRow(db: DbOrTx, workspaceId: string, id: string): GatewayRow | undefined {
  return db
    .select()
    .from(gateways)
    .where(and(eq(gateways.id, id), eq(gateways.workspaceId, workspaceId)))
    .get();
}

function requireGatewayRow(db: DbOrTx, workspaceId: string, id: string): GatewayRow {
  const row = getGatewayRow(db, workspaceId, id);
  if (!row) throw apiError("NOT_FOUND", "gateway not found");
  return row;
}

/** 이름은 워크스페이스 안에서 유일 — 유일 인덱스가 막기 전에 칸 오류로 돌려준다(웹 대화상자가 이름 칸에 띄운다) */
function assertNameFree(tx: DbOrTx, workspaceId: string, name: string, exceptId?: string): void {
  const taken = tx
    .select({ id: gateways.id })
    .from(gateways)
    .where(
      and(
        eq(gateways.workspaceId, workspaceId),
        eq(gateways.name, name),
        exceptId === undefined ? undefined : ne(gateways.id, exceptId),
      ),
    )
    .get();
  if (taken) throw apiError("CONFLICT", "gateway name is already used", { field: "name" });
}

export function createGateway(
  db: Db,
  workspaceId: string,
  body: CreateGatewayBody,
  now = new Date(),
): GatewayRow {
  return db.transaction((tx) => {
    assertNameFree(tx, workspaceId, body.name);
    return tx
      .insert(gateways)
      .values({
        id: uuidv7(),
        workspaceId,
        name: body.name,
        url: body.url,
        token: body.token,
        enabled: true,
        ownerUserId: null,
        lastVersion: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

/** 빈 토큰은 「바꾸지 않음」(수정 대화상자의 「바꾸려면 입력」 칸). 바뀐 것이 없으면 행을 쓰지 않는다(changed 거짓) */
export function updateGateway(
  db: Db,
  workspaceId: string,
  id: string,
  patch: UpdateGatewayBody,
  now = new Date(),
): { before: GatewayRow; row: GatewayRow; changed: boolean } {
  return db.transaction((tx) => {
    const current = requireGatewayRow(tx, workspaceId, id);
    const set: Partial<GatewayRow> = {};
    if (patch.name !== undefined && patch.name !== current.name) {
      assertNameFree(tx, workspaceId, patch.name, id);
      set.name = patch.name;
    }
    if (patch.url !== undefined && patch.url !== current.url) set.url = patch.url;
    if (patch.token !== undefined && patch.token !== "" && patch.token !== current.token)
      set.token = patch.token;
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) return { before: current, row: current, changed: false };
    const row = tx
      .update(gateways)
      .set({ ...set, updatedAt: now })
      .where(eq(gateways.id, id))
      .returning()
      .get();
    return { before: current, row, changed: true };
  });
}

/**
 * 한 트랜잭션(계획 판정 PG9) — 그 Gateway 에이전트의 연결을 비우고(에이전트·채널 멤버십·이력은 남는다, 스펙 결정 7) Gateway 행을
 * 지운다. 브리지 토큰은 FK cascade 로 함께 지워진다(폐기된 것도). 어댑터 연결은 부르는 쪽이 커밋 뒤에 `removeGateway` 로 끊는다
 */
export function deleteGateway(db: Db, workspaceId: string, id: string): DeleteGatewayResult {
  return db.transaction((tx) => {
    requireGatewayRow(tx, workspaceId, id);
    const deletedTokens =
      tx
        .select({ n: sql<number>`count(*)` })
        .from(bridgeTokens)
        .where(eq(bridgeTokens.gatewayId, id))
        .get()?.n ?? 0;
    const unboundAgents = tx
      .update(agents)
      .set({ gatewayId: null })
      .where(eq(agents.gatewayId, id))
      .run().changes;
    tx.delete(gateways).where(eq(gateways.id, id)).run();
    return { unboundAgents, deletedTokens };
  });
}

/**
 * 부팅 때 DB 의 Gateway 를 모두 어댑터에 넣는다(스펙 6.2) — 꺼진 것도 `enabled: false` 로 넣어 연결 페이지에 「꺼짐」으로 보이게 한다.
 * 한 Gateway 의 설정이 어댑터에 거절돼도(id 규칙) 나머지는 넣는다 — 부르는 쪽이 실패를 로그로 남긴다
 */
export function bootGateways(
  db: DbOrTx,
  workspaceId: string,
  host: Pick<OpenClawGateways, "upsertGateway">,
  onError: (gatewayId: string, err: unknown) => void,
): number {
  const rows = listGatewayRows(db, workspaceId);
  for (const row of rows) {
    try {
      host.upsertGateway(gatewayConfig(row));
    } catch (err) {
      onError(row.id, err);
    }
  }
  return rows.length;
}

/**
 * 그 Gateway 에서 마지막으로 본 버전(`last_version`, 멀티 Gateway 스펙 「gateways (새 표)」 절)을 version 으로 바꾼다 — 지운 Gateway 면 아무것도
 * 하지 않는다. 설정이 아니라 관측값이라 `updated_at` 은 건드리지 않는다
 */
export function setGatewayLastVersion(db: Db, workspaceId: string, id: string, version: string): void {
  db.update(gateways)
    .set({ lastVersion: version })
    .where(and(eq(gateways.workspaceId, workspaceId), eq(gateways.id, id)))
    .run();
}
