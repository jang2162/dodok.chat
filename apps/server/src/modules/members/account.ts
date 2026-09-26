/**
 * 「내 계정」(팀 스펙 3.5). Better Auth 의 /change-password·/update-user 는 닫아 둔 채 우리 경로가 내부 어댑터로 바꾼다 —
 * users 행 동기화와 「owner 비밀번호 = 로컬 토큰」 불변식을 우리 쪽 한곳에서 지키려고.
 */
import type { ChangePasswordBody } from "@dodok/shared";
import { eq } from "drizzle-orm";
import type { Auth } from "../../auth";
import type { Db } from "../../db/client";
import { users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

export function updateDisplayName(db: Db, userId: string, displayName: string): void {
  db.update(users).set({ displayName }).where(eq(users.id, userId)).run();
}

/**
 * 현재 비밀번호를 확인하고 바꾼 뒤 이 세션(keepSessionToken)을 뺀 본인 세션을 끊는다.
 * 틀린 현재 비밀번호는 401 이 아니라 400 field "current" — 웹은 401 을 「세션 끝남」으로 읽어 로그인 화면으로 보낸다
 */
export async function changePassword(
  auth: Auth,
  userId: string,
  keepSessionToken: string,
  body: ChangePasswordBody,
): Promise<void> {
  const ctx = await auth.$context;
  const adapter = ctx.internalAdapter;
  const credential = await adapter.findCredentialAccount(userId);
  const ok = credential?.password
    ? await ctx.password.verify({ hash: credential.password, password: body.current })
    : false;
  if (!ok) throw apiError("VALIDATION", "현재 비밀번호가 맞지 않는다", { field: "current" });
  await adapter.updatePassword(userId, await ctx.password.hash(body.next));
  const others = (await adapter.listSessions(userId))
    .map((s) => s.token)
    .filter((token) => token !== keepSessionToken);
  if (others.length > 0) await adapter.deleteSessions(others);
}
