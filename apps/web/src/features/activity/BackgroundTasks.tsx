import type { BackgroundTask } from "@dodok/shared";
import { SquareIcon } from "lucide-react";
import { useState } from "react";
import { useNowTick } from "@/hooks/useNowTick";
import { cn } from "@/lib/utils";
import { emitAck, useWireStatus, WireAckError } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { useBackgroundTaskStore } from "./useBackgroundTasks";

// 문구(백그라운드 작업 스펙 5.7·D6·D7 원문)
export const RUNNER_DISCONNECTED_TEXT = "러너 연결 끊김";
export const HELD_SETTINGS_TEXT = "백그라운드 작업 때문에 일부 설정은 이전 값으로 실행";
export const heldSlotsText = (n: number) =>
  `백그라운드 작업 ${n}개가 러너 자리를 쓰는 중 — 활동 탭에서 종료하면 이어집니다`;
export const backgroundChipText = (n: number) => `백그라운드 ${n}`;
export const backgroundChipLabel = (n: number) => `백그라운드 작업 ${n}개`;

const KIND_LABEL: Record<BackgroundTask["kind"], string> = {
  shell: "셸",
  subagent: "서브에이전트",
  other: "작업",
};

/** 걸린 시간 — 「N초째」·「N분째」·「N시간 M분째」. 시계가 시작보다 앞서 있으면 0초 */
export function elapsedLabel(startedAt: string, now: number): string {
  const sec = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (sec < 60) return `${sec}초째`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분째`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분째`;
}

/** 「종료」 실패 문구 — 러너 끊김·끄기 실패는 ADAPTER_UNAVAILABLE(서버 task.stop) */
function stopErrorMessage(e: unknown): string {
  if (!(e instanceof WireAckError)) return "작업을 종료하지 못했습니다";
  switch (e.code) {
    case "ADAPTER_UNAVAILABLE":
      return "러너에 닿지 않아 작업을 종료하지 못했습니다";
    case "TIMEOUT":
      return "서버 응답이 없어 작업을 종료하지 못했습니다";
    default:
      return `작업을 종료하지 못했습니다 (${e.code})`;
  }
}

/** 활동 패널 맨 위 묶음의 제목 — 받은 런 목록 밖(최근 50 너머)의 런이 띄운 작업(백그라운드 작업 스펙 5.7, 리뷰 B1) */
export const EARLIER_RUN_TASKS_TEXT = "이전 런의 백그라운드 작업";

/**
 * 런 카드의 백그라운드 작업 줄(스펙 5.7) — 카드가 접혀 있어도 보인다. 러너가 끊겼으면 줄을 흐리고 「러너 연결 끊김」, 「종료」는 없다.
 * 「종료」는 그 런의 「중지」와 같은 판정이다 — 런을 볼 수 있으면 누구나(서버 task.stop 이 run.abort 와 같은 볼 수 있음 판정),
 * wire 가 붙어 있지 않으면 비활성. 카드 없는 원래 런의 묶음(`EarlierRunTasks`)도 같은 줄을 쓴다
 */
export function BackgroundTasks({
  channelId,
  originRunId,
  tasks,
  runnerConnected,
  className,
}: {
  channelId: string;
  originRunId: string;
  tasks: readonly BackgroundTask[];
  runnerConnected: boolean;
  className?: string;
}) {
  if (tasks.length === 0) return null;
  // 같은 종류·설명의 작업이 둘 이상이면 「종료」 이름에 순번을 붙인다 — 이름만으로 어느 줄인지 갈리게(리뷰 N2)
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const t of tasks) total.set(nameOf(t), (total.get(nameOf(t)) ?? 0) + 1);
  return (
    <ul
      aria-label={backgroundChipLabel(tasks.length)}
      data-slot="background-tasks"
      data-runner-connected={runnerConnected ? "true" : "false"}
      className={cn(
        "flex flex-col gap-0.5 px-3 pb-2 pl-11 text-xs",
        !runnerConnected && "opacity-60",
        className,
      )}
    >
      {!runnerConnected && <li className="text-muted-foreground">{RUNNER_DISCONNECTED_TEXT}</li>}
      {tasks.map((task) => {
        const name = nameOf(task);
        const nth = (seen.get(name) ?? 0) + 1;
        seen.set(name, nth);
        return (
          <TaskRow
            key={task.taskId}
            channelId={channelId}
            originRunId={originRunId}
            task={task}
            label={(total.get(name) ?? 0) > 1 ? `${name} (${nth})` : name}
            runnerConnected={runnerConnected}
          />
        );
      })}
    </ul>
  );
}

const nameOf = (task: BackgroundTask) => `${KIND_LABEL[task.kind]} ${task.description}`;

