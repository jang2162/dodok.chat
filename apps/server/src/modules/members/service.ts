import { MemberRow, roleAtLeast, TeamRole } from "@dodok/shared";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Auth } from "../../auth";
import { assertRole, membershipOf, roleOf } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { channelMembers, invites, memberships, pushSubscriptions, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { listMembers as listChannelMembers } from "../channels/service";
import type { OpsService } from "../ops/service";

// 멤버 관리(팀 스펙 「멤버 관리」 절). 권한은 여기서도 membership 을 다시 읽어 본다 — 라우트 가드는 최소 역할만 거른다

/** 워크스페이스 멤버 표 — membership 이 있는 사람만, 비활성 멤버도 deactivatedAt 과 함께. 모르는 역할(guest 등)은 roleOf 처럼 멤버로 치지 않는다. 가입 순 */
export function listMembers(db: DbOrTx, workspaceId: string): MemberRow[] {
  return db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      email: users.email,
      createdAt: users.createdAt,
      role: memberships.role,
      deactivatedAt: memberships.deactivatedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.role, TeamRole.options)))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all()
    .map((row) =>
      parseStored(
        MemberRow,
        {
          id: row.id,
          handle: row.handle,
          displayName: row.displayName,
          role: row.role,
          deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
          email: row.email ?? undefined,
          avatarUrl: row.avatarUrl ?? undefined,
          createdAt: row.createdAt.toISOString(),
        },
        "member",
      ),
    );
}

/**
 * owner 만. owner 를 대상으로 하면(owner 자신 포함) 403, membership 이 없거나 비활성이면 404.
 * admin → member 면 그 사람이 발급한 쓰이지 않은 초대·재설정 링크를 같은 트랜잭션에서 폐기한다 — 발급 권한을 잃었다.
 * member → admin 이면 그 사람을 겨눈 owner 아닌 사람이 발급한 쓰이지 않은 재설정 링크를 폐기한다 — 조회·수락이 지금 역할로
 * 막아도(resetLinkUsable) 다시 member 로 내려가면 되살아나지 않게. owner 가 낸 링크는 admin 에게도 유효라 남긴다
 */
export function changeRole(
  db: Db,
  workspaceId: string,
  actorId: string,
  userId: string,
  role: "admin" | "member",
): MemberRow {
  return db.transaction((tx) => {
    assertRole(tx, workspaceId, actorId, "owner");
    const current = roleOf(tx, workspaceId, userId);
    if (!current) throw apiError("NOT_FOUND", "member not found");
    if (current === "owner") throw apiError("FORBIDDEN", "owner 의 역할은 바꿀 수 없다");
    tx.update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .run();
    if (current === "admin" && role === "member") {
      tx.update(invites)
        .set({ revokedAt: new Date() })
        .where(and(eq(invites.createdBy, userId), isNull(invites.usedBy), isNull(invites.revokedAt)))
        .run();
    }
    if (current === "member" && role === "admin") {
      const ids = tx
        .select({ id: invites.id, createdBy: invites.createdBy })
        .from(invites)
        .where(
          and(
            eq(invites.workspaceId, workspaceId),
            eq(invites.kind, "reset"),
            eq(invites.targetUserId, userId),
            isNull(invites.usedBy),
            isNull(invites.revokedAt),
          ),
        )
        .all()
        .filter((r) => roleOf(tx, workspaceId, r.createdBy) !== "owner")
        .map((r) => r.id);
      if (ids.length > 0)
        tx.update(invites).set({ revokedAt: new Date() }).where(inArray(invites.id, ids)).run();
    }
    const row = listMembers(tx, workspaceId).find((m) => m.id === userId);
    if (!row) throw apiError("NOT_FOUND", "member not found");
    return row;
  });
}

export type MemberStateDeps = {
  db: Db;
  auth: Auth;
  bus: ServerBus;
  workspaceId: string;
  ops: Pick<OpsService, "record">;
  logger: Logger;
  /** 그 사용자의 열린 wire 소켓을 서버가 끊는다(realtime/socket.ts disconnectUser) */
  disconnectUser(userId: string): void;
};

/**
 * 비활성화(채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절). admin 은 member 만, owner 는 owner 를 뺀 모두. membership 이 없으면 404,
 * 이미 비활성이면 쓰기 없이 세션 지우기만 다시 한다(멱등 — 앞선 호출의 세션 지우기가 실패했으면 이어진다).
 * 한 트랜잭션으로 deactivated_at·푸시 구독·그 사람이 발급했거나 그 사람을 겨눈 쓰이지 않은 링크 폐기를 쓰고, 같은 동기 구간에서 열린 소켓을
 * 끊는다 — 그 순간부터 roleOf 가 undefined 라 REST·핸드셰이크·connection 이 모두 막는다. 그 뒤 Better Auth 세션을 지운다(사용자·계정은
 * 남긴다 — 다시 활성화하면 예전 비밀번호로 들어온다). 세션 지우기가 실패하면 운영 사건을 남기고 500 — 남은 세션은 비활성이라 쓸 수 없고,
 * 다시 부르거나 다시 활성화하면 지운다. 채널 참여 행은 남기고 읽을 때 거른다(channels/service.ts listMembers). people.changed 는 호출자(라우트)가 낸다
 */
