import {
  type Agent,
  BOT_TEMPLATES,
  type DmAccess,
  RUNNER_BOT_PURPOSE_MAX,
  RUNNER_BOT_SECTION_MAX,
  RUNNER_BOTS_UPDATE_MESSAGE,
  type RunnerBotDefinition,
  type RunnerProject,
  RUNNER_EFFORTS,
  RUNNER_PERMISSION_MODES,
  RUNNER_PROGRAM_NAME,
  type RunnerEffort,
  type RunnerPermissionMode,
  type RunnerProgram,
  type SessionDefaults,
  permissionModeRank,
} from "@dodok/shared";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { detailField, formError } from "@/api/formErrors";
import { EFFORT_LABEL } from "@/features/conversations/agentSettings";
import { type BotTools, BotToolsFields, botToolsOf, EMPTY_BOT_TOOLS } from "./BotToolsFields";
import {
  isNoApprovalMode,
  NO_APPROVAL_HINT,
  PERMISSION_MODE_LABEL,
  ROOT_MISSING,
  projectPlace,
  runnerRequestError,
  worktreeLock,
  worktreeName,
} from "@/features/runners/copy";
import { useCreateWorktree } from "@/features/runners/mutations";
import { WorktreeFields, useWorktreeDraft, worktreeCreateError } from "@/features/runners/worktreeFields";
import { useRunnerProjects, useRunners } from "@/features/runners/queries";
import { ReasonHint } from "@/features/components/DisabledHint";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Textarea } from "@/ui/textarea";
import { AgentFields, HANDLE_TAKEN, handleIssue, nameProblem } from "./ManualAgentForm";
import { type CreateRunnerAgentInput, useCreateAgent, usePatchAgent } from "./mutations";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive";
const MODEL_MAX = 128;
const PROMPT_MAX = 20_000;

/** 러너 천장에 걸린 칸(서버 400 `details.field` — program·permissionMode·allowedTools) */
export const CEILING_REFUSED = "러너 설정이 허용하지 않습니다 — 러너 머신의 설정(상한)을 확인하세요";
/** 고른 프로젝트가 보관됐거나 없다(서버 400 `details.field === "runnerProjectId"`, 또는 고른 뒤 보관·옮기기) */
export const PROJECT_GONE = "보관됐거나 없는 프로젝트입니다 — 다른 프로젝트를 고르세요";
/**
 * 고른 러너가 만드는 동안 끊겼다 — 다른 러너로 바꾸지 않고 만들기를 잠근다. 폼이 처음 고른 러너(사람이 고르지 않았다 — 열 때 캐시가
 * 낡아 붙은 줄 알았던 것)일 수도 있어 「고른」이라 하지 않는다
 */
export const PICKED_RUNNER_OFFLINE = "선택된 러너가 끊겼습니다 — 러너를 다시 띄우거나 다른 러너를 고르세요";
/** 고른 러너의 토큰이 만드는 동안 폐기됐다 — 목록에서 빠져 고른 칸이 보이지 않는다 */
export const PICKED_RUNNER_REVOKED = "선택돼 있던 러너의 토큰이 폐기됐습니다 — 다른 러너를 고르세요";
/** 고른 프로젝트의 루트를 붙은 러너가 알리지 않는다(머신 주인이 루트 id 를 바꾸거나 지움) */
export const PICKED_PROJECT_ROOT_MISSING =
  "러너가 이 프로젝트의 루트를 알리지 않습니다 — 다른 프로젝트를 고르세요";
/** 고른 프로그램을 러너가 못 쓴다고 알렸다 */
export const PICKED_PROGRAM_UNAVAILABLE = "선택된 프로그램을 지금 쓸 수 없습니다 — 다른 프로그램을 고르세요";
/** 「새 워크트리」로 워크트리는 만들었는데 에이전트 만들기가 실패했다 — 워크트리는 남는다(하위 프로젝트로 보인다) */
export const WORKTREE_KEPT = "워크트리는 만들었습니다 — 에이전트는 만들지 못했습니다";
/** 만들기 실패 가운데 칸·충돌·러너 연결로 가르지 못한 것 — 전역 토스트를 끄므로 폼 아래 이 한 줄 */
export const CREATE_FAILED = "에이전트를 만들지 못했습니다 — 다시 시도하세요";

