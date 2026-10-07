import {
  OPS_DEFAULT_DAILY_RUN_LIMIT,
  OPS_DEFAULT_TIME_ZONE,
  type OpsSettings,
  OpsSettingsPatch,
} from "@dodok/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../../db/client";
import { workspaces } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import { assertTimeZone } from "../automations/schedule";

/** workspaces.ops_json 의 모양 — 키가 없으면 기본값(한도 300·시간대 Asia/Seoul). 모르는 키는 patch 가 그대로 남긴다 */
const StoredOps = z.looseObject({
  dailyRunLimit: OpsSettingsPatch.shape.dailyRunLimit.optional(),
  timeZone: OpsSettingsPatch.shape.timeZone,
});
type StoredOps = z.infer<typeof StoredOps>;

/**
 * ops_json 을 읽는다. 망가진 값(JSON 아님·모양 다름)이면 {} 로 보고 logger 가 있으면 warn 을 남긴다. 저장된 시간대를 이 서버의 Intl 이
 * 모르면(다른 ICU 로 저장한 이름 등) 시간대만 기본값으로 읽는다 — 예약 틱이 매번 이 값으로 다음 시각을 세므로 던지면 틱이 멈춘다
 */
export function getOpsSettings(db: DbOrTx, workspaceId: string, logger?: Pick<Logger, "warn">): OpsSettings {
  return withKnownTimeZone(toSettings(readStored(db, workspaceId, logger)), workspaceId, logger);
}

/**
 * 준 키만 바꾼다(undefined 값은 바꾸지 않는다). 범위 밖이거나 없는 시간대 이름이면 VALIDATION 으로 던지고 아무 키도 저장하지 않는다.
 * 시간대는 Intl 의 정규형으로 저장한다(assertTimeZone). 돌려주는 값은 getOpsSettings 와 같은 읽기다 — 저장된 시간대를 모르면(한도만
 * 바꾼 경우) 저장값은 두고 기본값으로 돌려준다. 부르는 쪽(설정 PATCH)이 바꾸기 전 읽기와 비교해 다음 시각을 다시 세므로, 저장값을
 * 그대로 돌려주면 모르는 이름으로 다시 세다 던진다. 시간대를 바꿔도 다음 시각은 여기서 다시 세지 않는다(계획 판정 PA4)
 */
export function patchOpsSettings(db: DbOrTx, workspaceId: string, patch: Partial<OpsSettings>): OpsSettings {
  const timeZone = patch.timeZone === undefined ? undefined : assertTimeZone(patch.timeZone);
  const next: Record<string, unknown> = { ...readStored(db, workspaceId) };
  for (const [key, value] of Object.entries({ ...patch, timeZone }))
    if (value !== undefined) next[key] = value;
  const parsed = StoredOps.safeParse(next);
  if (!parsed.success) throw apiError("VALIDATION", "invalid ops settings");
  db.update(workspaces)
    .set({ opsJson: JSON.stringify(parsed.data) })
    .where(eq(workspaces.id, workspaceId))
    .run();
  return withKnownTimeZone(toSettings(parsed.data), workspaceId);
}

/** 저장된 시간대를 이 서버의 Intl 이 모르면 시간대만 기본값으로 — 읽기·patch 의 돌려주는 값이 같은 규칙을 쓴다 */
function withKnownTimeZone(
  settings: OpsSettings,
  workspaceId: string,
  logger?: Pick<Logger, "warn">,
): OpsSettings {
  try {
    assertTimeZone(settings.timeZone);
  } catch {
    logger?.warn({ workspaceId }, "ops settings time zone unknown");
    return { ...settings, timeZone: OPS_DEFAULT_TIME_ZONE };
  }
  return settings;
}

function readStored(db: DbOrTx, workspaceId: string, logger?: Pick<Logger, "warn">): StoredOps {
  const raw = db
    .select({ opsJson: workspaces.opsJson })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get()?.opsJson;
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = StoredOps.safeParse(value);
  if (parsed.success) return parsed.data;
  logger?.warn({ workspaceId }, "ops settings unreadable");
  return {};
}

function toSettings(stored: StoredOps): OpsSettings {
  return {
    dailyRunLimit: stored.dailyRunLimit === undefined ? OPS_DEFAULT_DAILY_RUN_LIMIT : stored.dailyRunLimit,
    timeZone: stored.timeZone ?? OPS_DEFAULT_TIME_ZONE,
  };
}
