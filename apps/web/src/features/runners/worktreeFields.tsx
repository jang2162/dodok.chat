import {
  type CreateWorktreeBody,
  RunnerRelPath,
  type RunnerProject,
  type RunnerProjectRef,
  type RunnerSummary,
} from "@dodok/shared";
import { type KeyboardEvent, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { formError } from "@/api/formErrors";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { DirectoryBrowser, REL_PATH_RULE } from "./AddProjectDialog";
import {
  BROWSE_OFF,
  PROJECT_LABEL_MAX,
  PROJECT_LABEL_RULE,
  WORKTREE_CREATE_REASON,
  randomHex,
  runnerRequestError,
  slugOf,
  worktreeDefaults,
} from "./copy";

// 워크트리 칸 셋(이름·브랜치·위치) — 「워크트리 만들기」 대화상자와 에이전트 폼의 「새 워크트리」가 함께 쓴다(워크트리 스펙 5.5)

const BRANCH_MAX = 200;
export const WORKTREE_LABEL_REQUIRED = "워크트리 이름을 적어 주세요";
export const WORKTREE_BRANCH_REQUIRED = "브랜치 이름을 1~200자로 적어 주세요";
/** 같은 자리의 프로젝트가 이미 있다(서버 409, 러너에 묻기 전) */
export const WORKTREE_PLACE_TAKEN = "그 위치에 프로젝트가 이미 있습니다 — 다른 위치를 고르세요";
const WORKTREE_CREATE_FAILED = "워크트리를 만들지 못했습니다 — 다시 시도하세요";

/** 바꾼 위치 — exact 는 적은 경로 그대로, under 는 고른 디렉터리 아래에 이름 슬러그를 붙인다 */
type LocationPick = { kind: "exact"; ref: RunnerProjectRef } | { kind: "under"; ref: RunnerProjectRef };

export type WorktreeDraft = ReturnType<typeof useWorktreeDraft>;

/** 칸 셋의 상태 — 브랜치·위치는 손대지 않으면 이름을 따라간다. 한글 이름의 `wt-<hex>` 는 열려 있는 동안 고정 */
export function useWorktreeDraft(parent: Pick<RunnerProject, "rootId" | "relPath">) {
  const [hex] = useState(randomHex);
  const [label, setLabel] = useState("");
  const [branchEdit, setBranchEdit] = useState<string>();
  const [pick, setPick] = useState<LocationPick>();
  const [touched, setTouched] = useState(false);
  const defaults = worktreeDefaults(parent, label, hex);
  const slug = slugOf(label, hex);
  const branch = branchEdit ?? defaults.branch;
  const location: RunnerProjectRef =
    pick === undefined
      ? defaults.location
      : pick.kind === "exact"
        ? pick.ref
        : {
            rootId: pick.ref.rootId,
            relPath: pick.ref.relPath === "" ? slug : `${pick.ref.relPath}/${slug}`,
          };
  const trimmed = label.trim();
  const labelError =
    trimmed === ""
      ? touched
        ? WORKTREE_LABEL_REQUIRED
        : undefined
      : trimmed.length > PROJECT_LABEL_MAX
        ? PROJECT_LABEL_RULE
        : undefined;
  const branchError =
    branch.trim() === "" || branch.trim().length > BRANCH_MAX ? WORKTREE_BRANCH_REQUIRED : undefined;
  const valid = trimmed !== "" && labelError === undefined && branchError === undefined;
  return {
    label,
    setLabel,
    branch,
    setBranch: (v: string) => setBranchEdit(v),
    location,
    picked: pick !== undefined,
    setPick,
    labelError,
    branchError,
    valid,
    /** 보내기 전 — 빈 이름 사유를 보이게 */
    touch: () => setTouched(true),
    body: (): CreateWorktreeBody => ({ label: trimmed, branch: branch.trim(), location }),
  };
}

/** 만들기 실패 문구 — 러너 사유(400 details.reason)·같은 자리·끊김. 러너가 준 git 한 줄(details.message)은 따로 */
export function worktreeCreateError(e: unknown): { text: string; detail?: string } {
  const transport = runnerRequestError(e);
  if (transport) return { text: transport };
  if (e instanceof ApiRequestError) {
    const reason = e.details?.reason;
    const detail = typeof e.details?.message === "string" ? e.details.message : undefined;
    if (typeof reason === "string" && reason in WORKTREE_CREATE_REASON)
      return {
        text: WORKTREE_CREATE_REASON[reason] ?? WORKTREE_CREATE_FAILED,
        ...(detail ? { detail } : {}),
      };
    if (e.code === "CONFLICT") return { text: WORKTREE_PLACE_TAKEN };
    if (e.code === "VALIDATION" && e.details?.field === "label") return { text: PROJECT_LABEL_RULE };
    if (e.code === "VALIDATION" && e.details?.field === "location") return { text: REL_PATH_RULE };
  }
  return { text: formError(e) ?? WORKTREE_CREATE_FAILED };
}

/** 위치 자리 — `루트 라벨/relPath` */
const placeOf = (runner: Pick<RunnerSummary, "roots">, ref: RunnerProjectRef) => {
  const root = runner.roots.find((r) => r.id === ref.rootId)?.label ?? ref.rootId;
  return ref.relPath === "" ? root : `${root}/${ref.relPath}`;
};

export function WorktreeFields({
  draft,
  runner,
  disabled = false,
}: {
  draft: WorktreeDraft;
  runner: RunnerSummary;
  disabled?: boolean;
}) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-label`}>워크트리 이름</Label>
        <Input
          id={`${ids}-label`}
          value={draft.label}
          maxLength={PROJECT_LABEL_MAX}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={draft.labelError !== undefined}
          aria-describedby={draft.labelError ? `${ids}-label-error` : undefined}
          onChange={(e) => draft.setLabel(e.target.value)}
        />
        <FieldError id={`${ids}-label-error`}>{draft.labelError}</FieldError>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-branch`}>브랜치</Label>
        <Input
          id={`${ids}-branch`}
          value={draft.branch}
          maxLength={BRANCH_MAX}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={draft.branchError !== undefined}
          aria-describedby={draft.branchError ? `${ids}-branch-error` : `${ids}-branch-hint`}
          onChange={(e) => draft.setBranch(e.target.value)}
        />
        <p id={`${ids}-branch-hint`} className="text-xs text-muted-foreground">
          없는 이름이면 이 프로젝트의 지금 커밋에서 새로 만듭니다. 있는 브랜치면 그것을 체크아웃합니다.
        </p>
        <FieldError id={`${ids}-branch-error`}>{draft.branchError}</FieldError>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">위치</span>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 font-mono text-sm break-all">{placeOf(runner, draft.location)}</code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-expanded={editing}
            onClick={() => setEditing((v) => !v)}
          >
            위치 바꾸기
          </Button>
          {draft.picked && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                draft.setPick(undefined);
                setEditing(false);
              }}
            >
              기본 위치로
            </Button>
          )}
        </div>
        {editing && (
          <LocationEditor
            runner={runner}
            onPick={(pick) => {
              draft.setPick(pick);
              setEditing(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 위치 바꾸기 — 「프로젝트 추가」와 같은 루트 고르기·둘러보기(DirectoryBrowser — 고른 디렉터리 아래에 이름을 붙인다)·직접 입력(적은 경로
 * 그대로). 둘러보기를 끈 러너는 직접 입력만. 직접 입력은 폼이 아니다 — 에이전트 폼 안에서도 쓰므로 바깥 폼을 보내지 않게
 */
function LocationEditor({ runner, onPick }: { runner: RunnerSummary; onPick: (pick: LocationPick) => void }) {
  const [rootId, setRootId] = useState<string>();
  const [denied, setDenied] = useState(false);
  const [mode, setMode] = useState<"browse" | "type">("browse");
  const root = runner.roots.find((r) => r.id === rootId) ?? runner.roots[0];
  const browseOff = runner.browse === false || denied;
  const typing = browseOff || mode === "type";
  const ids = useId();
  if (!root) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
      {runner.roots.length > 1 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">루트</legend>
          <RadioGroup value={root.id} onValueChange={setRootId} className="flex flex-wrap gap-4">
            {runner.roots.map((r) => (
              <div key={r.id} className="flex items-center gap-2">
                <RadioGroupItem id={`${ids}-${r.id}`} value={r.id} />
                <Label htmlFor={`${ids}-${r.id}`} className="font-normal">
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
        <TypedLocation
          key={root.id}
          rootLabel={root.label}
          onPick={(relPath) => onPick({ kind: "exact", ref: { rootId: root.id, relPath } })}
        />
      ) : (
        <DirectoryBrowser
          key={root.id}
          runnerId={runner.id}
          root={root}
          onDenied={() => setDenied(true)}
          onPick={(relPath) => onPick({ kind: "under", ref: { rootId: root.id, relPath } })}
        />
      )}
    </div>
  );
}

/** 워크트리 폴더의 경로를 그대로 적는다 — shared `RunnerRelPath` 로 거르고 루트 자신(빈 경로)은 받지 않는다 */
function TypedLocation({ rootLabel, onPick }: { rootLabel: string; onPick: (relPath: string) => void }) {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();

  function apply() {
    const trimmed = raw.trim();
    const relPath = trimmed.startsWith("/") ? trimmed : trimmed.replace(/\/+$/, "");
    if (relPath === "" || trimmed.startsWith("/") || !RunnerRelPath.safeParse(relPath).success) {
      setError(REL_PATH_RULE);
      return;
    }
    onPick(relPath);
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    // 바깥 폼(에이전트 만들기)을 보내지 않는다
    e.preventDefault();
    apply();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>루트 안의 경로</Label>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm text-muted-foreground">{rootLabel}/</span>
        <Input
          id={id}
          value={raw}
          placeholder="worktrees/feat"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setRaw(e.target.value);
            setError(undefined);
          }}
        />
      </div>
      <FieldError id={`${id}-error`}>{error}</FieldError>
      <Button type="button" size="sm" className="self-end" onClick={apply}>
        다음
      </Button>
    </div>
  );
}
