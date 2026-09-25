import type { OpsAckResult, OpsSettingsPatch, OpsStatus } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 「모두 확인」 — 상태(배지)와 사건 목록을 다시 받는다. 배지를 0 으로 덮지 않는다: 서버는 ack 를 처리한 때까지만 확인하므로
 * ack 가 떠 있는 동안 온 사건은 남을 수 있다. 응답(`acked`)에는 남은 수가 없어 상태를 다시 받는다
 */
export function useAckEvents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<OpsAckResult>("POST", "/ops/events/ack"),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.opsStatus }),
        qc.invalidateQueries({ queryKey: qk.opsEventsAll }),
      ]),
  });
}

/** 워크스페이스 일일 런 상한 — null 은 무제한. 오류 문구는 폼이 그린다(`silent`) */
export function useSaveRunLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dailyRunLimit: number | null) =>
      api<OpsSettingsPatch>("PATCH", "/ops/settings", { dailyRunLimit } satisfies OpsSettingsPatch),
    onSuccess: ({ dailyRunLimit }) =>
      qc.setQueryData<OpsStatus>(qk.opsStatus, (prev) => prev && { ...prev, dailyRunLimit }),
    meta: { silent: true },
  });
}
