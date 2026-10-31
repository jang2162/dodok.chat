/**
 * 초대·재설정 링크 저장소(팀 스펙 3.1·3.2). 유효 = used_at·revoked_at 이 비고 expires_at > now.
 * 무효의 까닭(쓰임·만료·폐기·없음)은 밖으로 가르지 않는다 — 부르는 쪽은 모두 404 로 낸다.
 */
import type { Invite, TeamRole } from "@dodok/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { roleOf } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { invites } from "../../db/schema.sqlite";
import { hashToken, newToken, sameHash } from "./tokens";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

export type InviteRow = typeof invites.$inferSelect;

const valid = (now: Date) =>
  and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));

export function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.role ? { role: row.role } : {}),
    ...(row.targetUserId ? { targetUserId: row.targetUserId } : {}),
    prefix: row.prefix,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export function issueInvite(
  db: Db,
  input: { workspaceId: string; role: "admin" | "member"; createdBy: string; now: Date },
): { invite: Invite; token: string } {
  const { token, hash, prefix } = newToken("invite");
  const row: InviteRow = {
    id: uuidv7(),
    workspaceId: input.workspaceId,
    kind: "invite",
    role: input.role,
    targetUserId: null,
    tokenHash: hash,
    prefix,
    createdBy: input.createdBy,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    usedAt: null,
    usedBy: null,
    revokedAt: null,
  };
  db.insert(invites).values(row).run();
  return { invite: toInvite(row), token };
}

/**
 * 재설정 링크 규칙(팀 스펙 3.2) — owner 계정은 받지 않는다(로컬 토큰이 비밀번호). owner 는 그 밖 누구에게나, admin 은 member 에게만.
 * 발급(POST /members/:userId/reset-link)과 조회·수락(resetLinkUsable)이 이 함수 하나로 본다 — 발급 뒤 대상이 admin 으로 오르면
 * admin 이 낸 링크는 무효다
 */
export function canIssueResetLink(issuer: TeamRole | undefined, target: TeamRole | undefined): boolean {
  if (!target || target === "owner") return false;
  return issuer === "owner" || (issuer === "admin" && target === "member");
}

/** 조회·수락 때 — 발급자와 대상의 **지금** 역할로 canIssueResetLink 를 다시 본다. 발급자·대상이 비활성이면 false(roleOf) */
export function resetLinkUsable(db: DbOrTx, workspaceId: string, row: InviteRow): boolean {
  if (row.kind !== "reset" || !row.targetUserId) return false;
  return canIssueResetLink(roleOf(db, workspaceId, row.createdBy), roleOf(db, workspaceId, row.targetUserId));
}

/** 대상의 앞선(아직 유효한) 재설정 링크는 같은 트랜잭션에서 폐기한다 — 한 사용자에게 살아 있는 링크는 하나 */
export function issueResetLink(
  db: Db,
  input: { workspaceId: string; targetUserId: string; createdBy: string; now: Date },
): { invite: Invite; token: string } {
  const { token, hash, prefix } = newToken("reset");
  const row: InviteRow = {
    id: uuidv7(),
    workspaceId: input.workspaceId,
    kind: "reset",
    role: null,
    targetUserId: input.targetUserId,
    tokenHash: hash,
    prefix,
    createdBy: input.createdBy,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + RESET_TTL_MS),
    usedAt: null,
    usedBy: null,
    revokedAt: null,
  };
  db.transaction((tx) => {
    revokePendingResetLinks(tx, input);
    tx.insert(invites).values(row).run();
  });
  return { invite: toInvite(row), token };
}

/**
 * 대상의 쓰이지 않은(폐기도 안 된) 재설정 링크를 모두 폐기한다 — 새 링크 발급과 본인 비밀번호 변경(POST /me/password)이 부른다.
 * 본인이 비밀번호를 바꾼 뒤에도 관리자가 앞서 낸 링크가 살아 있으면 그 링크로 다시 바꿀 수 있다
 */
export function revokePendingResetLinks(
  db: DbOrTx,
  input: { workspaceId: string; targetUserId: string; now: Date },
): void {
  db.update(invites)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(invites.workspaceId, input.workspaceId),
        eq(invites.kind, "reset"),
        eq(invites.targetUserId, input.targetUserId),
        isNull(invites.usedAt),
        isNull(invites.revokedAt),
      ),
    )
    .run();
}

/** 대기 중인 초대(kind invite)만 — 재설정 링크는 멤버 줄의 일이라 싣지 않는다 */
export function listPendingInvites(db: DbOrTx, workspaceId: string, now: Date): Invite[] {
  return db
    .select()
    .from(invites)
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.kind, "invite"), valid(now)))
    .orderBy(desc(invites.createdAt), desc(invites.id))
    .all()
    .map(toInvite);
}

/** 대기 중인 초대 하나(폐기 전 역할 검사용) */
export function getPendingInvite(db: DbOrTx, workspaceId: string, id: string, now: Date): Invite | undefined {
  const row = db
    .select()
    .from(invites)
    .where(
      and(eq(invites.id, id), eq(invites.workspaceId, workspaceId), eq(invites.kind, "invite"), valid(now)),
    )
    .get();
  return row ? toInvite(row) : undefined;
}

/** 유효한 초대를 폐기한다. 이미 쓰였거나 만료·폐기됐으면 undefined */
export function revokeInvite(db: Db, workspaceId: string, id: string, now: Date): Invite | undefined {
  const row = db
    .update(invites)
    .set({ revokedAt: now })
    .where(
      and(eq(invites.id, id), eq(invites.workspaceId, workspaceId), eq(invites.kind, "invite"), valid(now)),
    )
    .returning()
    .get();
  return row ? toInvite(row) : undefined;
}

/** 유효하면 행, 아니면 undefined(까닭 구분 없음) */
export function findValidInvite(db: DbOrTx, token: string, now: Date): InviteRow | undefined {
  if (typeof token !== "string" || token === "") return undefined;
  const hash = hashToken(token);
  const row = db
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, hash), valid(now)))
    .get();
  return row && sameHash(row.tokenHash, hash) ? row : undefined;
}

/**
 * used_at IS NULL·revoked_at IS NULL·expires_at > now 인 행만 used_at 을 채운다 — 바뀐 행 수 1 이면 true.
 * 같은 링크의 동시 제출은 이 UPDATE 하나가 가른다(Review Focus 1)
 */
export function claimInvite(db: DbOrTx, id: string, now: Date): boolean {
  return (
    db
      .update(invites)
      .set({ usedAt: now })
      .where(and(eq(invites.id, id), valid(now)))
      .run().changes === 1
  );
}

export function unclaimInvite(db: DbOrTx, id: string): void {
  db.update(invites).set({ usedAt: null, usedBy: null }).where(eq(invites.id, id)).run();
}
