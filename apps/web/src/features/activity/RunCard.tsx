import type { Approval, RunEvent } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, ChevronDownIcon, SquareIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/http";
import { qk, useAgents } from "@/api/queries";
import { ProgramBadge } from "@/features/runners/ProgramBadge";
import { abortErrorMessage } from "@/features/runs/abortError";
import { TERMINAL } from "@/features/runs/runStore";
import { useNowTick } from "@/hooks/useNowTick";
import { cn } from "@/lib/utils";
import { emitAck, useWireStatus } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { RunTimeline } from "./RunTimeline";
import {
  type ActivityRun,
  type RunStatusTone,
  hasFlowingDuration,
  runDurationMs,
  runStatusLabel,
  runStatusTone,
  runSummaryLabel,
  summarizeRun,
} from "./timeline";

const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" });
const FROZEN_HINT = "멈춤 — 끝난 시각을 모릅니다";
export const UNKNOWN_AGENT = "알 수 없는 에이전트";

const TONE_CLASS: Record<RunStatusTone, string> = {
  running: "bg-primary/12 text-primary",
  approval: "bg-warning/16 text-foreground",
  done: "bg-success/14 text-foreground",
  error: "bg-destructive/12 text-destructive",
  aborted: "bg-muted text-muted-foreground",
};

type ApprovalOf = (approvalId: string) => Approval | undefined;

/**
 * 런 카드들(재설계 스펙 목표 7) — 펼침은 부르는 쪽이 쥔다. 아직 안 끝난 런의 소요만 흐른다 — 그런 런이 있을 때만 1초 틱을
 * 돌리고(조건은 `hasFlowingDuration` 이 잠근다) 모든 카드가 그 시계 하나를 본다(D6). 목록 전체가 한 스크롤 영역이다(D10)
 */
export function RunCards({
  runs,
  isExpanded,
  onToggle,
  approval,
}: {
  runs: readonly ActivityRun[];
  isExpanded: (runId: string) => boolean;
  onToggle: (runId: string) => void;
  approval: ApprovalOf;
}) {
  const now = useNowTick(hasFlowingDuration(runs));
  return (
    <ul aria-label="런 목록" className="min-h-0 flex-1 overflow-y-auto">
      {runs.map((run) => (
        <li key={run.id}>
          <RunCard
            run={run}
            expanded={isExpanded(run.id)}
            onToggle={() => onToggle(run.id)}
            now={now}
            approval={approval}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * 런 하나의 카드. 머리: 에이전트 아바타 · 핸들 · 프로그램 배지(러너 에이전트만) · 상태 칩 · 시작 시각 · 소요 · 펼침 단추, 진행 중이면
 * 「런 중지」. 펼치면 그 런의 타임라인(`key={runId}` — 다른 카드의 펼침이 번지지 않는다), 접힌 끝난 런은 이미 받아 둔 이벤트가
 * 있을 때만 요약 한 줄(접힌 카드는 이벤트를 부르지 않는다 — 런이 수백 개인 채널)
 */
export function RunCard({
  run,
  expanded,
  onToggle,
  now,
  approval,
}: {
  run: ActivityRun;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  approval: ApprovalOf;
}) {
  const agent = useAgents().data?.find((a) => a.id === run.agentId);
  const who = agent ? `@${agent.handle}` : UNKNOWN_AGENT;
  const label = runStatusLabel(run.status);
  const running = !TERMINAL.has(run.status);
  const duration = runDurationMs(run, now);
  const bodyId = useId();

  return (
    <section
      aria-label={`${who} 런, ${label}`}
      data-run-id={run.id}
      data-expanded={expanded ? "true" : "false"}
      className="border-b"
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-accent",
            "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          )}
        >
          {agent ? (
            <IdentityAvatar
              kind="agent"
              id={agent.id}
              name={agent.name}
              handle={agent.handle}
              avatarUrl={agent.avatarUrl}
              size={24}
            />
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
              <BotIcon aria-hidden className="size-3.5" />
            </span>
          )}
          <span className="min-w-0 truncate font-medium">{who}</span>
          {agent?.provider === "runner" && agent.program && <ProgramBadge program={agent.program} />}
          <span
            data-slot="run-status"
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              TONE_CLASS[runStatusTone(run.status)],
            )}
          >
            {label}
          </span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {run.startedAt ? TIME.format(new Date(run.startedAt)) : "—"}
            {duration !== undefined &&
              (run.frozenAt === undefined ? (
                ` · ${Math.round(duration / 1000)}초`
              ) : (
                // 멈춘 자리값 — 끝난 시각을 몰라 빠진 것을 **안** 시각에서 멈췄다. 실제보다 길 수 있어 흐리게 두고 까닭을 단다
                <span data-frozen="true" title={FROZEN_HINT} className="opacity-60">
                  {` · ${Math.round(duration / 1000)}초`}
                  <span className="sr-only"> ({FROZEN_HINT})</span>
                </span>
              ))}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
          />
        </button>
        {running && <StopRunButton runId={run.id} />}
      </div>
      {expanded ? (
        <div id={bodyId} className="pb-1">
          <RunTimeline key={run.id} runId={run.id} running={running} approval={approval} />
        </div>
      ) : (
        !running && <CollapsedSummary runId={run.id} />
      )}
    </section>
  );
}

/**
 * 접힌 끝난 런의 요약 한 줄. 캐시를 **보기만** 한다(`enabled: false`) — 펼쳐 본 적 있거나 응답 안 활동이 받아 둔 런만 요약이 있다.
 * 원본 이벤트(텍스트 포함)를 봐야 답을 센다
 */
function CollapsedSummary({ runId }: { runId: string }) {
  const cached = useQuery({
    queryKey: qk.runEvents(runId),
    queryFn: async () => (await api<{ events: RunEvent[] }>("GET", `/runs/${runId}/events`)).events,
    enabled: false,
    meta: { silent: true },
  });
  const text = useMemo(() => cached.data && runSummaryLabel(summarizeRun(cached.data)), [cached.data]);
  if (!text) return null;
  return (
    <p data-slot="run-summary" className="truncate px-3 pb-2 pl-11 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

/**
 * 카드의 「런 중지」 — 버블의 중지와 같은 길(`run.abort`). 누른 뒤에는 「중지 중」으로 잠그고 런이 끝나 단추가 내려갈 때까지 그대로 둔다.
 * 잠금은 `aria-disabled` + 누름 무시(키보드 초점을 잃지 않게), ack 실패는 버블과 같은 문구로 토스트하고 다시 연다
 */
function StopRunButton({ runId }: { runId: string }) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const [stopping, setStopping] = useState(false);

  function stop() {
    if (!socket || stopping) return;
    setStopping(true);
    emitAck(socket, "run.abort", { runId }).catch((e: unknown) => {
      const message = abortErrorMessage(e);
      toast.error(message, { id: `run-abort:${message}` });
      setStopping(false);
    });
  }

  return (
    <Button
      variant="outline"
      size="xs"
      disabled={!socket || !connected}
      aria-disabled={stopping || undefined}
      aria-label={stopping ? "런 중지 중" : "런 중지"}
      onClick={stop}
    >
      <SquareIcon aria-hidden />
      {stopping ? "중지 중…" : "중지"}
    </Button>
  );
}
