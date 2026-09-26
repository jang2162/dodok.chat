import {
  Approval,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalReason,
  type ApprovalSeverity,
  type ApprovalStatus,
} from "@dodok/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../db/client";
import { approvals } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";

type ApprovalRow = typeof approvals.$inferSelect;
type ApprovalInsert = typeof approvals.$inferInsert;

/**
 * 어댑터가 정규화한 승인 한 건을 행으로 옮긴 값(설계 4.2).
 *
 * `undefined` 는 **「모른다」**지 「지워라」가 아니다 — 같은 승인이 두 모양으로 오고(`plugin.approval.*` 에는
 * `toolCallId` 가 있고 `session.approval` 에는 없다) 해결 프레임에는 `createdAt`·`expiresAt` 이 아예 없다(스파이크 3.4).
 * 그래서 갱신은 **병합**이다: 값이 온 열만 덮는다.
 */
export type ApprovalRowInput = {
  providerApprovalId: string;
  kind: ApprovalKind;
  /** 새 행에만 쓴다 — 세션 키에서 푼 값이라 승인이 사는 동안 바뀌지 않는다 */
  channelId: string;
  agentId: string;
  runId?: string | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  pluginId?: string | undefined;
  title: string;
  description?: string | undefined;
  detail?: string | undefined;
  severity: ApprovalSeverity;
  allowedDecisions: ApprovalDecision[];
  urlPath?: string | undefined;
  status: ApprovalStatus;
  decision?: ApprovalDecision | undefined;
  reason?: ApprovalReason | undefined;
  decidedAt?: Date | undefined;
  /** 새 행에만 쓴다 — 행의 나이는 움직이지 않는다 */
  createdAt: Date;
  /** 카운트다운의 근거. 해결 프레임에는 없다 — 없으면 있는 행의 값을 지키고, 새 행이면 createdAt 으로 채운다 */
  expiresAt?: Date | undefined;
};

export type ApprovalPatch = {
  status: ApprovalStatus;
  decision?: ApprovalDecision | undefined;
  reason?: ApprovalReason | undefined;
  /** 우리 사용자가 해결했을 때만. 다른 디바이스(TUI·다른 탭)가 해결하면 비운다 */
  decidedBy?: string | undefined;
  decidedAt: Date;
};

export function rowToApproval(row: ApprovalRow): Approval {
  return parseStored(
    Approval,
    {
      id: row.id,
      providerApprovalId: row.providerApprovalId,
      kind: row.kind,
      channelId: row.channelId,
      agentId: row.agentId,
      runId: row.runId ?? undefined,
      toolCallId: row.toolCallId ?? undefined,
      toolName: row.toolName ?? undefined,
      pluginId: row.pluginId ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      detail: row.detail ?? undefined,
      severity: row.severity,
      allowedDecisions: row.allowedDecisions,
      urlPath: row.urlPath ?? undefined,
      status: row.status,
      decision: row.decision ?? undefined,
      reason: row.reason ?? undefined,
      decidedBy: row.decidedBy ?? undefined,
      decidedAt: row.decidedAt?.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    },
    "approval",
  );
}

/**
 * `providerApprovalId` 유일 인덱스로 upsert 한다(설계 4.2 ④).
 *
 * `changed` 는 「새로 알게 된 사실」이다 — 새 행이거나 저장된 열이 실제로 바뀌었을 때만 참이다.
 * `created` 는 그중 **이 승인을 처음 본 것**인지다 — 어댑터가 같은 승인의 두 번째 프레임을 병합해 다시 주므로
 * (`plugin.approval.requested` 의 `toolCallId` + `session.approval` 의 `urlPath`) 값만 늦게 차는 갱신과 갈라야 한다.
 * **종료된 행은 더 바뀌지 않는다**: 늦게 온 `pending` 도, 다른 결말도 여기서 멈춘다(설계 4.4 「먼저 온 쪽이 이긴다」).
 * 딱 하나 예외가 `filled` 다 — **같은 결말**을 말하는 확정 짝의 뒤엣것이 비어 있는 `decision`·`reason` 을 채운다.
 * 실물은 확정도 짝으로 오고(`session.approval(terminal)` + `*.approval.resolved`) 만료의 `decision` 은 뒤엣것에만
 * 실려 온다(스파이크 5.2) — 이 예외가 없으면 같은 만료가 프레임 도착 순서에 따라 다른 행으로 남는다(p2-t6 리뷰 F2).
 * `filled` 면 타임라인에 `APPROVAL_RESOLVED` 를 또 쌓지 않는다 — 결말은 이미 알렸고 값만 늦게 찼다.
 */
