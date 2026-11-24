import type { RunnerProject, RunnerProjectCheck, RunnerSummary } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { OverflowMenu, type OverflowMenuItem } from "@/features/connections/DetailCard";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import {
  ARCHIVE_BLOCKED,
  KEEP_FOLDER,
  PROJECT_LABEL_MAX,
  PROJECT_LABEL_RULE,
  ROOT_MISSING,
  WORKTREE_ARCHIVE_NOTE,
  WORKTREE_CLEANUP_REASON,
  checkText,
  projectPlace,
  runnerRequestError,
} from "./copy";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { MoveProjectDialog } from "./MoveProjectDialog";
import { useArchiveRunnerProject, useCheckRunnerProject, useRenameRunnerProject } from "./mutations";
import { useRunnerProjects } from "./queries";

/**
 * 줄·버튼의 접근성 이름 — 라벨에 자리를 붙인다(「dodok (src/dodok)」). 라벨이 같은 프로젝트(`src/dodok`·`src/.config/dodok`)가
 * 눈에는 자리로 갈리지만 이름이 같으면 화면 읽기·음성 제어가 둘을 못 가른다(t6 보고 O2). 화면 글은 그대로다
 */
function a11yName(project: Pick<RunnerProject, "label" | "rootId" | "rootLabel" | "relPath">): string {
  return `${project.label} (${projectPlace(project)})`;
}

/**
 * 러너 상세의 프로젝트 목록 — 보관하지 않은 것은 줄마다 라벨(그 프로젝트 상세 링크)·자리·에이전트 수와 「워크트리 만들기」, 드문 동작은
 * 「⋯」 메뉴(확인·이름 바꾸기·옮기기·보관 — 연결 재설계 스펙 목표 3),
 * 보관한 것은 아래 접힌 묶음에 이름만. 보관·옮기기로 줄이 빠지면 초점을 `afterRemove()`(「프로젝트 추가」, 잠겼으면 상세 머리)로 옮긴다
 */
