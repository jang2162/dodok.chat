import type { FileList, FileListQuery } from "@dodok/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 이름 칸 입력이 이만큼 멈춘 뒤 다시 받는다 */
export const FILES_DEBOUNCE_MS = 300;

/** 거름 줄의 값 — 비어 있으면 그 조건을 싣지 않는다. `channelId` 는 전체 화면의 대화 고르기 */
export type FileFilters = Pick<FileListQuery, "kind" | "q" | "authorType" | "authorId" | "channelId">;

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function filesPath(filters: FileFilters, cursor: string | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  if (cursor !== undefined) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `/attachments?${qs}` : "/attachments";
}

/**
 * `GET /api/v1/attachments`(파일함 스펙 「목록 API」) — 쪽은 커서로 잇는다. `scope.channelId` 가 있으면 패널 「파일」 탭(그 대화 하나), 없으면
 * 전체 화면(`filters.channelId` 로 좁힐 수 있다). 키는 계획 판정 PF5 — 패널은 채널 키라 새 글(`channel.activity`)이 낡게 하고, 전체 화면은
 * 실시간을 받지 않는 대신 들어올 때·창이 초점을 받을 때 다시 받는다(앱 기본은 둘 다 꺼짐 — `app/queryClient.ts`).
 * 오류는 화면이 그 안에 그린다(`silent`)
 */
export function useFiles(scope: { channelId?: string }, filters: FileFilters) {
  const panel = scope.channelId !== undefined;
  const sent: FileFilters = panel ? { ...filters, channelId: scope.channelId } : filters;
  return useInfiniteQuery({
    queryKey: [...(panel ? qk.files(scope.channelId as string) : qk.filesAll), filters] as const,
    queryFn: ({ pageParam }) => api<FileList>("GET", filesPath(sent, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    meta: { silent: true },
    ...(panel ? {} : { refetchOnWindowFocus: true, refetchOnMount: "always" as const }),
  });
}
