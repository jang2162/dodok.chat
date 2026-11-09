/** 운영 화면 런 표(운영 보강 스펙 6장 GET /api/v1/ops/runs) — runs 를 채널별·에이전트별로 묶고 채널 한도 차단 수를 붙인다 */
import { OPS_DM_ROW_ID, type OpsRunsRow, type OpsRunsSummary, type RunnerProgram } from "@dodok/shared";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { agents, channels, runs } from "../../db/schema.sqlite";
import type { OpsService } from "./service";

/**
 * runs.usage_json 의 토큰·금액을 믿을 수 있는 러너 프로그램(운영 보강 스펙 3.3, 러너 계획 판정 P8, 러너 일반화 스펙 결정 6).
 * OpenClaw 는 출력 토큰·비용이 CLI `result` 와 달라 빠진다(ADR 0005) — OpenClaw 에이전트는 프로그램이 없다. Claude Code 는 SDK
 * `result` 를 그대로 싣는다(ADR 0007 4.8). 믿는 프로그램의 런만 토큰·비용을 합치고, 그런 런이 없는 행에는 tokens·costUsd 키가 없다
 * — 화면은 「측정 불가」. 더한 런 수는 measuredRuns — runs 보다 적으면 부분합이다
 */
export const USAGE_TRUSTED_PROGRAMS: ReadonlySet<RunnerProgram> = new Set<RunnerProgram>(["claude"]);

/**
 * 쓰이는 프로그램 가운데 믿는 프로그램 — 응답의 usageTrustedPrograms 가 비면 웹은 열 대신 「측정 불가」를 보인다.
 * 쓰이지 않는 프로그램까지 실으면 OpenClaw 만 쓰는 배포에서 토큰·금액 열이 전부 「—」로 켜진다
 */
export function usageTrustedAmong(inUse: Iterable<RunnerProgram>): ReadonlySet<RunnerProgram> {
  return new Set([...inUse].filter((p) => USAGE_TRUSTED_PROGRAMS.has(p)));
}

/**
 * 붙은 어댑터의 제공자에 등록된 에이전트가 쓰는 프로그램 — 러너 어댑터는 모든 배포에 붙어 있으므로 「붙음」만으로는 러너를 쓰는지
 * 가를 수 없다. 에이전트는 지우지 않으므로 옛 런의 프로그램도 남는다
 */
export function programsWithAgents(db: Db, workspaceId: string, attached: Iterable<string>): RunnerProgram[] {
  const providers = [...new Set(attached)];
  if (providers.length === 0) return [];
  return db
    .selectDistinct({ program: agents.program })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        inArray(agents.provider, providers),
        isNotNull(agents.program),
      ),
    )
    .all()
    .flatMap((r) => (r.program === null ? [] : [r.program]))
    .sort();
}

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
    usageTrustedPrograms?: ReadonlySet<RunnerProgram>;
  },
): OpsRunsSummary {
  const { days, now, workspaceId } = opts;
  const trustedPrograms = [...(opts.usageTrustedPrograms ?? USAGE_TRUSTED_PROGRAMS)].sort();
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));

  // 런의 에이전트가 믿는 프로그램인가 — 채널 행도 에이전트를 조인해 그 런만 더한다. program 이 null(OpenClaw)이면 IN 이 거짓이다
  const trusted = trustedPrograms.length > 0 ? inArray(agents.program, trustedPrograms) : sql`0`;
  const tally = {
    runs: sql<number>`count(*)`,
    failed: sql<number>`coalesce(sum(${runs.status} = 'error'), 0)`,
    aborted: sql<number>`coalesce(sum(${runs.status} = 'aborted'), 0)`,
    trustedRuns: sql<number>`coalesce(sum(${trusted}), 0)`,
    // usage 가 없는 런·빠진 필드는 0 으로 더한다
    tokens: sql<number>`coalesce(sum(case when ${trusted} then coalesce(json_extract(${runs.usage}, '$.inputTokens'), 0) + coalesce(json_extract(${runs.usage}, '$.outputTokens'), 0) else 0 end), 0)`,
    costUsd: sql<number>`coalesce(total(case when ${trusted} then json_extract(${runs.usage}, '$.costUsd') end), 0)`,
    // 믿는 런 가운데 구독 로그인의 공시 단가 환산값(러너 스펙 7장 「환산값」) — 청구액이 아니다
    estimatedRuns: sql<number>`coalesce(sum(${trusted} and json_extract(${runs.usage}, '$.costKind') = 'subscription_estimate'), 0)`,
  };
  type Tally = { id: string; name: string; kind?: string } & { [K in keyof typeof tally]: number };

  const channelRows: Tally[] = db
    .select({ id: channels.id, name: channels.name, kind: channels.kind, ...tally })
    .from(runs)
    .innerJoin(channels, eq(runs.channelId, channels.id))
    .innerJoin(agents, eq(runs.agentId, agents.id))
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
    const zero = { runs: 0, failed: 0, aborted: 0, trustedRuns: 0, tokens: 0, costUsd: 0, estimatedRuns: 0 };
    for (const ch of db
      .select({ id: channels.id, name: channels.name, kind: channels.kind })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, blockedOnly)))
      .all())
      channelRows.push({ ...ch, ...zero });
  }

  // DM 은 채널 이름(내부용)·주인 없이 「DM」 한 줄로 합친다 — 운영 화면을 보는 owner·admin 에게 누구의 DM 이 몇 개 있는지 드러내지
  // 않는다(에이전트 DM 스펙 4장, 계획 판정 PD5). 사람 DM·그룹 DM(direct)도 같은 줄이다(사람 간 DM 스펙 7.5). 모르는 kind 는 채널별
  // 줄에 싣지 않는다(기본이 닫힘). 에이전트별 행은 이 런들도 그 에이전트에 그대로 센다(내용·주인이 없다)
  const dmRow = channelRows
    .filter((r) => r.kind === "dm" || r.kind === "direct")
    .reduce<(Tally & { blocked: number }) | undefined>((sum, r) => {
      const blockedCount = blocked.get(r.id) ?? 0;
      if (!sum) return { ...r, id: OPS_DM_ROW_ID, name: "DM", kind: "dm", blocked: blockedCount };
      for (const k of Object.keys(tally) as (keyof typeof tally)[]) sum[k] += r[k];
      sum.blocked += blockedCount;
      return sum;
    }, undefined);
  const plainRows = channelRows.filter((r) => r.kind === "channel");

  const toRow = (r: Tally, blockedCount: number): OpsRunsRow => ({
    id: r.id,
    name: r.name,
    ...(r.kind === "dm" ? { kind: "dm" as const } : {}),
    runs: r.runs,
    failed: r.failed,
    aborted: r.aborted,
    blocked: blockedCount,
    ...(r.trustedRuns > 0
      ? {
          measuredRuns: r.trustedRuns,
          tokens: r.tokens,
          costUsd: r.costUsd,
          costEstimated: r.estimatedRuns > 0,
        }
      : {}),
  });
  const byRuns = (a: OpsRunsRow, b: OpsRunsRow) =>
    b.runs - a.runs || b.blocked - a.blocked || a.name.localeCompare(b.name);
  return {
    days,
    byChannel: [
      ...plainRows.map((r) => toRow(r, blocked.get(r.id) ?? 0)),
      ...(dmRow ? [toRow(dmRow, dmRow.blocked)] : []),
    ].sort(byRuns),
    byAgent: agentRows.map((r) => toRow(r, 0)).sort(byRuns),
    usageTrustedPrograms: trustedPrograms,
  };
}
