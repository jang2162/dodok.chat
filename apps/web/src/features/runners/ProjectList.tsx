import type { RunnerProject, RunnerProjectCheck, RunnerSummary } from "@dodok/shared";
import { ChevronRightIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import {
  PROJECT_LABEL_MAX,
  PROJECT_LABEL_RULE,
  ROOT_MISSING,
  checkText,
  projectPlace,
  runnerRequestError,
} from "./copy";
import { MoveProjectDialog } from "./MoveProjectDialog";
import { useArchiveRunnerProject, useCheckRunnerProject, useRenameRunnerProject } from "./mutations";
import { useRunnerProjects } from "./queries";

/**
 * 러너 카드 안의 프로젝트 목록 — 보관하지 않은 것은 줄마다 라벨·자리·에이전트 수와 「확인」·이름 바꾸기·옮기기·보관, 보관한 것은 아래
 * 접힌 묶음에 이름만. 보관·옮기기로 줄이 빠지면 초점을 `afterRemove`(그 카드의 「프로젝트 추가」)로 옮긴다
 */
export function ProjectList({
  runner,
  runners,
  afterRemove,
}: {
  runner: RunnerSummary;
  runners: readonly RunnerSummary[];
  afterRemove: RefObject<HTMLButtonElement | null>;
}) {
  const projects = useRunnerProjects(runner.id);
  if (projects.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  if (!projects.data)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">프로젝트 목록을 불러오지 못했습니다</p>
        <Button variant="outline" size="sm" onClick={() => void projects.refetch()}>
          다시 시도
        </Button>
      </div>
    );
  const active = projects.data.filter((p) => p.archivedAt === null);
  const archived = projects.data.filter((p) => p.archivedAt !== null);
  return (
    <>
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">프로젝트가 없습니다.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {active.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              runner={runner}
              runners={runners}
              afterRemove={afterRemove}
            />
          ))}
        </ul>
      )}
      {archived.length > 0 && <ArchivedProjects projects={archived} />}
    </>
  );
}

/**
 * 프로젝트 한 줄. 자리는 `루트 라벨/relPath` — 붙은 러너가 그 루트를 알리지 않으면 「루트 없음」(Review Focus 2: 머신 주인이 루트 id 를
 * 바꾸거나 지움). 러너가 끊겨 있으면 루트 라벨을 모를 뿐이라 「루트 없음」을 달지 않는다(카드에 「끊김」이 있다).
 * git 여부는 프로젝트 행에 없다 — 「확인」(러너 project.check) 결과로 보인다
 */
