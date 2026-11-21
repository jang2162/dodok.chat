import { type AgentCommand, COMMANDS_UNSUPPORTED_MESSAGE } from "@dodok/shared";
import { type Editor, Extension, type JSONContent, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { type Ref, useEffect, useId, useImperativeHandle, useState } from "react";
import { cn } from "@/lib/utils";
import { commandTrigger, matchCommands } from "./commands";

/** 목록의 한 줄 — 명령, 또는 그 에이전트가 명령을 받지 못한다는 한 줄(옛 러너·플러그인·끊김) */
export type CommandItem = { kind: "command"; command: AgentCommand } | { kind: "unsupported" };

export type CommandListHandle = { onKeyDown(event: KeyboardEvent): boolean };
type CommandListProps = {
  items: CommandItem[];
  select: (item: AgentCommand) => void;
  onActive?: (optionId: string | undefined) => void;
  ref?: Ref<CommandListHandle>;
};

/**
 * `/` 명령 후보 팝업(에이전트 명령 스펙 5.5) — 멘션 목록(MentionList)과 같은 꼴: 이름·인자 힌트·설명, ↑↓ 이동, Enter·Tab 선택(Esc 는
 * suggestion 플러그인이 닫는다). 명령을 못 받는 에이전트면 목록 대신 업데이트 안내 한 줄(고를 수 없다)
 */
export function CommandList({ items, select, onActive, ref }: CommandListProps) {
  const listboxId = useId();
  const commands = items.flatMap((i) => (i.kind === "command" ? [i.command] : []));
  const [active, setActive] = useState({ items, index: 0 });
  const index = active.items === items ? active.index : 0;
  const move = (delta: number) =>
    setActive({ items, index: (index + delta + commands.length) % commands.length });
  const pick = (i: number) => {
    const c = commands[i];
    if (c) select(c);
  };
  const activeId = commands.length > 0 ? `${listboxId}-${index}` : undefined;
  useEffect(() => {
    onActive?.(activeId);
    return () => onActive?.(undefined);
  }, [activeId, onActive]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (commands.length === 0) return false;
      if (event.key === "ArrowUp") move(-1);
      else if (event.key === "ArrowDown") move(1);
      else if (event.key === "Enter" || event.key === "Tab") pick(index);
      else return false;
      return true;
    },
  }));

  if (items.length === 0) return null;
  if (items.some((i) => i.kind === "unsupported")) {
    return (
      <div
        role="status"
        className="z-50 max-w-80 rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md"
      >
        {COMMANDS_UNSUPPORTED_MESSAGE}
      </div>
    );
  }
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label="명령 후보"
      className="z-50 max-w-[min(28rem,calc(100vw-2rem))] min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {commands.map((c, i) => (
        <div
          key={c.name}
          id={`${listboxId}-${i}`}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(i)}
          className={cn(
            "flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1.5 text-sm",
            i === index && "bg-accent text-accent-foreground",
          )}
        >
          <span className="shrink-0 font-medium">/{c.name}</span>
          {c.argumentHint && <span className="shrink-0 text-xs text-muted-foreground">{c.argumentHint}</span>}
          <span className="truncate text-muted-foreground">{c.description}</span>
        </div>
      ))}
    </div>
  );
}

/** 지금 그 에이전트의 목록 — 아직 못 받았으면 undefined(빈 목록), 못 받는 에이전트면 supported false */
export type AgentCommandsLookup = (
  agentId: string,
) => { supported: boolean; commands: AgentCommand[] } | undefined;

type CommandSuggestion = Omit<SuggestionOptions<CommandItem, AgentCommand>, "editor">;

/** 편집기가 팝업을 가리키게 한다(MentionList 의 pointTo 와 같다) */
function pointTo(editorDom: HTMLElement, listboxId: string | undefined, activeId: string | undefined) {
  if (listboxId === undefined) editorDom.removeAttribute("aria-controls");
  else editorDom.setAttribute("aria-controls", listboxId);
  if (activeId === undefined) editorDom.removeAttribute("aria-activedescendant");
  else editorDom.setAttribute("aria-activedescendant", activeId);
}

/**
 * `/` 의 suggestion 설정. 문서가 명령 모양일 때만 연다(commandTrigger) — 글 중간·경로의 `/` 에는 뜨지 않는다. 고르면 `/<이름> ` 을
 * 넣는다. 목록은 처음 `/` 를 칠 때 받기 시작한다(onTrigger) — 받으면 작성기가 `refresh()` 로 열린 목록을 다시 그린다
 */
