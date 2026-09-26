import { MemberRow, roleAtLeast, TeamRole } from "@dodok/shared";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Auth } from "../../auth";
import { assertRole, roleOf } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { channelMembers, invites, memberships, pushSubscriptions, users } from "../../db/schema.sqlite";
import { apiError, HttpError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { listMembers as listChannelMembers } from "../channels/service";
import type { OpsService } from "../ops/service";
import { LEFT_HANDLE_PREFIX } from "./handles";

// 멤버 관리(팀 스펙 「멤버 관리」 절). 권한은 여기서도 membership 을 다시 읽어 본다 — 라우트 가드는 최소 역할만 거른다

/** 워크스페이스 멤버 표 — membership 이 있는 사람만(나간 멤버는 없다). 모르는 역할(guest 등)은 roleOf 처럼 멤버로 치지 않는다. 가입 순 */
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
          email: row.email ?? undefined,
          avatarUrl: row.avatarUrl ?? undefined,
          createdAt: row.createdAt.toISOString(),
        },
        "member",
      ),
    );
}

/**
 * owner 만. owner 를 대상으로 하면(owner 자신 포함) 403, membership 이 없으면 404.
 * admin → member 면 그 사람이 발급한 쓰이지 않은 초대·재설정 링크를 같은 트랜잭션에서 폐기한다 — 발급 권한을 잃었다
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
    const row = listMembers(tx, workspaceId).find((m) => m.id === userId);
    if (!row) throw apiError("NOT_FOUND", "member not found");
    return row;
  });
}

export type RemoveMemberDeps = {
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
 * 내보내기. admin 은 member 만, owner 는 owner 를 뺀 모두. membership 이 없으면(이미 나감) 404.
 * Better Auth 사용자·계정·세션을 먼저 지운다 — 같은 이메일로 다시 들일 수 있어야 하고(Better Auth 의 이메일은 유일),
 * 우리 쪽 쓰기가 실패해도 다시 부르면 이어진다. 그다음 한 트랜잭션으로 membership·채널 참여·푸시 구독을 지우고
 * 그 사람을 겨눈 재설정 링크와 그 사람이 발급한 쓰이지 않은 초대·재설정 링크를 폐기하고(원문을 쥔 채 나간 사람이 다시
 * 들어오거나 남의 비밀번호를 바꾸지 못하게) users 행이 핸들·이메일을 놓아준다. 행과 메시지는 남는다(작성자 참조).
 * 그 트랜잭션이 실패하면 세션은 이미 지워졌으니 어느 갈래든 열린 소켓은 끊는다. 권한·없음 판정이면 그 오류를, 아니면 운영 사건을
 * 남긴 뒤 500 — membership 이 남아 있어 다시 부르면 이어진다. people.changed 는 호출자(라우트)가 낸다
 */
export async function removeMember(deps: RemoveMemberDeps, actorId: string, userId: string): Promise<void> {
  const { db, workspaceId } = deps;
  const target = roleOf(db, workspaceId, userId);
  if (!target) throw apiError("NOT_FOUND", "member not found");
  assertCanRemove(roleOf(db, workspaceId, actorId), target);

  const adapter = (await deps.auth.$context).internalAdapter;
  await adapter.deleteUserSessions(userId);
  await adapter.deleteAccounts(userId);
  await adapter.deleteUser(userId);

  const now = new Date();
  let channelIds: string[];
  try {
    channelIds = leaveInTransaction(deps, actorId, userId, now);
  } catch (err) {
    // 세션은 이미 지웠다 — 재검사가 권한·없음으로 떨어져도(await 사이 행위자 강등 등) 열린 소켓은 끊는다
    deps.disconnectUser(userId);
    if (err instanceof HttpError && err.body.code !== "INTERNAL") throw err;
    deps.ops.record({
      kind: "member_remove_failed",
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
      "member remove failed",
    );
    throw apiError("INTERNAL", "요청을 마치지 못했다");
  }
  // 트랜잭션과 같은 동기 구간에서 끊는다 — 핸드셰이크를 지나던 소켓은 connection 에서 membership 을 다시 본다(socket.ts)
  deps.disconnectUser(userId);
  for (const channelId of channelIds) {
    deps.bus.emit("channel.member.changed", { channelId, members: listChannelMembers(db, channelId) });
  }
}

function leaveInTransaction(deps: RemoveMemberDeps, actorId: string, userId: string, now: Date): string[] {
  const { db, workspaceId } = deps;
  return db.transaction((tx) => {
    // await 사이 역할이 바뀌었거나 같은 요청이 먼저 끝났을 수 있다 — 다시 본다. 두 번 돌면 left_handle 이 left-… 로 덮인다
    assertCanRemove(roleOf(tx, workspaceId, actorId), roleOf(tx, workspaceId, userId));
    tx.delete(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .run();
    const left = tx
      .delete(channelMembers)
      .where(and(eq(channelMembers.memberType, "user"), eq(channelMembers.memberId, userId)))
      .returning({ channelId: channelMembers.channelId })
      .all();
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
    const row = tx.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).get();
    if (!row) throw apiError("NOT_FOUND", "member not found");
    tx.update(users)
      .set({ leftHandle: row.handle, handle: leftHandleOf(userId), email: null })
      .where(eq(users.id, userId))
      .run();
    return [...new Set(left.map((r) => r.channelId))];
  });
}

/**
 * 나간 멤버의 핸들 — `left-` + id(하이픈 뺀 32 hex)의 뒤 27자 = Handle 상한 32자. 앞 8자는 v7 의 시각이라 약 65초 안에
 * 만든 사용자끼리 같아 users_ws_handle 유일 인덱스에 걸린다 — 시각 앞 5자만 버리고 seq·rand_a·rand_b 를 모두 싣는다.
 * 결정적이라 한 번 겹치면 다시 불러도 겹치므로 엔트로피를 최대로 둔다. `left-` 는 가입·등록에 예약돼 있다(handles.ts)
 */
export function leftHandleOf(userId: string): string {
  return `${LEFT_HANDLE_PREFIX}${userId.replace(/-/g, "").slice(-27)}`;
}

function assertCanRemove(actor: TeamRole | undefined, target: TeamRole | undefined): void {
  if (!target) throw apiError("NOT_FOUND", "member not found");
  if (target === "owner") throw apiError("FORBIDDEN", "owner 는 내보낼 수 없다");
  const min: TeamRole = target === "admin" ? "owner" : "admin";
  if (!roleAtLeast(actor, min)) {
    throw apiError(
      "FORBIDDEN",
      min === "owner" ? "admin 은 owner 만 내보낼 수 있다" : "admin 이상만 내보낼 수 있다",
    );
  }
}
