import type { Channel, Conversation, OpenClawGatewayStatus, OpsStatus } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AdapterCapabilities, AdapterStatusList, AdapterStatusResponse } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { TooltipProvider } from "@/ui/tooltip";

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** 로그인한 owner — 관리 화면이 열려 있다. member·admin 을 재는 테스트는 `{ ...ME, role: "member" }` 로 덮는다 */
export const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w", role: "owner" };
/** 테스트 서버의 Gateway 하나 — 셸 테스트는 이것 하나로 붙어 있다 */
export const TEST_GATEWAY: OpenClawGatewayStatus = {
  id: "01a00000-0000-7000-8000-0000000000a1",
  name: "사무실",
  enabled: true,
  gateway: "connected",
  bridge: "connected",
};

export const ADAPTER_OK: AdapterStatusResponse = {
  provider: "openclaw",
  gateways: [TEST_GATEWAY],
  capabilities: { agentsList: true, configSet: true },
};

/**
 * GET /adapter/status 응답 모양(어댑터 목록) — OpenClaw 줄 하나로 싸서 준다. Gateway 는 TEST_GATEWAY 하나이고 그 상태는 준 값의
 * gateway·bridge 다(`{ ...ADAPTER_OK, gateway: "down" }` 이 그 Gateway 가 끊긴 서버가 된다)
 */
export function adapterStatusBody(
  openclaw: Partial<Pick<OpenClawGatewayStatus, "gateway" | "bridge">> & {
    capabilities: AdapterCapabilities;
  },
): AdapterStatusList {
  const { capabilities, gateway = "connected", bridge = "connected" } = openclaw;
  return {
    statuses: [{ provider: "openclaw", gateways: [{ ...TEST_GATEWAY, gateway, bridge }] }],
    capabilities: { openclaw: capabilities },
  };
}

/** 문제 없는 운영 상태(OpsStatus 모양) — 운영 화면 테스트는 test/opsServer 의 `opsStatusOf` 로 칸을 덮는다 */
export const OPS_STATUS_OK: OpsStatus = {
  workspaceId: "01a00000-0000-7000-8000-000000000003",
  server: { version: "0.1.0", startedAt: "2026-09-25T00:00:00.000Z", previousClean: true },
  db: { bytes: 1_048_576 },
  disk: { level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
  adapter: { provider: "openclaw", gateways: [TEST_GATEWAY] },
  gateways: [
    {
      id: TEST_GATEWAY.id,
      name: TEST_GATEWAY.name,
      enabled: true,
      gateway: { state: "connected", version: "2026.9.4", pinned: "2026.9.4", drift: false },
      plugin: { state: "connected" },
    },
  ],
  runsToday: 0,
  dailyRunLimit: 300,
  timeZone: "Asia/Seoul",
  blockedToday: 0,
  unacked: { warn: 0, error: 0 },
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
  archivedAt: null,
  sessionPolicy: { create: "members" },
  kind: "channel",
  dmOwnerId: null,
  dmAgentId: null,
  ...over,
});

/**
 * 테스트용 세션(REST 응답 모양). 기본은 그 채널의 「이전 대화」 — id 가 채널 id 와 같다(채널 세션 계획 Global Constraints).
 * 메시지 픽스처(test/fixtures `msg`)의 기본 세션도 그것이다
 */
export const conversationOf = (channelId: string, over: Partial<Conversation> = {}): Conversation => ({
  id: channelId,
  channelId,
  title: "이전 대화",
  titleSource: "user",
  createdBy: { type: "user", id: "u" },
  createdAt: "2026-09-19T00:00:00.000Z",
  lastSeq: 0,
  ...over,
});

/**
 * 앱 셸(사이드바·배너·채널 헤더)이 뜨면서 부르는 GET 의 기본 응답 — 채널·에이전트·멤버 없음, Gateway·플러그인 연결됨,
 * `/channels/:id` 는 그 id 의 채널, `/channels/:id/conversations` 는 그 채널의 「이전 대화」 하나. 해당하지 않으면 undefined — 부르는 쪽 스텁이 이어서 가른다
 */
export function shellGet(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
  if ((init?.method ?? "GET") !== "GET") return undefined;
  const url = String(input);
  if (url === "/api/v1/channels") return json(200, { channels: [] });
  if (url === "/api/v1/adapter/status") return json(200, adapterStatusBody(ADAPTER_OK));
  if (url === "/api/v1/agents") return json(200, { agents: [] });
  // 「내 계정」의 MCP 토큰 목록 — 기본은 하나도 없음
  if (url === "/api/v1/me/tokens") return json(200, { tokens: [] });
  // 사람 목록(작성자·@ 후보) — 기본은 로그인한 owner 한 명
  if (url === "/api/v1/people")
    return json(200, {
      people: [{ id: ME.user.id, handle: ME.user.handle, displayName: "주인", role: "owner" }],
    });
  // owner 의 사이드바 「운영」 배지가 부르는 상태 — 기본은 확인 안 한 사건 없음
  if (url === "/api/v1/ops/status") return json(200, OPS_STATUS_OK);
  // 활동 패널(오른쪽 패널 「활동」 탭)이 부르는 조회 — 기본은 런도 이벤트도 없음
  if (/^\/api\/v1\/channels\/[^/]+\/runs(\?|$)/.test(url)) return json(200, { runs: [] });
  if (/^\/api\/v1\/runs\/[^/]+\/events(\?|$)/.test(url)) return json(200, { events: [] });
  // 채널 주소(`/c/<id>`)가 최근 세션으로 넘길 때 — 기본은 채널마다 「이전 대화」 하나
  const sessions = /^\/api\/v1\/channels\/([^/]+)\/conversations(\?|$)/.exec(url);
  if (sessions?.[1]) return json(200, { conversations: [conversationOf(sessions[1])] });
  const m = /^\/api\/v1\/channels\/([^/]+)(\/members)?$/.exec(url);
  if (m?.[1]) return m[2] ? json(200, { members: [] }) : json(200, { channel: channelOf(m[1]) });
  return undefined;
}

/** 앱 라우터를 메모리 히스토리로 띄운다 — App 과 같은 Provider(Query·Tooltip), 실시간(WireProvider)은 없다 */
export function renderRoute(
  path: string,
  queryClient: QueryClient = createQueryClient(() => {}),
  /** 라우터 바깥에 씌울 컨텍스트(읽음 전송기 등) */
  wrap: (children: ReactNode) => ReactNode = (children) => children,
) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(queryClient, history);
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{wrap(<RouterProvider router={router} />)}</TooltipProvider>
    </QueryClientProvider>,
  );
  return { router, history, queryClient };
}
