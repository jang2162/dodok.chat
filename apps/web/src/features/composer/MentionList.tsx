import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { type Ref, useEffect, useId, useImperativeHandle, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { CANDIDATE_ROW_CLASS, CheckMark, MentionCandidateRow } from "./MentionCandidateRow";
import { type MentionCandidate, matchMentions, mentionContent, mentionIdsIn } from "./mentions";

export type MentionListHandle = { onKeyDown(event: KeyboardEvent): boolean };
type MentionListProps = {
  items: MentionCandidate[];
  /** 한 명 고르기 — 여럿 고르기(`onInsert`)가 없을 때(자동화 문구 칸) Enter·Tab·클릭이 부른다 */
  command: (attrs: MentionNodeAttrs) => void;
  /**
   * 여럿 고르기(작성기): 줄 클릭·Tab 은 체크를 켜고 끄고, Enter 는 체크한 것(없으면 강조된 하나)을, 「N명 넣기」는 체크한 것을 넣는다.
   * 체크는 검색어가 바뀌어 줄이 안 보여도 남는다(목록이 닫히면 버린다)
   */
  onInsert?: (picked: readonly MentionCandidate[]) => void;
  /** 이미 초안에 든 후보 id — 체크된 채 잠근다(여럿 고르기에서만) */
  inDraft?: ReadonlySet<string>;
  /** 체크한 수가 바뀔 때 — 후보가 안 보여도 체크가 있으면 목록이 열린 것으로 친다(작성기의 Enter 전송이 양보하게) */
  onCheckedChange?: (count: number) => void;
  /** 편집기가 `aria-activedescendant` 로 가리킬 지금 줄의 id — 목록이 닫히면 undefined */
  onActive?: (optionId: string | undefined) => void;
  ref?: Ref<MentionListHandle>;
};

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * @ 후보 팝업(스펙 5.1): 줄은 @ 단추 피커와 같은 `MentionCandidateRow`(아바타·이름·핸들·「AI」 배지 등), 꺼진 에이전트는 흐리게 +
 * 「꺼짐」(고를 수 있으므로 aria-disabled 는 달지 않는다). ↑↓ 이동, Esc 는 suggestion 플러그인이 닫는다(체크도 함께 버린다).
 * 여럿 고르기(`onInsert`)면 Tab·클릭은 체크, Enter 는 넣기 — 아니면 Enter·Tab·클릭이 한 명 고르기. 후보도 체크도 없으면 그리지 않는다.
 * 목록·줄에 id 를 두고 지금 줄을 `onActive` 로 알린다 — 편집기(텍스트 상자)가 그 id 를 가리켜야 스크린 리더가 이동을 읽는다
 */
export function MentionList({
  items,
  command,
  onInsert,
  inDraft = NO_IDS,
  onCheckedChange,
  onActive,
  ref,
}: MentionListProps) {
  const listboxId = useId();
  const multi = onInsert !== undefined;
  const [active, setActive] = useState({ items, index: 0 });
  // 고른 순서대로 — 넣을 때 순서는 부르는 쪽이 정한다
  const [checked, setChecked] = useState<ReadonlyMap<string, MentionCandidate>>(new Map());
  // 후보가 바뀌면 첫 줄부터
  const index = active.items === items ? active.index : 0;
  const move = (delta: number) => setActive({ items, index: (index + delta + items.length) % items.length });
  const pickOne = (c: MentionCandidate) => command({ id: c.id, label: c.label });
  const toggle = (c: MentionCandidate) => {
    if (inDraft.has(c.id)) return;
    setChecked((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, c);
      return next;
    });
  };
  const insertChecked = () => {
    if (checked.size > 0) onInsert?.([...checked.values()]);
  };
  const choose = (i: number) => {
    const c = items[i];
    if (!multi) {
      if (c) pickOne(c);
    } else if (checked.size > 0) insertChecked();
    else if (c) onInsert([c]);
  };

  const activeId = items.length > 0 ? `${listboxId}-${index}` : undefined;
  useEffect(() => {
    onActive?.(activeId);
    return () => onActive?.(undefined);
  }, [activeId, onActive]);
  useEffect(() => onCheckedChange?.(checked.size), [checked.size, onCheckedChange]);

  useImperativeHandle(ref, () => ({
    onKeyDown(event) {
      if (items.length === 0 && checked.size === 0) return false;
      if (event.key === "Enter") choose(index);
      else if (items.length === 0) return false;
      else if (event.key === "ArrowUp") move(-1);
      else if (event.key === "ArrowDown") move(1);
      else if (event.key === "Tab") {
        const c = items[index];
        if (c) (multi ? toggle : pickOne)(c);
      } else return false;
      return true;
    },
  }));

  if (items.length === 0 && checked.size === 0) return null;
  return (
    <div className="z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      <div
        id={listboxId}
        role="listbox"
        aria-label="멘션 후보"
        {...(multi ? { "aria-multiselectable": true } : {})}
        className="flex flex-col"
      >
        {items.map((c, i) => {
          const has = multi && inDraft.has(c.id);
          const on = has || checked.has(c.id);
          return (
            <div
              key={c.id}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === index}
              {...(multi ? { "aria-checked": on } : {})}
              // 누르는 동안 편집기 포커스를 뺏지 않는다
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (multi ? toggle(c) : pickOne(c))}
              className={cn(
                CANDIDATE_ROW_CLASS,
                i === index && "bg-accent text-accent-foreground",
                has && "cursor-default opacity-60",
                !c.enabled && "opacity-50",
              )}
            >
              <MentionCandidateRow candidate={c} locked={has} check={multi && <CheckMark checked={on} />} />
            </div>
          );
        })}
      </div>
      {multi && checked.size > 0 && (
        <Button type="button" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={insertChecked}>
          {`${checked.size}명 넣기`}
        </Button>
      )}
    </div>
  );
}

