import { useAgents } from "@/api/queries";
import { useNowTick } from "@/hooks/useNowTick";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Notice } from "./Notice";
import {
  type ActivityRun,
  hasFlowingDuration,
  runDurationMs,
  runStatusLabel,
  runStatusVariant,
} from "./timeline";

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
  // 아직 안 끝난 런의 소요만 흐른다 — 그런 런이 있을 때만 1초 틱을 돌린다(조건은 `hasFlowingDuration` 이 잠근다)
  const now = useNowTick(hasFlowingDuration(runs));

  const failure = error && (
    <Notice onRetry={onRetry} retrying={retrying}>
      런 목록을 불러오지 못했습니다.
    </Notice>
  );
  // 조회가 실패해도 실시간으로 아는 런은 그대로 그린다(태스크 7 리뷰 이월 6) —
  // 잠깐 끊긴 사이에 진행 중인 런이 화면에서 사라지면 「멈춘 것」처럼 보인다
  if (runs.length === 0) {
    return failure || <Notice>{loading ? "불러오는 중…" : "아직 실행 기록이 없습니다."}</Notice>;
  }

  return (
    <>
      {failure}
      {/*
       * 높이는 최대 40% — 다만 자리가 모자라면 줄어든다(shrink-0 없음). 짧은 창에서 목록이 제 몫을 먼저 가져가면
       * 아래 타임라인이 읽을 수 없게 눌린다(브라우저 검증 D10). 자리가 넉넉하면 줄어들 일이 없어 넓은 화면은 그대로다
       */}
      <ul aria-label="런 목록" className="max-h-[40%] divide-y overflow-y-auto border-b">
        {runs.map((run) => {
          const selected = run.id === selectedId;
          const handle = handleOf(run.agentId);
          const duration = runDurationMs(run, now);
          return (
            <li key={run.id}>
              <button
                type="button"
                data-run-id={run.id}
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
    </>
  );
}
