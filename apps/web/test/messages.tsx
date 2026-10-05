import type { Agent, Person } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { AGENT, USER } from "./fixtures";

/** 메시지 렌더 테스트의 작성자: 사람 owner(USER) 한 명과 에이전트 dev(AGENT). 역할은 owner — 관리 동작이 열려 있다 */
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
  role: "owner",
};
/** 사람 목록(`GET /people`)의 owner 한 줄 — ME_USER 와 같은 사람 */
export const OWNER_PERSON: Person = { id: USER, handle: "owner", displayName: "주인", role: "owner" };
export const DEV: Agent = {
  id: AGENT,
  workspaceId: USER,
  provider: "openclaw",
  providerAgentId: "dev",
  handle: "dev",
  name: "Dev",
  enabled: true,
  createdAt: "2027-01-01T00:00:00.000Z",
  archivedAt: null,
};

/** me·에이전트·사람 목록 캐시를 미리 채운 QueryClient — 렌더가 REST 를 부르지 않는다 */
export function authorsClient(agents: Agent[] = [DEV], people: Person[] = [OWNER_PERSON]): QueryClient {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.me, ME_USER);
  qc.setQueryData(qk.agents, agents);
  qc.setQueryData(qk.people, people);
  // 캐시 값이 있어도 마운트 때 다시 부르지 않게
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, staleTime: Infinity } });
  return qc;
}

/**
 * QueryClientProvider 로 감싸 그린다 — rerender 도 같은 Provider 안. 메시지 행의 스레드 링크(칩·「스레드에서 답하기」)가
 * 라우터 문맥을 읽으므로 앱 라우터의 문맥만 준다(화면은 그리지 않는다 — 넘긴 ui 가 곧 화면이다)
 */
export function renderWithClient(ui: ReactElement, qc: QueryClient = authorsClient()) {
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/"] }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), qc, router };
}
