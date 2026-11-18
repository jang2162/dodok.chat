import {
  type AgentSettingsPatch,
  type ConversationAgentSettings,
  permissionModeRank,
  RUNNER_EFFORTS,
  RUNNER_PERMISSION_MODES,
  type RunnerEffort,
  type RunnerModelOption,
  type RunnerPermissionMode,
} from "@dodok/shared";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";

/** 「기본」 — 모델·effort 는 프로그램 기본, 권한은 실행 때 min(default, 러너 상한)(세션 설정 스펙 S5) */
export const DEFAULT_LABEL = "기본";
/** 러너가 모델 목록을 알리지 않을 때(옛 러너·끊김)의 고정 목록 — 그 밖은 「직접 입력」(작성기 칩 스펙 C4) */
export const MODEL_PRESETS = ["sonnet", "opus", "haiku"] as const;
/** default 보다 높은 권한(acceptEdits)은 러너 주인·admin 만(S2) */
export const RAISE_LOCKED = "러너 주인·admin 만 올릴 수 있습니다";
export const ABOVE_CEILING = (ceiling: RunnerPermissionMode) => `러너 상한(${ceiling}) 위는 고를 수 없습니다`;
/** 지금 effort 를 고른 모델이 받지 않는다 — 값은 그대로 둔다(작성기 칩 스펙 5.4) */
export const EFFORT_UNSUPPORTED = "이 모델이 받지 않는 effort";
const CUSTOM_LABEL = "직접 입력";
/** supportedModels 의 「기본」 줄 — 따로 보이지 않고 「기본」(null)에 합친다(C9) */
const DEFAULT_MODEL_VALUE = "default";

export type ModelChoice = { value: string | null; label: string };

/** 권한 선택지 하나가 막힌 사유 — 상한 위가 먼저(누구도 못 고른다), 그다음 올리기 권한 */
export function permissionLock(
  mode: RunnerPermissionMode,
  opts: { canRaise: boolean; ceiling: RunnerPermissionMode | undefined },
): string | undefined {
  if (opts.ceiling !== undefined && permissionModeRank(mode) > permissionModeRank(opts.ceiling))
    return ABOVE_CEILING(opts.ceiling);
  if (!opts.canRaise && permissionModeRank(mode) > permissionModeRank("default")) return RAISE_LOCKED;
  return undefined;
}

/**
 * 모델 칩의 선택지 — 「기본」(null) + 러너가 알린 모델(표시 이름). default 줄은 「기본」에 합친다(C9). 목록이 비면(옛 러너·끊김)
 * 고정 목록(C4). 저장된 값이 목록에 없으면(직접 입력했던 값·다른 러너로 옮긴 프로젝트) 맨 위에 그 값 그대로 — 사라지게 두지 않는다
 */
export function modelChoices(models: readonly RunnerModelOption[], saved: string | null): ModelChoice[] {
  const listed: ModelChoice[] =
    models.length === 0
      ? MODEL_PRESETS.map((m) => ({ value: m, label: m }))
      : models
          .filter((m) => m.value !== DEFAULT_MODEL_VALUE)
          .map((m) => ({ value: m.value, label: m.displayName || m.value }));
  const choices: ModelChoice[] = [{ value: null, label: DEFAULT_LABEL }, ...listed];
  if (saved !== null && !choices.some((c) => c.value === saved))
    return [{ value: saved, label: saved }, ...choices];
  return choices;
}

/**
 * 노력치 칩의 선택지 — 고른 모델이 받는 단계, 「기본」이면 default 줄의 것. 목록이 없거나(옛 러너·목록에 없는 모델) 그 줄의 단계가
 * 비었으면 다섯 단계 전부(고를 수 없게 되지 않게 — C4)
 */
export function effortChoices(models: readonly RunnerModelOption[], model: string | null): RunnerEffort[] {
  const row = models.find((m) => m.value === (model ?? DEFAULT_MODEL_VALUE));
  return row && row.efforts.length > 0 ? row.efforts : [...RUNNER_EFFORTS];
}

const CHIP =
  "h-6 max-w-48 gap-1 rounded-full border border-input bg-background px-2 text-xs font-normal text-foreground";

/**
 * 작성기 위 칩 셋(작성기 칩 스펙 5.4) — 모델·effort·권한. 칩을 누르면 그 칩의 선택지만 뜨고, 고르면 바로 저장한다(부르는 쪽이 대화면
 * PATCH, 새 세션 창이면 보류 값). 실패·잠금 사유는 칩 옆에(부르는 쪽이 `error` 로 돌려준다)
 */
