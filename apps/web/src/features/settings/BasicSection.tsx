import type { Channel } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/features/agents/mutations";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { usePatchChannel } from "./mutations";
import { Saved, Section } from "./Section";

/** shared Channel 과 같은 한계 — 서버 VALIDATION(영문 message)보다 먼저 막는다 */
const NAME_MAX = 80;
const TOPIC_MAX = 500;

type Draft = { name: string; topic: string };

/**
 * 이름(필수)·주제. 고치기 전에는 캐시의 채널 값을 그대로 보인다(wire 로 바뀌면 따라간다) — 고치기 시작하면 초안.
 * 주제를 비우면 지운다(null). VALIDATION·CONFLICT 만 섹션 안에, 그 밖은 전역 토스트
 */
export function BasicSection({ channel }: { channel: Channel }) {
  const save = usePatchChannel(channel.id);
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const value = draft ?? { name: channel.name, topic: channel.topic ?? "" };
  const nameMissing = value.name.trim() === "";

  function edit(next: Partial<Draft>) {
    setDraft({ ...value, ...next });
    setError(undefined);
    setSaved(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || nameMissing || save.isPending) return;
    setError(undefined);
    const topic = value.topic.trim();
    save.mutate(
      { name: value.name.trim(), topic: topic === "" ? null : topic },
      {
        onSuccess: () => {
          setDraft(undefined);
          setSaved(true);
        },
        onError: (err) => setError(formError(err)),
      },
    );
  }

  return (
    <Section title="기본">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>이름</Label>
          <Input
            id={`${id}-name`}
            value={value.name}
            maxLength={NAME_MAX}
            aria-invalid={nameMissing || undefined}
            aria-describedby={nameMissing ? `${id}-name-error` : undefined}
            disabled={save.isPending}
            onChange={(e) => edit({ name: e.target.value })}
          />
          {nameMissing && (
            <p id={`${id}-name-error`} className="text-xs text-destructive">
              이름은 비울 수 없습니다
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-topic`}>주제</Label>
          <Input
            id={`${id}-topic`}
            value={value.topic}
            maxLength={TOPIC_MAX}
            placeholder="없음"
            disabled={save.isPending}
            onChange={(e) => edit({ topic: e.target.value })}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {saved && <Saved />}
          <Button type="submit" size="sm" disabled={draft === undefined || nameMissing || save.isPending}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
        </div>
      </form>
    </Section>
  );
}
