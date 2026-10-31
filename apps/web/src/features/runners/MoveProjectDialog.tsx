import type { Agent, RunnerProject, RunnerSummary } from "@dodok/shared";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useAgents } from "@/api/queries";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { CHECK_REASON, runnerRequestError } from "./copy";
import { useMoveRunnerProject } from "./mutations";

/**
 * 옮길 러너의 천장 밖 에이전트(서버 400 `details.field === "runnerId"`, `agentIds` — 러너 일반화 계획 Task 5 Step 3b′). 에이전트마다
 * 사유를 다시 묻지 않고 이름을 늘어놓는다. 목록에 없는 id 는 건너뛴다
 */
export function ceilingBlockedText(
  agentIds: readonly string[],
  agents: readonly Agent[] | undefined,
): string {
  const names = agentIds.flatMap((id) => {
    const agent = agents?.find((a) => a.id === id);
    return agent ? [`@${agent.handle}`] : [];
  });
  const list = names.length > 0 ? names.join(", ") : `${agentIds.length}개`;
  return `이 러너의 설정이 허용하지 않는 에이전트가 있습니다: ${list} — 먼저 권한·도구를 낮추거나 보관하세요`;
}

/** 옮기기 실패 문구 — 서버 문구는 보이지 않는다 */
function moveError(e: unknown, agents: readonly Agent[] | undefined): string {
  const transport = runnerRequestError(e);
  if (transport) return transport;
  if (e instanceof ApiRequestError) {
    const details = e.details ?? {};
    if (e.code === "VALIDATION" && details.field === "runnerId" && Array.isArray(details.agentIds))
      return ceilingBlockedText(details.agentIds.map(String), agents);
    if (e.code === "VALIDATION" && typeof details.reason === "string" && details.reason in CHECK_REASON)
      return `옮길 러너에서 이 자리를 쓸 수 없습니다 — ${CHECK_REASON[details.reason as keyof typeof CHECK_REASON]}`;
    if (e.code === "CONFLICT")
      return "옮길 러너에 같은 자리의 프로젝트가 이미 있거나, 토큰이 폐기된 러너입니다";
    if (e.code === "NOT_FOUND") return "프로젝트나 러너가 이미 없습니다 — 목록을 다시 보세요";
  }
  return "옮기지 못했습니다 — 다시 시도하세요";
}

/**
 * 「다른 러너로 옮기기」(러너 일반화 계획 판정 PR8) — 프로젝트와 그 에이전트(보관한 것도)가 함께 가고, 러너 세션은 새로 열린다(세션
 * 전사는 옛 머신에 있다). 옮길 러너는 폐기하지 않은 다른 러너 가운데 붙어 있는 것만 고른다 — 서버가 그 러너에 같은 자리를 확인한다.
 * 옮기면 이 줄이 카드에서 빠지므로 초점을 `afterMove()` 로 옮긴다
 */
export function MoveProjectDialog({
  project,
  runner,
  runners,
  afterMove,
}: {
  project: RunnerProject;
  runner: RunnerSummary;
  runners: readonly RunnerSummary[];
  afterMove: () => HTMLElement | null;
}) {
  const move = useMoveRunnerProject();
  const agents = useAgents().data;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>();
  const [error, setError] = useState<string>();
  const sending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const errorLine = useRef<HTMLDivElement>(null);
  const focusError = useRef(false);
  useEffect(() => {
    if (error === undefined || !focusError.current) return;
    focusError.current = false;
    errorLine.current?.focus();
  }, [error]);
  const moved = useRef(false);
  const id = useId();
  const others = runners.filter((r) => r.id !== runner.id && !r.revoked);
  const picked = others.find((r) => r.id === target && r.connected);

  function onOpenChange(next: boolean) {
    if (!next && move.isPending) return;
    if (next) {
      setTarget(undefined);
      setError(undefined);
      moved.current = false;
    }
    setOpen(next);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!picked || sending.current) return;
    sending.current = true;
    setError(undefined);
    // 옮긴 목록이 다시 오면 이 줄(과 대화상자)이 먼저 사라진다 — 언마운트된 컴포넌트에는 mutate 의 콜백이 불리지 않으므로
    // mutateAsync 로 이어 초점을 직접 옮긴다. 실패면 누른 「옮기기」가 기다리는 동안 잠겨 초점이 body 로 떨어졌다 — 그 버튼은 실패 뒤에도
    // 잠겨 있을 수 있으므로(옮길 러너가 끊겨 고른 것이 사라짐) 잠기지 않는 오류 줄로 옮긴다(아래 효과 — 오류가 그려진 뒤)
    move.mutateAsync({ id: project.id, runnerId: picked.id }).then(
      () => {
        sending.current = false;
        moved.current = true;
        setOpen(false);
        requestAnimationFrame(() => afterMove()?.focus());
      },
      (err: unknown) => {
        sending.current = false;
        focusError.current = true;
        setError(moveError(err, agents));
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        ref={trigger}
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${project.label} 옮기기`}
        onClick={() => onOpenChange(true)}
      >
        옮기기
      </Button>
      <DialogContent
        closeDisabled={move.isPending}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          (moved.current ? afterMove() : trigger.current)?.focus();
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>「{project.label}」 다른 러너로 옮기기</DialogTitle>
            <DialogDescription>
              프로젝트와 그 에이전트가 함께 옮겨 갑니다. 옮길 러너의 같은 루트 id·경로에 같은 디렉터리가
              있어야 하고, 에이전트는 새 세션에서 시작합니다(앞 작업 맥락은 옛 머신에 남습니다).
            </DialogDescription>
          </DialogHeader>
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">옮길 다른 러너가 없습니다.</p>
          ) : (
            <fieldset className="grid gap-2" disabled={move.isPending}>
              <legend className="mb-1 text-sm font-medium">옮길 러너</legend>
              <RadioGroup
                value={target ?? ""}
                onValueChange={(v) => {
                  setTarget(v);
                  setError(undefined);
                }}
                className="flex flex-col gap-2"
              >
                {others.map((r) => (
                  <div key={r.id} className="flex items-center gap-2">
                    <RadioGroupItem id={`${id}-${r.id}`} value={r.id} disabled={!r.connected} />
                    <Label
                      htmlFor={`${id}-${r.id}`}
                      className={r.connected ? "font-normal" : "font-normal text-muted-foreground"}
                    >
                      {r.label}
                      {!r.connected && " (끊김)"}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
          )}
          {error !== undefined && (
            <Alert ref={errorLine} tabIndex={-1} variant="destructive" className="outline-none">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!picked || move.isPending}>
              {move.isPending ? "옮기는 중…" : "옮기기"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
