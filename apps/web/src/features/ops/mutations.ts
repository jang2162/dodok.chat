import type { OpsAckResult, OpsSettingsPatch, OpsStatus } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 「모두 확인」 — 배지를 곧바로 0 으로 두고 사건 목록을 다시 받는다(확인 표시가 바뀐다) */
export function useAckEvents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<OpsAckResult>("POST", "/ops/events/ack"),
    onSuccess: () => {
      qc.setQueryData<OpsStatus>(qk.opsStatus, (prev) => prev && { ...prev, unacked: { warn: 0, error: 0 } });
      return qc.invalidateQueries({ queryKey: qk.opsEventsAll });
    },
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