export function commandSuggestion(opts: {
  lookup: AgentCommandsLookup;
  directAgentId: () => string | undefined;
  onTrigger: () => void;
  menu: { open: boolean };
}): { suggestion: CommandSuggestion; refresh: () => void } {
  // 문서는 부르는 쪽이 준다 — allow 는 플러그인 apply 안에서 불려 editor.state 가 아직 옛 문서다(새 state 를 받는다)
  const trigger = (doc: JSONContent) => {
    const directAgentId = opts.directAgentId();
    return commandTrigger(doc, directAgentId === undefined ? {} : { directAgentId });
  };
  const itemsFor = (editor: Editor, query: string): CommandItem[] => {
    const at = trigger(editor.getJSON());
    if (!at) return [];
    opts.onTrigger();
    const entry = opts.lookup(at.agentId);
    if (!entry) return [];
    if (!entry.supported) return [{ kind: "unsupported" }];
    return matchCommands(entry.commands, query).map((command) => ({ kind: "command", command }));
  };
  // 열린 목록 — 목록이 늦게 도착하면 refresh 가 이것으로 다시 그린다
  let current:
    | { props: SuggestionProps<CommandItem, AgentCommand>; redraw: (items: CommandItem[]) => void }
    | undefined;
  const refresh = () => {
    if (current) current.redraw(itemsFor(current.props.editor, current.props.query));
  };
  const suggestion: CommandSuggestion = {
    char: "/",
    pluginKey: new PluginKey("agentCommand"),
    placement: "top-start",
    allow: ({ state }) => trigger(state.doc.toJSON() as JSONContent) !== null,
    items: ({ editor, query }) => itemsFor(editor, query),
    command: ({ editor, range, props }: { editor: Editor; range: Range; props: AgentCommand }) => {
      editor.chain().focus().insertContentAt(range, `/${props.name} `).run();
    },
    render: () => {
      let renderer: ReactRenderer<CommandListHandle, CommandListProps> | undefined;
      let unmount: (() => void) | undefined;
      let editorDom: HTMLElement | undefined;
      const onActive = (activeId: string | undefined) => {
        const listbox = renderer?.element.querySelector('[role="listbox"]');
        if (editorDom) pointTo(editorDom, listbox?.id, activeId);
      };
      const propsOf = (p: SuggestionProps<CommandItem, AgentCommand>): CommandListProps => ({
        items: p.items,
        select: (c) => p.command(c),
        onActive,
      });
      // 고를 줄이 있을 때만 Enter 를 가로챈다 — 안내 한 줄이면 Enter 는 보내기다
      const isOpen = (p: SuggestionProps<CommandItem, AgentCommand>) =>
        p.items.some((i) => i.kind === "command");
      const track = (p: SuggestionProps<CommandItem, AgentCommand>) => {
        current = {
          props: p,
          redraw: (items) => {
            const next = { ...p, items };
            opts.menu.open = isOpen(next);
            renderer?.updateProps(propsOf(next));
          },
        };
      };
      // 이 판의 suggestion 은 items 를 비동기로 받아 늦은 onUpdate 가 옛 목록으로 덮는다 — 그릴 때마다 지금 목록으로 다시 계산한다
      const fresh = (p: SuggestionProps<CommandItem, AgentCommand>) => ({
        ...p,
        items: itemsFor(p.editor, p.query),
      });
      return {
        onStart: (raw) => {
          const p = fresh(raw);
          editorDom = p.editor.view.dom;
          renderer = new ReactRenderer(CommandList, { editor: p.editor, props: propsOf(p) });
          opts.menu.open = isOpen(p);
          unmount = p.mount(renderer.element);
          track(p);
        },
        onUpdate: (raw) => {
          const p = fresh(raw);
          opts.menu.open = isOpen(p);
          renderer?.updateProps(propsOf(p));
          track(p);
        },
        onKeyDown: ({ event }) => renderer?.ref?.onKeyDown(event) ?? false,
        onExit: () => {
          current = undefined;
          opts.menu.open = false;
          if (editorDom) pointTo(editorDom, undefined, undefined);
          unmount?.();
          renderer?.destroy();
          renderer = undefined;
          unmount = undefined;
          editorDom = undefined;
        },
      };
    },
  };
  return { suggestion, refresh };
}

/** `/` 명령 자동완성 확장 — Mention 확장과 나란히 둔다 */
export const AgentCommandSuggestion = Extension.create<{ suggestion: CommandSuggestion | null }>({
  name: "agentCommandSuggestion",
  addOptions: () => ({ suggestion: null }),
  addProseMirrorPlugins() {
    return this.options.suggestion ? [Suggestion({ editor: this.editor, ...this.options.suggestion })] : [];
  },
});
