import type { SearchQuery, SearchResult } from "@dodok/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/api/http";

/** 입력이 이만큼 멈춘 뒤에 부른다 — 서버 상한이 사용자당 분당 60 이다(스레드·검색 스펙 5.2) */
export const SEARCH_DEBOUNCE_MS = 300;
/** 서버 `SearchQuery` 의 `q` 하한 — 코드 포인트로 센다(zod 4 와 같다) */
export const SEARCH_MIN_CHARS = 2;

/** 대화상자의 필터 — 비어 있으면 그 조건을 싣지 않는다 */
export type SearchFilters = Pick<SearchQuery, "channelId" | "authorType" | "from" | "to">;

export const searchLength = (q: string): number => [...q.trim()].length;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function searchPath(q: string, filters: SearchFilters, cursor: string | undefined): string {
  const params = new URLSearchParams({ q });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  if (cursor !== undefined) params.set("cursor", cursor);
  return `/search?${params}`;
}

/**
 * `GET /api/v1/search`(스레드·검색 스펙 5.2) — 검색어는 디바운스하고 앞뒤 공백을 자른다. 2글자 미만이면 부르지 않는다.
 * 쪽은 커서로 잇는다(2글자 검색은 `limited` 라 커서가 없다). 오류는 대화상자가 그 안에 그린다(`silent`) — 되풀이하지 않는다:
 * 429 는 되풀이해도 같은 한도이고, 그 밖은 입력을 고치면 새로 부른다
 */
export function useSearch(input: string, filters: SearchFilters) {
  const q = useDebounced(input.trim(), SEARCH_DEBOUNCE_MS);
  const enabled = searchLength(q) >= SEARCH_MIN_CHARS;
  const query = useInfiniteQuery({
    queryKey: ["search", q, filters] as const,
    queryFn: ({ pageParam }) => api<SearchResult>("GET", searchPath(q, filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    retry: false,
    // 결과는 그때의 것이다 — 닫았다 다시 열면 새로 찾는다
    gcTime: 0,
    meta: { silent: true },
  });
  return {
    ...query,
    /** 디바운스가 끝나 실제로 부른 검색어 — 입력 중이면 input 과 다르다 */
    q,
    enabled,
    hits: query.data?.pages.flatMap((p) => p.hits) ?? [],
    limited: query.data?.pages[0]?.limited === true,
  };
}
