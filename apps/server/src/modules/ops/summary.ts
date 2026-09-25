/** 운영 화면 런 표(운영 보강 스펙 6장 GET /api/v1/ops/runs) — runs 를 채널별·에이전트별로 묶고 채널 한도 차단 수를 붙인다 */
import type { OpsRunsRow, OpsRunsSummary } from "@dodok/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { agents, channels, runs } from "../../db/schema.sqlite";
import type { OpsService } from "./service";

/**
 * runs.usage_json 의 토큰·금액을 믿을 수 있는가(스펙 3.3). 출력 토큰·비용이 CLI `result` 와 같을 때만 true — 판정·다시 재는 법은 ADR 0005.
 * false 인 동안 응답 행에 tokens·costUsd 키가 없고 화면은 「측정 불가」를 보인다
 */
export const USAGE_TRUSTED = false;

const CHANNEL_KEY_PREFIX = "channel:";

/**
 * 기간 시작은 서버 현지 자정 — days=1 은 오늘 0시, days=7 은 6일 전 0시(관문의 「하루」와 같다).
 * blocked 는 채널 한도 run_limit 사건(key channel:<id>)의 count 합이다. 워크스페이스 차단(key workspace)은 채널로 나눌 수
 * 없어 어느 행에도 넣지 않는다(ops/status 의 blockedToday). 런 없이 막히기만 한 채널도 행이 있다
 */
export function runsSummary(
  db: Db,
  opts: {
    days: 1 | 7;
    now: Date;
    ops: Pick<OpsService, "countsSince">;
    workspaceId: string;
    usageTrusted?: boolean;
  },
): OpsRunsSummary {
  const { days, now, workspaceId } = opts;
  const usageTrusted = opts.usageTrusted ?? USAGE_TRUSTED;
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

  const tally = {
    runs: sql<number>`count(*)`,
    failed: sql<number>`coalesce(sum(${runs.status} = 'error'), 0)`,
    aborted: sql<number>`coalesce(sum(${runs.status} = 'aborted'), 0)`,
    // usage 가 없는 런·빠진 필드는 0 으로 더한다
    tokens: sql<number>`coalesce(sum(coalesce(json_extract(${runs.usage}, '$.inputTokens'), 0) + coalesce(json_extract(${runs.usage}, '$.outputTokens'), 0)), 0)`,
    costUsd: sql<number>`coalesce(total(json_extract(${runs.usage}, '$.costUsd')), 0)`,
  };
  type Tally = { id: string; name: string } & { [K in keyof typeof tally]: number };

  const channelRows: Tally[] = db
    .select({ id: channels.id, name: channels.name, ...tally })
    .from(runs)
    .innerJoin(channels, eq(runs.channelId, channels.id))
    .where(and(eq(channels.workspaceId, workspaceId), gte(runs.createdAt, since)))
    .groupBy(channels.id)
    .all();
  const agentRows: Tally[] = db
    .select({ id: agents.id, name: agents.name, ...tally })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(and(eq(agents.workspaceId, workspaceId), gte(runs.createdAt, since)))
    .groupBy(agents.id)
    .all();

  const blocked = new Map<string, number>();
  for (const [key, n] of opts.ops.countsSince("run_limit", since))
    if (key.startsWith(CHANNEL_KEY_PREFIX)) blocked.set(key.slice(CHANNEL_KEY_PREFIX.length), n);
  // 런 없이 막히기만 한 채널 — 이름을 따로 읽는다(지워졌거나 다른 워크스페이스면 싣지 않는다)
  const seen = new Set(channelRows.map((r) => r.id));
  const blockedOnly = [...blocked.keys()].filter((id) => !seen.has(id));
  if (blockedOnly.length > 0) {
    const zero = { runs: 0, failed: 0, aborted: 0, tokens: 0, costUsd: 0 };
    for (const ch of db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, blockedOnly)))
      .all())
      channelRows.push({ ...ch, ...zero });
  }

  const toRow = (r: Tally, blockedCount: number): OpsRunsRow => ({
    id: r.id,
    name: r.name,
    runs: r.runs,
    failed: r.failed,
    aborted: r.aborted,
    blocked: blockedCount,
    ...(usageTrusted ? { tokens: r.tokens, costUsd: r.costUsd } : {}),
  });
  const byRuns = (a: OpsRunsRow, b: OpsRunsRow) =>
    b.runs - a.runs || b.blocked - a.blocked || a.name.localeCompare(b.name);
  return {
    days,
    byChannel: channelRows.map((r) => toRow(r, blocked.get(r.id) ?? 0)).sort(byRuns),
    byAgent: agentRows.map((r) => toRow(r, 0)).sort(byRuns),
    usageTrusted,
  };
}
