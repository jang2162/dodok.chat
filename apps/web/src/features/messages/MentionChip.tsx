import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { useAuthors } from "./useAuthors";

/** 본문 안 멘션(스펙 5.2) — @핸들, 에이전트면 에이전트 색 점. 모르는 id 는 점 없이 「@알 수 없음」 */
export function MentionChip({ kind, id, label }: { kind: "a" | "u"; id: string; label: ReactNode }) {
  const handle = useAuthors().mention(kind, id);
  return (
    <span
      data-mention={kind}
      className={cn(
        "inline-flex items-center gap-1 rounded bg-accent px-1 align-baseline font-medium text-accent-foreground",
        !handle && "text-muted-foreground",
      )}
    >
      {kind === "a" && handle && (
        <span
          data-agent-dot
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: agentColorVar(handle) }}
        />
      )}
      {label}
    </span>
  );
}
