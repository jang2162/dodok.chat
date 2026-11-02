import { type MyStatus, StatusMessage, type StatusMode } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { type ExpiryChoice, expiryOf } from "./avatarImage";
import { useUpdateMyStatus } from "./mutations";

const MODE_LABEL: Record<StatusMode, string> = {
  auto: "자동",
  away: "자리 비움",
  busy: "다른 용무 중",
  dnd: "방해 금지",
  invisible: "오프라인으로 보이기",
};
const MODES: StatusMode[] = ["auto", "away", "busy", "dnd", "invisible"];
type Preset = Exclude<ExpiryChoice, { at: Date }> | "custom";
const EXPIRY_LABEL: Record<Preset, string> = {
  never: "안 지움",
  "30m": "30분",
  "1h": "1시간",
  "4h": "4시간",
  today: "오늘",
  custom: "직접 고른 시각",
};
const PRESETS = Object.keys(EXPIRY_LABEL) as Preset[];
/** 자주 쓰는 이모지 — 직접 넣어도 된다(저장은 문자열 하나) */
const EMOJIS = ["💬", "📅", "🍱", "🚗", "🏠", "🤒", "🌴", "🎧"];
const TEXT_MAX = 100;

const SELECT = cn(
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
);

function ExpiryField({
  label,
  preset,
  onPreset,
  custom,
  onCustom,
  disabled,
}: {
  label: string;
  preset: Preset;
  onPreset: (p: Preset) => void;
  custom: string;
  onCustom: (v: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap gap-2">
        <select
          id={id}
          className={SELECT}
          value={preset}
          disabled={disabled}
          onChange={(e) => onPreset(e.target.value as Preset)}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {EXPIRY_LABEL[p]}
            </option>
          ))}
        </select>
        {preset === "custom" && (
          <Input
            type="datetime-local"
            aria-label={`${label} 시각`}
            className="w-auto"
            value={custom}
            disabled={disabled}
            onChange={(e) => onCustom(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

const choiceOf = (preset: Preset, custom: string): ExpiryChoice | undefined =>
  preset === "custom" ? (custom ? { at: new Date(custom) } : undefined) : preset;

/**
 * 상태 고르기(프로필 스펙 3.2·3.8) — 상태 다섯 + 만료, 상태 메시지(이모지 + 글 + 만료), 방해 금지 옵션. 「내 계정」 프로필 섹션과
 * 내 프로필 패널의 「상태 바꾸기」가 같은 폼을 쓴다. 저장하면 `PUT /me/status` 한 번
 */
export function StatusForm({ status, onSaved }: { status: MyStatus | undefined; onSaved?: () => void }) {
  const update = useUpdateMyStatus();
  const ids = { mode: useId(), emoji: useId(), text: useId(), approvals: useId() };
  const [mode, setMode] = useState<StatusMode>(status?.mode ?? "auto");
  const [modePreset, setModePreset] = useState<Preset>("never");
  const [modeCustom, setModeCustom] = useState("");
  const [emoji, setEmoji] = useState(status?.message?.emoji ?? "");
  const [text, setText] = useState(status?.message?.text ?? "");
  const [textPreset, setTextPreset] = useState<Preset>("never");
  const [textCustom, setTextCustom] = useState("");
  const [allowApprovals, setAllowApprovals] = useState(status?.dndAllowApprovals ?? true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  const trimmed = text.trim();
  const tooLong = trimmed.length > TEXT_MAX;
  const modeChoice = mode === "auto" ? "never" : choiceOf(modePreset, modeCustom);
  const textChoice = choiceOf(textPreset, textCustom);
  const ready = !tooLong && modeChoice !== undefined && (trimmed === "" || textChoice !== undefined);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || update.isPending || modeChoice === undefined) return;
    const now = new Date();
    const message =
      trimmed === ""
        ? null
        : StatusMessage.parse({
            emoji: emoji.trim() || null,
            text: trimmed,
            until: textChoice === undefined ? null : expiryOf(textChoice, now),
          });
    setError(undefined);
    setSaved(false);
    update.mutate(
      {
        mode,
        modeUntil: mode === "auto" ? null : expiryOf(modeChoice, now),
        message,
        dndAllowApprovals: allowApprovals,
      },
      {
        onSuccess: () => {
          setSaved(true);
          onSaved?.();
        },
        onError: (err) =>
          setError(formError(err) ?? (err instanceof Error ? err.message : "저장하지 못했습니다")),
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="상태 바꾸기">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.mode}>상태</Label>
        <select
          id={ids.mode}
          className={SELECT}
          value={mode}
          onChange={(e) => setMode(e.target.value as StatusMode)}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </div>
      {mode !== "auto" && (
        <ExpiryField
          label="상태 만료"
          preset={modePreset}
          onPreset={setModePreset}
          custom={modeCustom}
          onCustom={setModeCustom}
        />
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.text}>상태 메시지</Label>
        <div className="flex gap-2">
          <Input
            id={ids.emoji}
            aria-label="상태 이모지"
            className="w-14 text-center"
            value={emoji}
            maxLength={16}
            placeholder="🙂"
            onChange={(e) => setEmoji(e.target.value)}
          />
          <Input
            id={ids.text}
            value={text}
            placeholder="무엇을 하고 있나요?"
            aria-invalid={tooLong || undefined}
            aria-describedby={tooLong ? `${ids.text}-error` : undefined}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="이모지 고르기">
          {EMOJIS.map((e) => (
            <Button
              key={e}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={emoji === e}
              onClick={() => setEmoji(e)}
            >
              {e}
            </Button>
          ))}
        </div>
        {tooLong && (
          <p id={`${ids.text}-error`} className="text-sm text-destructive">
            상태 메시지는 {TEXT_MAX}자까지입니다
          </p>
        )}
      </div>
      {trimmed !== "" && (
        <ExpiryField
          label="상태 메시지 만료"
          preset={textPreset}
          onPreset={setTextPreset}
          custom={textCustom}
          onCustom={setTextCustom}
        />
      )}
      <div className="flex items-start gap-2">
        <Checkbox
          id={ids.approvals}
          checked={allowApprovals}
          aria-describedby={`${ids.approvals}-hint`}
          onCheckedChange={(v) => setAllowApprovals(v === true)}
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={ids.approvals} className="font-normal">
            도구 승인 요청은 계속 받기
          </Label>
          <span id={`${ids.approvals}-hint`} className="text-xs text-muted-foreground">
            방해 금지 중에도 승인 푸시는 보냅니다 — 놓치면 런이 멈춰 기다립니다
          </span>
        </div>
      </div>
      <div className="flex items-center justify-end gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {saved ? "상태를 저장했습니다" : ""}
        </p>
        <Button type="submit" size="sm" disabled={!ready || update.isPending}>
          {update.isPending ? "저장 중…" : "상태 저장"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
