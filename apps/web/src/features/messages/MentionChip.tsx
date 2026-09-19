import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { useAuthors } from "./useAuthors";

/**
 * 본문 안 멘션(스펙 5.2) — @핸들, 에이전트면 에이전트 색 점. 모르는 id 는 점 없이 「@알 수 없음」.
 * 라벨은 링크 글자가 아니라 id 로 찾은 핸들이다 — 칩에 보이는 이름과 릴레이 대상이 늘 같다(web-t7 리뷰 m1)
 */
export function MentionChip({ kind, id }: { kind: "a" | "u"; id: string }) {
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
      {`@${handle ?? "알 수 없음"}`}
    </span>
  );
}
