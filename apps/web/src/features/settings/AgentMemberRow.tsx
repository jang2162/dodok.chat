import type { Agent, ChannelMember } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/features/agents/mutations";
import { ResetSessionDialog } from "@/features/agents/ResetSessionDialog";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { type AutoRespondStep, autoRespondPlan } from "./autoRespond";
import { ConfirmDialog } from "./ConfirmDialog";
import { usePatchMember, useRemoveMember } from "./mutations";
import { PROMPT_MAX } from "./PromptSection";

/**
 * 채널의 에이전트 한 줄(스펙 6.4): 이름·핸들, 자동 응답, 채널 오버라이드 프롬프트(펼침), 「새 대화」, 제거.
 * 자동 응답을 켤 때 다른 에이전트가 켜져 있으면 확인을 받은 뒤 그쪽을 먼저 끈다(`autoRespondPlan`)
 */
export function AgentMemberRow({
  channelId,
  member,
  agent,
  members,
  handleOf,
  autoRespondBusy,
  onAutoRespond,
}: {
  channelId: string;
  member: ChannelMember;
  agent: Agent;
  members: ChannelMember[];
  handleOf: (agentId: string) => string;
  autoRespondBusy: boolean;
  onAutoRespond: (steps: AutoRespondStep[]) => void;
}) {
  const remove = useRemoveMember(channelId);
  const [switching, setSwitching] = useState<AutoRespondStep[]>();
  const [removing, setRemoving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const handle = `@${agent.handle}`;

  function toggleAutoRespond(on: boolean) {
    const steps = autoRespondPlan(members, agent.id, on);
    if (steps.length > 1) setSwitching(steps);
    else onAutoRespond(steps);
  }

  const turnedOff = (switching ?? []).filter((s) => !s.autoRespond).map((s) => `@${handleOf(s.memberId)}`);
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-1.5 size-2.5 shrink-0 rounded-full"
          style={{ background: agentColorVar(agent.handle) }}
        />
        <div className={cn("min-w-0 flex-1", !agent.enabled && "opacity-60")}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-medium">{agent.name}</span>
            <span className="text-sm text-muted-foreground">{handle}</span>
            {!agent.enabled && <Badge variant="outline">꺼짐</Badge>}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${member.id}-auto`} className="font-normal">
          자동 응답
          <span className="text-xs text-muted-foreground">멘션 없는 메시지에 답함</span>
        </Label>
        <Switch
          id={`${member.id}-auto`}
          aria-label={`${handle} 자동 응답`}
          checked={member.autoRespond}
          disabled={autoRespondBusy}
          onCheckedChange={toggleAutoRespond}
        />
      </div>
      <OverrideEditor channelId={channelId} member={member} handle={handle} />
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label={`${handle} 새 대화`}
          onClick={() => setResetting(true)}
        >
          새 대화
        </Button>
        <Button variant="ghost" size="sm" aria-label={`${handle} 제거`} onClick={() => setRemoving(true)}>
          제거
        </Button>
      </div>

      <ConfirmDialog
        open={switching !== undefined}
        onOpenChange={(open) => !open && setSwitching(undefined)}
        title="자동 응답 바꾸기"
        description={`${turnedOff.join(", ")} 의 자동 응답을 끄고 ${handle} 를 켭니다`}
        confirmLabel="바꾸기"
        onConfirm={() => {
          if (switching) onAutoRespond(switching);
          setSwitching(undefined);
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="에이전트 제거"
        description={`${handle} 를 이 채널에서 뺍니다. 채널 프롬프트 오버라이드와 자동 응답 설정도 사라집니다`}
        confirmLabel="제거"
        pendingLabel="제거하는 중…"
        pending={remove.isPending}
        destructive
        onConfirm={() => remove.mutate(agent.id, { onSuccess: () => setRemoving(false) })}
      />
      <ResetSessionDialog
        channelId={channelId}
        agentId={agent.id}
        handle={agent.handle}
        open={resetting}
        onOpenChange={setResetting}
      />
    </li>
  );
}

/** 채널 오버라이드 프롬프트 — 접힌 채로는 미리보기, 펼치면 편집. 공백뿐이면 지운다(null). VALIDATION·CONFLICT 만 폼 안에 */
function OverrideEditor({
  channelId,
  member,
  handle,
}: {
  channelId: string;
  member: ChannelMember;
  handle: string;
}) {
  const save = usePatchMember(channelId);
  const [draft, setDraft] = useState<string>(); // undefined 면 접힘
  const [error, setError] = useState<string>();
  const id = useId();

  if (draft === undefined) {
    return (
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            "line-clamp-2 min-w-0 text-xs whitespace-pre-wrap",
            member.promptOverride === undefined && "text-muted-foreground",
          )}
        >
          {member.promptOverride ?? "채널 프롬프트 오버라이드 없음"}
        </p>
        <Button
          variant="outline"
          size="xs"
          aria-label={`${handle} 채널 프롬프트 편집`}
          onClick={() => setDraft(member.promptOverride ?? "")}
        >
          편집
        </Button>
      </div>
    );
  }

  function close() {
    setDraft(undefined);
    setError(undefined);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending) return;
    setError(undefined);
    save.mutate(
      { memberId: member.memberId, patch: { promptOverride: draft.trim() === "" ? null : draft } },
      { onSuccess: close, onError: (err) => setError(formError(err)) },
    );
  }

  const describedBy = [`${id}-count`, error && `${id}-error`].filter(Boolean).join(" ");
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor={id}>채널 프롬프트 오버라이드</Label>
      <Textarea
        id={id}
        aria-label={`${handle} 채널 프롬프트`}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined || undefined}
        value={draft}
        maxLength={PROMPT_MAX}
        rows={5}
        autoFocus
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value)}
      />
      <p id={`${id}-count`} className="text-xs text-muted-foreground">
        {(PROMPT_MAX - draft.length).toLocaleString("ko-KR")}자 남음 · 이 채널에서 {handle} 에게만 더하는
        지시입니다
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close} disabled={save.isPending}>
          취소
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}
