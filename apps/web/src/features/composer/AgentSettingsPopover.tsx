import {
  type AgentSettingsPatch,
  RUNNER_EFFORTS,
  RUNNER_PERMISSION_MODES,
  type RunnerEffort,
  type RunnerPermissionMode,
  type SessionDefaults,
  permissionModeRank,
} from "@dodok/shared";
import { Popover as PopoverPrimitive } from "radix-ui";
import { type FormEvent, useId, useState } from "react";
import { ReasonHint } from "@/features/components/DisabledHint";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/** 「기본」 — 모델·effort 는 프로그램 기본, 권한은 실행 때 min(default, 러너 상한)(세션 설정 스펙 S5) */
export const DEFAULT_LABEL = "기본";
/** 모델 고르기의 이름 셋 — 그 밖은 「직접 입력」 */
export const MODEL_PRESETS = ["sonnet", "opus", "haiku"] as const;
const CUSTOM = "__custom";
/** default 보다 높은 권한(acceptEdits)은 러너 주인·admin 만(S2) */
export const RAISE_LOCKED = "러너 주인·admin 만 올릴 수 있습니다";
export const ABOVE_CEILING = (ceiling: RunnerPermissionMode) => `러너 상한(${ceiling}) 위는 고를 수 없습니다`;

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

type Draft = {
  model: string;
  custom: string;
  effort: RunnerEffort | "";
  permissionMode: RunnerPermissionMode | "";
};

const draftOf = (v: SessionDefaults): Draft => {
  const preset = v.model === null || (MODEL_PRESETS as readonly string[]).includes(v.model);
  return {
    model: v.model === null ? "" : preset ? v.model : CUSTOM,
    custom: preset ? "" : (v.model ?? ""),
    effort: v.effort ?? "",
    permissionMode: v.permissionMode ?? "",
  };
};

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
 * 「변경」 팝오버(세션 설정 스펙 5.4) — 모델(기본·sonnet·opus·haiku·직접 입력)·effort(기본·다섯)·권한 모드(기본·넷). 막힌 권한은 고를 수
 * 없고 사유 한 줄. 저장은 바뀐 칸만 싣고, 실패는 그 자리에(부르는 쪽이 `error` 로 돌려준다)
 */
export function AgentSettingsPopover({
  handle,
  value,
  canRaise,
  ceiling,
  saving,
  error,
  onSave,
}: {
  handle: string;
  value: SessionDefaults;
  canRaise: boolean;
  /** 그 러너가 알린 권한 상한 — 모르면(끊김·남의 러너) undefined, 서버가 막는다 */
  ceiling: RunnerPermissionMode | undefined;
  saving: boolean;
  error: string | undefined;
  /** 성공하면 true — 팝오버를 닫는다 */
  onSave: (patch: AgentSettingsPatch) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  const ids = useId();
  const locks = RUNNER_PERMISSION_MODES.map((mode) => ({
    mode,
    lock: permissionLock(mode, { canRaise, ceiling }),
  }));
  const reasons = [...new Set(locks.flatMap((l) => (l.lock ? [l.lock] : [])))];

  const model =
    draft.model === "" ? null : draft.model === CUSTOM ? draft.custom.trim() || null : draft.model;
  const effort = draft.effort === "" ? null : draft.effort;
  const permissionMode = draft.permissionMode === "" ? null : draft.permissionMode;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const patch: AgentSettingsPatch = {
      ...(model === value.model ? {} : { model }),
      ...(effort === value.effort ? {} : { effort }),
      ...(permissionMode === value.permissionMode ? {} : { permissionMode }),
    };
    if (Object.keys(patch).length === 0) return setOpen(false);
    if (await onSave(patch)) setOpen(false);
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(draftOf(value));
        setOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          aria-label={`@${handle} 설정 변경`}
        >
          변경
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          aria-label={`@${handle} 설정`}
          className="z-50 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-model`}>모델</Label>
              <select
                id={`${ids}-model`}
                className={SELECT}
                value={draft.model}
                disabled={saving}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              >
                <option value="">{DEFAULT_LABEL}</option>
                {MODEL_PRESETS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM}>직접 입력</option>
              </select>
              {draft.model === CUSTOM && (
                <Input
                  aria-label="모델 이름"
                  value={draft.custom}
                  maxLength={128}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                  onChange={(e) => setDraft((d) => ({ ...d, custom: e.target.value }))}
                />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-effort`}>effort</Label>
              <select
                id={`${ids}-effort`}
                className={SELECT}
                value={draft.effort}
                disabled={saving}
                onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value as Draft["effort"] }))}
              >
                <option value="">{DEFAULT_LABEL}</option>
                {RUNNER_EFFORTS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-mode`}>권한 모드</Label>
              <select
                id={`${ids}-mode`}
                className={SELECT}
                value={draft.permissionMode}
                disabled={saving}
                aria-describedby={reasons.length > 0 ? `${ids}-locks` : undefined}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, permissionMode: e.target.value as Draft["permissionMode"] }))
                }
              >
                <option value="">{DEFAULT_LABEL}</option>
                {locks.map(({ mode, lock }) => (
                  <option key={mode} value={mode} disabled={lock !== undefined}>
                    {mode}
                  </option>
                ))}
              </select>
              {reasons.length > 0 && <ReasonHint id={`${ids}-locks`} text={reasons.join(" · ")} />}
            </div>
            <FieldError id={`${ids}-error`}>{error}</FieldError>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                취소
              </Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </Button>
            </div>
          </form>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
