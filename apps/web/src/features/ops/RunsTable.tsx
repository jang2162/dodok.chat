import type { OpsRunsRow } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useAgents } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { ArchivedTag } from "@/features/agents/ArchivedTag";
import { Section } from "@/features/setup/sections";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { Button } from "@/ui/button";
import { useOpsRuns } from "./queries";

const NUM = new Intl.NumberFormat("ko-KR");
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

type Column = { name: string; value: (r: OpsRunsRow) => ReactNode };
const COUNTS: Column[] = [
  { name: "런", value: (r) => NUM.format(r.runs) },
  { name: "실패", value: (r) => NUM.format(r.failed) },
  { name: "중지", value: (r) => NUM.format(r.aborted) },
  { name: "차단", value: (r) => NUM.format(r.blocked) },
];
const UNMEASURED = "측정 불가";
const TAG = "ml-1 text-xs text-muted-foreground";

/** 믿는 런만 더한 부분합이면(OpenClaw 런이 섞인 채널 등) 「런 m/n개만」 — 더한 런 수는 서버 measuredRuns */
function partialTag(r: OpsRunsRow) {
  return r.measuredRuns !== undefined && r.measuredRuns < r.runs
    ? `런 ${r.measuredRuns}/${r.runs}개만`
    : undefined;
}

/** 값 뒤 꼬리표들 */
function Measured({ value, tags }: { value: string; tags: (string | undefined)[] }) {
  return (
    <>
      {value}
      {tags
        .filter((t) => t !== undefined)
        .map((t) => (
          <span key={t} className={TAG}>
            {t}
          </span>
        ))}
    </>
  );
}

/**
 * usage 를 믿는 제공자가 있을 때만(스펙 3.3). 행에 값이 없으면 믿는 제공자의 런이 없는 행(OpenClaw 에이전트 등) — 「측정 불가」.
 * 믿는 런만 더한 부분합이면 「런 m/n개만」. 구독 로그인의 금액은 공시 단가 환산값이라(러너 스펙 7장) 그런 런이 하나라도 든 금액에
 * 「환산 포함」 — 같은 합에 api 로 청구된 몫이 섞일 수 있어 「환산값」이라 부르지 않는다
 */
const USAGE: Column[] = [
  {
    name: "토큰",
    value: (r) =>
      r.tokens === undefined ? UNMEASURED : <Measured value={NUM.format(r.tokens)} tags={[partialTag(r)]} />,
  },
  {
    name: "금액",
    value: (r) =>
      r.costUsd === undefined ? (
        UNMEASURED
      ) : (
        <Measured
          value={USD.format(r.costUsd)}
          tags={[r.costEstimated ? "환산 포함" : undefined, partialTag(r)]}
        />
      ),
  },
];

/**
 * 채널 이름은 그 채널로 가는 링크, 에이전트는 이름과 핸들·Gateway — 보관(삭제)한 에이전트도 기록이라 남기고 「삭제됨」을 붙인다(스펙 「에이전트 보관」 절).
 * 「DM」 묶음 줄은 모든 DM(에이전트 DM·사람 DM·그룹 DM)을 합친 것이라 갈 채널이 없다(에이전트 DM 계획 판정 PD5). 링크는 `kind` 가 없는
 * 채널 줄에만 — 모르는 묶음 줄을 채널로 읽지 않는다(사람 간 DM 계획 Global Constraints 「기본이 닫힘」)
 */
function Name({ row, channel }: { row: OpsRunsRow; channel: boolean }) {
  if (!channel) return <AgentName row={row} />;
  if (row.kind !== undefined) return <>{row.name}</>;
  return (
    <Link to="/c/$channelId" params={{ channelId: row.id }} className="underline-offset-4 hover:underline">
      {row.name}
    </Link>
  );
}

/**
 * 이름 옆에 `@핸들 · Gateway 이름`(러너 에이전트면 핸들만) — 같은 id 를 이름 그대로 가져온 두 Gateway 의 에이전트(둘 다 `main`)가
 * 이 표에서 갈리게 한다(다중 Gateway 실연 보고). 행 id 가 에이전트 id 라 에이전트 목록(그 안의 `gateway`)으로 푼다 — 새 API 없음.
 * 목록에 없으면(아직 못 받음) 이름만
 */
