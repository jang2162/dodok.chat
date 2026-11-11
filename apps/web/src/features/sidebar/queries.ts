import { SidebarLayout } from "@dodok/shared";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@/api/http";

// 사이드바 개인 섹션의 배치(사이드바 섹션 스펙 B4) — GET·PUT /me/sidebar, 바꾸면 낙관적으로 그리고 PUT, 실패면 되돌리고 토스트.
// 다른 탭·기기의 저장은 wire `me.sidebar` 로 온다(`receiveSidebar`)

export const sidebarKey = ["sidebar"] as const;

/** 저절로 낡지 않는다 — wire `me.sidebar`·다시 붙기가 고친다. 실패하면 섹션 없이 기본 두 절만 그린다(무엇도 사라지지 않는다) */
export const sidebarQuery = queryOptions({
  queryKey: sidebarKey,
  queryFn: async () => SidebarLayout.parse(await api<unknown>("GET", "/me/sidebar")),
  staleTime: Number.POSITIVE_INFINITY,
  meta: { silent: true },
});
export const useSidebarLayout = () => useQuery(sidebarQuery);

export const SIDEBAR_SAVE_FAILED_TEXT = "섹션을 저장하지 못했습니다";

/**
 * 한 QueryClient 의 저장 상태. `holds` 가 0 보다 크면(저장 중·끌기 중) 다른 탭의 배치를 바로 그리지 않고 `buffered` 에 두었다가 놓은
 * 뒤 그린다 — 끌던 항목이 손에서 사라지거나 저장 중인 낙관 배치가 밀려나지 않게. `confirmed` 는 서버가 아는 마지막 배치(실패 때
 * 돌아갈 자리), `seq` 는 마지막으로 보낸 저장 — 늦게 끝난 앞 저장이 뒤 저장의 화면을 덮지 않게
 */
type SaveState = { holds: number; buffered?: SidebarLayout; confirmed?: SidebarLayout; seq: number };
const states = new WeakMap<QueryClient, SaveState>();
function stateOf(qc: QueryClient): SaveState {
  let s = states.get(qc);
  if (!s) {
    s = { holds: 0, seq: 0 };
    states.set(qc, s);
  }
  return s;
}

/** 다른 탭의 배치를 잠시 미룬다 — 돌려준 함수로 푼다(두 번 불러도 한 번). 모두 풀리면 미뤄 둔 마지막 배치를 그린다 */
export function holdSidebar(qc: QueryClient): () => void {
  const s = stateOf(qc);
  s.holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.holds -= 1;
    if (s.holds === 0 && s.buffered) {
      qc.setQueryData(sidebarKey, s.buffered);
      s.buffered = undefined;
    }
  };
}

/** wire `me.sidebar` — 저장·끌기 중이면 미루고, 아니면 바로 그린다 */
export function receiveSidebar(qc: QueryClient, layout: SidebarLayout): void {
  const s = stateOf(qc);
  s.confirmed = layout;
  if (s.holds > 0) s.buffered = layout;
  else qc.setQueryData(sidebarKey, layout);
}

/**
 * 배치 바꾸기 — `change` 를 지금 그리고 있는 배치에 적용해 저장한다. 배치를 아직 못 받았거나 바뀐 것이 없으면 아무것도 하지 않는다
 * (빈 배치로 서버의 배치를 덮지 않게). 돌려준 함수는 바뀌지 않는다
 */
export function useUpdateSidebar(): (change: (layout: SidebarLayout) => SidebarLayout) => void {
  const qc = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: (layout: SidebarLayout) => api<unknown>("PUT", "/me/sidebar", layout),
    onMutate: (layout) => {
      const s = stateOf(qc);
      // 저장 중인 것이 없으면 지금 그리는 배치가 곧 서버의 배치다
      if (s.holds === 0) s.confirmed = qc.getQueryData<SidebarLayout>(sidebarKey);
      const release = holdSidebar(qc);
      void qc.cancelQueries({ queryKey: sidebarKey });
      qc.setQueryData(sidebarKey, layout);
      s.seq += 1;
      return { release, seq: s.seq };
    },
    onSuccess: (body, _layout, ctx) => {
      const s = stateOf(qc);
      const saved = SidebarLayout.parse(body);
      s.confirmed = saved;
      if (ctx.seq === s.seq) qc.setQueryData(sidebarKey, saved);
    },
    onError: (_e, _layout, ctx) => {
      const s = stateOf(qc);
      // 뒤에 보낸 저장이 있으면 그것이 이 바꿈까지 싣고 간다 — 그 결과를 기다린다
      if (ctx && ctx.seq === s.seq && s.confirmed) qc.setQueryData(sidebarKey, s.confirmed);
      toast.error(SIDEBAR_SAVE_FAILED_TEXT, { id: "sidebar-save" });
    },
    onSettled: (_d, _e, _layout, ctx) => ctx?.release(),
    meta: { silent: true },
  });
  return useCallback(
    (change) => {
      const current = qc.getQueryData<SidebarLayout>(sidebarKey);
      if (!current) return;
      const next = change(current);
      if (next !== current) mutate(next);
    },
    [qc, mutate],
  );
}