/** DM 허용 선택지 — 에이전트 줄의 `DmAccessField` 와 같은 글 */
const DM_ACCESS_LABEL: Record<DmAccess, string> = { off: "끔", admins: "admin 이상", everyone: "모두" };

/** 「기본」(null) — 모델·effort 는 프로그램 기본, 권한은 실행 때 min(default, 그 러너의 상한)(세션 설정 스펙 S5) */
export const DEFAULT_LABEL = "기본";
/** 권한 모드 선택지가 러너 상한 위라 막혔다 */
export const ABOVE_CEILING = (ceiling: RunnerPermissionMode) => `러너 상한(${ceiling}) 위는 고를 수 없습니다`;

type PermissionOption = { mode: RunnerPermissionMode; disabled: boolean };

/** 권한 모드 선택지 넷 — 러너 상한(`ceiling`) 위는 막는다. 상한을 모르면(러너 끊김) 넷 다 고른다(서버도 대조를 건너뛴다) */
export function permissionOptions(ceiling: RunnerPermissionMode | undefined): PermissionOption[] {
  return RUNNER_PERMISSION_MODES.map((mode) => ({
    mode,
    disabled: ceiling !== undefined && permissionModeRank(mode) > permissionModeRank(ceiling),
  }));
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

/** 서버 400 의 칸 — 천장(program)은 고정 문구, 프로젝트는 PROJECT_GONE, 봇은 옛 러너·폐기한 러너 */
function serverCreateError(err: unknown): { field: string; message: string } | undefined {
  if (!(err instanceof ApiRequestError) || err.code !== "VALIDATION") return undefined;
  const field = detailField(err, ["program", "runnerProjectId", "bot", "runnerTokenId"]);
  if (field === undefined) return undefined;
  if (field === "bot") return { field: "place", message: RUNNER_BOTS_UPDATE_MESSAGE };
  if (field === "runnerTokenId") return { field: "form", message: PICKED_RUNNER_REVOKED };
  return { field, message: field === "runnerProjectId" ? PROJECT_GONE : CEILING_REFUSED };
}

/** 봇 정의 네 칸의 화면 이름(러너 봇 스펙 B3) — 만들기와 상세 편집이 같은 글 */
export const BOT_FIELD_LABEL: Record<"purpose" | "watches" | "does" | "reports", string> = {
  purpose: "목적(한 줄)",
  watches: "지켜볼 것",
  does: "할 일",
  reports: "보고할 것",
};
/** 「봇(폴더만)」 선택지의 설명 — 러너가 그 봇 전용 폴더를 만들고 런은 그 폴더에서 돈다(B1) */
export const BOT_PLACE_HINT =
  "러너가 이 봇 전용 폴더를 만들고 그 폴더에서 돕니다 — 저장소·프로젝트가 없어도 됩니다";
export const EMPTY_BOT: RunnerBotDefinition = { purpose: "", watches: "", does: "", reports: "" };

/** 봇 정의 네 칸 + 도구 — 빈 도구는 키째 뺀다(옛 정의와 같은 꼴) */
function withTools(def: RunnerBotDefinition, tools: BotTools): RunnerBotDefinition {
  const { purpose, watches, does, reports } = def;
  return {
    purpose,
    watches,
    does,
    reports,
    mcpServers: tools.mcpServers,
    mcpAutoAllow: tools.mcpAutoAllow,
    builtinTools: tools.builtinTools,
  };
}

/**
 * 봇 정의 네 칸과 템플릿(러너 봇 스펙 B3·B5) — 템플릿을 고르면 네 칸을 그 글로 채운다(고친 글은 덮인다). 상한은 칸의 maxLength 가
 * 지킨다(목적 200, 나머지 2000 — 서버도 거른다)
 */
export function BotDefinitionFields({
  value,
  onChange,
  disabled,
}: {
  value: RunnerBotDefinition;
  onChange: (next: RunnerBotDefinition) => void;
  disabled: boolean;
}) {
  const ids = useId();
  const set = (key: keyof typeof BOT_FIELD_LABEL) => (text: string) => onChange({ ...value, [key]: text });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span id={`${ids}-templates`} className="text-sm font-medium">
          템플릿
        </span>
        <div role="group" aria-labelledby={`${ids}-templates`} className="flex flex-wrap gap-2">
          {BOT_TEMPLATES.map((t) => (
            <Button
              key={t.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onChange({ ...t.definition })}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>
      <Row label={BOT_FIELD_LABEL.purpose}>
        {(id, describedBy) => (
          <Input
            id={id}
            value={value.purpose}
            maxLength={RUNNER_BOT_PURPOSE_MAX}
            aria-describedby={describedBy}
            disabled={disabled}
            onChange={(e) => set("purpose")(e.target.value)}
          />
        )}
      </Row>
      {(["watches", "does", "reports"] as const).map((key) => (
        <Row key={key} label={BOT_FIELD_LABEL[key]}>
          {(id, describedBy) => (
            <Textarea
              id={id}
              value={value[key]}
              rows={3}
              maxLength={RUNNER_BOT_SECTION_MAX}
              aria-describedby={describedBy}
              disabled={disabled}
              onChange={(e) => set(key)(e.target.value)}
            />
          )}
        </Row>
      ))}
    </div>
  );
}

/** 봇 정의가 상한 안인가 — maxLength 가 지키지만 붙여 넣기·옛 값까지 */
const botWithinLimits = (def: RunnerBotDefinition) =>
  def.purpose.length <= RUNNER_BOT_PURPOSE_MAX &&
  [def.watches, def.does, def.reports].every((t) => t.length <= RUNNER_BOT_SECTION_MAX);

/**
 * 에이전트 상세의 봇 정의(러너 봇 스펙 B3·B10) — 접힌 채로는 목적 한 줄, 펼치면 네 칸 편집. 정의는 그 연결의 주인·admin 이상만 받는다
 * (member 의 Agent 에는 없다 — 그때는 그리지 않는다). 저장하면 그 봇의 세션이 새 정의로 새로 열린다
 */
export function BotDefinitionEditor({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const current = agent.runnerAgent?.bot;
  const save = usePatchAgent();
  const runners = useRunners();
  const [draft, setDraft] = useState<RunnerBotDefinition>();
  const [tools, setTools] = useState<BotTools>(EMPTY_BOT_TOOLS);
  const [toolsValid, setToolsValid] = useState(true);
  const [error, setError] = useState<string>();
  const runner = runners.data?.find((r) => r.id === agent.runner?.tokenId);
  const handle = `@${agent.handle}`;
  if (current === undefined) return null;
  if (draft === undefined || readOnly) {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">봇 정의</p>
          <p className={current.purpose === "" ? "text-sm text-muted-foreground" : "line-clamp-2 text-sm"}>
            {current.purpose === "" ? "목적이 비어 있습니다" : current.purpose}
          </p>
        </div>
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`${handle} 봇 정의 편집`}
            onClick={() => {
              setDraft({ ...current });
              setTools(botToolsOf(current));
              setToolsValid(true);
            }}
          >
            정의 편집
          </Button>
        )}
      </div>
    );
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending || !botWithinLimits(draft) || !toolsValid) return;
    setError(undefined);
    save.mutate(
      // 가림 글자(••••) 자리는 그대로 보낸다 — 서버가 원래 값을 지킨다(T4)
      { id: agent.id, patch: { bot: withTools(draft, tools) } },
      {
        onSuccess: () => setDraft(undefined),
        onError: (err) => setError(formError(err) ?? "봇 정의를 저장하지 못했습니다 — 다시 시도하세요"),
      },
    );
  }
  return (
    <form onSubmit={submit} aria-label={`${handle} 봇 정의`} className="flex flex-col gap-3">
      <p className="text-sm font-medium">봇 정의</p>
      <p className="-mt-2 text-xs text-muted-foreground">
        저장하면 이 봇의 세션이 새 정의로 새로 열립니다. 러너 머신의 SOUL.md 도 다음 런에 이 정의로 바뀝니다.
      </p>
      <BotDefinitionFields value={draft} onChange={setDraft} disabled={save.isPending} />
      <BotToolsFields
        value={tools}
        onChange={setTools}
        onValidity={setToolsValid}
        runner={runner}
        disabled={save.isPending}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setDraft(undefined)} disabled={save.isPending}>
          취소
        </Button>
        <Button type="submit" disabled={save.isPending || !toolsValid}>
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}

