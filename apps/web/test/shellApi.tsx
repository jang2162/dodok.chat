import type { Channel } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { AdapterStatusResponse } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { TooltipProvider } from "@/ui/tooltip";

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
export const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w" };
export const ADAPTER_OK: AdapterStatusResponse = {
  provider: "openclaw",
  gateway: "connected",
  bridge: "connected",
  capabilities: { sessionReset: true, agentsList: true, configSet: true },
};

/** 테스트용 채널(REST 응답 모양). id 는 URL 에 들어가는 문자열이면 된다 */
export const channelOf = (id: string, over: Partial<Channel> = {}): Channel => ({
  id,
  workspaceId: "w",
  name: `채널-${id}`,
  relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
  visibility: "public",
  createdBy: "u",
  createdAt: "2026-09-19T00:00:00.000Z",
  ...over,
});

/**
 * 앱 셸(사이드바·배너·채널 헤더)이 뜨면서 부르는 GET 의 기본 응답 — 채널·에이전트·멤버 없음, Gateway·플러그인 연결됨,
 * `/channels/:id` 는 그 id 의 채널. 해당하지 않으면 undefined — 부르는 쪽 스텁이 이어서 가른다
 */
export function shellGet(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
  if ((init?.method ?? "GET") !== "GET") return undefined;
  const url = String(input);
  if (url === "/api/v1/channels") return json(200, { channels: [] });
  if (url === "/api/v1/adapter/status") return json(200, ADAPTER_OK);
  if (url === "/api/v1/agents") return json(200, { agents: [] });
  const m = /^\/api\/v1\/channels\/([^/]+)(\/members)?$/.exec(url);
  if (m?.[1]) return m[2] ? json(200, { members: [] }) : json(200, { channel: channelOf(m[1]) });
  return undefined;
}

/** 앱 라우터를 메모리 히스토리로 띄운다 — App 과 같은 Provider(Query·Tooltip), 실시간(WireProvider)은 없다 */
export function renderRoute(path: string, queryClient: QueryClient = createQueryClient(() => {})) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(queryClient, history);
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { router, history, queryClient };
}
