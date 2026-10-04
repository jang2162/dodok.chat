import type { Agent } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { formError } from "@/api/formErrors";
import { useIsOwner } from "@/api/queries";
import { MoveGatewayDialog } from "./MoveGatewayDialog";
import { usePatchAgent } from "./mutations";
import { providerIdLabel } from "./providerLabels";

const PROMPT_MAX = 20_000;

/**
 * 목록 한 줄: 이름·핸들(OpenClaw 면 「@핸들 · Gateway 이름」)·제공자별 id·사용 토글·기본 프롬프트. 토글은 낙관적 갱신 없이 요청 중에만
 * 잠근다(실패는 전역 토스트). `readOnly`(admin 미만 — 팀 스펙 2장)면 토글을 잠그고 프롬프트는 미리보기만.
 * OpenClaw 에이전트의 「Gateway 옮기기」는 owner 에게만(멀티 Gateway 스펙 「권한」 절) — 연결이 빈 줄뿐 아니라 어느 줄에서나 옮길 수 있다.
 * 연결이 빈 줄의 안내도 역할에 맞춘다 — 옮길 수 없는 admin·member 에게 옮기라고 권하지 않는다
 */
export function AgentRow({ agent, readOnly = false }: { agent: Agent; readOnly?: boolean }) {
  const toggle = usePatchAgent();
  const owner = useIsOwner();
  const handle = `@${agent.handle}`;
  const openclaw = agent.provider === "openclaw";
  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1.5 size-2.5 shrink-0 rounded-full"
          style={{ background: agentColorVar(agent.handle) }}
        />
        <div className={cn("min-w-0 flex-1", !agent.enabled && "opacity-60")}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{agent.name}</span>
            <span className="text-sm text-muted-foreground">
              <span>{handle}</span>
              {openclaw && agent.gateway && <> · {agent.gateway.name}</>}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {providerIdLabel(agent.provider)} <code className="font-mono">{agent.providerAgentId}</code>
          </p>
          {agent.provider === "claude" && <RunnerLine runner={agent.runner} />}
          {openclaw && agent.gateway === null && (
            <p className="text-xs font-medium text-destructive">
              {owner
                ? "Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요"
                : "Gateway 가 삭제됨 — owner 가 다른 Gateway 로 옮길 때까지 답하지 못합니다"}
            </p>
          )}
        </div>
        {openclaw && owner && <MoveGatewayDialog agent={agent} />}
        <Switch
          aria-label={`${handle} 사용`}
          checked={agent.enabled}
          disabled={toggle.isPending || readOnly}
          onCheckedChange={(enabled) => toggle.mutate({ id: agent.id, patch: { enabled } })}
        />
      </div>
      <BasePromptEditor agent={agent} readOnly={readOnly} />
    </li>
  );
}

/** Claude 러너 에이전트를 맡는 러너(묶인 러너 토큰의 라벨) — 다시 묶기는 연결 페이지(owner)에서 한다 */
function RunnerLine({ runner }: { runner: Agent["runner"] }) {
  if (!runner)
    return <p className="text-xs text-muted-foreground">러너 미정 — 처음 알리는 러너에 묶입니다</p>;
  if (!runner.revoked) return <p className="text-xs text-muted-foreground">러너 {runner.label}</p>;
  return (
    <p className="text-xs font-medium text-destructive">
      러너 {runner.label} — 토큰이 폐기돼 맡을 러너가 없습니다. 연결 페이지에서 다시 묶으세요
    </p>
  );
}

/** 접힌 채로는 미리보기, 펼치면 편집. 비워 저장하면 null(지움). VALIDATION·CONFLICT 만 폼 안에 — 그 밖은 전역 토스트 */
function BasePromptEditor({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const save = usePatchAgent();
  const [draft, setDraft] = useState<string>(); // undefined 면 접힘
  const [error, setError] = useState<string>();
  // 편집을 닫으면(저장·취소) 다시 그려지는 편집 버튼에 초점 — 편집칸이 사라져 body 로 떨어지지 않게
  const [refocus, setRefocus] = useState(false);
  const id = useId();
  const handle = `@${agent.handle}`;

  if (draft === undefined || readOnly) {
    return (
      <div className="flex items-start justify-between gap-3">
        <p
          className={cn(
            "line-clamp-2 min-w-0 text-sm whitespace-pre-wrap",
            agent.basePrompt === undefined && "text-muted-foreground",
          )}
        >
          {agent.basePrompt ?? "기본 프롬프트 없음"}
        </p>
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`${handle} 기본 프롬프트 편집`}
            autoFocus={refocus}
            onClick={() => setDraft(agent.basePrompt ?? "")}
          >
            기본 프롬프트 편집
          </Button>
        )}
      </div>
    );
  }

  function close() {
    setDraft(undefined);
    setError(undefined);
    setRefocus(true);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending) return;
    setError(undefined);
    save.mutate(
      { id: agent.id, patch: { basePrompt: draft.trim() === "" ? null : draft } },
      { onSuccess: close, onError: (err) => setError(formError(err)) },
    );
  }

  const describedBy = [`${id}-count`, error && `${id}-error`].filter(Boolean).join(" ");
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor={id}>기본 프롬프트</Label>
      <Textarea
        id={id}
        aria-label={`${handle} 기본 프롬프트`}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined}
        value={draft}
        maxLength={PROMPT_MAX}
        rows={6}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        disabled={save.isPending}
      />
      <p id={`${id}-count`} className="text-xs text-muted-foreground">
        {(PROMPT_MAX - draft.length).toLocaleString("ko-KR")}자 남음
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close} disabled={save.isPending}>
          취소
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}
