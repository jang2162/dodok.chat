/**
 * 초대 수락·재설정 수락(팀 스펙 3.3). 가입은 공개 경로가 아니라 Better Auth 내부 어댑터로 한다 — bootstrapOwner 와 같은 길.
 * SQLite 동기 드라이버라 Better Auth 호출과 우리 행을 한 트랜잭션으로 묶을 수 없다 — 초대를 먼저 원자적으로 잡고,
 * 뒤가 실패하면 만든 Better Auth 사용자를 지우고 초대를 되돌린다. 그 사이에서 프로세스가 죽어 남은 고아 Better Auth 사용자는
 * 같은 이메일의 다음 수락이 지운다(clearOrphanAndAssertEmailFree).
 */
import type { AcceptInviteBody, ResetPasswordBody } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { type Auth, OWNER_EMAIL } from "../../auth";
import type { Db, DbOrTx } from "../../db/client";
import { invites, memberships, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { OpsService } from "../ops/service";
import { assertHandleFree } from "./handles";
import { claimInvite, findValidInvite, type InviteRow, resetLinkUsable, unclaimInvite } from "./invites";

export type AcceptDeps = {
  db: Db;
  auth: Auth;
  workspaceId: string;
  ops: Pick<OpsService, "record">;
  logger: Logger;
  now: () => Date;
};

/** 무효의 까닭은 가르지 않는다 — 쓰임·만료·폐기·없음·종류 다름 모두 이 한 문구 */
export const inviteNotFound = () => apiError("NOT_FOUND", "초대가 만료됐거나 이미 쓰였습니다");

/**
 * users_ws_email 유일 인덱스는 대소문자를 가른다 — 넣기·찾기 전에 모두 이것을 지난다.
 * Better Auth 도 user.email 을 소문자로 넣으므로 두 테이블이 같은 값을 갖는다
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

function emailTaken(db: DbOrTx, workspaceId: string, email: string): boolean {
  return !!db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.workspaceId, workspaceId), eq(users.email, email)))
    .get();
}

const emailConflict = () => apiError("CONFLICT", "이미 가입된 이메일입니다", { field: "email" });

/** Better Auth 의 이메일은 워크스페이스와 무관하게 유일하다 — 우리 users 에 없는 행(owner 부트스트랩 중간 등)도 본다 */
async function assertEmailFree(deps: AcceptDeps, email: string): Promise<void> {
  if (emailTaken(deps.db, deps.workspaceId, email)) throw emailConflict();
  const ctx = await deps.auth.$context;
  if (await ctx.internalAdapter.findUserByEmail(email)) throw emailConflict();
}

/**
 * 이 프로세스에서 수락이 진행 중인 이메일(DB 연결마다) — 그 수락이 만든 Better Auth 사용자는 우리 행을 넣기 전까지 고아처럼 보인다.
 * 진행 중인 수락이 없는데 users 행 없는 Better Auth 사용자가 있으면, 앞선 수락이 그 사이에서 죽은 것이다(단일 프로세스 서버)
 */
const acceptingEmails = new WeakMap<DbOrTx, Set<string>>();

function acceptingSet(db: DbOrTx): Set<string> {
  let set = acceptingEmails.get(db);
  if (!set) acceptingEmails.set(db, (set = new Set()));
  return set;
}

/**
 * assertEmailFree 와 같되, 같은 이메일의 고아 Better Auth 사용자 — 우리 users 행(어느 워크스페이스든 같은 id)이 없고 owner 이메일이
 * 아닌 것 — 는 그 세션·계정과 함께 지운다. 고아는 수락이 Better Auth 생성 뒤·우리 행 앞에서 죽은 자리라 membership 이 없어
 * 로그인해도 401 이고, 그대로 두면 그 이메일은 DB 를 손으로 고치기 전까지 가입할 수 없다. 진행 중인 수락의 사용자는 호출자가
 * acceptingSet 으로 먼저 막는다. owner 이메일은 다음 부팅의 bootstrapOwner 가 그 사용자로 users 행을 채우므로 지우지 않는다
 */
async function clearOrphanAndAssertEmailFree(deps: AcceptDeps, email: string): Promise<void> {
  if (emailTaken(deps.db, deps.workspaceId, email)) throw emailConflict();
  const adapter = (await deps.auth.$context).internalAdapter;
  const found = await adapter.findUserByEmail(email);
  if (!found) return;
  const orphanId = found.user.id;
  const ours = deps.db.select({ id: users.id }).from(users).where(eq(users.id, orphanId)).get();
  if (ours || email === OWNER_EMAIL) throw emailConflict();
  await adapter.deleteUserSessions(orphanId);
  await adapter.deleteAccounts(orphanId);
  await adapter.deleteUser(orphanId);
  deps.logger.warn({ userId: orphanId }, "orphan auth user removed before invite accept");
}

function validInvite(deps: AcceptDeps, token: string, kind: InviteRow["kind"], now: Date): InviteRow {
  const invite = findValidInvite(deps.db, token, now);
  if (!invite || invite.kind !== kind || invite.workspaceId !== deps.workspaceId) throw inviteNotFound();
  return invite;
}

/**
 * 오류 객체를 통째로 로그·응답에 싣지 않고 이름·코드만 남긴다(스펙 7장 — 로그에 이메일 없음). 이 자리는 Better Auth 어댑터와
 * 드라이버 오류를 함께 받는데 그 문구에 무엇이 실리는지 여기서 보증할 수 없다(better-sqlite3 SqliteError 는 파라미터를 싣지 않는다 —
 * members.accept.test 의 users 트리거 실패 테스트가 로그를 본다)
 */
function internal(deps: AcceptDeps, err: unknown, what: string, ids: Record<string, string>) {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  deps.logger.error(
    {
      ...ids,
      errName: err instanceof Error ? err.name : typeof err,
      code: (err as { code?: unknown } | undefined)?.code ?? cause?.code,
    },
    what,
  );
  return apiError("INTERNAL", "요청을 마치지 못했다");
}

export async function acceptInvite(
  deps: AcceptDeps,
  body: AcceptInviteBody,
): Promise<{ userId: string; sessionToken: string }> {
  const email = normalizeEmail(body.email);
  const invite = validInvite(deps, body.token, "invite", deps.now());
  // 같은 이메일의 다른 수락이 이 프로세스에서 진행 중이면 409 — 그쪽이 만든 Better Auth 사용자를 고아로 지우지 않게.
  // 표시는 첫 await 전에 건다(검사와 표시 사이에 다른 수락이 끼지 않는다). 이 요청의 초대는 잡기 전이라 소비되지 않는다
  const accepting = acceptingSet(deps.db);
  if (accepting.has(email)) throw emailConflict();
  accepting.add(email);
  try {
    return await acceptHoldingEmail(deps, body, email, invite);
  } finally {
    accepting.delete(email);
  }
}

async function acceptHoldingEmail(
  deps: AcceptDeps,
  body: AcceptInviteBody,
  email: string,
  invite: InviteRow,
): Promise<{ userId: string; sessionToken: string }> {
  const { db, workspaceId } = deps;
  const ctx = await deps.auth.$context;
  const adapter = ctx.internalAdapter;
  await clearOrphanAndAssertEmailFree(deps, email);
  const passwordHash = await ctx.password.hash(body.password);

  // 여기서 claim 까지는 await 가 없다 — 검사와 잡기 사이에 다른 가입이 끼지 않는다. 그 전의 await 사이에 낀 경합은
  // 아래 유일 인덱스가 막고 catch 의 재검사(assertHandleFree·assertEmailFree)가 409 로 바꾼다
  assertHandleFree(db, workspaceId, body.handle);
  if (emailTaken(db, workspaceId, email)) throw emailConflict();
  if (!claimInvite(db, invite.id, deps.now())) throw inviteNotFound();

  const userId = uuidv7();
  let created = false;
  try {
    await adapter.createUser(
      { id: userId, email, name: body.displayName, emailVerified: true },
      { method: "email-password" },
    );
    created = true;
    await adapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: passwordHash,
    });
    const now = deps.now();
    db.transaction((tx) => {
      tx.insert(users)
        .values({
          id: userId,
          workspaceId,
          handle: body.handle,
          displayName: body.displayName,
          email,
          authProvider: "local",
          createdAt: now,
        })
        .run();
      tx.insert(memberships)
        .values({ id: uuidv7(), workspaceId, userId, role: invite.role ?? "member" })
        .run();
      tx.update(invites).set({ usedBy: userId }).where(eq(invites.id, invite.id)).run();
    });
  } catch (err) {
    await undoAccept(deps, invite.id, created ? userId : undefined);
    // 검사 뒤 await 사이에 같은 핸들·이메일을 다른 가입이 먼저 넣었으면 유일 인덱스가 막은 것이다
    assertHandleFree(db, workspaceId, body.handle);
    await assertEmailFree(deps, email);
    throw internal(deps, err, "invite accept failed", { inviteId: invite.id });
  }
  const session = await adapter.createSession(userId);
  deps.logger.info({ userId, inviteId: invite.id, role: invite.role }, "invite accepted");
  return { userId, sessionToken: session.token };
}

