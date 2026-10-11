/** 네이티브 푸시 기기 저장(스펙 2장) — 웹 구독(service.ts)과 같은 규칙: 토큰은 전역 유일, 세션이 살아 있는 동안만 쓴다 */
import { IosToken, type PushDeviceInput } from "@dodok/shared";
import { and, eq, gt, ne } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { session } from "../../db/auth-schema";
import type { DbOrTx } from "../../db/client";
import { pushDevices } from "../../db/schema.sqlite";

export type PushDeviceRow = typeof pushDevices.$inferSelect;

/**
 * token 으로 upsert. 이미 다른 사용자에게 묶여 있으면 지금 사용자·세션으로 옮긴다 — 같은 폰에서 계정이 바뀌면
 * 앞 사람에게 뒷사람의 알림이 가지 않게(Review Focus 1). 행 id·created_at 은 처음 것을 둔다
 */
export function upsertDevice(
  db: DbOrTx,
  userId: string,
  sessionId: string,
  input: PushDeviceInput,
  now: Date,
): PushDeviceRow {
  const environment = input.platform === "ios" ? input.environment : null;
  // 세션당 기기 1행(PN5) — 토큰이 돌았거나 거절된 옛 토큰이 세션에 쌓이지 않게
  db.delete(pushDevices)
    .where(and(eq(pushDevices.sessionId, sessionId), ne(pushDevices.token, input.token)))
    .run();
  return db
    .insert(pushDevices)
    .values({
      id: uuidv7(),
      userId,
      sessionId,
      platform: input.platform,
      token: input.token,
      appId: input.appId,
      environment,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: { userId, sessionId, platform: input.platform, appId: input.appId, environment, lastSeenAt: now },
    })
    .returning()
    .get();
}

/** 세션 사용자의 것만 지운다 — 남의 토큰·없는 토큰은 아무 일도 없다(멱등) */
export function removeDevice(db: DbOrTx, userId: string, token: string): void {
  const key = IosToken.safeParse(token);
  db.delete(pushDevices)
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, key.success ? key.data : token)))
    .run();
}

/** 발송 대상 — 등록한 세션이 아직 만료 전인 기기만(listSubscriptions 와 같은 규칙) */
export function listDevices(db: DbOrTx, userId: string, now: Date = new Date()): PushDeviceRow[] {
  return db
    .select({ device: pushDevices })
    .from(pushDevices)
    .innerJoin(session, eq(session.id, pushDevices.sessionId))
    .where(and(eq(pushDevices.userId, userId), gt(session.expiresAt, now)))
    .all()
    .map((r) => r.device);
}

/** 발송이 기기 없음(gone)을 받았을 때 그 행 하나를 지운다 */
export function deleteDeviceById(db: DbOrTx, id: string): void {
  db.delete(pushDevices).where(eq(pushDevices.id, id)).run();
}
