import type { SearchHit } from "@dodok/shared";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useChannels } from "@/api/queries";
import { requestJump } from "@/features/messages/jumpTarget";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { SEARCH_DIALOG_ATTR } from "./openSearch";
import { SearchResults } from "./SearchResults";
import { SEARCH_MIN_CHARS, type SearchFilters, searchLength, useSearch } from "./useSearch";

const SELECT =
  "h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * 검색 대화상자(스레드·검색 스펙 5.4) — `⌘K`/`Ctrl+K`·사이드바 검색 칸이 연다. 넓은 화면은 가운데 대화상자, 좁은 화면(390px 등)은
 * 전체 시트. 안은 매번 새로 그린다(닫으면 검색어·필터를 버린다)
 */
export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const narrow = useIsNarrow();
  const opener = useRef<HTMLElement | null>(null);
  const body = <SearchPanel onDone={() => onOpenChange(false)} />;
  // `DialogTrigger` 없이 열어 Radix 기본 복귀가 갈 곳이 없다 — 열 때 초점을 가졌던 자리(검색 칸·작성기 등)를 기억해 돌려준다.
  // 그 자리가 사라졌으면(결과로 가서 화면이 바뀌었다) 기본대로 둔다
  const contentProps = {
    "aria-describedby": undefined,
    [SEARCH_DIALOG_ATTR]: "",
    onOpenAutoFocus: () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (e: Event) => {
      if (!opener.current?.isConnected) return;
      e.preventDefault();
      opener.current.focus();
    },
  };
  if (narrow) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-dvh gap-0 p-0" {...contentProps}>
          <SheetTitle className="sr-only">검색</SheetTitle>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80dvh] flex-col gap-0 p-0 sm:max-w-xl" {...contentProps}>
        <DialogTitle className="sr-only">검색</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** 검색어·필터·결과. 결과를 누르면 그 자리로 가며(`requestJump` → 목록이 around 로 받는다) 대화상자를 닫는다 */
function SearchPanel({ onDone }: { onDone: () => void }) {
  const [input, setInput] = useState("");
  const [filters, setFilters] = useState<SearchFilters>({});
  const search = useSearch(input, filters);
  const channels = useChannels().data ?? [];
  const navigate = useNavigate();
  const set = (patch: SearchFilters) => setFilters((f) => ({ ...f, ...patch }));
  // 짧으면 옛 결과를 곧바로 숨긴다 — 결과는 디바운스된 검색어로 그리므로 기다리면 안내와 옛 결과가 겹친다
  const tooShort = searchLength(input) < SEARCH_MIN_CHARS;
  const short = input.trim() !== "" && tooShort;

  const pick = (hit: SearchHit) => {
    requestJump(hit);
    onDone();
    const params = { channelId: hit.channelId, conversationId: hit.conversationId };
    if (hit.threadRootId === undefined) void navigate({ to: "/c/$channelId/s/$conversationId", params });
    else
      void navigate({
        to: "/c/$channelId/s/$conversationId/t/$rootId",
        params: { ...params, rootId: hit.threadRootId },
      });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3 pr-12">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          aria-label="검색어"
          placeholder="메시지 검색"
          maxLength={200}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
        <select
          aria-label="채널"
          className={SELECT}
          value={filters.channelId ?? ""}
          onChange={(e) => set({ channelId: e.target.value || undefined })}
        >
          <option value="">모든 채널</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="작성자"
          className={SELECT}
          value={filters.authorType ?? ""}
          onChange={(e) => set({ authorType: (e.target.value || undefined) as SearchFilters["authorType"] })}
        >
          <option value="">모두</option>
          <option value="user">사람</option>
          <option value="agent">에이전트</option>
        </select>
        <input
          type="date"
          aria-label="시작 날짜"
          className={SELECT}
          value={filters.from ?? ""}
          onChange={(e) => set({ from: e.target.value || undefined })}
        />
        <span aria-hidden>~</span>
        <input
          type="date"
          aria-label="끝 날짜"
          className={SELECT}
          value={filters.to ?? ""}
          onChange={(e) => set({ to: e.target.value || undefined })}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {short && <p className="px-4 py-3 text-sm text-muted-foreground">2글자 이상 입력하세요</p>}
        {!tooShort && <SearchResults search={search} onPick={pick} />}
      </div>
    </div>
  );
}
