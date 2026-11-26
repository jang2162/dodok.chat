import { AtSignIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { CANDIDATE_ROW_CLASS, candidateName, MentionCandidateRow } from "./MentionCandidateRow";
import type { MentionCandidate } from "./mentions";

export const PICKER_LABEL = "에이전트 부르기";

const matches = (c: MentionCandidate, q: string) =>
  q === "" || [c.label, c.name, ...c.aliases].some((s) => s.toLowerCase().includes(q));

/**
 * 작성기 도구 줄의 @ 단추(UI 시안 02) — 누르면 검색 칸 + 후보 목록(체크박스, 여러 명) + 「N명 넣기」. 후보는 @ 자동완성과 같은 목록
 * (`candidates` — 작성기가 `mentionCandidates` 와 DM 거르기로 만든 것)이라 서버 규칙과 어긋나지 않는다. 초안에 이미 든 후보
 * (`inDraft`, 멘션 노드 id)는 체크된 채 잠근다. 넣기는 팝오버가 닫히고 초점 되돌리기를 막은 **뒤에** 부른다 — 작성기가 커서 자리에 넣고
 * 초점을 가져간다(바로 부르면 닫히는 팝오버가 초점을 단추로 되돌린다)
 */
export function MentionPicker({
  candidates,
  inDraft,
  onInsert,
}: {
  candidates: readonly MentionCandidate[];
  inDraft: () => ReadonlySet<string>;
  onInsert: (picked: readonly MentionCandidate[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [already, setAlready] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef<MentionCandidate[] | null>(null);

  const q = query.trim().toLowerCase();
  const shown = candidates.filter((c) => matches(c, q));
  const agents = shown.filter((c) => c.kind === "agent");
  const people = shown.filter((c) => c.kind === "user");
  const chosen = candidates.filter((c) => picked.has(c.id));

  const onOpenChange = (next: boolean) => {
    if (next) {
      setQuery("");
      setPicked(new Set());
      setAlready(inDraft());
    }
    setOpen(next);
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const insert = () => {
    if (chosen.length === 0) return;
    pending.current = chosen;
    setOpen(false);
  };

  const group = (title: string, list: readonly MentionCandidate[]) =>
    list.length > 0 && (
      <div role="group" aria-label={title} className="flex flex-col">
        <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground" aria-hidden>
          {title}
        </p>
        {list.map((c) => {
          const has = already.has(c.id);
          return (
            <label
              key={c.id}
              className={cn(
                CANDIDATE_ROW_CLASS,
                "hover:bg-accent",
                has && "cursor-default opacity-60 hover:bg-transparent",
                !c.enabled && "opacity-50",
              )}
            >
              <MentionCandidateRow
                candidate={c}
                locked={has}
                check={
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={has || picked.has(c.id)}
                    disabled={has}
                    aria-label={candidateName(c, has)}
                    onChange={(e) => toggle(c.id, e.currentTarget.checked)}
                  />
                }
              />
            </label>
          );
        })}
      </div>
    );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={PICKER_LABEL}
          title={PICKER_LABEL}
          className="shrink-0"
        >
          <AtSignIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label={PICKER_LABEL}
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 p-2"
        onCloseAutoFocus={(e) => {
          const run = pending.current;
          pending.current = null;
          if (!run) return;
          e.preventDefault();
          onInsert(run);
        }}
      >
        <Input
          type="search"
          aria-label="에이전트 찾기"
          placeholder="에이전트 찾기…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              insert();
            }
          }}
          className="h-8 text-sm"
        />
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">맞는 후보가 없습니다</p>
          ) : (
            <>
              {group("에이전트", agents)}
              {group("사람", people)}
            </>
          )}
        </div>
        <Button type="button" size="sm" disabled={chosen.length === 0} onClick={insert}>
          {chosen.length === 0 ? "넣을 후보를 고르세요" : `${chosen.length}명 넣기`}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
