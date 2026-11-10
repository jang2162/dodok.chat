import { RunnerRelPath, type RunnerSummary } from "@dodok/shared";
import { FolderIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/api/http";
import { qk } from "@/api/queries";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import {
  BROWSE_OFF,
  CHECK_REASON,
  PROJECT_LABEL_MAX,
  PROJECT_LABEL_RULE,
  RUNNER_OFFLINE,
  runnerRequestError,
} from "./copy";
import { useCreateRunnerProject } from "./mutations";
import { useRunnerFs } from "./queries";

/** 둘러보기 목록이 잘렸을 때(러너 fs.list 는 이름순 500개) */
export const TRUNCATED_NOTE = "500개까지만 보입니다 — 찾는 디렉터리가 없으면 경로를 직접 입력하세요";
/** 직접 입력한 경로가 shared `RunnerRelPath` 밖 */
export const REL_PATH_RULE = "루트 안의 상대 경로로 적으세요 — 앞의 /, .., \\ 없이 / 로 나눕니다";
/** 둘러보기 429 — 서버가 사용자당 분당 60번으로 막는다(`LIMITS.runnerBrowsePerMin`) */
export const BROWSE_RATE_LIMITED = "잠시 뒤 다시 시도하세요 — 둘러보기는 1분에 60번까지입니다";
/** 둘러보기 줄의 이름이 `RunnerRelPath` 를 못 지난다(\·NUL 이 든 이름 — macOS·Linux 에서는 쓸 수 있다) */
export const UNUSABLE_NAME = "고를 수 없는 이름입니다(\\ 등이 들어 있음) — 디렉터리 이름을 바꾸세요";
/** 열린 대화상자의 러너가 붙어 있지만 루트를 하나도 알리지 않는다 */
const NO_ROOTS = "러너가 알린 루트가 없습니다 — 러너 머신의 설정에서 루트를 확인하세요";

/** 고른 자리 — `git` 은 둘러보기에서 고른 디렉터리만 안다(직접 입력·루트 자신은 모른다) */
type Picked = { rootId: string; relPath: string; git?: boolean };

/** 더하기 실패 문구 — 서버가 먼저 러너 project.check 를 묻는다(실패면 400 `details.reason`) */
function createError(e: unknown): string {
  const transport = runnerRequestError(e);
  if (transport) return transport;
  if (e instanceof ApiRequestError) {
    const reason = e.details?.reason;
    if (e.code === "VALIDATION" && typeof reason === "string" && reason in CHECK_REASON)
      return CHECK_REASON[reason as keyof typeof CHECK_REASON];
    if (e.code === "VALIDATION") return e.details?.field === "label" ? PROJECT_LABEL_RULE : REL_PATH_RULE;
    if (e.code === "CONFLICT")
      return "이 러너에 같은 자리의 프로젝트가 이미 있거나, 토큰이 폐기된 러너입니다";
  }
  return "프로젝트를 더하지 못했습니다 — 다시 시도하세요";
}

/** 서버가 비워 둔 라벨에 붙이는 이름 — 경로 마지막 성분, 루트 자신이면 루트 라벨 */
const defaultLabel = (picked: Picked, rootLabel: string) => picked.relPath.split("/").at(-1) || rootLabel;

/**
 * 「프로젝트 추가」(러너 일반화 스펙 7장) — 루트 고르기 → 둘러보기(빵 부스러기·git 표시) 또는 상대 경로 직접 입력 → 자리와 이름을
 * 보고 더하기. 자리의 확인(project.check)은 더하기가 한다 — 따로 묻는 경로가 없다. 그래서 확인 실패 사유는 더하기 결과에 보인다.
 * 러너가 둘러보기를 껐으면(hello `browse: false` 또는 fs 403) 직접 입력만 남는다. 붙어 있지 않은 러너면 열 수 없다
 */
export function AddProjectDialog({
  runner,
  triggerRef,
}: {
  runner: RunnerSummary;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const create = useCreateRunnerProject(runner.id);
  const [rootId, setRootId] = useState<string>();
  const [denied, setDenied] = useState(false);
  const [mode, setMode] = useState<"browse" | "type">("browse");
  const [picked, setPicked] = useState<Picked>();
  const live = runner.connected && !runner.revoked && runner.roots.length > 0;
  const root = runner.roots.find((r) => r.id === rootId) ?? runner.roots[0];
  const browseOff = runner.browse === false || denied;
  const typing = browseOff || mode === "type";
  const rootFieldId = useId();

  function onOpenChange(next: boolean) {
    if (!next && create.isPending) return;
    if (next) {
      // 지난번에 받은 둘러보기는 버린다 — 그새 디렉터리가 바뀌었을 수 있다
      qc.removeQueries({ queryKey: qk.runnerFsOf(runner.id) });
      setRootId(undefined);
      setDenied(false);
      setMode("browse");
      setPicked(undefined);
      create.reset();
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" disabled={!live}>
          <PlusIcon />
          프로젝트 추가
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} closeDisabled={create.isPending} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>프로젝트 추가 — {runner.label}</DialogTitle>
        </DialogHeader>
        {!runner.connected || runner.revoked ? (
          // 열어 둔 사이에 러너가 끊겼다(둘러보기·확인 어느 단계든) — 다시 붙으면 고른 자리 그대로 돌아온다
          <Alert variant="destructive">
            <AlertDescription>{RUNNER_OFFLINE}</AlertDescription>
          </Alert>
        ) : !root ? (
          <p className="text-sm text-muted-foreground">{NO_ROOTS}</p>
        ) : picked ? (
          <ConfirmStep
            picked={picked}
            rootLabel={root.label}
            pending={create.isPending}
            error={create.isError ? createError(create.error) : undefined}
            onBack={() => {
              create.reset();
              setPicked(undefined);
            }}
            onSubmit={(label) =>
              create.mutate(
                { rootId: picked.rootId, relPath: picked.relPath, ...(label ? { label } : {}) },
                { onSuccess: () => setOpen(false) },
              )
            }
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {runner.roots.length > 1 && (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">루트</legend>
                <RadioGroup value={root.id} onValueChange={setRootId} className="flex flex-wrap gap-4">
                  {runner.roots.map((r) => (
                    <div key={r.id} className="flex items-center gap-2">
                      <RadioGroupItem id={`${rootFieldId}-${r.id}`} value={r.id} />
                      <Label htmlFor={`${rootFieldId}-${r.id}`} className="font-normal">
                        {r.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </fieldset>
            )}
            {browseOff ? (
              <p role="note" className="text-sm text-muted-foreground">
                {BROWSE_OFF}
              </p>
            ) : (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "browse" ? "secondary" : "ghost"}
                  aria-pressed={mode === "browse"}
                  onClick={() => setMode("browse")}
                >
                  둘러보기
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "type" ? "secondary" : "ghost"}
                  aria-pressed={mode === "type"}
                  onClick={() => setMode("type")}
                >
                  직접 입력
                </Button>
              </div>
            )}
            {typing ? (
              <TypedPath
                key={root.id}
                rootLabel={root.label}
                onPick={(relPath) => setPicked({ rootId: root.id, relPath })}
              />
            ) : (
              <DirectoryBrowser
                key={root.id}
                runnerId={runner.id}
                root={root}
                onDenied={() => setDenied(true)}
                onPick={(relPath, git) =>
                  setPicked({ rootId: root.id, relPath, ...(git === undefined ? {} : { git }) })
                }
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 상대 경로 직접 입력 — 비우면 루트 자신. shared `RunnerRelPath` 로 보내기 전에 거른다. 뒤의 `/` 는 걷어 주고 앞의 `/` 는 거절한다 —
 * 호스트의 절대 경로를 적은 것이라 서버로 보내지 않는다
 */
function TypedPath({ rootLabel, onPick }: { rootLabel: string; onPick: (relPath: string) => void }) {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = raw.trim();
    // 앞 / 는 뒤 / 를 걷기 전에 본다 — 「/」·「///」 가 걷혀 루트 자신이 되지 않게
    const relPath = trimmed.startsWith("/") ? trimmed : trimmed.replace(/\/+$/, "");
    if (trimmed.startsWith("/") || !RunnerRelPath.safeParse(relPath).success) {
      setError(REL_PATH_RULE);
      return;
    }
    onPick(relPath);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Label htmlFor={id}>루트 안의 경로</Label>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm text-muted-foreground">{rootLabel}/</span>
        <Input
          id={id}
          value={raw}
          placeholder="work/app"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          onChange={(e) => {
            setRaw(e.target.value);
            setError(undefined);
          }}
        />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        비우면 루트 자신입니다.
      </p>
      <FieldError id={`${id}-error`}>{error}</FieldError>
      <Button type="submit" size="sm" className="self-end">
        다음
      </Button>
    </form>
  );
}

/**
 * 디렉터리 둘러보기 — 빵 부스러기로 위로, 줄을 눌러 아래로. git 저장소는 표시. 403 이면 둘러보기를 접고 직접 입력으로(`onDenied`),
 * 404·끊김·429 는 이 칸 안에 문구와 「다시 시도」. 서버가 분당 60번으로 막으므로 한 번 받은 목록은 이 대화상자가 열린 동안 다시 받지 않는다
 * (wire 러너 상태도 둘러보기는 낡게 하지 않는다)
 */
function DirectoryBrowser({
  runnerId,
  root,
  onDenied,
  onPick,
}: {
  runnerId: string;
  root: { id: string; label: string };
  onDenied: () => void;
  onPick: (relPath: string, git: boolean | undefined) => void;
}) {
  const [trail, setTrail] = useState<{ name: string; git: boolean }[]>([]);
  const relPath = trail.map((t) => t.name).join("/");
  const fs = useRunnerFs(runnerId, root.id, relPath, true);
  const forbidden = fs.error instanceof ApiRequestError && fs.error.code === "FORBIDDEN";
  useEffect(() => {
    if (forbidden) onDenied();
  }, [forbidden, onDenied]);

  let listing;
  if (fs.isPending) {
    listing = (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  } else if (fs.data) {
    listing =
      fs.data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">하위 디렉터리가 없습니다.</p>
      ) : (
        <ul aria-label="하위 디렉터리" className="flex max-h-64 flex-col overflow-y-auto rounded-md border">
          {fs.data.entries.map((entry) => {
            // 서버가 받지 않을 경로(\·NUL 이 든 이름)는 눌러 봐야 400 이 되풀이된다 — 잠그고 까닭을 보인다
            const usable = RunnerRelPath.safeParse(
              relPath === "" ? entry.name : `${relPath}/${entry.name}`,
            ).success;
            return (
              <li key={entry.name}>
                <button
                  type="button"
                  disabled={!usable}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
                  onClick={() => setTrail([...trail, { name: entry.name, git: entry.isGitRepo }])}
                >
                  <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {!usable && <span className="shrink-0 text-xs">{UNUSABLE_NAME}</span>}
                  {entry.isGitRepo && (
                    <Badge variant="outline">
                      <GitBranchIcon aria-hidden />
                      git
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      );
  } else if (!forbidden) {
    const code = fs.error instanceof ApiRequestError ? fs.error.code : undefined;
    listing = (
      <div className="flex flex-col items-start gap-2">
        <Alert variant="destructive">
          <AlertDescription>
            {code === "NOT_FOUND"
              ? "디렉터리를 찾지 못했습니다 — 위로 올라가거나 경로를 직접 입력하세요"
              : code === "RATE_LIMITED"
                ? BROWSE_RATE_LIMITED
                : (runnerRequestError(fs.error) ?? "목록을 받지 못했습니다 — 다시 시도하세요")}
          </AlertDescription>
        </Alert>
        <Button type="button" size="sm" variant="outline" onClick={() => void fs.refetch()}>
          다시 시도
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <nav aria-label="경로">
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          {[{ name: root.label, git: false }, ...trail].map((crumb, i) => {
            const current = i === trail.length;
            return (
              <li key={`${i}-${crumb.name}`} className="flex items-center gap-1">
                {i > 0 && (
                  <span aria-hidden className="text-muted-foreground">
                    /
                  </span>
                )}
                <button
                  type="button"
                  aria-current={current ? "location" : undefined}
                  className="rounded px-1 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:font-medium aria-[current=location]:no-underline"
                  onClick={() => setTrail(trail.slice(0, i))}
                >
                  {crumb.name}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {listing}
      {fs.data?.truncated && <p className="text-xs text-muted-foreground">{TRUNCATED_NOTE}</p>}
      <Button
        type="button"
        size="sm"
        className="self-end"
        disabled={!fs.data}
        onClick={() => onPick(relPath, trail.at(-1)?.git)}
      >
        이 디렉터리로
      </Button>
    </div>
  );
}

/** 고른 자리와 이름을 보고 더한다 — 이름을 비우면 서버가 경로 마지막 성분(루트 자신이면 루트 라벨)으로 짓는다 */
function ConfirmStep({
  picked,
  rootLabel,
  pending,
  error,
  onBack,
  onSubmit,
}: {
  picked: Picked;
  rootLabel: string;
  pending: boolean;
  error: string | undefined;
  onBack: () => void;
  onSubmit: (label: string | undefined) => void;
}) {
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string>();
  const id = useId();
  const place = picked.relPath === "" ? rootLabel : `${rootLabel}/${picked.relPath}`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const trimmed = label.trim();
    if (trimmed.length > PROJECT_LABEL_MAX) {
      setLabelError(PROJECT_LABEL_RULE);
      return;
    }
    onSubmit(trimmed === "" ? undefined : trimmed);
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">자리</dt>
          <dd className="min-w-0 break-all">
            <code className="font-mono">{place}</code>
            {picked.git === true && <> · git 저장소</>}
          </dd>
        </div>
      </dl>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>이름</Label>
        <Input
          id={id}
          value={label}
          maxLength={PROJECT_LABEL_MAX}
          placeholder={defaultLabel(picked, rootLabel)}
          autoComplete="off"
          aria-invalid={labelError !== undefined}
          aria-describedby={labelError ? `${id}-error` : undefined}
          disabled={pending}
          onChange={(e) => {
            setLabel(e.target.value);
            setLabelError(undefined);
          }}
        />
        <FieldError id={`${id}-error`}>{labelError}</FieldError>
      </div>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={pending} onClick={onBack}>
          뒤로
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "확인하는 중…" : "확인하고 추가"}
        </Button>
      </DialogFooter>
    </form>
  );
}
