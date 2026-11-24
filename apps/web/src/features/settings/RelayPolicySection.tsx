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
 * 채널 에이전트의 보내는 쪽(행) × 받는 쪽(열) 격자(대각선 없음). 검증 오류·서버 VALIDATION·CONFLICT 는 섹션 안, 그 밖은 전역 토스트.
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

  /**
   * 행(`to` 가 null — 그 에이전트가 보내는 쌍 전부)이나 열(`from` 이 null — 받는 쌍 전부)을 한꺼번에 켜고 끈다.
   * 지금 채널 에이전트 사이의 쌍만 건드린다 — 채널에서 빠진 에이전트의 쌍은 남긴다(목록이 그랬듯)
   */
  function setPairs(from: string | null, to: string | null, on: boolean) {
    const targets = agents.flatMap((a) =>
      agents
        .filter((b) => b.id !== a.id && (from === null || a.id === from) && (to === null || b.id === to))
        .map((b) => ({ from: a.id, to: b.id })),
    );
    const hit = (p: { from: string; to: string }) => targets.some((t) => t.from === p.from && t.to === p.to);
    const rest = form.pairs.filter((p) => !hit(p));
    edit({ pairs: on ? [...rest, ...targets] : rest });
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
        {!form.allowAll && (
          <PairGrid
            agents={agents}
            form={form}
            disabled={disabled}
            onToggle={togglePair}
            onSetMany={setPairs}
          />
        )}
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {saved && <Saved />}
        {!locked && (
          <div className="flex items-center justify-end gap-3">
            <Button type="submit" size="sm" disabled={draft === undefined || save.isPending}>
              {save.isPending ? "저장 중…" : "저장"}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}

/**
 * 행 = 보내는 쪽, 열 = 받는 쪽. 체크한 쌍만 릴레이된다(비어 있으면 릴레이 없음). 머리 단추는 그 행·열을 모두 켜고,
 * 이미 모두 켜져 있으면 모두 끈다. 넓으면 표만 가로로 밀리고 머리 열은 붙어 있다
 */
function PairGrid({
  agents,
  form,
  disabled,
  onToggle,
  onSetMany,
}: {
  agents: Agent[];
  form: RelayForm;
  disabled: boolean;
  onToggle: (from: string, to: string, on: boolean) => void;
  onSetMany: (from: string | null, to: string | null, on: boolean) => void;
}) {
  const id = useId();
  if (agents.length < 2) {
    return <p className="text-xs text-muted-foreground">에이전트가 둘 이상 있어야 쌍을 고를 수 있습니다.</p>;
  }
  const has = (from: string, to: string) => form.pairs.some((p) => p.from === from && p.to === to);
  const others = (self: string) => agents.filter((a) => a.id !== self);
  const rowFull = (from: string) => others(from).every((to) => has(from, to.id));
  const colFull = (to: string) => others(to).every((from) => has(from.id, to));
  const headButton = "h-auto px-1.5 py-0.5 font-normal whitespace-nowrap";
  return (
    <div className="flex flex-col gap-1">
      <p id={`${id}-caption`} className="text-xs text-muted-foreground">
        행이 보내는 쪽, 열이 받는 쪽입니다
      </p>
      {/* relative: 폼 안 Radix 체크박스의 숨은 input(absolute)이 이 감싸개 밖을 기준 삼으면 스크롤에 안 갇혀 페이지를 넓힌다 */}
      <div className="relative max-w-full overflow-x-auto rounded-md border">
        <table aria-label="허용 쌍" aria-describedby={`${id}-caption`} className="border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-background p-1 text-left text-xs font-normal">
                <span className="text-muted-foreground">보냄 ↓ 받음 →</span>
              </th>
              {agents.map((to) => (
                <th key={to.id} scope="col" className="p-1 text-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={headButton}
                    disabled={disabled}
                    aria-label={`@${to.handle} 가 받는 쌍 모두`}
                    onClick={() => onSetMany(null, to.id, !colFull(to.id))}
                  >
                    @{to.handle}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((from) => (
              <tr key={from.id} className="border-t">
                <th scope="row" className="sticky left-0 z-10 bg-background p-1 text-left">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={headButton}
                    disabled={disabled}
                    aria-label={`@${from.handle} 가 보내는 쌍 모두`}
                    onClick={() => onSetMany(from.id, null, !rowFull(from.id))}
                  >
                    @{from.handle}
                  </Button>
                </th>
                {agents.map((to) => (
                  <td key={to.id} className="p-1 text-center">
                    {to.id === from.id ? (
                      <span aria-hidden="true" className="text-muted-foreground">
                        —
                      </span>
                    ) : (
                      <Checkbox
                        aria-label={`@${from.handle} → @${to.handle}`}
                        checked={has(from.id, to.id)}
                        disabled={disabled}
                        onCheckedChange={(on) => onToggle(from.id, to.id, on === true)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