type MentionSuggestion = Omit<SuggestionOptions<MentionCandidate, MentionNodeAttrs>, "editor">;

/** 편집기(role=textbox)가 팝업을 가리키게 한다 — 텍스트 상자에는 aria-expanded 를 달 수 없어(ARIA 1.2) 목록·지금 줄만 가리킨다 */
function pointTo(editorDom: HTMLElement, listboxId: string | undefined, activeId: string | undefined) {
  if (listboxId === undefined) editorDom.removeAttribute("aria-controls");
  else editorDom.setAttribute("aria-controls", listboxId);
  if (activeId === undefined) editorDom.removeAttribute("aria-activedescendant");
  else editorDom.setAttribute("aria-activedescendant", activeId);
}

/**
 * Mention 확장의 `suggestion` 설정. 후보는 부를 때마다 `getCandidates()` 로 읽는다(채널·멤버가 바뀌어도 편집기를 다시 만들지 않게).
 * 여럿 고르기 — 체크한 후보는 후보 목록 순서(@ 단추 피커와 같다)로 `@쿼리` 자리에 멘션 노드 + 공백씩 들어간다. 이미 초안에 든 후보는
 * 목록이 열릴 때 초안에서 읽어 잠근다. `menu.open` 은 후보나 체크가 보이는 동안 참 — 작성기의 Enter 전송이 그때는 양보한다(Enter 는 넣기)
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
      let editorDom: HTMLElement | undefined;
      let latest: SuggestionProps<MentionCandidate, MentionNodeAttrs> | undefined;
      let items = 0;
      let checked = 0;
      const syncOpen = () => {
        menu.open = items > 0 || checked > 0;
      };
      // 목록이 지금 줄을 알려 주면 편집기가 그것을 가리킨다(목록 자체의 id 는 그릴 때 정해진다)
      const onActive = (activeId: string | undefined) => {
        const listbox = renderer?.element.querySelector('[role="listbox"]');
        if (editorDom) pointTo(editorDom, listbox?.id, activeId);
      };
      const onCheckedChange = (n: number) => {
        checked = n;
        syncOpen();
      };
      // Mention 확장의 기본 command 와 같은 꼴(뒤에 공백이 이미 있으면 그것까지 덮는다) — 노드가 여럿일 뿐이다
      const onInsert = (picked: readonly MentionCandidate[]) => {
        if (!latest || picked.length === 0) return;
        const order = getCandidates().map((c) => c.id);
        const rank = (c: MentionCandidate) => {
          const i = order.indexOf(c.id);
          return i === -1 ? order.length : i;
        };
        const sorted = [...picked].sort((a, b) => rank(a) - rank(b));
        const { editor, range } = latest;
        const to = editor.view.state.selection.$to.nodeAfter?.text?.startsWith(" ") ? range.to + 1 : range.to;
        editor.chain().focus().insertContentAt({ from: range.from, to }, mentionContent(sorted)).run();
        editor.view.dom.ownerDocument.defaultView?.getSelection()?.collapseToEnd();
      };
      const propsOf = (
        p: SuggestionProps<MentionCandidate, MentionNodeAttrs>,
        inDraft: ReadonlySet<string>,
      ) => ({
        items: p.items,
        command: p.command,
        onInsert,
        inDraft,
        onCheckedChange,
        onActive,
      });
      let inDraft: ReadonlySet<string> = new Set();
      return {
        onStart: (p) => {
          latest = p;
          editorDom = p.editor.view.dom;
          inDraft = mentionIdsIn(p.editor.getJSON());
          items = p.items.length;
          checked = 0;
          syncOpen();
          renderer = new ReactRenderer(MentionList, { editor: p.editor, props: propsOf(p, inDraft) });
          unmount = p.mount(renderer.element);
        },
        onUpdate: (p) => {
          latest = p;
          items = p.items.length;
          syncOpen();
          renderer?.updateProps(propsOf(p, inDraft));
        },
        onKeyDown: ({ event }) => renderer?.ref?.onKeyDown(event) ?? false,
        onExit: () => {
          menu.open = false;
          if (editorDom) pointTo(editorDom, undefined, undefined);
          unmount?.();
          renderer?.destroy();
          renderer = undefined;
          unmount = undefined;
          editorDom = undefined;
          latest = undefined;
        },
      };
    },
  };
}
