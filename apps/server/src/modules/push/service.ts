/** 푸시 구독 저장(스펙 5.1). 발송·404·410 정리는 태스크 3 이 여기에 더한다 */
import type { PushSubscriptionInput } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../db/client";
import { pushSubscriptions } from "../../db/schema.sqlite";

/**
 * endpoint 로 upsert. 이미 다른 사용자에게 묶여 있으면 지금 사용자로 옮긴다 — 같은 브라우저에서 사람이 바뀌면
 * 앞 사람에게 뒷사람의 알림이 가지 않게(Review Focus 1). 행 id 는 처음 것을 그대로 둔다
 */
export function upsertSubscription(
  db: DbOrTx,
  userId: string,
  input: PushSubscriptionInput,
  userAgent?: string,
): void {
  const now = new Date();
  const userAgentValue = userAgent ?? null;
  db.insert(pushSubscriptions)
    .values({
      id: uuidv7(),
      userId,
      endpoint: input.endpoint,
      keys: input.keys,
      userAgent: userAgentValue,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, keys: input.keys, userAgent: userAgentValue, createdAt: now },
    })
    .run();
}

/** 세션 사용자의 것만 지운다 — 남의 endpoint·없는 endpoint 는 아무 일도 없다(멱등) */
export function removeSubscription(db: DbOrTx, userId: string, endpoint: string): void {
  db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .run();
}

export function listSubscriptions(
  db: DbOrTx,
  userId: string,
): Array<{ id: string; endpoint: string; keys: { p256dh: string; auth: string } }> {
  return db
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, keys: pushSubscriptions.keys })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .all();
}

/** 발송이 404·410 을 받았을 때 그 구독 하나를 지운다 */
export function deleteSubscriptionById(db: DbOrTx, id: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
}