function ProjectRow({
  project,
  runner,
  runners,
  afterRemove,
}: {
  project: RunnerProject;
  runner: RunnerSummary;
  runners: readonly RunnerSummary[];
  afterRemove: RefObject<HTMLButtonElement | null>;
}) {
  const check = useCheckRunnerProject();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const live = runner.connected && !runner.revoked;
  const rootMissing = live && project.rootLabel === null;

  function runCheck() {
    if (check.isPending) return;
    setResult(undefined);
    check.mutate(project.id, {
      onSuccess: (r: RunnerProjectCheck) => setResult({ ok: r.ok, text: checkText(r) }),
      onError: (e) =>
        setResult({ ok: false, text: runnerRequestError(e) ?? "확인하지 못했습니다 — 다시 시도하세요" }),
    });
  }

  return (
    <li aria-label={project.label} className="flex flex-col gap-2 px-3 py-2.5 text-sm">
      {renaming ? (
        <RenameForm
          project={project}
          onClose={() => {
            setRenaming(false);
            // 이름 칸이 사라진다 — 초점을 다시 그려지는 「이름 바꾸기」로
            requestAnimationFrame(() => renameButton.current?.focus());
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{project.label}</span>
              {rootMissing && <Badge variant="destructive">{ROOT_MISSING}</Badge>}
            </div>
            <p className="text-xs break-all text-muted-foreground">
              <code className="font-mono">{projectPlace(project)}</code> · 에이전트 {project.agentCount}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`${project.label} 확인`}
              disabled={check.isPending || !live}
              onClick={runCheck}
            >
              {check.isPending ? "확인하는 중…" : "확인"}
            </Button>
            <Button
              ref={renameButton}
              type="button"
              size="sm"
              variant="outline"
              aria-label={`${project.label} 이름 바꾸기`}
              onClick={() => setRenaming(true)}
            >
              이름 바꾸기
            </Button>
            <MoveProjectDialog project={project} runner={runner} runners={runners} afterMove={afterRemove} />
            <ArchiveProjectButton project={project} afterArchive={afterRemove} />
          </div>
        </div>
      )}
      <p
        aria-live="polite"
        className={cn("text-xs empty:hidden", result?.ok === false && "text-destructive")}
      >
        {result?.text}
      </p>
    </li>
  );
}

/** 이름 바꾸기 — 빈 이름·64자 넘음은 보내기 전에 막는다. 서버 VALIDATION 도 같은 문구 */
function RenameForm({ project, onClose }: { project: RunnerProject; onClose: () => void }) {
  const rename = useRenameRunnerProject();
  const [draft, setDraft] = useState(project.label);
  const [error, setError] = useState<string>();
  const id = useId();
  const trimmed = draft.trim();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (rename.isPending) return;
    if (trimmed === "" || trimmed.length > PROJECT_LABEL_MAX) {
      setError(PROJECT_LABEL_RULE);
      return;
    }
    rename.mutate(
      { id: project.id, label: trimmed },
      {
        onSuccess: onClose,
        // 그 밖(네트워크·404)은 전역 토스트가 알린다
        onError: (err) => {
          if (err instanceof ApiRequestError && err.code === "VALIDATION") setError(PROJECT_LABEL_RULE);
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`${project.label} 새 이름`}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="h-8 max-w-xs"
          value={draft}
          maxLength={PROJECT_LABEL_MAX}
          autoFocus
          disabled={rename.isPending}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
          }}
        />
        <Button type="submit" size="sm" disabled={rename.isPending}>
          {rename.isPending ? "저장 중…" : "저장"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={rename.isPending} onClick={onClose}>
          취소
        </Button>
      </div>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </form>
  );
}

/** 보관 — 확인을 거친다. 이미 있는 에이전트는 남고 계속 답한다(스펙 8장) — 멈추려면 에이전트를 삭제한다 */
function ArchiveProjectButton({
  project,
  afterArchive,
}: {
  project: RunnerProject;
  afterArchive: RefObject<HTMLButtonElement | null>;
}) {
  const archive = useArchiveRunnerProject();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  // 보관에 성공하면 줄과 이 버튼이 사라진다 — 초점은 카드의 「프로젝트 추가」로
  const returnFocus = useRef<HTMLElement | null>(null);

  function confirm() {
    if (sending.current) return;
    sending.current = true;
    archive.mutate(project.id, {
      onSuccess: () => {
        returnFocus.current = afterArchive.current;
        setOpen(false);
      },
      onSettled: () => {
        sending.current = false;
      },
    });
  }

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${project.label} 보관`}
        onClick={() => {
          returnFocus.current = trigger.current;
          setOpen(true);
        }}
      >
        보관
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`「${project.label}」 프로젝트를 보관할까요?`}
        description={
          project.agentCount > 0
            ? `보관하면 이 프로젝트에 새 에이전트를 만들 수 없습니다. 이미 있는 에이전트 ${project.agentCount}개는 남아 계속 답합니다 — 멈추려면 그 에이전트를 삭제하세요.`
            : "보관하면 이 프로젝트에 새 에이전트를 만들 수 없습니다."
        }
        confirmLabel="보관"
        pendingLabel="보관하는 중…"
        pending={archive.isPending}
        returnFocus={returnFocus}
        onConfirm={confirm}
      />
    </>
  );
}

/** 보관한 프로젝트 — 이름·자리만. 되돌리는 경로는 없다(같은 자리에 프로젝트를 새로 더한다) */
function ArchivedProjects({ projects }: { projects: readonly RunnerProject[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon aria-hidden className={cn("transition-transform", open && "rotate-90")} />
        보관한 프로젝트 {projects.length}
      </Button>
      {open && (
        <ul id={listId} className="flex flex-col gap-1 pl-2 text-sm text-muted-foreground">
          {projects.map((p) => (
            <li key={p.id} aria-label={p.label}>
              {p.label} · <code className="font-mono text-xs">{projectPlace(p)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
