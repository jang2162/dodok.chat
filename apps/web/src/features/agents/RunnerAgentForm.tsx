import {
  type Agent,
  type DmAccess,
  RUNNER_PERMISSION_MODES,
  RUNNER_PROGRAM_NAME,
  type RunnerPermissionMode,
  type RunnerProgram,
  type RunnerProgramStatus,
  type RunnerSummary,
  permissionModeRank,
} from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { detailField, formError } from "@/api/formErrors";
import { useIsOwner } from "@/api/queries";
import {
  PERMISSION_MODE_LABEL,
  ROOT_MISSING,
  projectPlace,
  runnerRequestError,
} from "@/features/runners/copy";
import { useRunnerProjects, useRunners } from "@/features/runners/queries";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Textarea } from "@/ui/textarea";
import { AgentFields, HANDLE_TAKEN, handleIssue, nameProblem } from "./ManualAgentForm";
import { type CreateRunnerAgentInput, useCreateAgent } from "./mutations";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive";
const MODEL_MAX = 128;
const PROMPT_MAX = 20_000;

/** 러너 천장에 걸린 칸(서버 400 `details.field` — program·permissionMode·allowedTools) */
export const CEILING_REFUSED = "러너 설정이 허용하지 않습니다 — 러너 머신의 설정(상한)을 확인하세요";
/** 고른 프로젝트가 보관됐거나 없다(서버 400 `details.field === "runnerProjectId"`, 또는 고른 뒤 보관·옮기기) */
export const PROJECT_GONE = "보관됐거나 없는 프로젝트입니다 — 다른 프로젝트를 고르세요";
/** 고른 러너가 만드는 동안 끊겼다 — 다른 러너로 바꾸지 않고 만들기를 잠근다 */
export const PICKED_RUNNER_OFFLINE = "고른 러너가 끊겼습니다 — 러너를 다시 띄우거나 다른 러너를 고르세요";
/** 고른 러너의 토큰이 만드는 동안 폐기됐다 */
export const PICKED_RUNNER_REVOKED = "고른 러너의 토큰이 폐기됐습니다 — 다른 러너를 고르세요";
/** 고른 프로젝트의 루트를 붙은 러너가 알리지 않는다(머신 주인이 루트 id 를 바꾸거나 지움) */
export const PICKED_PROJECT_ROOT_MISSING =
  "러너가 이 프로젝트의 루트를 알리지 않습니다 — 다른 프로젝트를 고르세요";
/** 고른 프로그램을 러너가 못 쓴다고 알렸다 */
export const PICKED_PROGRAM_UNAVAILABLE = "고른 프로그램을 지금 쓸 수 없습니다 — 다른 프로그램을 고르세요";
/** 만들기 실패 가운데 칸·충돌·러너 연결로 가르지 못한 것 — 전역 토스트를 끄므로 폼 아래 이 한 줄 */
export const CREATE_FAILED = "에이전트를 만들지 못했습니다 — 다시 시도하세요";

/** DM 허용 선택지 — 에이전트 줄의 `DmAccessField` 와 같은 글 */
const DM_ACCESS_LABEL: Record<DmAccess, string> = { off: "끔", admins: "admin 이상", everyone: "모두" };

type PermissionOption = { mode: RunnerPermissionMode; disabled: boolean };

/**
 * 권한 모드 선택지 — 러너 상한(`ceiling`)까지만(Review Focus 3). 상한을 모르면(러너 끊김) 넷 다. 지금 값이 상한 위면(머신 주인이
 * 상한을 낮춤) 그 값을 고를 수 없는 줄로 남겨 지금 상태가 보이게 한다 — 서버는 상한 위로 바꾸는 PATCH 를 거절한다
 */
export function permissionOptions(
  ceiling: RunnerPermissionMode | undefined,
  current?: RunnerPermissionMode,
): PermissionOption[] {
  return RUNNER_PERMISSION_MODES.flatMap((mode): PermissionOption[] => {
    const within = ceiling === undefined || permissionModeRank(mode) <= permissionModeRank(ceiling);
    if (within) return [{ mode, disabled: false }];
    return mode === current ? [{ mode, disabled: true }] : [];
  });
}

