import type { OpsRunsRow } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Section } from "@/features/setup/sections";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { Button } from "@/ui/button";
import { useOpsRuns } from "./queries";

const NUM = new Intl.NumberFormat("ko-KR");
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

type Column = { name: string; value: (r: OpsRunsRow) => string };
const COUNTS: Column[] = [
  { name: "런", value: (r) => NUM.format(r.runs) },
  { name: "실패", value: (r) => NUM.format(r.failed) },
  { name: "중지", value: (r) => NUM.format(r.aborted) },
  { name: "차단", value: (r) => NUM.format(r.blocked) },
];
/** usage 값을 믿을 수 있을 때만(스펙 3.3) */
const USAGE: Column[] = [
  { name: "토큰", value: (r) => (r.tokens === undefined ? "—" : NUM.format(r.tokens)) },
  { name: "금액", value: (r) => (r.costUsd === undefined ? "—" : USD.format(r.costUsd)) },
];

/** 채널 이름은 그 채널로 가는 링크, 에이전트는 이름만 */
function Name({ row, channel }: { row: OpsRunsRow; channel: boolean }) {
  if (!channel) return <>{row.name}</>;
  return (
    <Link to="/c/$channelId" params={{ channelId: row.id }} className="underline-offset-4 hover:underline">
      {row.name}
    </Link>
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
 * 런 표(스펙 7장): 「오늘 / 7일」, 채널별·에이전트별 런·실패·중지·차단. usage 가 맞을 때만 토큰·금액 열 — 아니면 「측정 불가」 한 줄.
 * 좁은 화면(768px 미만)은 표 대신 카드 목록
 */
export function RunsTable() {
  const [days, setDays] = useState<1 | 7>(1);
  const runs = useOpsRuns(days);
  const narrow = useIsNarrow();
  const data = runs.data;
  const columns = data?.usageTrusted ? [...COUNTS, ...USAGE] : COUNTS;
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
          {!data.usageTrusted && (
            <p className="text-xs text-muted-foreground">
              토큰·금액은 측정 불가 — Gateway 가 주는 사용량 값을 아직 믿을 수 없습니다 (ADR 0005)
            </p>
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
