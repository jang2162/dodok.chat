import type { BridgeTokenRecord, SetupStatus } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 연결 설정 조회(스펙 「API」) — owner 화면만 부른다(아니면 403). 실시간 `setup.status` 가 상태를 덮고 토큰 목록을 낡게 한다.
 * 두 키 모두 오프라인 사본에서 빠진다(pwa/persist)
 */
export const useSetupStatus = () =>
  useQuery({ queryKey: qk.setupStatus, queryFn: () => api<SetupStatus>("GET", "/setup/status") });

/** 폐기된 것도 포함, 원문 없음 */
export const useBridgeTokens = () =>
  useQuery({
    queryKey: qk.bridgeTokens,
    queryFn: async () => (await api<{ tokens: BridgeTokenRecord[] }>("GET", "/setup/bridge-tokens")).tokens,
  });