/** 되돌리기도 실패하면 초대가 잡힌 채 남거나 Better Auth 사용자가 고아가 된다 — 사람이 봐야 하므로 운영 사건 */
async function undoAccept(
  deps: AcceptDeps,
  inviteId: string,
  createdUserId: string | undefined,
): Promise<void> {
  let failed: unknown;
  if (createdUserId) {
    try {
      await (await deps.auth.$context).internalAdapter.deleteUser(createdUserId);
    } catch (err) {
      failed = err;
    }
  }
  try {
    unclaimInvite(deps.db, inviteId);
  } catch (err) {
    failed ??= err;
  }
  if (failed === undefined) return;
  deps.ops.record({
    kind: "invite_accept_failed",
    key: "invite:accept",
    severity: "error",
    detail: { inviteId, ...(createdUserId ? { userId: createdUserId } : {}) },
  });
  throw internal(deps, failed, "invite accept rollback failed", { inviteId });
}

export type ResetDeps = AcceptDeps & {
  /** 그 사용자의 열린 wire 소켓을 서버가 끊는다(realtime/socket.ts disconnectUser) */
  disconnectUser(userId: string): void;
};

/**
 * 대상의 비밀번호를 바꾸고 그 사용자의 세션과 열린 wire 소켓을 모두 끊은 뒤 새 세션을 낸다. 지금 역할로 발급 규칙(canIssueResetLink)을
 * 다시 지나지 못하면 404(링크 미소비).
 * 소켓은 핸드셰이크에서만 세션을 본다 — 세션만 지우면 새어 나간 쪽의 열린 탭이 계속 말하고 받는다
 */
