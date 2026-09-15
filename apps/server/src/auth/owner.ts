import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client";
import { memberships, users } from "../db/schema.sqlite";
import { type Auth, OWNER_EMAIL } from "./index";

/**
 * owner 를 보장한다(부팅 때 매번). 가입이 막혀 있어 Better Auth 내부 어댑터로 만든다.
 * SQLite 동기 드라이버라 Better Auth 호출과 한 트랜잭션으로 묶을 수 없다 — 대신 단계마다 「없으면 만든다」로
 * 중간에 끊긴 부팅도 다음 부팅이 마저 채운다.
 * 토큰(= 비밀번호)이 바뀌었으면 비밀번호를 갱신하고 기존 세션을 모두 끊는다.
 */
export async function bootstrapOwner(
  db: Db,
  auth: Auth,
  config: { LOCAL_AUTH_TOKEN: string; OWNER_HANDLE: string },
  workspaceId: string,
): Promise<{ userId: string }> {
  const ctx = await auth.$context;
  const adapter = ctx.internalAdapter;

  const found = await adapter.findUserByEmail(OWNER_EMAIL);
  const userId =
    found?.user.id ??
    (
      await adapter.createUser(
        { id: uuidv7(), email: OWNER_EMAIL, name: config.OWNER_HANDLE, emailVerified: true },
        { method: "email-password" },
      )
    ).id;

  const credential = await adapter.findCredentialAccount(userId);
  if (!credential) {
    await adapter.linkAccount({
      userId,
      providerId: "credential",
      accountId: userId,
      password: await ctx.password.hash(config.LOCAL_AUTH_TOKEN),
    });
  } else {
    const same = credential.password
      ? await ctx.password.verify({ hash: credential.password, password: config.LOCAL_AUTH_TOKEN })
      : false;
    if (!same) {
      await adapter.updatePassword(userId, await ctx.password.hash(config.LOCAL_AUTH_TOKEN));
      await adapter.deleteUserSessions(userId);
    }
  }

  if (!db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) {
    db.insert(users)
      .values({
        id: userId,
        workspaceId,
        handle: config.OWNER_HANDLE,
        displayName: config.OWNER_HANDLE,
        email: OWNER_EMAIL,
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
  }
  const membership = db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .get();
  if (!membership) {
    db.insert(memberships).values({ id: uuidv7(), workspaceId, userId, role: "owner" }).run();
  }
  return { userId };
}