export function upsertApproval(
  db: DbOrTx,
  input: ApprovalRowInput,
): { approval: Approval; changed: boolean; created: boolean; filled: boolean } {
  const existing = db
    .select()
    .from(approvals)
    .where(eq(approvals.providerApprovalId, input.providerApprovalId))
    .get();

  if (!existing) {
    // 삽입과 계약 확인을 한 트랜잭션에 묶는다 — 읽을 수 없는 행을 남기면 그 채널의 pendingApprovals 가 통째로 막힌다
    return db.transaction((tx) => ({
      approval: rowToApproval(insertApproval(tx, input)),
      changed: true,
      created: true,
      filled: false,
    }));
  }

  const filled = existing.status !== "pending";
  const patch = filled ? fillOutcome(existing, input) : mergePatch(existing, input);
  if (Object.keys(patch).length === 0) {
    return { approval: rowToApproval(existing), changed: false, created: false, filled: false };
  }
  return db.transaction((tx) => {
    const row = tx.update(approvals).set(patch).where(eq(approvals.id, existing.id)).returning().get();
    if (!row) throw apiError("NOT_FOUND", "approval not found");
    return { approval: rowToApproval(row), changed: true, created: false, filled };
  });
}

/**
 * 종료된 행에 허락하는 유일한 갱신 — **같은 결말**을 말하는 프레임이 비어 있는 `decision`·`reason` 만 채운다.
 * 결말이 다르면(`expired` 행에 `allowed` 가 온다) 아무것도 하지 않는다. 이미 찬 값도 덮지 않는다(해결자 판단이 흔들리지 않게).
 */
function fillOutcome(existing: ApprovalRow, input: ApprovalRowInput): Partial<ApprovalInsert> {
  if (input.status !== existing.status) return {};
  const patch: Partial<ApprovalInsert> = {};
  if (existing.decision === null && input.decision !== undefined) patch.decision = input.decision;
  if (existing.reason === null && input.reason !== undefined) patch.reason = input.reason;
  return patch;
}

function insertApproval(db: DbOrTx, input: ApprovalRowInput): ApprovalRow {
  return db
    .insert(approvals)
    .values({
      id: uuidv7(),
      providerApprovalId: input.providerApprovalId,
      kind: input.kind,
      channelId: input.channelId,
      agentId: input.agentId,
      runId: input.runId ?? null,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName ?? null,
      pluginId: input.pluginId ?? null,
      title: input.title,
      description: input.description ?? null,
      detail: input.detail ?? null,
      severity: input.severity,
      allowedDecisions: input.allowedDecisions,
      urlPath: input.urlPath ?? null,
      status: input.status,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      decidedBy: null,
      decidedAt: input.decidedAt ?? null,
      expiresAt: input.expiresAt ?? input.createdAt,
      createdAt: input.createdAt,
    })
    .returning()
    .get();
}

