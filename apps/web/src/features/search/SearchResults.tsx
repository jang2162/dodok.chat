import type { SearchHit } from "@dodok/shared";
import { useMemo } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { useArchivedChannels, useChannels } from "@/api/queries";
import { useLoadAutomationAuthors } from "@/features/automations/queries";
import { useAuthors } from "@/features/messages/useAuthors";
import { Button } from "@/ui/button";
import { Snippet } from "./highlight";
import type { useSearch } from "./useSearch";

const WHEN = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

/** 검색 실패 한 줄 — 429 는 기다리라고, 그 밖은 원인. 입력은 대화상자가 그대로 둔다 */
export function searchErrorText(e: unknown): string {
  if (e instanceof ApiRequestError && e.code === "RATE_LIMITED")
    return "검색 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요";
  if (e instanceof NetworkError) return "서버에 연결할 수 없습니다";
  if (e instanceof ApiRequestError) return `검색하지 못했습니다 — ${e.message}`;
  return "검색하지 못했습니다";
}

/**
 * 결과 목록(스레드·검색 스펙 5.4) — 줄마다 채널·작성자·시각·스니펫(일치 부분 강조), 답글이면 「스레드 답글」, 보관한 채널이면 「보관됨」
 * (누르면 읽기 전용 채널 화면으로 간다 — 채널 화면이 상세를 받아 안다).
 * 누르면 `onPick`. 2글자 검색(`limited`)은 「더 보기」 없이 범위 안내 한 줄. 다음 쪽이 실패하면(429 포함) 받은 결과 아래에 한 줄
 */
export function SearchResults({
  search,
  onPick,
}: {
  search: ReturnType<typeof useSearch>;
  onPick: (hit: SearchHit) => void;
}) {
  const channels = useChannels().data;
  // 보관한 채널은 사이드바 목록에 없다 — 그 결과가 있을 때만 보관 목록을 받아 이름을 찾는다
  const archived = useArchivedChannels({ enabled: search.hits.some((h) => h.channelArchived) }).data;
  const nameOf = useMemo(
    () => new Map([...(channels ?? []), ...(archived ?? [])].map((c) => [c.id, c.name])),
    [channels, archived],
  );
  const { author } = useAuthors();
  useLoadAutomationAuthors(search.hits);

  if (!search.enabled) return null;
  // 다음 쪽 실패면 받은 결과는 둔다 — 한 줄은 목록 아래에
  if (search.isError && !search.isFetchNextPageError) {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive">
        {searchErrorText(search.error)}
      </p>
    );
  }
  if (search.isPending) {
    return (
      <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
        찾는 중…
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {search.limited && (
        <p className="px-4 pt-3 text-xs text-muted-foreground">2글자는 최근 90일에서 50개까지만 찾습니다</p>
      )}
      {search.hits.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">결과가 없습니다</p>
      ) : (
        <ul aria-label="검색 결과" className="flex flex-col py-1">
          {search.hits.map((hit) => (
            <li key={hit.messageId}>
              <button
                type="button"
                onClick={() => onPick(hit)}
                className="flex w-full flex-col gap-1 px-4 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    #{nameOf.get(hit.channelId) ?? "알 수 없는 채널"}
                  </span>
                  <span>{author(hit).name}</span>
                  <time dateTime={hit.createdAt}>{WHEN.format(new Date(hit.createdAt))}</time>
                  {hit.channelArchived && <span className="rounded-sm bg-muted px-1">보관됨</span>}
                  {hit.threadRootId !== undefined && (
                    <span className="rounded-sm bg-muted px-1">스레드 답글</span>
                  )}
                </span>
                <span className="line-clamp-2 text-sm break-words whitespace-pre-wrap">
                  <Snippet text={hit.snippet} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {search.isFetchNextPageError && (
        <p role="alert" className="px-4 pt-2 text-sm text-destructive">
          {searchErrorText(search.error)}
        </p>
      )}
      {!search.limited && search.hasNextPage && (
        <div className="flex justify-center px-4 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            더 보기
          </Button>
        </div>
      )}
    </div>
  );
}