/**
 * 상한 안으로 내린 권한 모드 — 상한 위면 상한 자신, 상한을 모르면 그대로. 선택지 밖 값을 상태로 두면 React 가 첫 option 을 고른 것처럼
 * 보이고 그 option 은 다시 고를 수 없다(change 가 나지 않는다)
 */
export function fitPermissionMode(
  mode: RunnerPermissionMode,
  ceiling: RunnerPermissionMode | undefined,
): RunnerPermissionMode {
  return ceiling !== undefined && permissionModeRank(mode) > permissionModeRank(ceiling) ? ceiling : mode;
}

/** 저장된 허용 도구와 칸의 목록이 같은가 — `[]` 와 null 은 둘 다 「미리 허용한 도구 없음」이라 같게 본다 */
const sameTools = (a: readonly string[] | null, b: readonly string[] | null) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** 허용 도구 칸의 글 → 목록. 쉼표·공백으로 나눈다. 비우면 null(미리 허용한 도구 없음 — 상한 안에서 프로그램 기본) */
export function parseTools(text: string): string[] | null {
  const tools = text.split(/[\s,]+/).filter((t) => t !== "");
  return tools.length === 0 ? null : [...new Set(tools)];
}

/** 허용 도구 칸의 문제 — 상한이 목록이면 그 부분집합이어야 한다 */
export function toolsProblem(
  tools: string[] | null,
  ceiling: string[] | null | undefined,
): string | undefined {
  if (tools === null || !ceiling) return undefined;
  if (tools.length > 100) return "도구는 100개까지입니다";
  const outside = tools.filter((t) => !ceiling.includes(t));
  return outside.length > 0 ? `러너 상한에 없는 도구입니다: ${outside.join(", ")}` : undefined;
}

/** 라벨·칸·안내·오류 한 벌 — 칸은 `children(id, describedBy)` 로 받는다(select·textarea 도 같은 꼴로) */
function Row({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const describedBy = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id, describedBy)}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

type DefinitionDraft = { model: string; permissionMode: RunnerPermissionMode; tools: string };
type DefinitionErrors = Partial<Record<"model" | "permissionMode" | "allowedTools", string>>;

/** 모델·권한 모드·허용 도구 — 만들기와 고치기가 같은 칸을 쓴다(러너 일반화 스펙 7장) */
function DefinitionFields({
  draft,
  onChange,
  ceiling,
  ceilingPending = false,
  current,
  errors,
  disabled,
}: {
  draft: DefinitionDraft;
  onChange: (patch: Partial<DefinitionDraft>) => void;
  /** 그 러너·그 프로그램의 천장 — 러너가 끊겼으면 undefined(모른다) */
  ceiling: RunnerProgramStatus["ceiling"] | undefined;
  /** 러너 목록을 받는 중 — 상한을 아직 모른다(끊김이 아니다). 그동안 권한 모드는 잠근다 */
  ceilingPending?: boolean;
  /** 고치기의 저장된 권한 모드 */
  current?: RunnerPermissionMode;
  errors: DefinitionErrors;
  disabled: boolean;
}) {
  const options = permissionOptions(ceiling?.maxPermissionMode, current);
  const toolCeiling = ceiling?.allowedToolsCeiling;
  const overCeiling =
    ceiling !== undefined &&
    permissionModeRank(draft.permissionMode) > permissionModeRank(ceiling.maxPermissionMode);
  return (
    <>
      <Row label="모델" hint="비우면 프로그램의 기본 모델입니다(예: sonnet, opus)" error={errors.model}>
        {(id, describedBy) => (
          <Input
            id={id}
            value={draft.model}
            maxLength={MODEL_MAX}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.model !== undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onChange={(e) => onChange({ model: e.target.value })}
          />
        )}
      </Row>
      <Row
        label="권한 모드"
        hint={
          ceilingPending
            ? "러너 상한을 불러오는 중…"
            : overCeiling
              ? `지금 값이 러너 상한(${ceiling?.maxPermissionMode})보다 높습니다 — 낮추지 않으면 런이 거절됩니다`
              : ceiling
                ? `러너 상한은 ${ceiling.maxPermissionMode} 입니다 — 그 위는 고를 수 없습니다`
                : "러너가 끊겨 있어 상한을 모릅니다 — 다음 런에서 러너가 다시 봅니다"
        }
        error={errors.permissionMode}
      >
        {(id, describedBy) => (
          <select
            id={id}
            className={SELECT}
            value={draft.permissionMode}
            aria-invalid={errors.permissionMode !== undefined}
            aria-describedby={describedBy}
            disabled={disabled || ceilingPending}
            onChange={(e) => onChange({ permissionMode: e.target.value as RunnerPermissionMode })}
          >
            {options.map(({ mode, disabled: above }) => (
              <option key={mode} value={mode} disabled={above}>
                {PERMISSION_MODE_LABEL[mode]}
                {above ? " (상한 초과)" : ""}
              </option>
            ))}
          </select>
        )}
      </Row>
      <Row
        label="허용 도구"
        hint={
          toolCeiling
            ? `묻지 않고 쓸 도구를 쉼표로 나눠 적습니다. 러너 상한: ${toolCeiling.length === 0 ? "없음" : toolCeiling.join(", ")}`
            : "묻지 않고 쓸 도구를 쉼표로 나눠 적습니다(예: Read, Grep, Glob). 비우면 미리 허용한 도구가 없습니다"
        }
        error={errors.allowedTools}
      >
        {(id, describedBy) => (
          <Input
            id={id}
            value={draft.tools}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.allowedTools !== undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onChange={(e) => onChange({ tools: e.target.value })}
          />
        )}
      </Row>
    </>
  );
}