/** 값이 온 열 중 저장된 것과 다른 것만. 빈 객체면 새 사실이 없다. */
function mergePatch(existing: ApprovalRow, input: ApprovalRowInput): Partial<ApprovalInsert> {
  const patch: Partial<ApprovalInsert> = {};
  const set = <K extends keyof ApprovalInsert>(key: K, value: ApprovalInsert[K] | undefined): void => {
    if (value === undefined) return;
    if (same(existing[key as keyof ApprovalRow], value)) return;
    patch[key] = value;
  };
  set("kind", input.kind);
  set("runId", input.runId);
  set("toolCallId", input.toolCallId);
  set("toolName", input.toolName);
  set("pluginId", input.pluginId);
  set("title", input.title);
  set("description", input.description);
  set("detail", input.detail);
  set("severity", input.severity);
  set("allowedDecisions", input.allowedDecisions);
  set("urlPath", input.urlPath);
  set("status", input.status);
  set("decision", input.decision);
  set("reason", input.reason);
  set("decidedAt", input.decidedAt);
  set("expiresAt", input.expiresAt);
  return patch;
}

function same(stored: unknown, next: unknown): boolean {
  if (stored instanceof Date && next instanceof Date) return stored.getTime() === next.getTime();
  if (Array.isArray(stored) && Array.isArray(next)) return JSON.stringify(stored) === JSON.stringify(next);
  return stored === next;
}

export function getApproval(db: DbOrTx, id: string): Approval | undefined {
  const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
  return row ? rowToApproval(row) : undefined;
}

export function getApprovalByProviderId(db: DbOrTx, providerApprovalId: string): Approval | undefined {
  const row = db.select().from(approvals).where(eq(approvals.providerApprovalId, providerApprovalId)).get();
  return row ? rowToApproval(row) : undefined;
}

/** 그 채널의 아직 살아 있는 승인 — 만료 시각이 지난 것은 빼고 준다(화면이 죽은 카드를 그리지 않게) */
export function listPendingApprovals(db: DbOrTx, channelId: string, now: Date): Approval[] {
  return db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.channelId, channelId), eq(approvals.status, "pending"), gt(approvals.expiresAt, now)),
    )
    .orderBy(asc(approvals.createdAt), asc(approvals.id))
    .all()
    .map(rowToApproval);
}

/** 그 런의 승인 전부(오래된 것부터) — 활동 타임라인 */
export function listRunApprovals(db: DbOrTx, runId: string): Approval[] {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.runId, runId))
    .orderBy(asc(approvals.createdAt), asc(approvals.id))
    .all()
    .map(rowToApproval);
}

/** 만료 시각과 무관하게 아직 pending 인 것 — 런이 끝날 때 닫을 대상이라 시각으로 거르지 않는다 */
export function listPendingApprovalsByRun(db: DbOrTx, runId: string): Approval[] {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
    .orderBy(asc(approvals.createdAt), asc(approvals.id))
    .all()
    .map(rowToApproval);
}

/**
 * `decided_by` 가 비어 있을 때만 채운다(원자적 `WHERE decided_by IS NULL`) — Gateway 해결 이벤트가 RPC 응답보다
 * 먼저 결말을 적어도(설계 4.4 「먼저 온 쪽이 이긴다」) `approval.resolve` 를 부른 사용자가 감사 기록에 남게 한다.
 * 이미 다른 사용자가 먼저 채웠으면(두 사람이 거의 동시에 눌렀을 때) 덮지 않고 그 행 그대로 돌려준다.
 */
export function claimDecidedBy(db: DbOrTx, id: string, userId: string): Approval | undefined {
  const claimed = db
    .update(approvals)
    .set({ decidedBy: userId })
    .where(and(eq(approvals.id, id), isNull(approvals.decidedBy)))
    .returning()
    .get();
  if (claimed) return rowToApproval(claimed);
  const existing = db.select().from(approvals).where(eq(approvals.id, id)).get();
  return existing ? rowToApproval(existing) : undefined;
}

export function markApproval(db: DbOrTx, id: string, patch: ApprovalPatch): Approval {
  const row = db
    .update(approvals)
    .set({
      status: patch.status,
      decision: patch.decision ?? null,
      reason: patch.reason ?? null,
      decidedBy: patch.decidedBy ?? null,
      decidedAt: patch.decidedAt,
    })
    .where(eq(approvals.id, id))
    .returning()
    .get();
  if (!row) throw apiError("NOT_FOUND", "approval not found");
  return rowToApproval(row);
}
