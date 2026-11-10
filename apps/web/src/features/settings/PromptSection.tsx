import type { Channel } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { useCanManage } from "@/api/queries";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { usePatchChannel } from "./mutations";
import { Saved, Section } from "./Section";

export const PROMPT_MAX = 20_000;

/** 지시 저장 안내 — 다음 턴부터 반영된다 */
export const PROMPT_SAVED_NOTICE = "다음 턴부터 반영됩니다.";

/**
 * 채널 프롬프트(스펙 6.3). 공백뿐이면 지운다(null). VALIDATION·CONFLICT 만 섹션 안에, 그 밖은 전역 토스트.
 * admin 미만이면 값만 보이고 잠근다(팀 스펙 2장 — 서버도 막는다)
 */
export function PromptSection({ channel }: { channel: Channel }) {
  const locked = !useCanManage();
  const save = usePatchChannel(channel.id);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  // 잠겼으면 저장되지 않은 초안이 아니라 서버 값을 보인다(강등 직후 — `OverrideEditor` 와 같은 규칙)
  const value = (locked ? undefined : draft) ?? channel.prompt ?? "";

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending || locked) return;
    setError(undefined);
    save.mutate(
      { prompt: draft.trim() === "" ? null : draft },
      {
        onSuccess: () => {
          setDraft(undefined);
          setSaved(true);
        },
        onError: (err) => setError(formError(err)),
      },
    );
  }

  const describedBy = [`${id}-count`, error && `${id}-error`].filter(Boolean).join(" ");
  return (
    <Section title="채널 프롬프트" locked={locked}>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Textarea
          aria-label="채널 프롬프트"
          aria-describedby={describedBy}
          aria-invalid={error !== undefined || undefined}
          value={value}
          maxLength={PROMPT_MAX}
          rows={8}
          placeholder="없음"
          // 저장 중 잠금은 `disabled` 가 아니라 `readOnly` + `aria-disabled` — `disabled` 가 되면 브라우저가 초점을 버려
          // 키보드로 저장한 사람이 자리를 잃는다(보관 채널 반응 칩·자동화 「지금 실행」과 같은 꼴). 권한 잠금은 그대로 `disabled`
          disabled={locked}
          readOnly={save.isPending}
          aria-disabled={save.isPending || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
        {!locked && (
          <div className="flex justify-end">
            {/* 보낼 것이 없거나 저장 중이면 `aria-disabled` 로만 잠근다 — 저장이 끝나 초안이 비어도 초점이 이 버튼에 남게. 누름은 submit 이 거른다 */}
            <Button
              type="submit"
              size="sm"
              aria-disabled={draft === undefined || save.isPending || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {save.isPending ? "저장 중…" : "저장"}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}
