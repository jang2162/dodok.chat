import type { Channel } from "@dodok/shared";
import { useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { useCanManage } from "@/api/queries";
import { cn } from "@/lib/utils";
import { Textarea } from "@/ui/textarea";
import { usePatchChannel } from "./mutations";
import { useRegisterDraft } from "./draft";
import { DIRTY_FIELD, Saved, Section } from "./Section";

export const PROMPT_MAX = 20_000;

/** 지시 저장 안내 — 다음 턴부터 반영된다 */
export const PROMPT_SAVED_NOTICE = "다음 턴부터 반영됩니다.";

/**
 * 채널 프롬프트(스펙 6.3). 저장은 패널 아래 저장 막대가 한다(`useRegisterDraft`). 공백뿐이면 지운다(null). VALIDATION·CONFLICT 만 섹션 안에,
 * 그 밖은 전역 토스트. admin 미만이면 값만 보이고 잠근다(팀 스펙 2장 — 서버도 막는다) — 잠긴 섹션은 막대에 들지 않는다
 */
export function PromptSection({ channel }: { channel: Channel }) {
  const locked = !useCanManage();
  const save = usePatchChannel(channel.id);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const server = channel.prompt ?? "";
  // 잠겼으면 저장되지 않은 초안이 아니라 서버 값을 보인다(강등 직후 — `OverrideEditor` 와 같은 규칙)
  const value = (locked ? undefined : draft) ?? server;
  const dirty = value !== server;

  async function submit() {
    if (draft === undefined || locked) throw new Error("저장할 수 없는 초안");
    const sent = draft;
    setError(undefined);
    try {
      await save.mutateAsync({ prompt: sent.trim() === "" ? null : sent });
    } catch (err) {
      setError(formError(err));
      throw err;
    }
    setDraft((cur) => (cur === sent ? undefined : cur));
    setSaved(true);
  }

  useRegisterDraft(
    "prompt",
    !dirty ? null : { changed: 1, save: submit, reset: () => (setDraft(undefined), setError(undefined)) },
  );

  const describedBy = [`${id}-count`, error && `${id}-error`].filter(Boolean).join(" ");
  return (
    <Section title="채널 프롬프트" locked={locked}>
      <div className="flex flex-col gap-2">
        <Textarea
          aria-label="채널 프롬프트"
          aria-describedby={describedBy}
          aria-invalid={error !== undefined || undefined}
          value={value}
          maxLength={PROMPT_MAX}
          rows={8}
          placeholder="없음"
          data-dirty={dirty || undefined}
          // 저장 중 잠금은 `disabled` 가 아니라 `readOnly` + `aria-disabled` — `disabled` 가 되면 브라우저가 초점을 버려
          // 이 칸에 있던 사람이 자리를 잃는다(보관 채널 반응 칩·자동화 「지금 실행」과 같은 꼴). 권한 잠금은 그대로 `disabled`
          disabled={locked}
          readOnly={save.isPending}
          aria-disabled={save.isPending || undefined}
          className={cn("aria-disabled:cursor-not-allowed aria-disabled:opacity-50", DIRTY_FIELD)}
          onChange={(e) => {
            if (save.isPending) return;
            setDraft(e.target.value);
            setError(undefined);
            setSaved(false);
          }}
        />
        <p id={`${id}-count`} className="text-xs text-muted-foreground">
          {(PROMPT_MAX - value.length).toLocaleString("ko-KR")}자 남음
        </p>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {saved && <Saved>{PROMPT_SAVED_NOTICE}</Saved>}
      </div>
    </Section>
  );
}
