import type { Message, ReactionEmoji } from "@dodok/shared";
import { useChannelArchived } from "@/features/channels/archived";
import { UNKNOWN_NAME, useAuthors } from "@/features/messages/useAuthors";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";

/**
 * 메시지 아래 칩 `👍 3` — 내가 단 칩은 `aria-pressed` 로 강조, 누르면 켜기/끄기. 마우스를 올리거나 초점이 오면 단 사람을
 * 「@mia, @owner」 로 보이고, 비활성 멤버는 「@핸들 (비활성)」. 리액션이 없으면 아무것도 그리지 않는다.
 * 보관한 채널은 읽기만 — `disabled` 가 아니라 `aria-disabled` 에 누름 무시: `disabled` 버튼은 초점을 받지 못해 키보드로는
 * 누가 달았는지 볼 길이 없고, 포인터 이벤트도 브라우저에 따라 안 나간다
 */
export function ReactionChips({
  message,
  me,
  onToggle,
}: {
  message: Pick<Message, "reactions">;
  me: string;
  onToggle: (emoji: ReactionEmoji, on: boolean) => void;
}) {
  const archived = useChannelArchived();
  const { mention, deactivatedPerson } = useAuthors();
  if (message.reactions.length === 0) return null;
  const who = (id: string): string => {
    const handle = mention("u", id);
    if (!handle) return UNKNOWN_NAME;
    return deactivatedPerson(id) ? `@${handle} (비활성)` : `@${handle}`;
  };
  return (
    <TooltipProvider>
      <div className="mt-1 flex flex-wrap gap-1" data-slot="reaction-chips">
        {message.reactions.map((r) => {
          const mine = r.userIds.includes(me);
          return (
            <Tooltip key={r.emoji}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={mine}
                  aria-disabled={archived || undefined}
                  onClick={() => {
                    if (!archived) onToggle(r.emoji, !mine);
                  }}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-disabled:cursor-default",
                    mine
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background text-muted-foreground hover:bg-accent aria-disabled:hover:bg-background",
                  )}
                >
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{r.userIds.map(who).join(", ")}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
