import type { Agent } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { AGENT, USER } from "./fixtures";

/** 메시지 렌더 테스트의 작성자: 사람 owner(USER) 한 명과 에이전트 dev(AGENT) */
export const ME_USER = {
  user: {
    id: USER,
    workspaceId: USER,
    handle: "owner",
    displayName: "주인",
    authProvider: "local",
    createdAt: "2027-01-01T00:00:00.000Z",
  },
  workspaceId: USER,
};
export const DEV: Agent = {
  id: AGENT,
  workspaceId: USER,
  provider: "openclaw",
  providerAgentId: "dev",
  handle: "dev",
  name: "Dev",
  enabled: true,
  createdAt: "2027-01-01T00:00:00.000Z",
};

/** me·에이전트 캐시를 미리 채운 QueryClient — 렌더가 REST 를 부르지 않는다 */
export function authorsClient(agents: Agent[] = [DEV]): QueryClient {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.me, ME_USER);
  qc.setQueryData(qk.agents, agents);
  // 캐시 값이 있어도 마운트 때 다시 부르지 않게
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, staleTime: Infinity } });
  return qc;
}

/** QueryClientProvider 로 감싸 그린다 — rerender 도 같은 Provider 안 */
export function renderWithClient(ui: ReactElement, qc: QueryClient = authorsClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), qc };
}