/** 클라이언트 검사 — 서버가 붙은 러너의 hello 로 보는 천장과 같은 규칙(권한 순서·허용 도구 부분집합) */
function definitionErrors(
  draft: DefinitionDraft,
  ceiling: RunnerProgramStatus["ceiling"] | undefined,
): DefinitionErrors {
  const errors: DefinitionErrors = {};
  const tools = toolsProblem(parseTools(draft.tools), ceiling?.allowedToolsCeiling);
  if (tools) errors.allowedTools = tools;
  if (ceiling && permissionModeRank(draft.permissionMode) > permissionModeRank(ceiling.maxPermissionMode))
    errors.permissionMode = `러너 상한(${ceiling.maxPermissionMode}) 위입니다 — 낮추세요`;
  return errors;
}

/** 서버 400 의 칸 — 천장(program·permissionMode·allowedTools)은 고정 문구, model 은 서버 문구 */
function serverDefinitionError(err: unknown): { field: string; message: string } | undefined {
  if (!(err instanceof ApiRequestError) || err.code !== "VALIDATION") return undefined;
  const field = detailField(err, ["program", "permissionMode", "allowedTools", "model", "runnerProjectId"]);
  if (field === undefined) return undefined;
  if (field === "runnerProjectId") return { field, message: PROJECT_GONE };
  if (field === "model") return { field, message: "모델 이름은 1~128자입니다" };
  return { field, message: CEILING_REFUSED };
}

/** 러너 없음 — 러너는 연결 페이지(owner)에서 붙인다. owner 에게만 링크 */
function NoRunners() {
  const owner = useIsOwner();
  return (
    <p className="text-sm text-muted-foreground">
      연결된 러너가 없습니다 —{" "}
      {owner ? (
        <Link to="/settings/connection" className="underline underline-offset-4">
          연결 페이지
        </Link>
      ) : (
        "연결 페이지"
      )}
      에서 러너를 붙이세요{owner ? "." : "(워크스페이스 owner 가 할 수 있습니다)."}
    </p>
  );
}

/** 처음 고를 러너 — 붙은 것 가운데 첫째 */
const firstLive = (runners: readonly RunnerSummary[]) => runners.find((r) => r.connected && !r.revoked)?.id;