function AgentName({ row }: { row: OpsRunsRow }) {
  const agent = useAgents().data?.find((a) => a.id === row.id);
  const where = agent
    ? agent.provider === "openclaw" && agent.gateway
      ? `@${agent.handle} · ${agent.gateway.name}`
      : `@${agent.handle}`
    : undefined;
  return (
    <>
      {row.name}
      {where && (
        <span data-slot="agent-where" className={TAG}>
          {where}
        </span>
      )}
      {agent && isArchived(agent) && <ArchivedTag className={TAG} />}
    </>
  );
}

/** 넓은 화면 — 표 */
function Table({
  title,
  rows,
  columns,
  channel,
}: {
  title: string;
  rows: OpsRunsRow[];
  columns: Column[];
  channel: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="pb-1 text-left text-xs font-medium text-muted-foreground">{title}</caption>
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th scope="col" className="py-1 text-left font-medium">
            이름
          </th>
          {columns.map((c) => (
            <th key={c.name} scope="col" className="py-1 text-right font-medium">
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b last:border-0">
            <td className="max-w-0 truncate py-1.5 pr-2">
              <Name row={r} channel={channel} />
            </td>
            {columns.map((c) => (
              <td key={c.name} className="py-1.5 text-right tabular-nums">
                {c.value(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 좁은 화면 — 가로 스크롤 없이 한 행을 카드 하나로 */
function Cards({
  title,
  rows,
  columns,
  channel,
}: {
  title: string;
  rows: OpsRunsRow[];
  columns: Column[];
  channel: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul aria-label={title} className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1 rounded-md border px-3 py-2 text-sm">
            <span className="font-medium break-words">
              <Name row={r} channel={channel} />
            </span>
            <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {columns.map((c) => (
                <div key={c.name} className="flex gap-1">
                  <dt className="text-muted-foreground">{c.name}</dt>
                  <dd className="tabular-nums">{c.value(r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Group(props: {
  title: string;
  rows: OpsRunsRow[];
  columns: Column[];
  channel: boolean;
  narrow: boolean;
}) {
  if (props.rows.length === 0)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">{props.title}</p>
        <p className="text-sm text-muted-foreground">이 기간에 런이 없습니다</p>
      </div>
    );
  return props.narrow ? <Cards {...props} /> : <Table {...props} />;
}

/**
 * 런 표(스펙 7장): 「오늘 / 7일」, 채널별·에이전트별 런·실패·중지·차단. usage 를 믿는 제공자(러너 계획 판정 P8)가 있을 때만 토큰·금액 열 —
 * 아니면 「측정 불가」 한 줄. 열이 있어도 믿는 제공자의 런이 없는 행은 칸마다 「측정 불가」.
 * 좁은 화면(768px 미만)은 표 대신 카드 목록
 */
export function RunsTable() {
  const [days, setDays] = useState<1 | 7>(1);
  const runs = useOpsRuns(days);
  const narrow = useIsNarrow();
  const data = runs.data;
  // 믿는 제공자가 하나라도 있으면 열을 둔다 — 그 제공자의 런이 없는 행은 「측정 불가」
  const usageTrusted = (data?.usageTrustedPrograms.length ?? 0) > 0;
  const rows = data ? [...data.byChannel, ...data.byAgent] : [];
  const estimated = rows.some((r) => r.costEstimated);
  const columns = usageTrusted ? [...COUNTS, ...USAGE] : COUNTS;
  return (
    <Section title="런">
      <div role="group" aria-label="기간" className="flex gap-1">
        {([1, 7] as const).map((d) => (
          <Button
            key={d}
            type="button"
            size="xs"
            variant={days === d ? "secondary" : "ghost"}
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {d === 1 ? "오늘" : "7일"}
          </Button>
        ))}
      </div>
      {data ? (
        <>
          <Group title="채널별" rows={data.byChannel} columns={columns} channel narrow={narrow} />
          <Group title="에이전트별" rows={data.byAgent} columns={columns} channel={false} narrow={narrow} />
          {!usageTrusted && <p className="text-xs text-muted-foreground">토큰·금액은 측정 불가</p>}
          {estimated && (
            <p className="text-xs text-muted-foreground">「환산 포함」 몫은 청구액이 아닙니다.</p>
          )}
        </>
      ) : runs.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">런 집계를 불러오지 못했습니다</p>
          <Button variant="outline" size="sm" onClick={() => void runs.refetch()}>
            다시 시도
          </Button>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          불러오는 중…
        </p>
      )}
    </Section>
  );
}
