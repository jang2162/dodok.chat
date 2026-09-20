import { useAgents } from "@/api/queries";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Notice } from "./Notice";
import { type ActivityRun, runDurationMs, runStatusLabel, runStatusVariant } from "./timeline";

const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });

/**
 * 채널의 런 목록(설계 5.2). 한 줄에 에이전트 핸들·상태 배지·시작 시각·소요.
 * 고르면 아래 타임라인이 그 런을 그린다 — 기본은 가장 최근 런
 */
export function RunList({
  runs,
  selectedId,
  onSelect,
  loading,
  error,
  onRetry,
  retrying,
}: {
  runs: readonly ActivityRun[];
  selectedId: string | undefined;
  onSelect: (runId: string) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const agents = useAgents().data;
  const handleOf = (agentId: string) => agents?.find((a) => a.id === agentId)?.handle;
  const now = Date.now();

  if (error) {
    return (
      <Notice onRetry={onRetry} retrying={retrying}>
        런 목록을 불러오지 못했습니다.
      </Notice>
    );
  }
  if (runs.length === 0) return <Notice>{loading ? "불러오는 중…" : "아직 실행 기록이 없습니다."}</Notice>;

  return (
    <ul aria-label="런 목록" className="max-h-[40%] shrink-0 divide-y overflow-y-auto border-b">
      {runs.map((run) => {
        const selected = run.id === selectedId;
        const handle = handleOf(run.agentId);
        const duration = runDurationMs(run, now);
        return (
          <li key={run.id}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(run.id)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:-outline-offset-2",
                selected && "bg-accent",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {handle ? `@${handle}` : "알 수 없는 에이전트"}
              </span>
              <Badge variant={runStatusVariant(run.status)} className="shrink-0">
                {runStatusLabel(run.status)}
              </Badge>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {run.startedAt ? TIME.format(new Date(run.startedAt)) : "—"}
                {duration !== undefined && ` · ${Math.round(duration / 1000)}초`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
