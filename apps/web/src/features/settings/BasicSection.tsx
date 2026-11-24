import type { Channel } from "@dodok/shared";
import { useId, useState } from "react";
import { formError, validationField } from "@/api/formErrors";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { usePatchChannel } from "./mutations";
import { useRegisterDraft } from "./draft";
import { DIRTY_FIELD, Saved, Section } from "./Section";

/** shared Channel 과 같은 한계 — 서버 VALIDATION(영문 message)보다 먼저 막는다 */
const NAME_MAX = 80;
const TOPIC_MAX = 500;

type Draft = { name: string; topic: string };

/**
 * 이름(필수)·주제. 고치기 전에는 캐시의 채널 값을 그대로 보인다(wire 로 바뀌면 따라간다) — 고치기 시작하면 초안.
 * 저장은 패널 아래 저장 막대가 한다(`useRegisterDraft`). 주제를 비우면 지운다(null). VALIDATION·CONFLICT 만 섹션 안에, 그 밖은 전역 토스트.
 * 저장 중에도 고칠 수 있다 — 저장이 끝났을 때 그 사이 새로 고친 값은 초안으로 남는다(보낸 초안일 때만 내린다)
 */
export function BasicSection({ channel }: { channel: Channel }) {
  const save = usePatchChannel(channel.id);
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState<{ message: string; field?: "name" | "topic" }>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const server = { name: channel.name, topic: channel.topic ?? "" };
  const value = draft ?? server;
  const nameMissing = value.name.trim() === "";
  const dirty = { name: value.name !== server.name, topic: value.topic !== server.topic };
  const changed = Number(dirty.name) + Number(dirty.topic);

  function edit(next: Partial<Draft>) {
    setDraft({ ...value, ...next });
    setError(undefined);
    setSaved(false);
  }

  async function submit() {
    if (draft === undefined || nameMissing) throw new Error("저장할 수 없는 초안");
    const sent = draft;
    setError(undefined);
    const topic = sent.topic.trim();
    try {
      await save.mutateAsync({ name: sent.name.trim(), topic: topic === "" ? null : topic });
    } catch (err) {
      const message = formError(err);
      if (message !== undefined) setError({ message, field: validationField(message, ["name", "topic"]) });
      throw err;
    }
    setDraft((cur) => (cur === sent ? undefined : cur));
    setSaved(true);
  }

  useRegisterDraft(
    "basic",
    changed === 0 ? null : { changed, save: submit, reset: () => (setDraft(undefined), setError(undefined)) },
  );

  return (
    <Section title="기본">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>이름</Label>
          <Input
            id={`${id}-name`}
            value={value.name}
            maxLength={NAME_MAX}
            data-dirty={dirty.name || undefined}
            aria-invalid={nameMissing || error?.field === "name" || undefined}
            aria-describedby={
              nameMissing ? `${id}-name-error` : error?.field === "name" ? `${id}-error` : undefined
            }
            className={DIRTY_FIELD}
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
            data-dirty={dirty.topic || undefined}
            aria-invalid={error?.field === "topic" || undefined}
            aria-describedby={error?.field === "topic" ? `${id}-error` : undefined}
            className={DIRTY_FIELD}
            onChange={(e) => edit({ topic: e.target.value })}
          />
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {saved && <Saved />}
      </div>
    </Section>
  );
}
