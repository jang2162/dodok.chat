import { REACTION_EMOJIS, type ReactionEmoji } from "@dodok/shared";
import { SmilePlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";

/**
 * 「반응 추가」 버튼 + 이모지 8개 메뉴 — 화살표·Enter·Esc 와 닫힐 때 초점 복귀는 Radix 메뉴가 맡는다.
 * 메시지 행의 동작 줄에 놓여 마우스를 올리거나 행 안에 초점이 있을 때 나타나고, 마우스가 없는 기기(`hover: none`)에서는 늘 보인다.
 * 메뉴가 열려 있는 동안은 초점이 행 밖(포털)이라 `data-[state=open]` 으로 붙들어 둔다
 */
export function ReactionPicker({
  onPick,
  className,
}: {
  onPick: (emoji: ReactionEmoji) => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="반응 추가"
          title="반응 추가"
          data-slot="reaction-picker"
          className={cn(
            "absolute top-1 inline-flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground opacity-0 shadow-xs group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
            className,
          )}
        >
          <SmilePlusIcon className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex min-w-0 gap-0.5 p-1">
        {REACTION_EMOJIS.map((emoji) => (
          <DropdownMenuItem
            key={emoji}
            aria-label={emoji}
            className="size-8 justify-center p-0 text-lg"
            onSelect={() => onPick(emoji)}
          >
            {emoji}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
