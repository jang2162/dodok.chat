import type { BackgroundTask } from "@dodok/shared";
import { SquareIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { emitAck, useWireStatus, WireAckError } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";

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

/**
 * 런 카드의 백그라운드 작업 줄(스펙 5.7) — 카드가 접혀 있어도 보인다. 러너가 끊겼으면 줄을 흐리고 「러너 연결 끊김」, 「종료」는 없다.
 * 「종료」는 그 런의 「중지」와 같은 판정이다 — 런을 볼 수 있으면 누구나(서버 task.stop 이 run.abort 와 같은 볼 수 있음 판정),
 * wire 가 붙어 있지 않으면 비활성
 */
export function BackgroundTasks({
  originRunId,
  tasks,
  runnerConnected,
  now,
}: {
  originRunId: string;
  tasks: readonly BackgroundTask[];
  runnerConnected: boolean;
  now: number;
}) {
  // NOT_FOUND 로 답한 작업 — 서버가 그 런을 모른다(볼 수 없게 됐다). 다음 tasks.updated 를 기다리지 않고 줄을 지운다
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const shown = tasks.filter((t) => !gone.has(t.taskId));
  if (shown.length === 0) return null;
  return (
    <ul
      aria-label={backgroundChipLabel(shown.length)}
      data-slot="background-tasks"
      data-runner-connected={runnerConnected ? "true" : "false"}
      className={cn("flex flex-col gap-0.5 px-3 pb-2 pl-11 text-xs", !runnerConnected && "opacity-60")}
    >
      {!runnerConnected && <li className="text-muted-foreground">{RUNNER_DISCONNECTED_TEXT}</li>}
      {shown.map((task) => (
        <TaskRow
          key={task.taskId}
          originRunId={originRunId}
          task={task}
          runnerConnected={runnerConnected}
          now={now}
          onGone={() => setGone((prev) => new Set(prev).add(task.taskId))}
        />
      ))}
    </ul>
  );
}

function TaskRow({
  originRunId,
  task,
  runnerConnected,
  now,
  onGone,
}: {
  originRunId: string;
  task: BackgroundTask;
  runnerConnected: boolean;
  now: number;
  onGone: () => void;
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
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {elapsedLabel(task.startedAt, now)}
        </span>
        {runnerConnected && (
          <StopTaskButton
            originRunId={originRunId}
            taskId={task.taskId}
            label={`${kind} ${task.description}`}
            onGone={onGone}
          />
        )}
      </div>
      {sub.length > 0 && <p className="truncate pl-3.5 text-muted-foreground">{sub.join(" · ")}</p>}
    </li>
  );
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
