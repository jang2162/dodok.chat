import type { Channel } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { useCanManage } from "@/api/queries";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { usePatchChannel } from "./mutations";
import { Saved, Section } from "./Section";

export const PROMPT_MAX = 20_000;

/**
 * 채널 프롬프트·채널 지시·릴레이 정책 중 무엇이 바뀌어도 서버가 Claude 러너 세션을 다음 런에서 새 세션으로 연다
 * (ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」) — 세 저장 안내가 함께 싣는 대가
 */
export const RUNNER_RENEW_NOTICE = "Claude 러너 에이전트는 다음 런을 새 대화로 시작합니다";

/** OpenClaw 는 기존 세션에 채널 프롬프트가 온전히 반영되지 않는다(ADR 0003) */
export const PROMPT_SAVED_NOTICE = `다음 턴부터 반영됩니다. ${RUNNER_RENEW_NOTICE}. OpenClaw 에이전트의 진행 중인 세션에는 온전히 반영되지 않고 새 세션부터 반영됩니다`;

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
        <p className="text-xs text-muted-foreground">이 채널의 모든 에이전트가 매 턴 함께 받는 지시입니다.</p>
        <Textarea
          aria-label="채널 프롬프트"
          aria-describedby={describedBy}
          aria-invalid={error !== undefined || undefined}
          value={value}
          maxLength={PROMPT_MAX}
          rows={8}
          placeholder="없음"
          disabled={save.isPending || locked}
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
        {!locked && (
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={draft === undefined || save.isPending}>
              {save.isPending ? "저장 중…" : "저장"}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}
