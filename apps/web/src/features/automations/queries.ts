import type { AutomationSummary, Message } from "@dodok/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/api/http";
import { qk, useCanManage } from "@/api/queries";

/**
 * 자동화 목록(`GET /automations`, admin 이상 — 자동화 스펙 「관리 API」 장). 조회 실패는 설정 화면이 화면 안에 그리고, 작성자 이름
 * 풀기는 「⚙ 자동화」로 남을 뿐이라 토스트를 띄우지 않는다(`silent`). 같은 키의 관찰자가 모두 이 옵션을 쓴다 — meta 는 마지막
 * 관찰자의 것이 이긴다
 */
export const automationsQuery = queryOptions({
  queryKey: qk.automations,
  queryFn: () => api<AutomationSummary[]>("GET", "/automations"),
  meta: { silent: true },
});

/** 설정 화면 목록 — 권한이 있는 화면만 부른다(member 는 403) */
export const useAutomations = () => useQuery(automationsQuery);

/**
 * 작성자 이름을 풀 목록 — 캐시만 읽고 스스로 부르지 않는다. 메시지 행마다 관찰자가 붙으므로 여기서 부르면 행이 그려질 때마다 다시
 * 받는다. 받는 것은 `useLoadAutomationAuthors` 가 자동화 글이 보일 때만 한다
 */
export const useCachedAutomations = () => useQuery({ ...automationsQuery, enabled: false });

type Authored = Pick<Message, "authorType" | "authorId" | "createdAt">;

/**
 * 보이는 글 가운데 자동화 글이 있으면 그 작성자 이름(「⚙ 자동화 · <이름>」)을 풀 목록을 받아 둔다 — admin 이상만. member 는 부르지
 * 않는다(목록 API 가 403, 계획 판정 PA6). 받아 둔 목록이 그 글보다 먼저 받은 것이고 그 글의 자동화가 없으면 다시 받는다 — 다른 탭·
 * 다른 관리자가 만든 자동화의 글을 「⚙ 지운 자동화」로 보이지 않게(`useAuthors` 가 같은 시각 비교로 「⚙ 자동화」에 머문다).
 * 효과는 보이는 자동화 글이 바뀔 때만 돈다 — 다시 받은 뒤에도 없으면 지운 것이고, 다시 부르지 않는다.
 * 자동화 글이 보이는 동안 탭이 다시 보이면(`visibilitychange`) 한 번 더 받는다 — 다른 곳에서 바꾼 이름을 맞춘다
 */
export function useLoadAutomationAuthors(items: readonly Authored[]): void {
  const canManage = useCanManage();
  const qc = useQueryClient();
  const key = canManage
    ? items
        .filter((m) => m.authorType === "automation" && m.authorId !== undefined)
        .map((m) => `${m.authorId}@${m.createdAt}`)
        .join(" ")
    : "";
  useEffect(() => {
    if (key === "") return;
    const state = qc.getQueryState<AutomationSummary[]>(qk.automations);
    const list = state?.data;
    const fetchedAt = state?.dataUpdatedAt ?? 0;
    const stale =
      list === undefined ||
      key.split(" ").some((entry) => {
        const [id, createdAt = ""] = entry.split("@");
        return !list.some((a) => a.id === id) && fetchedAt < Date.parse(createdAt);
      });
    if (stale) void qc.fetchQuery({ ...automationsQuery, staleTime: 0 }).catch(() => undefined);
  }, [key, qc]);
  // 이름 바뀜은 wire 로 오지 않는다 — 다른 탭·기기에서 바꾼 이름은 이 탭이 다시 보일 때 맞춘다(보고만 있는 동안은 옛 이름)
  useEffect(() => {
    if (key === "") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void qc.fetchQuery({ ...automationsQuery, staleTime: 0 }).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key, qc]);
}