export async function resetPassword(
  deps: ResetDeps,
  body: ResetPasswordBody,
): Promise<{ userId: string; sessionToken: string }> {
  const invite = validInvite(deps, body.token, "reset", deps.now());
  const userId = invite.targetUserId;
  // 발급 뒤 발급자·대상의 역할이 바뀌었으면(대상이 owner·admin 으로 오름, 대상이 나감) 발급 규칙으로 다시 본다 — 링크는 소비하지 않는다
  if (!userId || !resetLinkUsable(deps.db, deps.workspaceId, invite)) throw inviteNotFound();
  const ctx = await deps.auth.$context;
  const adapter = ctx.internalAdapter;
  const passwordHash = await ctx.password.hash(body.password);
  if (!claimInvite(deps.db, invite.id, deps.now())) throw inviteNotFound();
  try {
    if (await adapter.findCredentialAccount(userId)) await adapter.updatePassword(userId, passwordHash);
    else
      await adapter.linkAccount({
        userId,
        providerId: "credential",
        accountId: userId,
        password: passwordHash,
      });
    await adapter.deleteUserSessions(userId);
    // 지운 바로 뒤 같은 동기 구간에서 — 아래가 실패해도 세션은 이미 없다. 핸드셰이크를 지나던 소켓은 connection 에서 세션을 다시 본다
    deps.disconnectUser(userId);
    deps.db.update(invites).set({ usedBy: userId }).where(eq(invites.id, invite.id)).run();
  } catch (err) {
    try {
      unclaimInvite(deps.db, invite.id);
    } catch {
      // 링크가 잡힌 채 남으면 발급자가 새 링크를 내면 된다 — 원래 오류를 낸다
    }
    throw internal(deps, err, "password reset failed", { inviteId: invite.id, userId });
  }
  const session = await adapter.createSession(userId);
  deps.logger.info({ userId, inviteId: invite.id }, "password reset");
  return { userId, sessionToken: session.token };
}