/**
 * 러너 에이전트 만들기(러너 일반화 스펙 7장) — 프로젝트 상세의 「에이전트 만들기」가 그 러너·프로젝트로 고정해 연다(연결 탭 통합 스펙
 * 3.3). 프로그램 → 이름·핸들·지시·DM 허용. 모델·권한 모드·허용 도구는 묻지 않는다 — 대화마다 작성기 위 상태 줄에서 고르고, 새 세션
 * 시작값은 에이전트 상세에서(세션 설정 스펙 S4·S10). 프로그램은 그 러너가 알린 것만, 못 쓰는 것은 흐리게 사유와 함께. 서버 400 의 천장
 * 칸은 그 칸 아래, 핸들 409 는 핸들 칸 아래, 그 밖은 폼 아래.
 * 러너·프로젝트는 고정이고 프로그램은 처음 한 번만 첫 것을 고른다 — 러너가 끊기거나 폐기되거나 프로젝트가 보관되거나 프로그램을 못 쓰게
 * 되면 그 칸에 사유를 보이며 「만들기」를 잠근다(에이전트가 어느 머신에서 돌지가 모르는 사이에 바뀌지 않게)
 */
export function RunnerAgentForm({
  runnerId,
  projectId,
  takenHandles,
  onCreated,
}: {
  runnerId: string;
  /** 없으면 봇만 만든다(러너 상세의 「봇 만들기」). 있으면 「이 프로젝트 / 봇(폴더만)」을 고른다 */
  projectId?: string;
  takenHandles: ReadonlySet<string>;
  onCreated: () => void;
}) {
  const runners = useRunners();
  const create = useCreateAgent({ silent: true });
  const runnerPick: string = runnerId;
  const projectPick: string = projectId ?? "";
  // 「자리」(러너 봇 스펙 B2) — 프로젝트 또는 봇(폴더만). 프로젝트 없이 열면 봇뿐
  const [place, setPlace] = useState<"project" | "bot">(projectId === undefined ? "bot" : "project");
  const [botDef, setBotDef] = useState<RunnerBotDefinition>(EMPTY_BOT);
  const [botTools, setBotTools] = useState<BotTools>(EMPTY_BOT_TOOLS);
  const [botToolsValid, setBotToolsValid] = useState(true);
  const [programPick, setProgramPick] = useState<RunnerProgram>();
  const [handle, setHandle] = useState("");
  const [name, setName] = useState<string>(); // undefined 면 핸들을 따른다
  const [prompt, setPrompt] = useState("");
  const [dmAccess, setDmAccess] = useState<DmAccess>("admins");
  const [serverError, setServerError] = useState<{ field: string; message: string }>();
  // 「작업 위치」 — 이 프로젝트 또는 새 워크트리(워크트리 스펙 5.5). 만든 워크트리는 에이전트가 실패해도 남아 다시 누르면 그것을 쓴다
  const [where, setWhere] = useState<"here" | "worktree">("here");
  const [madeWorktree, setMadeWorktree] = useState<RunnerProject>();
  const createWorktree = useCreateWorktree(projectPick);
  const ids = useId();

  const list = useMemo(() => (runners.data ?? []).filter((r) => !r.revoked), [runners.data]);
  // 고른 프로그램만 렌더 중에 정한다(앞 렌더에서 온 정보로 상태 맞추기) — 한 번 정한 뒤로는 바꾸지 않는다
  const runner = list.find((r) => r.id === runnerPick);
  const live = runner?.connected === true;
  const runnerIssue = runner === undefined ? PICKED_RUNNER_REVOKED : live ? undefined : PICKED_RUNNER_OFFLINE;
  const projects = useRunnerProjects(runner?.id, { enabled: projectId !== undefined });
  const asBot = place === "bot";
  // 능력 bots 가 없는 러너(옛 판)에서는 봇을 잠근다(B7). 끊겼으면 runnerIssue 가 먼저 막는다
  const botLock = live && !runner.capabilities.includes("bots") ? RUNNER_BOTS_UPDATE_MESSAGE : undefined;
  const activeProjects = (projects.data ?? []).filter((p) => p.archivedAt === null);
  // 붙은 러너가 그 루트를 알리지 않는 프로젝트 — 보이되 고를 수 없다(거기 만든 에이전트는 첫 런부터 천장 밖이다)
  const rootMissing = (p: { rootLabel: string | null }) => live && p.rootLabel === null;
  const selectable = activeProjects.filter((p) => !rootMissing(p));
  const project = selectable.find((p) => p.id === projectPick);
  const projectIssue =
    asBot || project !== undefined || projects.data === undefined
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
  const currentName = name ?? handle;
  const draft = useWorktreeDraft(project ?? { rootId: "", relPath: "" });
  // 부모가 git 저장소 맨 위이고 잠금이 없을 때만(옛 러너·끊김·워크트리 자신이면 지름길이 없다)
  const canWorktree =
    !asBot && project !== undefined && runner !== undefined && worktreeLock(project, runner) === undefined;
  // 이미 만든 워크트리가 있으면 러너가 그 사이 끊겨(canWorktree 거짓) 라디오가 사라져도 그 워크트리에 만든다 — 부모로 새지 않게
  const toWorktree = where === "worktree" && (canWorktree || madeWorktree !== undefined);
  const pending = create.isPending || createWorktree.isPending;

  const handleError =
    serverError?.field === "handle"
      ? serverError.message
      : handle !== ""
        ? handleIssue(handle, takenHandles)
        : undefined;
  const nameError = handle !== "" || name !== undefined ? nameProblem(currentName) : undefined;
  const ready =
    runner !== undefined &&
    runnerIssue === undefined &&
    (asBot ? botLock === undefined && botWithinLimits(botDef) && botToolsValid : project !== undefined) &&
    program !== undefined &&
    handle !== "" &&
    handleIssue(handle, takenHandles) === undefined &&
    nameProblem(currentName) === undefined &&
    (!toWorktree || madeWorktree !== undefined || draft.valid) &&
    !pending;

  const clear = () => setServerError(undefined);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (toWorktree) draft.touch();
    if (!ready || !program || !runner) return;
    if (asBot) {
      clear();
      const botInput: CreateRunnerAgentInput = {
        provider: "runner",
        runnerTokenId: runner.id,
        bot: withTools(botDef, botTools),
        program: program.program,
        handle,
        name: currentName.trim(),
        dmAccess,
      };
      create.mutate(botInput, { onSuccess: onCreated, onError: failed });
      return;
    }
    if (!project) return;
    clear();
    let target = project.id;
    let kept: RunnerProject | undefined;
    if (toWorktree) {
      kept = madeWorktree;
      if (!kept) {
        try {
          kept = await createWorktree.mutateAsync(draft.body());
        } catch (err) {
          const failure = worktreeCreateError(err);
          return setServerError({
            field: "worktree",
            message: failure.detail ? `${failure.text} (${failure.detail})` : failure.text,
          });
        }
        setMadeWorktree(kept);
      }
      target = kept.id;
    }
    const keptPrefix = (message: string) => (kept ? `${WORKTREE_KEPT} — ${message}` : message);
    const input: CreateRunnerAgentInput = {
      provider: "runner",
      runnerProjectId: target,
      program: program.program,
      handle,
      name: currentName.trim(),
      ...(prompt.trim() === "" ? {} : { basePrompt: prompt }),
      dmAccess,
    };
    create.mutate(input, {
      onSuccess: onCreated,
      onError: (err) => {
        const field = serverCreateError(err);
        if (field)
          return setServerError(kept ? { field: "form", message: keptPrefix(field.message) } : field);
        if (err instanceof ApiRequestError && err.code === "CONFLICT")
          return setServerError({ field: "handle", message: HANDLE_TAKEN });
        setServerError({
          field: "form",
          message: keptPrefix(runnerRequestError(err) ?? formError(err) ?? CREATE_FAILED),
        });
      },
    });
  }

  function failed(err: unknown) {
    const field = serverCreateError(err);
    if (field) return setServerError(field);
    if (err instanceof ApiRequestError && err.code === "CONFLICT")
      return setServerError({ field: "handle", message: HANDLE_TAKEN });
    setServerError({ field: "form", message: runnerRequestError(err) ?? formError(err) ?? CREATE_FAILED });
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
  const fixedProject = (projects.data ?? []).find((p) => p.id === projectPick);
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <dl className="grid gap-1.5 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">러너</dt>
          <dd aria-describedby={runnerIssue ? `${ids}-runner-error` : undefined}>
            {runner?.label ?? (runners.data ?? []).find((r) => r.id === runnerPick)?.label ?? "—"}
          </dd>
        </div>
        <FieldError id={`${ids}-runner-error`}>{runnerIssue}</FieldError>
        {projectId !== undefined && !asBot && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">프로젝트</dt>
            <dd className="min-w-0 break-all">
              {fixedProject ? (
                <>
                  {worktreeName(fixedProject, projects.data ?? [])} — {projectPlace(fixedProject)}
                  {rootMissing(fixedProject) ? ` (${ROOT_MISSING})` : ""}
                </>
              ) : (
                "—"
              )}
            </dd>
          </div>
        )}
        <FieldError id={`${ids}-project-error`}>
          {projectIssue ?? (serverError?.field === "runnerProjectId" ? serverError.message : undefined)}
        </FieldError>
      </dl>
      {projectId !== undefined && (
        <RadioGroup
          aria-label="자리"
          value={place}
          disabled={pending || madeWorktree !== undefined}
          onValueChange={(v) => {
            clear();
            setPlace(v as "project" | "bot");
          }}
          className="flex flex-col gap-2"
        >
          <span className="text-sm font-medium">자리</span>
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${ids}-place-project`} value="project" />
            <Label htmlFor={`${ids}-place-project`} className="font-normal">
              이 프로젝트
            </Label>
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <RadioGroupItem
                id={`${ids}-place-bot`}
                value="bot"
                disabled={botLock !== undefined}
                aria-describedby={`${ids}-place-bot-hint`}
              />
              <Label
                htmlFor={`${ids}-place-bot`}
                className={botLock ? "font-normal text-muted-foreground" : "font-normal"}
              >
                봇(폴더만)
              </Label>
            </div>
            <p id={`${ids}-place-bot-hint`} className="pl-6 text-xs text-muted-foreground">
              {botLock ?? BOT_PLACE_HINT}
            </p>
          </div>
        </RadioGroup>
      )}
      {projectId === undefined && (
        <p className="text-sm text-muted-foreground">{botLock ?? BOT_PLACE_HINT}</p>
      )}
      <FieldError id={`${ids}-place-error`}>
        {serverError?.field === "place" ? serverError.message : undefined}
      </FieldError>
      {canWorktree && runner && (
        <div className="flex flex-col gap-3">
          <RadioGroup
            aria-label="작업 위치"
            value={where}
            disabled={pending || madeWorktree !== undefined}
            onValueChange={(v) => {
              clear();
              setWhere(v as "here" | "worktree");
            }}
            className="flex flex-wrap gap-4"
          >
            <span className="text-sm font-medium">작업 위치</span>
            {(
              [
                ["here", "이 프로젝트"],
                ["worktree", "새 워크트리"],
              ] as const
            ).map(([value, text]) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem id={`${ids}-where-${value}`} value={value} />
                <Label htmlFor={`${ids}-where-${value}`} className="font-normal">
                  {text}
                </Label>
              </div>
            ))}
          </RadioGroup>
          {toWorktree &&
            (madeWorktree ? (
              <p className="text-sm text-muted-foreground">
                워크트리 <code className="font-mono">{madeWorktree.branch}</code> 를 만들었습니다 — 이
                워크트리에 에이전트를 만듭니다.
              </p>
            ) : (
              <WorktreeFields draft={draft} runner={runner} disabled={pending} />
            ))}
          {serverError?.field === "worktree" && (
            <Alert variant="destructive">
              <AlertDescription>{serverError.message}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
      {runner === undefined ? null : (
        <>
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
          {asBot ? (
            <BotDefinitionFields
              value={botDef}
              onChange={(next) => {
                clear();
                setBotDef(next);
              }}
              disabled={pending || botLock !== undefined}
            />
          ) : null}
          {asBot && (
            <BotToolsFields
              value={botTools}
              onChange={(next) => {
                clear();
                setBotTools(next);
              }}
              onValidity={setBotToolsValid}
              runner={runner}
              disabled={pending || botLock !== undefined}
            />
          )}
          {asBot ? null : (
            <Row label="지시">
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
          )}
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

/** 노력치(effort) 선택지 — 「기본」 뒤 다섯(shared RUNNER_EFFORTS), 화면 이름은 EFFORT_LABEL */
export const EFFORT_OPTIONS = RUNNER_EFFORTS;

type DefaultsDraft = { model: string; effort: RunnerEffort | ""; permissionMode: RunnerPermissionMode | "" };

/**
 * 러너 에이전트의 「새 세션 시작값」(세션 설정 스펙 S10) — 설정 행이 없는 새 세션이 이 값으로 돈다. 모델·effort·권한 모드 모두 비워 둘
 * 수 있다(「기본」). 권한은 지금 붙은 러너의 상한까지 — 위는 막고 사유 한 줄, 끊겨 있으면 넷 다(서버도 건너뛰고 런에서 러너가 거절한다).
 * PATCH 는 바뀐 칸만 sessionDefaults 로 싣는다. 프로그램·프로젝트는 읽기만 한다(러너 일반화 계획 판정 PR10)
 */
export function SessionDefaultsForm({
  agent,
  defaults,
  projectId,
  onSave,
  onCancel,
  pending,
  serverError,
}: {
  agent: Agent;
  defaults: SessionDefaults;
  projectId: string | null;
  onSave: (patch: Partial<SessionDefaults>) => void;
  onCancel: () => void;
  pending: boolean;
  serverError: unknown;
}) {
  const runners = useRunners();
  const tokenId = agent.runner?.tokenId;
  const runner = runners.data?.find((r) => r.id === tokenId);
  const projects = useRunnerProjects(tokenId);
  const project = projects.data?.find((p) => p.id === projectId);
  const program = agent.program ?? "claude";
  const ceiling = runner?.connected
    ? runner.programs.find((p) => p.program === program)?.ceiling.maxPermissionMode
    : undefined;
  const ceilingPending = tokenId !== undefined && runners.isPending;
  const ids = useId();
  const [draft, setDraft] = useState<DefaultsDraft>({
    model: defaults.model ?? "",
    effort: defaults.effort ?? "",
    permissionMode: defaults.permissionMode ?? "",
  });
  const model = draft.model.trim() === "" ? null : draft.model.trim();
  const effort = draft.effort === "" ? null : draft.effort;
  const permissionMode = draft.permissionMode === "" ? null : draft.permissionMode;
  const options = permissionOptions(ceiling);
  const blocked = options.some((o) => o.disabled);
  const server =
    serverError instanceof ApiRequestError && serverError.code === "VALIDATION"
      ? detailField(serverError, ["permissionMode", "sessionDefaults"])
      : undefined;
  const permissionError = server === "permissionMode" ? CEILING_REFUSED : undefined;
  const noApproval = isNoApprovalMode(permissionMode);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    onSave({
      ...(model === defaults.model ? {} : { model }),
      ...(effort === defaults.effort ? {} : { effort }),
      ...(permissionMode === defaults.permissionMode ? {} : { permissionMode }),
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
      <Row label="모델">
        {(id, describedBy) => (
          <Input
            id={id}
            value={draft.model}
            placeholder={DEFAULT_LABEL}
            maxLength={MODEL_MAX}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={describedBy}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          />
        )}
      </Row>
      <Row label="노력치">
        {(id, describedBy) => (
          <select
            id={id}
            className={SELECT}
            value={draft.effort}
            aria-describedby={describedBy}
            disabled={pending}
            onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value as DefaultsDraft["effort"] }))}
          >
            <option value="">{DEFAULT_LABEL}</option>
            {EFFORT_OPTIONS.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABEL[level]}
              </option>
            ))}
          </select>
        )}
      </Row>
      <Row label="권한 모드" error={permissionError}>
        {(id, describedBy) => (
          <>
            <select
              id={id}
              className={SELECT}
              value={draft.permissionMode}
              aria-invalid={permissionError !== undefined}
              aria-describedby={
                [
                  describedBy,
                  blocked && ceiling ? `${ids}-ceiling` : undefined,
                  noApproval ? `${ids}-no-approval` : undefined,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              disabled={pending || ceilingPending}
              onChange={(e) =>
                setDraft((d) => ({ ...d, permissionMode: e.target.value as DefaultsDraft["permissionMode"] }))
              }
            >
              <option value="">{DEFAULT_LABEL}</option>
              {options.map(({ mode, disabled }) => (
                <option key={mode} value={mode} disabled={disabled}>
                  {PERMISSION_MODE_LABEL[mode]}
                </option>
              ))}
            </select>
            {blocked && ceiling && <ReasonHint id={`${ids}-ceiling`} text={ABOVE_CEILING(ceiling)} />}
            {noApproval && (
              <p id={`${ids}-no-approval`} className="text-xs text-destructive">
                {NO_APPROVAL_HINT} — 이 에이전트는 이 세션 시작값으로 도는 동안 사람에게 묻지 않고 도구를
                씁니다
              </p>
            )}
          </>
        )}
      </Row>
      {serverError !== undefined && server === undefined && formError(serverError) !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{formError(serverError)}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
          취소
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}
