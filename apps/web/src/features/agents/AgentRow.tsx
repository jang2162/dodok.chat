import type { Agent } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { formError } from "@/api/formErrors";
import { usePatchAgent } from "./mutations";

const PROMPT_MAX = 20_000;

/** 목록 한 줄: 이름·핸들·OpenClaw id·사용 토글·기본 프롬프트. 토글은 낙관적 갱신 없이 요청 중에만 잠근다(실패는 전역 토스트) */
export function AgentRow({ agent }: { agent: Agent }) {
  const toggle = usePatchAgent();
  const handle = `@${agent.handle}`;
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
            <span className="text-sm text-muted-foreground">{handle}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            OpenClaw id <code className="font-mono">{agent.providerAgentId}</code>
          </p>
        </div>
        <Switch
          aria-label={`${handle} 사용`}
          checked={agent.enabled}
          disabled={toggle.isPending}
          onCheckedChange={(enabled) => toggle.mutate({ id: agent.id, patch: { enabled } })}
        />
      </div>
      <BasePromptEditor agent={agent} />
    </li>
  );
}

/** 접힌 채로는 미리보기, 펼치면 편집. 비워 저장하면 null(지움). VALIDATION·CONFLICT 만 폼 안에 — 그 밖은 전역 토스트 */
function BasePromptEditor({ agent }: { agent: Agent }) {
  const save = usePatchAgent();
  const [draft, setDraft] = useState<string>(); // undefined 면 접힘
  const [error, setError] = useState<string>();
  // 편집을 닫으면(저장·취소) 다시 그려지는 편집 버튼에 초점 — 편집칸이 사라져 body 로 떨어지지 않게
  const [refocus, setRefocus] = useState(false);
  const id = useId();
  const handle = `@${agent.handle}`;

  if (draft === undefined) {
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
        <Button
          variant="outline"
          size="sm"
          aria-label={`${handle} 기본 프롬프트 편집`}
          autoFocus={refocus}
          onClick={() => setDraft(agent.basePrompt ?? "")}
        >
          기본 프롬프트 편집
        </Button>
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
