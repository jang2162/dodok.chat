import type { Agent, Channel } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError, validationField } from "@/api/formErrors";
import { useCanManage } from "@/api/queries";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { usePatchChannel } from "./mutations";
import { type RelayForm, type RelayFormField, fromForm, toForm } from "./relayPolicyForm";
import { Saved, Section } from "./Section";

/**
 * 릴레이 정책(스펙 6.3): 턴 상한, 일일 실행 상한(빈칸 = 없음), 허용 쌍. 「모든 에이전트끼리 허용」을 끄면
 * 채널 에이전트의 from→to 체크 목록(자기 자신 제외). 검증 오류·서버 VALIDATION·CONFLICT 는 섹션 안, 그 밖은 전역 토스트.
 * admin 미만이면 값만 보이고 잠근다(팀 스펙 2장 — 릴레이 정책·일일 한도는 비용 설정이다)
 */
export function RelayPolicySection({ channel, agents }: { channel: Channel; agents: Agent[] }) {
  const locked = !useCanManage();
  const save = usePatchChannel(channel.id);
  const disabled = save.isPending || locked;
  const [draft, setDraft] = useState<RelayForm>();
  const [error, setError] = useState<{ message: string; field?: RelayFormField }>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  // 잠겼으면 저장되지 않은 초안이 아니라 서버 값을 보인다(강등 직후 — `OverrideEditor` 와 같은 규칙)
  const form = (locked ? undefined : draft) ?? toForm(channel.relayPolicy);

  function edit(next: Partial<RelayForm>) {
    setDraft({ ...form, ...next });
    setError(undefined);
    setSaved(false);
  }

  function togglePair(from: string, to: string, on: boolean) {
    const rest = form.pairs.filter((p) => !(p.from === from && p.to === to));
    edit({ pairs: on ? [...rest, { from, to }] : rest });
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || disabled) return;
    const parsed = fromForm(draft);
    if (!parsed.ok) {
      setError({ message: parsed.error, field: parsed.field });
      return;
    }
    setError(undefined);
    save.mutate(
      { relayPolicy: parsed.policy },
      {
        onSuccess: () => {
          setDraft(undefined);
          setSaved(true);
        },
        onError: (err) => {
          const message = formError(err);
          if (message === undefined) return;
          // 서버 VALIDATION 도 가리킨 칸이 있으면 그 칸에 표시한다(`body — relayPolicy.dailyRunLimit: …`)
          setError({ message, field: validationField(message, ["dailyRunLimit", "maxRelayTurns"]) });
        },
      },
    );
  }

  /** 그 칸의 오류면 표시와 설명을 잇는다 */
  const fieldProps = (field: RelayFormField, hintId: string) =>
    error?.field === field
      ? { "aria-invalid": true as const, "aria-describedby": `${hintId} ${id}-error` }
      : { "aria-describedby": hintId };

  return (
    <Section title="릴레이 정책" locked={locked}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-turns`}>턴 상한</Label>
            <Input
              id={`${id}-turns`}
              inputMode="numeric"
              value={form.maxRelayTurns}
              {...fieldProps("maxRelayTurns", `${id}-turns-hint`)}
              disabled={disabled}
              onChange={(e) => edit({ maxRelayTurns: e.target.value })}
            />
            <p id={`${id}-turns-hint`} className="text-xs text-muted-foreground">
              에이전트끼리 이어 부르는 횟수(0~32)
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-daily`}>일일 실행 상한</Label>
            <Input
              id={`${id}-daily`}
              inputMode="numeric"
              value={form.dailyRunLimit}
              placeholder="없음"
              {...fieldProps("dailyRunLimit", `${id}-daily-hint`)}
              disabled={disabled}
              onChange={(e) => edit({ dailyRunLimit: e.target.value })}
            />
            <p id={`${id}-daily-hint`} className="text-xs text-muted-foreground">
              비우면 상한 없음
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${id}-all`}
            checked={form.allowAll}
            disabled={disabled}
            onCheckedChange={(allowAll) => edit({ allowAll })}
          />
          <Label htmlFor={`${id}-all`}>모든 에이전트끼리 허용</Label>
        </div>
        {!form.allowAll && <PairList agents={agents} form={form} disabled={disabled} onToggle={togglePair} />}
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {!locked && (
          <div className="flex items-center justify-end gap-3">
            {saved && <Saved />}
            <Button type="submit" size="sm" disabled={draft === undefined || save.isPending}>
              {save.isPending ? "저장 중…" : "저장"}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}

/** 보내는 쪽 → 받는 쪽 체크 목록. 체크한 쌍만 릴레이된다(비어 있으면 릴레이 없음) */
function PairList({
  agents,
  form,
  disabled,
  onToggle,
}: {
  agents: Agent[];
  form: RelayForm;
  disabled: boolean;
  onToggle: (from: string, to: string, on: boolean) => void;
}) {
  const id = useId();
  if (agents.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        에이전트가 둘 이상 있어야 쌍을 고를 수 있습니다. 지금은 릴레이가 일어나지 않습니다.
      </p>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs text-muted-foreground">
        체크한 쌍만 릴레이합니다(보내는 쪽 → 받는 쪽)
      </legend>
      {agents.flatMap((from) =>
        agents
          .filter((to) => to.id !== from.id)
          .map((to) => {
            const pairId = `${id}-${from.id}-${to.id}`;
            return (
              <div key={pairId} className="flex items-center gap-2">
                <Checkbox
                  id={pairId}
                  checked={form.pairs.some((p) => p.from === from.id && p.to === to.id)}
                  disabled={disabled}
                  onCheckedChange={(on) => onToggle(from.id, to.id, on === true)}
                />
                <Label htmlFor={pairId} className="font-normal">
                  @{from.handle} → @{to.handle}
                </Label>
              </div>
            );
          }),
      )}
    </fieldset>
  );
}