export function AgentSettingChips({
  handle,
  row,
  models,
  canRaise,
  saving = false,
  error,
  onSave,
}: {
  handle: string;
  row: ConversationAgentSettings;
  /** 그 에이전트 러너가 알린 모델 — 비면 고정 목록 */
  models: readonly RunnerModelOption[];
  canRaise: boolean;
  saving?: boolean;
  error?: string | undefined;
  onSave: (patch: AgentSettingsPatch) => Promise<boolean>;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const ceiling = row.ceiling ?? undefined;
  const choices = modelChoices(models, row.model);
  const modelLabel =
    row.model === null
      ? `모델 ${DEFAULT_LABEL}`
      : (choices.find((c) => c.value === row.model)?.label ?? row.model);
  const efforts = effortChoices(models, row.model);
  const effortOff = row.effort !== null && !efforts.includes(row.effort);
  const locks = RUNNER_PERMISSION_MODES.map((mode) => ({
    mode,
    lock: permissionLock(mode, { canRaise, ceiling }),
  }));
  const reasons = [...new Set(locks.flatMap((l) => (l.lock ? [l.lock] : [])))];

  const pick = (patch: AgentSettingsPatch) => void onSave(patch);
  // Radix 라디오 값은 문자열이다 — 「기본」(null)을 빈 글로 싣는다
  const toValue = (v: string | null) => v ?? "";
  const fromValue = (v: string) => (v === "" ? null : v);

  async function saveCustom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const model = custom?.trim() ?? "";
    if (model === "") return setCustom(null);
    if (model === row.model || (await onSave({ model }))) setCustom(null);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={CHIP}
            disabled={saving}
            aria-label={`@${handle} 모델: ${modelLabel}`}
          >
            <span className="truncate">{modelLabel}</span>
            <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={toValue(row.model)}
            onValueChange={(v) => {
              const next = fromValue(v);
              if (next !== row.model) pick({ model: next });
            }}
          >
            {choices.map((c) => (
              <DropdownMenuRadioItem key={c.value ?? ""} value={toValue(c.value)}>
                {c.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCustom(row.model ?? "")}>{CUSTOM_LABEL}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {custom !== null && (
        <form className="flex items-center gap-1" onSubmit={(e) => void saveCustom(e)}>
          <Input
            aria-label="모델 이름"
            className="h-6 w-36 px-2 text-xs"
            value={custom}
            maxLength={128}
            autoFocus
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCustom(null);
            }}
          />
          <Button type="submit" size="sm" className="h-6 px-2 text-xs" disabled={saving}>
            저장
          </Button>
        </form>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(CHIP, effortOff && "border-amber-500/70")}
            disabled={saving}
            aria-label={`@${handle} effort: ${row.effort ?? DEFAULT_LABEL}${effortOff ? ` — ${EFFORT_UNSUPPORTED}` : ""}`}
            aria-invalid={effortOff || undefined}
          >
            {effortOff && <TriangleAlertIcon className="size-3 text-amber-600" aria-hidden />}
            <span className="truncate">
              {row.effort === null ? `effort ${DEFAULT_LABEL}` : `effort ${row.effort}`}
            </span>
            <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={row.effort ?? ""}
            onValueChange={(v) => {
              const next = v === "" ? null : (v as RunnerEffort);
              if (next !== row.effort) pick({ effort: next });
            }}
          >
            <DropdownMenuRadioItem value="">{DEFAULT_LABEL}</DropdownMenuRadioItem>
            {efforts.map((level) => (
              <DropdownMenuRadioItem key={level} value={level}>
                {level}
              </DropdownMenuRadioItem>
            ))}
            {effortOff && row.effort !== null && (
              <DropdownMenuRadioItem value={row.effort} disabled>
                {row.effort} — {EFFORT_UNSUPPORTED}
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={CHIP}
            disabled={saving}
            aria-label={`@${handle} 권한: ${row.permissionMode ?? DEFAULT_LABEL}`}
          >
            <span className="truncate">{row.permissionMode ?? `권한 ${DEFAULT_LABEL}`}</span>
            <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={row.permissionMode ?? ""}
            onValueChange={(v) => {
              const next = v === "" ? null : (v as RunnerPermissionMode);
              if (next !== row.permissionMode) pick({ permissionMode: next });
            }}
          >
            <DropdownMenuRadioItem value="">{DEFAULT_LABEL}</DropdownMenuRadioItem>
            {locks.map(({ mode, lock }) => (
              <DropdownMenuRadioItem key={mode} value={mode} disabled={lock !== undefined}>
                {mode}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {reasons.length > 0 && (
            <DropdownMenuLabel className="max-w-56 text-xs font-normal text-muted-foreground">
              {reasons.join(" · ")}
            </DropdownMenuLabel>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </>
  );
}