/**
 * 받은 런 목록 밖의 런이 띄운 작업 묶음(리뷰 B1) — 그 런의 카드가 없어도 작업은 보이고 「종료」로 끌 수 있어야 한다(「종료」는
 * `originRunId` 로 보내므로 카드가 없어도 된다). 제목 옆에 작업 수, 원래 런마다 카드 안과 같은 줄
 */
export function EarlierRunTasks({
  channelId,
  runIds,
  byRun,
}: {
  channelId: string;
  runIds: readonly string[];
  byRun: (runId: string) => { tasks: readonly BackgroundTask[]; runnerConnected: boolean };
}) {
  const total = runIds.reduce((n, id) => n + byRun(id).tasks.length, 0);
  return (
    <section
      aria-label={`${EARLIER_RUN_TASKS_TEXT} ${total}개`}
      data-slot="earlier-run-tasks"
      className="max-h-[40%] shrink-0 overflow-y-auto border-b pt-1.5"
    >
      <h3 className="flex items-center gap-1.5 px-3 pb-1 text-xs font-medium text-muted-foreground">
        {EARLIER_RUN_TASKS_TEXT}
        <span className="rounded-full bg-muted px-1.5 tabular-nums">{total}</span>
      </h3>
      {runIds.map((id) => {
        const { tasks, runnerConnected } = byRun(id);
        return (
          <BackgroundTasks
            key={id}
            channelId={channelId}
            originRunId={id}
            tasks={tasks}
            runnerConnected={runnerConnected}
            className="pl-3"
          />
        );
      })}
    </section>
  );
}

function TaskRow({
  channelId,
  originRunId,
  task,
  label,
  runnerConnected,
}: {
  channelId: string;
  originRunId: string;
  task: BackgroundTask;
  label: string;
  runnerConnected: boolean;
}) {
  const kind = KIND_LABEL[task.kind];
  const sub =
    task.kind === "subagent"
      ? [task.subagentType, task.summary, task.lastToolName].filter((v) => v !== undefined && v !== "")
      : [];
  return (
    <li data-task-id={task.taskId} className="flex flex-col gap-0.5">
      <div className="flex min-h-6 items-center gap-2">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {kind}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{task.description}</span>
        <Elapsed startedAt={task.startedAt} />
        {runnerConnected && (
          <StopTaskButton
            originRunId={originRunId}
            taskId={task.taskId}
            label={label}
            onGone={() => useBackgroundTaskStore.getState().drop(channelId, task.taskId)}
          />
        )}
      </div>
      {sub.length > 0 && <p className="truncate pl-3.5 text-muted-foreground">{sub.join(" · ")}</p>}
    </li>
  );
}

/**
 * 걸린 시간 칸 — 이 칸만 1초 틱을 받는다(리뷰 M1). 작업은 시간 상한이 없어(D2) 런 카드 목록 전체를 매초 다시 그리면 탭을 여는 내내
 * 카드 수십 개가 렌더된다. 공용 시계라 줄끼리, 런 카드의 소요와도 같은 틱에 넘어간다
 */
function Elapsed({ startedAt }: { startedAt: string }) {
  const now = useNowTick(true);
  return <span className="shrink-0 tabular-nums text-muted-foreground">{elapsedLabel(startedAt, now)}</span>;
}

/**
 * 「종료」 — `task.stop { runId: 작업의 originRunId, taskId }`. 누른 뒤 응답 전까지 잠근다(`aria-disabled` + 누름 무시 — 초점을 잃지
 * 않게, 런 카드의 「중지」와 같다). 성공이면 줄은 러너의 tasks.update 가 지우고, NOT_FOUND 면 그 자리에서 줄을 지우고, 그 밖의 실패는
 * 그 줄에 짧게 알리고 다시 연다
 */
function StopTaskButton({
  originRunId,
  taskId,
  label,
  onGone,
}: {
  originRunId: string;
  taskId: string;
  label: string;
  onGone: () => void;
}) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();

  function stop() {
    if (!socket || stopping) return;
    setStopping(true);
    setError(undefined);
    emitAck(socket, "task.stop", { runId: originRunId, taskId }).then(
      () => setStopping(false),
      (e: unknown) => {
        setStopping(false);
        if (e instanceof WireAckError && e.code === "NOT_FOUND") onGone();
        else setError(stopErrorMessage(e));
      },
    );
  }

  return (
    <>
      {error && (
        <span role="alert" className="shrink-0 text-destructive">
          {error}
        </span>
      )}
      <Button
        variant="outline"
        size="xs"
        disabled={!socket || !connected}
        aria-disabled={stopping || undefined}
        aria-label={stopping ? `${label} 종료 중` : `${label} 종료`}
        onClick={stop}
      >
        <SquareIcon aria-hidden />
        {stopping ? "종료 중…" : "종료"}
      </Button>
    </>
  );
}
