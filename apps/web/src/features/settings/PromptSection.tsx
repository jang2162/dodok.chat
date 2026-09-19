import type { Channel } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/features/agents/mutations";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { usePatchChannel } from "./mutations";
import { Saved, Section } from "./Section";

export const PROMPT_MAX = 20_000;

/** ADR 0003 — 기존 세션에는 채널 프롬프트가 온전히 반영되지 않는다 */
export const PROMPT_SAVED_NOTICE =
  "다음 턴부터 반영됩니다. 이미 진행 중인 대화에 온전히 반영하려면 에이전트별 「새 대화」를 누르세요";

/** 채널 프롬프트(스펙 6.3). 공백뿐이면 지운다(null). VALIDATION·CONFLICT 만 섹션 안에, 그 밖은 전역 토스트 */
export function PromptSection({ channel }: { channel: Channel }) {
  const save = usePatchChannel(channel.id);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const value = draft ?? channel.prompt ?? "";

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending) return;
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
    <Section title="채널 프롬프트">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">이 채널의 모든 에이전트가 매 턴 함께 받는 지시입니다.</p>
        <Textarea
          aria-label="채널 프롬프트"
          aria-describedby={describedBy}
          aria-invalid={error !== undefined || undefined}
          value={value}
          maxLength={PROMPT_MAX}
          rows={8}
          placeholder="없음"
          disabled={save.isPending}
          onChange={(e) => {
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
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={draft === undefined || save.isPending}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
        </div>
      </form>
    </Section>
  );
}
