import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { type Ref, useImperativeHandle, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { type MentionCandidate, matchMentions } from "./mentions";

export type MentionListHandle = { onKeyDown(event: KeyboardEvent): boolean };
type MentionListProps = {
  items: MentionCandidate[];
  command: (attrs: MentionNodeAttrs) => void;
  ref?: Ref<MentionListHandle>;
};

/**
 * @ 후보 팝업(스펙 5.1): 핸들·이름·「AI」 배지, 꺼진 에이전트는 흐리게 + 「꺼짐」. ↑↓ 이동, Enter·Tab 선택
 * (Esc 는 suggestion 플러그인이 닫는다). 후보가 없으면 그리지 않는다
 */
export function MentionList({ items, command, ref }: MentionListProps) {
  const [active, setActive] = useState({ items, index: 0 });
  // 후보가 바뀌면 첫 줄부터
  const index = active.items === items ? active.index : 0;
  const move = (delta: number) => setActive({ items, index: (index + delta + items.length) % items.length });
  const select = (i: number) => {
    const c = items[i];
    if (c) command({ id: c.id, label: c.label });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (items.length === 0) return false;
      if (event.key === "ArrowUp") move(-1);
      else if (event.key === "ArrowDown") move(1);
      else if (event.key === "Enter" || event.key === "Tab") select(index);
      else return false;
      return true;
    },
  }));

  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="멘션 후보"
      className="z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((c, i) => (
        <div
          key={c.id}
          role="option"
          aria-selected={i === index}
          aria-disabled={!c.enabled || undefined}
          // 누르는 동안 편집기 포커스를 뺏지 않는다
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => select(i)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
            i === index && "bg-accent text-accent-foreground",
            !c.enabled && "opacity-50",
          )}
        >
          <span className="font-medium">@{c.label}</span>
          <span className="truncate text-muted-foreground">{c.name}</span>
          {c.kind === "agent" && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              AI
            </Badge>
          )}
          {!c.enabled && <span className="ml-auto text-xs">꺼짐</span>}
        </div>
      ))}
    </div>
  );
}

type MentionSuggestion = Omit<SuggestionOptions<MentionCandidate, MentionNodeAttrs>, "editor">;

/**
 * Mention 확장의 `suggestion` 설정. 후보는 부를 때마다 `getCandidates()` 로 읽는다(채널·멤버가 바뀌어도 편집기를 다시 만들지 않게).
 * `menu.open` 은 후보가 보이는 동안 참 — 작성기의 Enter 전송이 그때는 양보한다(Enter 는 후보 선택)
 */
export function mentionSuggestion(
  getCandidates: () => readonly MentionCandidate[],
  menu: { open: boolean },
): MentionSuggestion {
  return {
    // 작성기는 화면 아래에 있다 — 커서 위로 띄운다(자리가 없으면 Floating UI 가 뒤집는다)
    placement: "top-start",
    items: ({ query }) => matchMentions(getCandidates(), query),
    render: () => {
      let renderer: ReactRenderer<MentionListHandle, MentionListProps> | undefined;
      let unmount: (() => void) | undefined;
      const sync = (p: SuggestionProps<MentionCandidate, MentionNodeAttrs>) => {
        menu.open = p.items.length > 0;
        renderer?.updateProps({ items: p.items, command: p.command });
      };
      return {
        onStart: (p) => {
          renderer = new ReactRenderer(MentionList, {
            editor: p.editor,
            props: { items: p.items, command: p.command },
          });
          menu.open = p.items.length > 0;
          unmount = p.mount(renderer.element);
        },
        onUpdate: sync,
        onKeyDown: ({ event }) => renderer?.ref?.onKeyDown(event) ?? false,
        onExit: () => {
          menu.open = false;
          unmount?.();
          renderer?.destroy();
          renderer = undefined;
          unmount = undefined;
        },
      };
    },
  };
}
