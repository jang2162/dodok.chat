import type { Agent } from "@dodok/shared";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Button } from "@/ui/button";
import { useRestoreAgent } from "./mutations";
import { providerIdLabel } from "./providerLabels";

/**
 * 「삭제된 에이전트 N」 접힌 묶음(스펙 「에이전트 보관」 절 웹) — 줄마다 이름·핸들·제공자 id, admin 이상이면 「되살리기」.
 * 되살린 줄은 살아 있는 목록으로 옮겨 가 여기서 빠진다. `toggleRef` 는 페이지가 보관 뒤 초점을 옮기는 자리다
 */
export function ArchivedAgents({
  agents,
  readOnly,
  toggleRef,
}: {
  agents: readonly Agent[];
  readOnly: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section aria-label="삭제된 에이전트" className="flex flex-col gap-3">
      <Button
        ref={toggleRef}
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon aria-hidden className={cn("transition-transform", open && "rotate-90")} />
        삭제된 에이전트 {agents.length}
      </Button>
      {open && (
        <ul id={listId} className="flex flex-col gap-2">
          {agents.map((agent) => (
            <ArchivedRow key={agent.id} agent={agent} readOnly={readOnly} toggleRef={toggleRef} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** 되살리면 이 줄이 사라진다 — 초점이 body 로 떨어지지 않게, 묶음이 남아 있으면 그 단추로 */
function ArchivedRow({
  agent,
  readOnly,
  toggleRef,
}: {
  agent: Agent;
  readOnly: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const { restore, isPending } = useRestoreAgent();
  const handle = `@${agent.handle}`;

  return (
    <li className="flex items-center gap-3 rounded-lg border border-dashed p-3">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full opacity-50"
        style={{ background: agentColorVar(agent.handle) }}
      />
      <div className="min-w-0 flex-1 text-muted-foreground">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{agent.name}</span>
          <span className="text-sm">
            <span>{handle}</span>
            {agent.provider === "openclaw" && agent.gateway && <> · {agent.gateway.name}</>}
          </span>
        </div>
        <p className="text-xs">
          {providerIdLabel(agent.provider)} <code className="font-mono">{agent.providerAgentId}</code>
        </p>
      </div>
      {!readOnly && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`${handle} 되살리기`}
          disabled={isPending}
          onClick={() => restore(agent.id, () => toggleRef.current?.focus())}
        >
          {isPending ? "되살리는 중…" : "되살리기"}
        </Button>
      )}
    </li>
  );
}
