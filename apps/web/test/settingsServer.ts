import type { Agent, Channel, ChannelMember } from "@dodok/shared";
import { screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { uid } from "./fixtures";
import { ME, channelOf, json, shellGet } from "./shellApi";

/** 채널 설정 패널 테스트의 가짜 서버 — 채널 하나·멤버·에이전트를 서버 상태로 들고 REST 를 흉내 낸다(서버 실물의 모양) */

export const CH = uid(1);
export const OWNER = uid(10);
export const DEV = uid(11);
export const FIN = uid(12);

export const agentOf = (id: string, handle: string, over: Partial<Agent> = {}): Agent => ({
  id,
  workspaceId: "w",
  provider: "openclaw",
  providerAgentId: handle,
  handle,
  name: `${handle.toUpperCase()} 봇`,
  enabled: true,
  createdAt: "2026-09-19T00:00:00.000Z",
  ...over,
});

export const memberOf = (
  memberType: ChannelMember["memberType"],
  memberId: string,
  over: Partial<ChannelMember> = {},
): ChannelMember => ({
  id: `m-${memberId}`,
  channelId: CH,
  memberType,
  memberId,
  autoRespond: false,
  aliases: [],
  joinedAt: "2026-09-19T00:00:00.000Z",
  ...over,
});

export const DEV_AGENT = agentOf(DEV, "dev");
export const FIN_AGENT = agentOf(FIN, "fin");

type Body = Record<string, unknown>;
export type Call = { method: string; url: string; body: Body | undefined };
/** undefined 면 다음 처리기로 넘긴다 */
type Reply = Response | undefined | Promise<Response | undefined>;

export const apiErr = (status: number, code: string, message: string) => json(status, { code, message });

/**
 * `override` 가 Response 를 주면 그것을 쓰고, undefined 면 기본 처리(상태를 고친다).
 * `channelList` 로 `/channels` 목록의 채널을 상세와 다르게 줄 수 있다(자리값 테스트)
 */
export function stubSettingsServer(
  opts: {
    channel?: Partial<Channel>;
    members?: ChannelMember[];
    agents?: Agent[];
    channelList?: () => Channel[];
    override?: (call: Call) => Reply;
  } = {},
) {
  const state = {
    channel: channelOf(CH, { name: "general", ...opts.channel }),
    members: opts.members ?? [memberOf("user", OWNER)],
    agents: opts.agents ?? [DEV_AGENT, FIN_AGENT],
  };
  const calls: Call[] = [];
  const base = `/api/v1/channels/${CH}`;

  function handle({ method, url, body }: Call): Reply {
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (method === "GET" && url === "/api/v1/channels")
      return json(200, { channels: opts.channelList?.() ?? [state.channel] });
    if (method === "GET" && url === "/api/v1/agents") return json(200, { agents: state.agents });
    if (method === "GET" && url === base) return json(200, { channel: state.channel });
    if (method === "PATCH" && url === base) {
      const next: Record<string, unknown> = { ...state.channel, ...body };
      for (const [k, v] of Object.entries(body ?? {})) if (v === null) delete next[k];
      state.channel = next as Channel;
      return json(200, { channel: state.channel });
    }
    if (method === "GET" && url === `${base}/members`) return json(200, { members: state.members });
    if (method === "POST" && url === `${base}/members`) {
      const memberId = String(body?.memberId);
      if (state.members.some((m) => m.memberId === memberId))
        return apiErr(409, "CONFLICT", "이미 채널 멤버다");
      const member = memberOf("agent", memberId);
      state.members = [...state.members, member];
      return json(201, { member });
    }
    const m = new RegExp(`^${base}/members/([^/]+)$`).exec(url);
    if (m?.[1] && method === "PATCH") {
      const i = state.members.findIndex((x) => x.memberType === "agent" && x.memberId === m[1]);
      const current = state.members[i];
      if (!current) return apiErr(404, "NOT_FOUND", "agent member not found");
      const next: Record<string, unknown> = { ...current, ...body };
      if (body?.promptOverride === null) delete next.promptOverride;
      state.members = state.members.map((x, j) => (j === i ? (next as ChannelMember) : x));
      return json(200, { member: next });
    }
    if (m?.[1] && method === "DELETE") {
      if (!state.members.some((x) => x.memberId === m[1]))
        return apiErr(404, "NOT_FOUND", "member not found");
      state.members = state.members.filter((x) => x.memberId !== m[1]);
      return json(200, { members: state.members });
    }
    if (method === "POST" && new RegExp(`^${base}/agents/[^/]+/reset$`).test(url))
      return json(200, { ok: true });
    return undefined;
  }

  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const reply = (await opts.override?.(call)) ?? (await handle(call)) ?? shellGet(input, init);
    if (!reply) throw new Error(`예상 밖 요청 ${call.method} ${call.url}`);
    return reply;
  });
  vi.stubGlobal("fetch", fetch);

  return {
    state,
    /** GET 밖의 요청(순서대로) */
    writes: () => calls.filter((c) => c.method !== "GET"),
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
  };
}

/** 풀릴 때까지 응답을 붙잡는다 */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** 소유자 한 명 + 준 에이전트들로 이뤄진 멤버 목록 */
export const members = (...agents: Array<[id: string, autoRespond?: boolean]>) => [
  memberOf("user", OWNER),
  ...agents.map(([id, autoRespond = false]) => memberOf("agent", id, { autoRespond })),
];
export const membersUrl = `/api/v1/channels/${CH}/members`;
export const memberUrl = (agentId: string) => `${membersUrl}/${agentId}`;

export async function membersSection() {
  return screen.findByRole("region", { name: "멤버" });
}
/** 멤버를 받아 에이전트 행이 뜬 뒤의 목록 */
export async function agentList() {
  return within(await membersSection()).findByRole("list", { name: "채널 에이전트" });
}
