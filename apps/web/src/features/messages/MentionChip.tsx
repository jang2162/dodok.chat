import { cn } from "@/lib/utils";
import { ArchivedTag } from "@/features/agents/ArchivedTag";
import { DeactivatedTag } from "@/features/members/DeactivatedTag";
import { agentColorVar } from "@/theme/agentColor";
import { useOpenProfile } from "@/features/profile/openProfile";
import { useAuthors } from "./useAuthors";

/**
 * 본문 안 멘션(스펙 5.2) — @핸들, 에이전트면 에이전트 색 점. 모르는 id 는 점 없이 「@알 수 없음」.
 * 보관(삭제)한 에이전트는 핸들 뒤에 「삭제됨」(스펙 「에이전트 보관」 절, 읽히는 모양은 `ArchivedTag`), 비활성 멤버는 「비활성」
 * (채널 보관·멤버 비활성화 스펙 「기록과 목록」 절, `DeactivatedTag`).
 * 라벨은 링크 글자가 아니라 id 로 찾은 핸들이다 — 칩에 보이는 이름과 릴레이 대상이 늘 같다(web-t7 리뷰 m1)
 */
export function MentionChip({ kind, id }: { kind: "a" | "u"; id: string }) {
  const authors = useAuthors();
  const openProfile = useOpenProfile();
  const handle = authors.mention(kind, id);
  const archived = kind === "a" && authors.archivedAgent(id);
  const deactivated = kind === "u" && authors.deactivatedPerson(id);
  // 아는 사람·에이전트면 누르면 프로필(프로필 스펙 3.1) — 세션 화면에서만
  const Tag = handle && openProfile ? "button" : "span";
  return (
    <Tag
      {...(Tag === "button"
        ? {
            type: "button" as const,
            onClick: () => openProfile?.({ kind: kind === "a" ? "agent" : "user", id }),
          }
        : {})}
      data-mention={kind}
      data-archived={archived || undefined}
      data-deactivated={deactivated || undefined}
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
      {deactivated && <DeactivatedTag className="ml-1 text-xs font-normal text-muted-foreground" />}
    </Tag>
  );
}
