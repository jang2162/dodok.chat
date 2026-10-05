import { cn } from "@/lib/utils";
import { ArchivedTag } from "@/features/agents/ArchivedTag";
import { agentColorVar } from "@/theme/agentColor";
import { useAuthors } from "./useAuthors";

/**
 * 본문 안 멘션(스펙 5.2) — @핸들, 에이전트면 에이전트 색 점. 모르는 id 는 점 없이 「@알 수 없음」.
 * 보관(삭제)한 에이전트는 핸들 뒤에 「삭제됨」(스펙 「에이전트 보관」 절, 읽히는 모양은 `ArchivedTag`).
 * 라벨은 링크 글자가 아니라 id 로 찾은 핸들이다 — 칩에 보이는 이름과 릴레이 대상이 늘 같다(web-t7 리뷰 m1)
 */
export function MentionChip({ kind, id }: { kind: "a" | "u"; id: string }) {
  const authors = useAuthors();
  const handle = authors.mention(kind, id);
  const archived = kind === "a" && authors.archivedAgent(id);
  return (
    <span
      data-mention={kind}
      data-archived={archived || undefined}
      className={cn(
        "rounded bg-primary/10 px-1 font-medium whitespace-nowrap text-primary",
        !handle && "bg-muted text-muted-foreground",
      )}
    >
      {kind === "a" && handle && (
        <span
          data-agent-dot
          aria-hidden
          className="mr-1 inline-block size-1.5 rounded-full align-middle"
          style={{ backgroundColor: agentColorVar(handle) }}
        />
      )}
      {`@${handle ?? "알 수 없음"}`}
      {archived && <ArchivedTag className="ml-1 text-xs font-normal text-muted-foreground" />}
    </span>
  );
}
