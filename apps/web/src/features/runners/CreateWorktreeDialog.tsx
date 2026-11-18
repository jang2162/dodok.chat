import type { RunnerProject, RunnerSummary } from "@dodok/shared";
import { GitBranchIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ReasonHint } from "@/features/components/DisabledHint";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { worktreeLock } from "./copy";
import { useCreateWorktree } from "./mutations";
import { useWorktreeDraft, WorktreeFields, worktreeCreateError } from "./worktreeFields";

/**
 * 「워크트리 만들기」(워크트리 스펙 5.5) — git 저장소 프로젝트 줄의 단추. 이름·브랜치(기본 `dodok/<슬러그>`)·위치(기본
 * `<부모 경로>/.worktrees/<슬러그>`). 러너가 폴더·브랜치를 만든 뒤 하위 프로젝트 줄이 생긴다. 끊긴 러너·옛 러너·git 아님·보관은
 * 단추를 잠그고 사유 한 줄(`worktreeLock`)
 */
export function CreateWorktreeDialog({
  parent,
  runner,
  a11yName,
}: {
  parent: RunnerProject;
  runner: RunnerSummary;
  /** 줄의 접근성 이름(「dodok (내 저장소들/dodok)」) */
  a11yName: string;
}) {
  const [open, setOpen] = useState(false);
  const lock = worktreeLock(parent, runner);
  const hintId = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`${a11yName} 워크트리 만들기`}
          disabled={lock !== undefined}
          aria-describedby={lock ? hintId : undefined}
        >
          <GitBranchIcon aria-hidden />
          워크트리 만들기
        </Button>
      </DialogTrigger>
      {lock && <ReasonHint id={hintId} text={lock} subject="워크트리 만들기" />}
      <DialogContent aria-describedby={undefined} className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>워크트리 만들기 — {parent.label}</DialogTitle>
        </DialogHeader>
        {open && <CreateWorktreeForm parent={parent} runner={runner} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateWorktreeForm({
  parent,
  runner,
  onDone,
}: {
  parent: RunnerProject;
  runner: RunnerSummary;
  onDone: () => void;
}) {
  const draft = useWorktreeDraft(parent);
  const create = useCreateWorktree(parent.id);
  const failure = create.isError ? worktreeCreateError(create.error) : undefined;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    draft.touch();
    if (!draft.valid || create.isPending) return;
    create.mutate(draft.body(), { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <WorktreeFields draft={draft} runner={runner} disabled={create.isPending} />
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{failure.text}</p>
            {failure.detail && <code className="font-mono text-xs break-all">{failure.detail}</code>}
          </AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={create.isPending} onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "만드는 중…" : "만들기"}
        </Button>
      </DialogFooter>
    </form>
  );
}
