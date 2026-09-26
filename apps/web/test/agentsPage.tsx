import type { Agent } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { AgentsPage } from "@/features/agents/AgentsPage";

/** 에이전트 페이지 테스트의 가짜 서버·렌더 도우미 — 목록 쪽과 등록 쪽 테스트가 함께 쓴다 */

export type Body = Record<string, unknown>;
export type Reply = Response | Promise<Response>;
export type Call = { method: string; url: string; body: unknown };

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
export const apiErr = (status: number, code: string, message: string) => json(status, { code, message });

let seq = 0;
export function makeAgent(
  fields: Partial<Agent> & Pick<Agent, "providerAgentId" | "handle" | "name">,
): Agent {
  seq += 1;
  return {
    id: `0190a000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    workspaceId: "0190a000-0000-7000-8000-00000000ffff",
    provider: "openclaw",
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
    ...fields,
  };
}
export const dev = () =>
  makeAgent({ providerAgentId: "dev", handle: "dev", name: "Dev 에이전트", basePrompt: "기존 프롬프트" });
export const fin = () =>
  makeAgent({ providerAgentId: "fin", handle: "fin", name: "Fin 에이전트", enabled: false });

/**
 * URL 로 가르는 가짜 서버. 에이전트 목록을 서버 상태로 들고, POST·PATCH 기본 처리기는 그 상태를 고쳐 `{ agent }` 를 돌려준다.
 * 처리기를 바꾸는 테스트는 마지막 인자(기본 처리기)로 넘길 수 있다
 */
export function stubServer(
  opts: {
    agents?: Agent[];
    list?: (fallback: () => Reply) => Reply;
    discover?: () => Reply;
    create?: (body: Body, fallback: (body: Body) => Reply) => Reply;
    patch?: (id: string, body: Body, fallback: (id: string, body: Body) => Reply) => Reply;
  } = {},
) {
  const state = [...(opts.agents ?? [])];
  const calls: Call[] = [];
  const listDefault = () => json(200, { agents: state });
  const createDefault = (body: Body) => {
    const agent = makeAgent(body as Pick<Agent, "providerAgentId" | "handle" | "name">);
    state.push(agent);
    return json(201, { agent });
  };
  const patchDefault = (id: string, body: Body) => {
    const i = state.findIndex((a) => a.id === id);
    const current = state[i];
    if (!current) return apiErr(404, "NOT_FOUND", "agent not found");
    const next: Agent = { ...current, ...(body as Partial<Agent>) };
    if (body.basePrompt === null) delete next.basePrompt;
    state[i] = next;
    return json(200, { agent: next });
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: Body | undefined = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (method === "GET" && url === "/api/v1/agents") return (opts.list ?? ((f) => f()))(listDefault);
    if (method === "GET" && url === "/api/v1/agents/discover")
      return (opts.discover ?? (() => json(200, { agents: [] })))();
    if (method === "POST" && url === "/api/v1/agents")
      return (opts.create ?? ((b, f) => f(b)))(body ?? {}, createDefault);
    const m = /^\/api\/v1\/agents\/([^/]+)$/.exec(url);
    if (method === "PATCH" && m?.[1])
      return (opts.patch ?? ((i, b, f) => f(i, b)))(m[1], body ?? {}, patchDefault);
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    bodies: (method: string) => calls.filter((c) => c.method === method).map((c) => c.body),
  };
}

/** 로그인한 사람은 owner — 라우트 가드가 받아 둔 me 를 흉내 낸다(이미 있으면 그대로). member 화면은 `role` 을 넘긴다 */
export function renderPage(qc: QueryClient = createQueryClient(() => {}), role = "owner") {
  if (qc.getQueryData(qk.me) === undefined)
    qc.setQueryData(qk.me, { user: { id: "u", handle: "owner" }, workspaceId: "w", role });
  render(
    <QueryClientProvider client={qc}>
      <AgentsPage />
    </QueryClientProvider>,
  );
  return qc;
}

/** 풀릴 때까지 응답을 붙잡는다 */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** 목록을 받기 전엔 가져오기 버튼이 잠겨 있다 — 풀리길 기다려 누른다 */
export async function openDiscover() {
  const trigger = await screen.findByRole("button", { name: "Gateway 에서 가져오기" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  return screen.findByRole("dialog");
}
