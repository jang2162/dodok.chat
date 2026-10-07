import type { OpsAckResult, OpsSettings, OpsSettingsPatch, OpsStatus } from "@dodok/shared";
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

/**
 * 워크스페이스 시간대(자동화 스펙 「워크스페이스 시간대」 절) — 이 키만 보낸다(같이 보내면 한도 칸의 고치다 만 값이 실린다).
 * 응답은 서버가 정규형으로 바꿔 저장한 설정 전체(`EST` → `America/Panama`) — 그 값을 상태에 넣어 선택기가 저장된 이름을 보인다.
 * 서버가 켜진 예약의 다음 실행을 다시 세므로 자동화 목록도 다시 받게 한다. 오류 문구는 폼이 그린다(`silent`)
 */
export function useSaveTimeZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (timeZone: string) =>
      api<OpsSettings>("PATCH", "/ops/settings", { timeZone } satisfies OpsSettingsPatch),
    onSuccess: ({ timeZone }) => {
      qc.setQueryData<OpsStatus>(qk.opsStatus, (prev) => prev && { ...prev, timeZone });
      void qc.invalidateQueries({ queryKey: qk.automations });
    },
    meta: { silent: true },
  });
}

/** 워크스페이스 일일 런 상한 — null 은 무제한. 오류 문구는 폼이 그린다(`silent`) */
export function useSaveRunLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dailyRunLimit: number | null) =>
      api<OpsSettings>("PATCH", "/ops/settings", { dailyRunLimit } satisfies OpsSettingsPatch),
    onSuccess: ({ dailyRunLimit }) =>
      qc.setQueryData<OpsStatus>(qk.opsStatus, (prev) => prev && { ...prev, dailyRunLimit }),
    meta: { silent: true },
  });
}
