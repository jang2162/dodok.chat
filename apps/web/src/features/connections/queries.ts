import { ConnectionsResponse } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 누구나 읽는 연결 목록 `GET /connections`(연결 탭 통합 스펙 5.3) — 트리의 주인·승인 대기·에이전트 없는 러너·프로젝트 이름. 주소·토큰은
 * 없다. 받지 못하면(옛 서버) 트리는 역할마다의 옛 길로 짓는다 — 실패를 전역 토스트로 띄우지 않는다
 */
export const useConnectionList = () =>
  useQuery({
    queryKey: qk.connections,
    // 경계에서 파싱한다 — 모양이 다른 응답(옛 서버의 다른 경로 등)은 받지 못한 것으로 친다
    queryFn: async () => ConnectionsResponse.parse(await api<unknown>("GET", "/connections")),
    retry: false,
    meta: { silent: true },
  });
