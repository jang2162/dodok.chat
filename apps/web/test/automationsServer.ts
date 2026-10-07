import { type Agent, AutomationSummary, type Channel, type ChannelMember, roleAtLeast } from "@dodok/shared";
import { vi } from "vitest";
import { uid } from "./fixtures";
import { DEV } from "./messages";
import { ME, OPS_STATUS_OK, channelOf, json, shellGet } from "./shellApi";

/** 자동화 화면(`/settings/automations`) 테스트의 가짜 서버 — 자동화를 서버 상태로 들고 관리 REST 여섯을 흉내 낸다(서버 실물의 모양) */

export const GENERAL = channelOf(uid(60), { name: "general" });
export const OPS_CHANNEL = channelOf(uid(61), { name: "ops" });

/** 만들기·재발급 응답의 원문 — 목록·다른 응답에는 나오지 않는다(앞 6자만 tokenPrefix) */
export const WEBHOOK_TOKEN = `whk_abc123${"Q".repeat(37)}`;
export const WEBHOOK_URL = `https://chat.example.com/hooks/${WEBHOOK_TOKEN}`;
export const REISSUED_TOKEN = `whk_zyx987${"R".repeat(37)}`;
export const REISSUED_URL = `https://chat.example.com/hooks/${REISSUED_TOKEN}`;

/** 예약의 다음 실행 — Asia/Seoul 로 10월 8일 (목) 오전 9:00 */
export const NEXT_RUN = "2026-10-08T00:00:00.000Z";

export const automationOf = (n: number, over: Partial<AutomationSummary> = {}): AutomationSummary =>
  AutomationSummary.parse({
    id: uid(500 + n),
    name: `자동화-${n}`,
    channelId: GENERAL.id,
    kind: "schedule",
    bodyMd: "@dev 점검해 줘",
    enabled: true,
    schedule: { repeat: "daily", time: "09:00" },
    nextRunAt: NEXT_RUN,
    warnings: [],
    ...over,
  });

/** 채널 general 의 에이전트 멤버 dev — 작성기와 같은 @ 후보가 나온다 */
export const DEV_MEMBER: ChannelMember = {
  id: uid(70),
  channelId: GENERAL.id,
  memberType: "agent",
  memberId: DEV.id,
  autoRespond: false,
  aliases: [],
  joinedAt: "2026-10-01T00:00:00.000Z",
};

type Body = Record<string, unknown> | undefined;
export type Call = { method: string; url: string; body: Body };

/**
 * `override` 가 Response 를 주면 그것을 쓰고, undefined 면 기본 처리(상태를 고친다). me 는 기본이 owner.
 * `holdRun()` 은 「지금 실행」 응답을 붙잡아 둔다 — 돌려받은 함수를 부르면 202 로 답한다
 */
export function stubAutomationsServer(
  opts: {
    me?: { user: { id: string; handle: string }; workspaceId: string; role?: string };
    automations?: AutomationSummary[];
    channels?: Channel[];
    archivedChannels?: Channel[];
    agents?: Agent[];
    members?: Record<string, ChannelMember[]>;
    timeZone?: string;
    override?: (call: Call) => Response | undefined | Promise<Response | undefined>;
  } = {},
) {
  const state = {
    me: opts.me ?? ME,
    automations: opts.automations ?? [],
    created: 0,
  };
  let runHold: Promise<void> | undefined;
  const calls: Call[] = [];

  async function handle({ method, url, body }: Call): Promise<Response | undefined> {
    if (url === "/api/v1/auth/me") return json(200, state.me);
    if (method === "GET" && url === "/api/v1/channels")
      return json(200, { channels: opts.channels ?? [GENERAL, OPS_CHANNEL] });
    if (method === "GET" && url === "/api/v1/channels?archived=1")
      return json(200, { channels: opts.archivedChannels ?? [] });
    const members = /^\/api\/v1\/channels\/([^/]+)\/members$/.exec(url)?.[1];
    if (method === "GET" && members)
      return json(200, { members: opts.members?.[members] ?? (members === GENERAL.id ? [DEV_MEMBER] : []) });
    if (method === "GET" && url === "/api/v1/agents") return json(200, { agents: opts.agents ?? [DEV] });
    if (method === "GET" && url === "/api/v1/ops/status")
      return json(200, { ...OPS_STATUS_OK, timeZone: opts.timeZone ?? "Asia/Seoul" });
    if (!url.startsWith("/api/v1/automations")) return undefined;
    // 관리 API 는 admin 이상(자동화 스펙 「권한」 장)
    if (!roleAtLeast(state.me.role, "admin")) return json(403, { code: "FORBIDDEN", message: "admin only" });
    if (method === "GET" && url === "/api/v1/automations") return json(200, state.automations);
    if (method === "POST" && url === "/api/v1/automations") {
      state.created += 1;
      const webhook = body?.kind === "webhook";
      const automation = automationOf(100 + state.created, {
        name: String(body?.name),
        channelId: String(body?.channelId),
        kind: webhook ? "webhook" : "schedule",
        bodyMd: String(body?.bodyMd),
        ...(webhook
          ? { schedule: undefined, nextRunAt: undefined, tokenPrefix: WEBHOOK_TOKEN.slice(4, 10) }
          : { schedule: body?.schedule as AutomationSummary["schedule"] }),
      });
      state.automations = [...state.automations, automation];
      return json(201, { automation, ...(webhook ? { webhookUrl: WEBHOOK_URL } : {}) });
    }
    const one = /^\/api\/v1\/automations\/([^/]+)(\/token|\/run)?$/.exec(url);
    const id = one?.[1];
    const found = state.automations.find((a) => a.id === id);
    if (!one || !found) return json(404, { code: "NOT_FOUND", message: "automation not found" });
    if (method === "PATCH" && !one[2]) {
      const enabled = (body?.enabled as boolean | undefined) ?? found.enabled;
      const next = AutomationSummary.parse({
        ...found,
        ...body,
        enabled,
        nextRunAt: found.kind === "schedule" && enabled ? NEXT_RUN : undefined,
      });
      state.automations = state.automations.map((a) => (a.id === id ? next : a));
      return json(200, next);
    }
    if (method === "DELETE" && !one[2]) {
      state.automations = state.automations.filter((a) => a.id !== id);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && one[2] === "/token") {
      const next = { ...found, tokenPrefix: REISSUED_TOKEN.slice(4, 10) };
      state.automations = state.automations.map((a) => (a.id === id ? next : a));
      return json(200, { automation: next, webhookUrl: REISSUED_URL });
    }
    if (method === "POST" && one[2] === "/run") {
      if (runHold) await runHold;
      return json(202, { messageId: uid(900) });
    }
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
    /** 자동화 관리 REST 호출만 — 권한 없는 화면이 부르지 않는지 잰다 */
    automationCalls: () => calls.filter((c) => c.url.startsWith("/api/v1/automations")),
    holdRun: () => {
      let release = () => {};
      runHold = new Promise<void>((resolve) => {
        release = () => {
          runHold = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}
