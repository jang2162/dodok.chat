import type { BridgeTokenRecord, RunnerTokenRecord, SetupStatus } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 연결 설정 조회(스펙 「API」) — owner 화면만 부른다(아니면 403). 실시간 `setup.status` 가 상태를 덮고 토큰 목록을 낡게 한다.
 * 두 키 모두 오프라인 사본에서 빠진다(pwa/persist)
 */
export const useSetupStatus = () =>
  useQuery({ queryKey: qk.setupStatus, queryFn: () => api<SetupStatus>("GET", "/setup/status") });

/** 그 Gateway 의 브리지 토큰 — 폐기된 것도 포함, 원문 없음. 키는 qk.bridgeTokens 아래라 그 접두로 함께 낡게 한다 */
export const useBridgeTokens = (gatewayId: string) =>
  useQuery({
    queryKey: [...qk.bridgeTokens, gatewayId],
    queryFn: async () =>
      (await api<{ tokens: BridgeTokenRecord[] }>("GET", `/gateways/${gatewayId}/bridge-tokens`)).tokens,
  });

/** 러너 토큰(러너 스펙 5장) — 폐기된 것도 포함, 원문 없음 */
export const useRunnerTokens = () =>
  useQuery({
    queryKey: qk.runnerTokens,
    queryFn: async () => (await api<{ tokens: RunnerTokenRecord[] }>("GET", "/setup/runner-tokens")).tokens,
  });