export async function deactivateMember(
  deps: MemberStateDeps,
  actorId: string,
  userId: string,
): Promise<void> {
  const { db, workspaceId } = deps;
  const now = new Date();
  const changed = db.transaction((tx) => {
    const target = membershipOf(tx, workspaceId, userId);
    assertCanManage(roleOf(tx, workspaceId, actorId), target?.role);
    if (!target || target.deactivatedAt !== null) return false;
    tx.update(memberships)
      .set({ deactivatedAt: now })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .run();
    tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).run();
    tx.update(invites)
      .set({ revokedAt: now })
      .where(
        and(
          or(and(eq(invites.kind, "reset"), eq(invites.targetUserId, userId)), eq(invites.createdBy, userId)),
          isNull(invites.usedBy),
          isNull(invites.revokedAt),
        ),
      )
      .run();
    return true;
  });
  // 쓰기와 같은 동기 구간에서 끊는다 — 핸드셰이크를 지나던 소켓은 connection 에서 membership 을 다시 본다(socket.ts)
  deps.disconnectUser(userId);
  try {
    await (await deps.auth.$context).internalAdapter.deleteUserSessions(userId);
  } catch (err) {
    deps.ops.record({
      kind: "member_deactivate_failed",
      key: `member:${userId}`,
      severity: "error",
      detail: { userId },
    });
    const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
    // 오류 객체를 통째로 싣지 않는다 — 드라이버 문구에 무엇이 실리는지 보증할 수 없다(accept.ts internal 과 같은 까닭)
    deps.logger.error(
      {
        userId,
        errName: err instanceof Error ? err.name : typeof err,
        code: (err as { code?: unknown } | undefined)?.code ?? cause?.code,
      },
      "member deactivate failed",
    );
    throw apiError("INTERNAL", "요청을 마치지 못했다");
  }
  if (changed) emitMemberChannels(deps, userId);
}

/**
 * 다시 활성화. 권한은 deactivateMember 와 같다. 활성이면 쓰기 없이 200(멱등). 남은 세션을 먼저 지운다 — 비활성화 때 세션 지우기가
 * 실패했어도 옛 세션이 되살아나지 않게. 역할·채널 참여는 비활성화 전 그대로, 비활성 중 폐기된 링크는 폐기된 채다
 */
export async function reactivateMember(
  deps: MemberStateDeps,
  actorId: string,
  userId: string,
): Promise<void> {
  const { db, workspaceId } = deps;
  const target = membershipOf(db, workspaceId, userId);
  assertCanManage(roleOf(db, workspaceId, actorId), target?.role);
  if (!target || target.deactivatedAt === null) return;
  await (await deps.auth.$context).internalAdapter.deleteUserSessions(userId);
  const changed = db.transaction((tx) => {
    // await 사이 역할이 바뀌었거나 같은 요청이 먼저 끝났을 수 있다 — 다시 본다
    const current = membershipOf(tx, workspaceId, userId);
    assertCanManage(roleOf(tx, workspaceId, actorId), current?.role);
    if (!current || current.deactivatedAt === null) return false;
    tx.update(memberships)
      .set({ deactivatedAt: null })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .run();
    return true;
  });
  if (changed) emitMemberChannels(deps, userId);
}

/** 그 사람이 참여한 채널마다 channel.member.changed — 비활성 멤버는 listMembers 가 거르므로 비활성화·다시 활성화 모두 목록이 바뀐다 */
function emitMemberChannels(deps: Pick<MemberStateDeps, "db" | "bus">, userId: string): void {
  const rows = deps.db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.memberType, "user"), eq(channelMembers.memberId, userId)))
    .all();
  for (const { channelId } of rows) {
    deps.bus.emit("channel.member.changed", { channelId, members: listChannelMembers(deps.db, channelId) });
  }
}

/** 비활성화·다시 활성화 권한 — owner 는 대상이 될 수 없고, admin 대상은 owner 만, member 대상은 admin 이상 */
function assertCanManage(actor: TeamRole | undefined, target: TeamRole | undefined): void {
  if (!target) throw apiError("NOT_FOUND", "member not found");
  if (target === "owner") throw apiError("FORBIDDEN", "owner 는 비활성화할 수 없다");
  const min: TeamRole = target === "admin" ? "owner" : "admin";
  if (!roleAtLeast(actor, min)) {
    throw apiError(
      "FORBIDDEN",
      min === "owner" ? "admin 은 owner 만 비활성화할 수 있다" : "admin 이상만 비활성화할 수 있다",
    );
  }
}