/**
 * 러너 에이전트 만들기(러너 일반화 스펙 7장 — 에이전트 추가의 「러너」 갈래): 러너 → 프로젝트 → 프로그램 → 이름·핸들·모델·권한 모드·
 * 허용 도구·지시·DM 허용. 끊긴 러너는 고를 수 없다(프로그램 목록이 없다). 프로그램은 그 러너가 알린 것만, 못 쓰는 것은 흐리게 사유와
 * 함께. 권한 모드는 그 프로그램의 상한까지만 고른다. 서버 400 의 천장 칸은 그 칸 아래, 핸들 409 는 핸들 칸 아래, 그 밖은 폼 아래.
 * 러너·프로젝트·프로그램은 처음 한 번만 첫 것을 고르고 그 뒤로는 고른 것을 쥔다 — 고른 것이 끊기거나 보관되거나 못 쓰게 되면 다른
 * 것으로 바꾸지 않고 그 칸에 사유를 보이며 「만들기」를 잠근다(에이전트가 어느 머신에서 돌지가 모르는 사이에 바뀌지 않게)
 */
export function RunnerAgentForm({
  takenHandles,
  onCreated,
}: {
  takenHandles: ReadonlySet<string>;
  onCreated: () => void;
}) {
  const runners = useRunners();
  const create = useCreateAgent({ silent: true });
  const [runnerPick, setRunnerPick] = useState<string>();
  const [projectPick, setProjectPick] = useState<string>();
  const [programPick, setProgramPick] = useState<RunnerProgram>();
  const [handle, setHandle] = useState("");
  const [name, setName] = useState<string>(); // undefined 면 핸들을 따른다
  const [definition, setDefinition] = useState<DefinitionDraft>({
    model: "",
    permissionMode: "default",
    tools: "",
  });
  const [prompt, setPrompt] = useState("");
  const [dmAccess, setDmAccess] = useState<DmAccess>("admins");
  const [serverError, setServerError] = useState<{ field: string; message: string }>();
  const ids = useId();

  const list = useMemo(() => (runners.data ?? []).filter((r) => !r.revoked), [runners.data]);
  // 처음 고르는 것만 렌더 중에 정한다(앞 렌더에서 온 정보로 상태 맞추기) — 한 번 정한 뒤로는 바꾸지 않는다
  const firstRunner = runnerPick === undefined ? firstLive(list) : undefined;
  if (firstRunner !== undefined) setRunnerPick(firstRunner);
  const runner = list.find((r) => r.id === runnerPick);
  const live = runner?.connected === true;
  const runnerIssue =
    runnerPick === undefined
      ? undefined
      : runner === undefined
        ? PICKED_RUNNER_REVOKED
        : live
          ? undefined
          : PICKED_RUNNER_OFFLINE;
  const projects = useRunnerProjects(runner?.id);
  const activeProjects = (projects.data ?? []).filter((p) => p.archivedAt === null);
  // 붙은 러너가 그 루트를 알리지 않는 프로젝트 — 보이되 고를 수 없다(거기 만든 에이전트는 첫 런부터 천장 밖이다)
  const rootMissing = (p: { rootLabel: string | null }) => live && p.rootLabel === null;
  const selectable = activeProjects.filter((p) => !rootMissing(p));
  const firstProject = projectPick === undefined && projects.data ? selectable[0]?.id : undefined;
  if (firstProject !== undefined) setProjectPick(firstProject);
  const project = selectable.find((p) => p.id === projectPick);
  const projectIssue =
    projectPick === undefined || project !== undefined || projects.data === undefined
      ? undefined
      : activeProjects.some((p) => p.id === projectPick)
        ? PICKED_PROJECT_ROOT_MISSING
        : PROJECT_GONE;
  const usable = live ? runner.programs.filter((p) => p.available) : [];
  const firstProgram = live && programPick === undefined ? usable[0]?.program : undefined;
  if (firstProgram !== undefined) setProgramPick(firstProgram);
  const program = usable.find((p) => p.program === programPick);
  const programIssue =
    live && programPick !== undefined && program === undefined ? PICKED_PROGRAM_UNAVAILABLE : undefined;
  const ceiling = program?.ceiling;
  // 권한 모드는 늘 그 프로그램의 상한 안이다 — 처음 값 default 가 상한(plan·dontAsk) 위이거나, 러너·프로그램을 바꿔(또는 러너가
  // 다시 붙어) 상한이 내려가면 상한으로 내린다
  const fitted = fitPermissionMode(definition.permissionMode, ceiling?.maxPermissionMode);
  if (fitted !== definition.permissionMode) setDefinition((d) => ({ ...d, permissionMode: fitted }));
  const currentName = name ?? handle;
  const clientErrors = definitionErrors(definition, ceiling);
  const pending = create.isPending;

  const handleError =
    serverError?.field === "handle"
      ? serverError.message
      : handle !== ""
        ? handleIssue(handle, takenHandles)
        : undefined;
  const nameError = handle !== "" || name !== undefined ? nameProblem(currentName) : undefined;
  const definitionServer =
    serverError && ["model", "permissionMode", "allowedTools"].includes(serverError.field);
  const errors: DefinitionErrors = {
    ...clientErrors,
    ...(definitionServer ? { [serverError.field]: serverError.message } : {}),
  };
  const ready =
    runner !== undefined &&
    runnerIssue === undefined &&
    project !== undefined &&
    program !== undefined &&
    handle !== "" &&
    handleIssue(handle, takenHandles) === undefined &&
    nameProblem(currentName) === undefined &&
    Object.keys(clientErrors).length === 0 &&
    !pending;

  const clear = () => setServerError(undefined);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || !project || !program) return;
    clear();
    const model = definition.model.trim();
    const input: CreateRunnerAgentInput = {
      provider: "runner",
      runnerProjectId: project.id,
      program: program.program,
      handle,
      name: currentName.trim(),
      ...(model === "" ? {} : { model }),
      permissionMode: definition.permissionMode,
      allowedTools: parseTools(definition.tools),
      ...(prompt.trim() === "" ? {} : { basePrompt: prompt }),
      dmAccess,
    };
    create.mutate(input, {
      onSuccess: onCreated,
      onError: (err) => {
        const field = serverDefinitionError(err);
        if (field) return setServerError(field);
        if (err instanceof ApiRequestError && err.code === "CONFLICT")
          return setServerError({ field: "handle", message: HANDLE_TAKEN });
        setServerError({
          field: "form",
          message: runnerRequestError(err) ?? formError(err) ?? CREATE_FAILED,
        });
      },
    });
  }

  if (runners.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        러너 목록을 불러오는 중…
      </p>
    );
  if (!runners.data)
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">러너 목록을 가져오지 못했습니다</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void runners.refetch()}>
          다시 시도
        </Button>
      </div>
    );
  if (list.length === 0) return <NoRunners />;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="grid gap-2" disabled={pending}>
        <legend className="mb-1 text-sm font-medium">러너</legend>
        <RadioGroup
          value={runnerPick ?? ""}
          onValueChange={(v) => {
            clear();
            setRunnerPick(v);
            setProjectPick(undefined);
            setProgramPick(undefined);
          }}
          className="flex flex-wrap gap-4"
        >
          {list.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <RadioGroupItem
                id={`${ids}-runner-${r.id}`}
                value={r.id}
                disabled={!r.connected}
                aria-describedby={r.id === runnerPick && runnerIssue ? `${ids}-runner-error` : undefined}
              />
              <Label
                htmlFor={`${ids}-runner-${r.id}`}
                className={r.connected ? "font-normal" : "font-normal text-muted-foreground"}
              >
                {r.label}
                {!r.connected && " (끊김)"}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <FieldError id={`${ids}-runner-error`}>{runnerIssue}</FieldError>
      </fieldset>
      {runnerPick === undefined ? (
        <p className="text-sm text-muted-foreground">
          붙어 있는 러너가 없습니다 — 러너를 띄운 뒤 다시 여세요.
        </p>
      ) : runner === undefined ? null : (
        <>
          <Row
            label="프로젝트"
            error={
              projectIssue ?? (serverError?.field === "runnerProjectId" ? serverError.message : undefined)
            }
            hint={
              selectable.length === 0 && !projects.isPending ? (
                <>
                  이 러너에 고를 수 있는 프로젝트가 없습니다 —{" "}
                  <Link to="/settings/runners" className="underline underline-offset-4">
                    러너 탭
                  </Link>
                  에서 프로젝트를 추가하세요.
                </>
              ) : undefined
            }
          >
            {(id, describedBy) => (
              <select
                id={id}
                className={SELECT}
                value={projectPick ?? ""}
                aria-invalid={projectIssue !== undefined || serverError?.field === "runnerProjectId"}
                aria-describedby={describedBy}
                disabled={pending || activeProjects.length === 0}
                onChange={(e) => {
                  clear();
                  setProjectPick(e.target.value);
                }}
              >
                {projectPick === undefined && activeProjects.length > 0 && (
                  <option value="" disabled>
                    프로젝트 고르기
                  </option>
                )}
                {projectPick !== undefined && !activeProjects.some((p) => p.id === projectPick) && (
                  // 고른 뒤 보관·옮기기로 빠진 것 — 고를 수 없는 줄로 남겨 지금 상태가 보이게 한다
                  <option value={projectPick} disabled>
                    고른 프로젝트(보관됐거나 없음)
                  </option>
                )}
                {activeProjects.map((p) => (
                  <option key={p.id} value={p.id} disabled={rootMissing(p)}>
                    {p.label} — {projectPlace(p)}
                    {rootMissing(p) ? ` (${ROOT_MISSING})` : ""}
                  </option>
                ))}
              </select>
            )}
          </Row>
          <fieldset className="grid gap-2" disabled={pending}>
            <legend className="mb-1 text-sm font-medium">프로그램</legend>
            {!live ? (
              <p className="text-sm text-muted-foreground">러너가 끊겨 있어 프로그램을 모릅니다.</p>
            ) : runner.programs.length === 0 ? (
              <p className="text-sm text-muted-foreground">이 러너에 켜진 프로그램이 없습니다.</p>
            ) : (
              <RadioGroup
                value={programPick ?? ""}
                onValueChange={(v) => {
                  clear();
                  setProgramPick(v as RunnerProgram);
                }}
                className="flex flex-col gap-2"
              >
                {runner.programs.map((p) => (
                  <div key={p.program} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        id={`${ids}-program-${p.program}`}
                        value={p.program}
                        disabled={!p.available}
                        aria-describedby={p.available ? undefined : `${ids}-program-${p.program}-reason`}
                      />
                      <Label
                        htmlFor={`${ids}-program-${p.program}`}
                        className={p.available ? "font-normal" : "font-normal text-muted-foreground"}
                      >
                        {RUNNER_PROGRAM_NAME[p.program]}
                        {p.version && <span className="text-muted-foreground"> {p.version}</span>}
                      </Label>
                    </div>
                    {!p.available && (
                      <p
                        id={`${ids}-program-${p.program}-reason`}
                        className="pl-6 text-xs text-muted-foreground"
                      >
                        쓸 수 없음{p.reason ? ` — ${p.reason}` : ""}
                      </p>
                    )}
                  </div>
                ))}
              </RadioGroup>
            )}
            <FieldError id={`${ids}-program-error`}>
              {programIssue ?? (serverError?.field === "program" ? serverError.message : undefined)}
            </FieldError>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <AgentFields
              handle={handle}
              name={currentName}
              onHandle={(v) => {
                clear();
                setHandle(v);
              }}
              onName={(v) => {
                clear();
                setName(v);
              }}
              handleError={handleError}
              nameError={nameError}
              disabled={pending}
            />
          </div>
          <DefinitionFields
            draft={definition}
            onChange={(patch) => {
              clear();
              setDefinition((d) => ({ ...d, ...patch }));
            }}
            ceiling={ceiling}
            errors={errors}
            disabled={pending}
          />
          <Row
            label="지시"
            hint="이 에이전트가 매 런 받는 지시입니다(채널 규칙 앞에 붙습니다). 비워도 됩니다"
          >
            {(id, describedBy) => (
              <Textarea
                id={id}
                value={prompt}
                rows={4}
                maxLength={PROMPT_MAX}
                aria-describedby={describedBy}
                disabled={pending}
                onChange={(e) => setPrompt(e.target.value)}
              />
            )}
          </Row>
          <fieldset className="grid gap-2" disabled={pending}>
            <legend className="mb-1 text-sm font-medium">DM 허용</legend>
            <RadioGroup
              value={dmAccess}
              onValueChange={(v) => setDmAccess(v as DmAccess)}
              className="flex flex-wrap gap-4"
            >
              {(["off", "admins", "everyone"] as const).map((option) => (
                <div key={option} className="flex items-center gap-2">
                  <RadioGroupItem id={`${ids}-dm-${option}`} value={option} />
                  <Label htmlFor={`${ids}-dm-${option}`} className="font-normal">
                    {DM_ACCESS_LABEL[option]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
        </>
      )}
      {serverError?.field === "form" && (
        <Alert variant="destructive">
          <AlertDescription>{serverError.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="self-end" disabled={!ready}>
        {pending ? "만드는 중…" : "만들기"}
      </Button>
    </form>
  );
}

/**
 * 러너 에이전트 고치기(admin 이상) — 만들기와 같은 정의 칸(모델·권한 모드·허용 도구). 프로그램·프로젝트는 읽기만 한다 — 프로젝트는
 * 「러너」 탭의 옮기기로만, 프로그램을 바꾸려면 새 에이전트(러너 일반화 계획 판정 PR10). PATCH 는 바뀐 정의 칸만 싣고 프로그램·
 * 프로젝트는 싣지 않는다(서버 400). 권한 모드는 지금 붙은 러너의 상한까지 — 끊겨 있으면 넷 다(서버도 건너뛰고 런에서 러너가 거절한다)
 */
export function RunnerDefinitionForm({
  agent,
  definition,
  onSave,
  onCancel,
  pending,
  serverError,
}: {
  agent: Agent;
  definition: NonNullable<Agent["runnerAgent"]>;
  onSave: (patch: {
    model?: string | null;
    permissionMode?: RunnerPermissionMode;
    allowedTools?: string[] | null;
  }) => void;
  onCancel: () => void;
  pending: boolean;
  serverError: unknown;
}) {
  const runners = useRunners();
  const tokenId = agent.runner?.tokenId;
  const runner = runners.data?.find((r) => r.id === tokenId);
  const projects = useRunnerProjects(tokenId);
  const project = projects.data?.find((p) => p.id === definition.projectId);
  const program = agent.program ?? "claude";
  const ceiling = runner?.connected ? runner.programs.find((p) => p.program === program)?.ceiling : undefined;
  const ceilingPending = tokenId !== undefined && runners.isPending;
  const [draft, setDraft] = useState<DefinitionDraft>({
    model: definition.model ?? "",
    permissionMode: definition.permissionMode,
    tools: (definition.allowedTools ?? []).join(", "),
  });
  const model = draft.model.trim() === "" ? null : draft.model.trim();
  const tools = parseTools(draft.tools);
  const permissionChanged = draft.permissionMode !== definition.permissionMode;
  const toolsChanged = !sameTools(tools, definition.allowedTools);
  // 상한이 낮아져 저장된 값이 상한 위인 것(Review Focus 3)은 고칠 거리일 뿐 다른 칸의 저장을 막지 않는다 — 서버도 바꾸는 칸만 본다
  const client = definitionErrors(draft, ceiling);
  const errors: DefinitionErrors = {
    ...(toolsChanged && client.allowedTools ? { allowedTools: client.allowedTools } : {}),
    ...(permissionChanged && client.permissionMode ? { permissionMode: client.permissionMode } : {}),
  };
  const ready = Object.keys(errors).length === 0 && !pending;
  const server = serverDefinitionError(serverError);
  if (server && server.field !== "program" && server.field !== "runnerProjectId")
    errors[server.field as keyof DefinitionErrors] = server.message;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    onSave({
      ...(model === definition.model ? {} : { model }),
      ...(permissionChanged ? { permissionMode: draft.permissionMode } : {}),
      ...(toolsChanged ? { allowedTools: tools } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">프로그램</dt>
          <dd>{RUNNER_PROGRAM_NAME[program]}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">프로젝트</dt>
          <dd className="min-w-0 break-all">
            {project ? (
              <>
                {project.label} · <code className="font-mono text-xs">{projectPlace(project)}</code>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        프로그램은 바꿀 수 없습니다(새 에이전트를 만드세요). 프로젝트는 「러너」 탭에서 다른 러너로 옮깁니다.
      </p>
      <DefinitionFields
        draft={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        ceiling={ceiling}
        ceilingPending={ceilingPending}
        current={definition.permissionMode}
        errors={errors}
        disabled={pending}
      />
      {serverError !== undefined && server === undefined && formError(serverError) !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{formError(serverError)}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          취소
        </Button>
        <Button type="submit" disabled={!ready}>
          {pending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}