export function ProjectList({
  runner,
  runners,
  afterRemove,
}: {
  runner: RunnerSummary;
  runners: readonly RunnerSummary[];
  afterRemove: () => HTMLElement | null;
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
  // 워크트리는 부모 줄 아래로(워크트리 스펙 5.5) — 부모가 목록에 없으면 맨 위 줄로
  const activeIds = new Set(active.map((p) => p.id));
  const top = active.filter((p) => p.parentProjectId === null || !activeIds.has(p.parentProjectId));
  return (
    <>
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">프로젝트가 없습니다.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {top.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              runner={runner}
              runners={runners}
              afterRemove={afterRemove}
              worktrees={active.filter((p) => p.parentProjectId === project.id)}
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
export function ProjectRow({
  project,
  runner,
  runners,
  afterRemove,
  linked = true,
  worktrees = [],
}: {
  project: RunnerProject;
  runner: RunnerSummary;
  runners: readonly RunnerSummary[];
  afterRemove: () => HTMLElement | null;
  /** 라벨이 그 프로젝트 상세로 가는 링크인가 — 프로젝트 상세 안에서는 아니다 */
  linked?: boolean;
  /** 이 프로젝트 아래의 보관하지 않은 워크트리 — 줄 아래 들여 그린다 */
  worktrees?: readonly RunnerProject[];
}) {
  const check = useCheckRunnerProject();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // 「⋯」 — 메뉴로 연 동작(이름 바꾸기 칸·대화상자)이 닫히면 초점이 돌아올 자리
  const menuButton = useRef<HTMLButtonElement>(null);
  const live = runner.connected && !runner.revoked;
  const rootMissing = live && project.rootLabel === null;
  const isWorktree = project.parentProjectId !== null;
  // 러너가 폐기된 워크트리는 폴더를 지울 수 없다 — 「보관」 대신 「폴더를 남기고 보관」만(ArchiveProject)
  const archiveBlocked = isWorktree && runner.revoked;
  const menuItems: OverflowMenuItem[] = [
    {
      label: check.isPending ? "확인하는 중…" : "확인",
      disabled: check.isPending || !live,
      onSelect: runCheck,
    },
    { label: "이름 바꾸기", onSelect: () => setRenaming(true) },
    // 워크트리는 옮기지 않는다(W9)
    ...(isWorktree ? [] : [{ label: "옮기기", onSelect: () => setMoving(true) }]),
    ...(archiveBlocked ? [] : [{ label: "보관", danger: true, onSelect: () => setArchiving(true) }]),
  ];

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
    <li aria-label={a11yName(project)} className="flex flex-col gap-2 px-3 py-2.5 text-sm">
      {renaming ? (
        <RenameForm
          project={project}
          onClose={() => {
            setRenaming(false);
            // 이름 칸이 사라진다 — 초점을 다시 그려지는 「⋯」로
            requestAnimationFrame(() => menuButton.current?.focus());
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              {linked ? (
                <Link
                  to="/settings/connection/project/$projectId"
                  params={{ projectId: project.id }}
                  className="font-medium break-all underline-offset-4 hover:underline"
                >
                  {project.label}
                </Link>
              ) : (
                <span className="font-medium break-all">{project.label}</span>
              )}
              {rootMissing && <Badge variant="destructive">{ROOT_MISSING}</Badge>}
            </div>
            <p className="text-xs break-all text-muted-foreground">
              {isWorktree && project.branch && (
                <>
                  <code className="font-mono">{project.branch}</code> ·{" "}
                </>
              )}
              <code className="font-mono">{projectPlace(project)}</code>
              {project.isGit && " · git"} · 에이전트 {project.agentCount}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {!isWorktree && (
              <CreateWorktreeDialog parent={project} runner={runner} a11yName={a11yName(project)} />
            )}
            <OverflowMenu label={`${a11yName(project)} 더 보기`} items={menuItems} triggerRef={menuButton} />
          </div>
        </div>
      )}
      {!isWorktree && (
        <MoveProjectDialog
          project={project}
          runner={runner}
          runners={runners}
          afterMove={afterRemove}
          open={moving}
          onOpenChange={setMoving}
          returnFocus={menuButton}
        />
      )}
      <ArchiveProject
        project={project}
        runner={runner}
        afterArchive={afterRemove}
        open={archiving}
        onOpenChange={setArchiving}
        returnFocus={menuButton}
      />
      <p
        aria-live="polite"
        className={cn("text-xs empty:hidden", result?.ok === false && "text-destructive")}
      >
        {result?.text}
      </p>
      {worktrees.length > 0 && (
        <ul aria-label={`${project.label} 워크트리`} className="flex flex-col divide-y border-l pl-3">
          {worktrees.map((wt) => (
            <ProjectRow
              key={wt.id}
              project={wt}
              runner={runner}
              runners={runners}
              afterRemove={afterRemove}
            />
          ))}
        </ul>
      )}
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
          aria-label={`${a11yName(project)} 새 이름`}
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

/**
 * 보관 — 줄의 「⋯」 메뉴가 열고 확인을 거친다. 일반 프로젝트의 이미 있는 에이전트는 남고 계속 답한다(스펙 8장) — 멈추려면 에이전트를 삭제한다. 워크트리는
 * 러너가 폴더를 지워야 보관된다(W7) — 정리가 실패하면(409) 그 줄에 사유와 「폴더를 남기고 보관」(W12). 러너가 폐기됐으면 처음부터
 * 그 단추만. 보관이 막힌 사유(워크트리·에이전트가 남음)도 그 줄에
 */
function ArchiveProject({
  project,
  runner,
  afterArchive,
  open,
  onOpenChange: setOpen,
  returnFocus: menuButton,
}: {
  project: RunnerProject;
  runner: RunnerSummary;
  afterArchive: () => HTMLElement | null;
  /** 「⋯」 메뉴의 「보관」이 연다 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const archive = useArchiveRunnerProject({ silent: true });
  const [failure, setFailure] = useState<{ text: string; keepFolder: boolean }>();
  const sending = useRef(false);
  // 대화상자가 닫힌 뒤의 초점 — 취소면 「⋯」, 보관에 성공하면 줄이 사라지므로 카드의 「프로젝트 추가」(잠겼으면 카드 머리)
  const archived = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  if (!archived.current) returnFocus.current = menuButton.current;
  const isWorktree = project.parentProjectId !== null;
  const revoked = isWorktree && runner.revoked;
  // 지난 시도의 정리 실패 사유(서버가 그 줄에 남겼다) — 이번 시도의 사유가 있으면 그것
  const savedIssue = revoked ? "runner_revoked" : (project.cleanupIssue ?? undefined);
  const shown =
    failure ??
    (isWorktree && savedIssue !== undefined
      ? { text: WORKTREE_CLEANUP_REASON[savedIssue] ?? WORKTREE_CLEANUP_REASON.git_failed!, keepFolder: true }
      : undefined);

  function send(keepFolder: boolean) {
    if (sending.current) return;
    sending.current = true;
    setFailure(undefined);
    // 보관을 받은 목록이 다시 오면 이 줄(과 확인 대화상자)이 먼저 사라진다 — 언마운트된 컴포넌트에는 mutate 의 콜백이 불리지 않아
    // 대화상자의 초점 되돌리기도 돌지 않으므로, mutateAsync 로 이어 초점을 직접 옮긴다
    archive.mutateAsync({ id: project.id, ...(keepFolder ? { keepFolder: true } : {}) }).then(
      () => {
        sending.current = false;
        archived.current = true;
        returnFocus.current = afterArchive();
        setOpen(false);
        requestAnimationFrame(() => afterArchive()?.focus());
      },
      (err: unknown) => {
        sending.current = false;
        setOpen(false);
        setFailure(archiveFailure(err));
      },
    );
  }

  return (
    <>
      {shown?.keepFolder && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`${a11yName(project)} ${KEEP_FOLDER}`}
          disabled={archive.isPending}
          onClick={() => send(true)}
        >
          {KEEP_FOLDER}
        </Button>
      )}
      {shown && <p className="text-xs text-destructive">{shown.text}</p>}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`「${project.label}」 ${isWorktree ? "워크트리" : "프로젝트"}를 보관할까요?`}
        description={
          isWorktree
            ? WORKTREE_ARCHIVE_NOTE
            : project.agentCount > 0
              ? `보관하면 이 프로젝트에 새 에이전트를 만들 수 없습니다(있는 에이전트 ${project.agentCount}개는 계속 답합니다).`
              : "보관하면 이 프로젝트에 새 에이전트를 만들 수 없습니다."
        }
        confirmLabel="보관"
        pendingLabel={isWorktree ? "폴더를 지우는 중…" : "보관하는 중…"}
        pending={archive.isPending}
        returnFocus={returnFocus}
        onConfirm={() => send(false)}
      />
    </>
  );
}

/** 보관 실패 — 정리 실패(409 details.reason)는 「폴더를 남기고 보관」과 함께, 막힘(워크트리·에이전트가 남음)은 사유만 */
function archiveFailure(err: unknown): { text: string; keepFolder: boolean } {
  const transport = runnerRequestError(err);
  if (transport) return { text: transport, keepFolder: false };
  if (err instanceof ApiRequestError) {
    const reason = typeof err.details?.reason === "string" ? err.details.reason : undefined;
    if (reason && reason in WORKTREE_CLEANUP_REASON)
      return { text: WORKTREE_CLEANUP_REASON[reason] ?? err.message, keepFolder: true };
    if (reason && reason in ARCHIVE_BLOCKED)
      return { text: ARCHIVE_BLOCKED[reason] ?? err.message, keepFolder: false };
  }
  return { text: "보관하지 못했습니다 — 다시 시도하세요", keepFolder: false };
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
            <li key={p.id} aria-label={a11yName(p)}>
              {p.label} · <code className="font-mono text-xs">{projectPlace(p)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
