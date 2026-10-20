import type { PersonalTokenSummary } from "@dodok/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

export const personalTokensQuery = queryOptions({
  queryKey: qk.personalTokens,
  queryFn: async () => (await api<{ tokens: PersonalTokenSummary[] }>("GET", "/me/tokens")).tokens,
});
export const usePersonalTokens = () => useQuery(personalTokensQuery);

/** 폐기 — 그 토큰으로 붙은 바깥 MCP 클라이언트는 다음 요청부터 401 이다. 목록은 다시 받는다(폐기한 줄은 서버 목록에서 빠진다) */
export function useRevokePersonalToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/me/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.personalTokens }),
  });
}

/**
 * 바깥 MCP 클라이언트(Claude Code)에 붙이는 한 줄. 주소는 이 페이지의 오리진 — 브라우저에게 웹과 API 는 같은 출처이고(개발은 vite.config 의
 * 프록시, 배포는 서버가 웹과 API 를 한 포트로 낸다), 「내 계정」은 누구나 보므로 owner 만 받는 브리지 공개 주소(`setup.status`)를 쓸 수 없다.
 * 끝 슬래시 없이 `/mcp` — 서버 라우트가 `POST /mcp` 하나다
 */
export function mcpAddCommand(origin: string, raw: string): string {
  return `claude mcp add --transport http dodok ${origin.replace(/\/+$/, "")}/mcp --header "Authorization: Bearer ${raw}"`;
}
