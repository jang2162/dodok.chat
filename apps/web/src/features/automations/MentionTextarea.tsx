import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import {
  type ComponentProps,
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgents, useMe, useMembers, usePeople } from "@/api/queries";
import { MentionList, type MentionListHandle } from "@/features/composer/MentionList";
import { matchMentions, mentionCandidates } from "@/features/composer/mentions";
import { Textarea } from "@/ui/textarea";

/** 커서 바로 앞의 `@검색어` — 글자·숫자 뒤의 @(이메일 등)는 멘션이 아니다 */
const QUERY = /(^|[^\p{L}\p{N}_])@([^\s@]*)$/u;

/**
 * 자동화 문구 칸 — 작성기와 같은 @ 후보(`mentionCandidates` — 그 채널의 에이전트 다음 사람)와 같은 후보 목록(`MentionList`)을 쓴다.
 * 고르면 평문 `@핸들` 이 들어간다: 자동화 문구는 평문으로 저장되고 게시할 때 서버가 토큰화한다(계획 판정 PA1) — 작성기처럼
 * `<@a:id>` 토큰을 넣으면 수정 때 그대로 보이고 핸들이 바뀌어도 경고가 따라가지 않는다. ↑↓·Enter·Tab 은 후보가 보일 때 목록이
 * 받는다. Esc 는 후보만 닫는다 — 대화상자까지 닫히지 않게 `onMenuChange` 로 부르는 쪽(대화상자의 Esc 처리)에 알린다
 */
export function MentionTextarea({
  channelId,
  value,
  onChange,
  onMenuChange,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  channelId: string;
  value: string;
  onChange: (value: string) => void;
  onMenuChange?: (open: boolean) => void;
}) {
  const members = useMembers(channelId, { enabled: channelId !== "" });
  const agents = useAgents();
  const me = useMe();
  const people = usePeople();
  const candidates = useMemo(
    () => mentionCandidates(channelId ? members.data : [], agents.data, me.data, people.data),
    [channelId, members.data, agents.data, me.data, people.data],
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<MentionListHandle>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  // Esc 로 닫은 검색어 자리 — 글이 바뀌거나 커서가 옮기면 다시 연다
  const [dismissed, setDismissed] = useState<{ value: string; caret: number }>();
  const [active, setActive] = useState<{ listbox?: string; option?: string }>({});
  const pendingCaret = useRef<number | undefined>(undefined);

  const match = QUERY.exec(value.slice(0, caret));
  const query = match?.[2];
  // 같은 배열을 넘겨야 목록이 ↑↓ 로 고른 줄을 지킨다 — 새 배열이면 MentionList 가 첫 줄로 돌아간다
  const items = useMemo(
    () => (query === undefined ? [] : matchMentions(candidates, query)),
    [candidates, query],
  );
  const open = items.length > 0 && !(dismissed?.value === value && dismissed.caret === caret);

  const menuChange = useRef(onMenuChange);
  menuChange.current = onMenuChange;
  useLayoutEffect(() => menuChange.current?.(open), [open]);
  useLayoutEffect(() => () => menuChange.current?.(false), []);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === undefined || !textarea.current) return;
    pendingCaret.current = undefined;
    textarea.current.setSelectionRange(at, at);
  }, [value]);

  const onActive = useCallback((option: string | undefined) => {
    const listbox = wrapper.current?.querySelector('[role="listbox"]')?.id;
    setActive((prev) =>
      prev.option === option && prev.listbox === listbox
        ? prev
        : option === undefined
          ? {}
          : { ...(listbox ? { listbox } : {}), option },
    );
  }, []);

  // 고른 후보가 늘 보이게 — 낮은 화면(화상 키보드)에서 목록이 대화상자 스크롤 상자 아래로 잘려도 ↑↓ 로 고른 줄은 들어온다(D3)
  useLayoutEffect(() => {
    if (!open || !active.option) return;
    document.getElementById(active.option)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active.option]);

  const { maxLength } = props;

  function pick({ label }: MentionNodeAttrs) {
    if (query === undefined) return;
    const start = caret - query.length - 1;
    const before = value.slice(0, start);
    const after = value.slice(caret);
    // 프로그램으로 넣는 글자는 textarea 의 maxLength 를 지나지 않는다 — 넘칠 만큼은 자른다
    const room = maxLength === undefined ? Infinity : Math.max(0, maxLength - before.length - after.length);
    const inserted = `@${label ?? ""} `.slice(0, room);
    const next = before + inserted + after;
    pendingCaret.current = start + inserted.length;
    setCaret(start + inserted.length);
    onChange(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed({ value, caret });
      return;
    }
    if (listRef.current?.onKeyDown(e.nativeEvent)) e.preventDefault();
  }

  return (
    <div ref={wrapper} className="relative">
      <Textarea
        {...props}
        ref={textarea}
        value={value}
        aria-autocomplete="list"
        aria-controls={open ? active.listbox : undefined}
        aria-activedescendant={open ? active.option : undefined}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          onChange(e.target.value);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1">
          <MentionList ref={listRef} items={items} command={pick} onActive={onActive} />
        </div>
      )}
    </div>
  );
}
