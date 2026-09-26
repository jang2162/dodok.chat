import type { Invite, MemberRow } from "@dodok/shared";
import { vi } from "vitest";
import { uid } from "./fixtures";
import { ME, json, shellGet } from "./shellApi";

/** 멤버 화면(`/settings/members`) 테스트의 가짜 서버 — 멤버·대기 초대를 서버 상태로 들고 팀 REST 를 흉내 낸다(서버 실물의 모양) */

export const OWNER_ID = ME.user.id;
export const ADMIN_ID = uid(40);
export const MINA_ID = uid(41);

export const memberRowOf = (
  over: Partial<MemberRow> & Pick<MemberRow, "id" | "handle" | "role">,
): MemberRow => ({
  displayName: over.handle,
  createdAt: "2026-09-20T12:00:00.000Z",
  ...over,
});

export const OWNER_ROW = memberRowOf({
  id: OWNER_ID,
  handle: "owner",
  displayName: "주인",
  role: "owner",
  email: "owner@example.com",
});
export const ADMIN_ROW = memberRowOf({
  id: ADMIN_ID,
  handle: "sora",
  displayName: "소라",
  role: "admin",
  email: "sora@example.com",
});
export const MINA_ROW = memberRowOf({
  id: MINA_ID,
  handle: "mina",
  displayName: "미나",
  role: "member",
  email: "mina@example.com",
  createdAt: "2026-09-25T12:00:00.000Z",
});

export const inviteOf = (n: number, role: "admin" | "member", over: Partial<Invite> = {}): Invite => ({
  id: uid(300 + n),
  kind: "invite",
  role,
  prefix: `dit_${String(n).padStart(4, "0")}`,
  createdBy: OWNER_ID,
  createdAt: "2026-09-26T12:00:00.000Z",
  expiresAt: "2026-10-03T12:00:00.000Z",
  ...over,
});

type Body = Record<string, unknown> | undefined;
export type Call = { method: string; url: string; body: Body };

/** 발급 응답의 원문 — 목록·다른 응답에는 나오지 않는다 */
export const INVITE_TOKEN = `dit_${"a".repeat(43)}`;
export const INVITE_URL = `https://chat.example.com/join/${INVITE_TOKEN}`;
export const RESET_TOKEN = `drt_${"b".repeat(43)}`;
export const RESET_URL = `https://chat.example.com/reset/${RESET_TOKEN}`;

/**
 * `override` 가 Response 를 주면 그것을 쓰고, undefined 면 기본 처리(상태를 고친다). me 는 기본이 owner.
 * `teamCalls()` 는 팀 REST(`/members`·`/invites`) 호출만 — 권한 없는 화면이 부르지 않는지 잰다
 */
export function stubMembersServer(
  opts: {
    me?: { user: { id: string; handle: string }; workspaceId: string; role?: string };
    members?: MemberRow[];
    invites?: Invite[];
    override?: (call: Call) => Response | undefined | Promise<Response | undefined>;
  } = {},
) {
  const state = {
    me: opts.me ?? ME,
    members: opts.members ?? [OWNER_ROW, ADMIN_ROW, MINA_ROW],
    invites: opts.invites ?? [inviteOf(1, "member"), inviteOf(2, "admin")],
  };
  const calls: Call[] = [];

  function handle({ method, url, body }: Call): Response | undefined {
    if (url === "/api/v1/auth/me") return json(200, state.me);
    if (method === "GET" && url === "/api/v1/members") return json(200, { members: state.members });
    const member = /^\/api\/v1\/members\/([^/]+)$/.exec(url)?.[1];
    if (member && method === "PATCH") {
      const role = body?.role as MemberRow["role"];
      state.members = state.members.map((m) => (m.id === member ? { ...m, role } : m));
      // 서버 실물: 강등하면 그 사람이 발급한 쓰이지 않은 링크를 폐기한다(팀 스펙 4장)
      if (role === "member") state.invites = state.invites.filter((i) => i.createdBy !== member);
      return json(200, { member: state.members.find((m) => m.id === member) });
    }
    if (member && method === "DELETE") {
      state.members = state.members.filter((m) => m.id !== member);
      state.invites = state.invites.filter((i) => i.createdBy !== member);
      return new Response(null, { status: 204 });
    }
    const reset = /^\/api\/v1\/members\/([^/]+)\/reset-link$/.exec(url)?.[1];
    if (reset && method === "POST")
      return json(201, {
        invite: inviteOf(90, "member", {
          kind: "reset",
          role: undefined,
          targetUserId: reset,
          prefix: "drt_bbbb",
        }),
        token: RESET_TOKEN,
        url: RESET_URL,
      });
    if (method === "GET" && url === "/api/v1/invites") return json(200, { invites: state.invites });
    if (method === "POST" && url === "/api/v1/invites") {
      const invite = inviteOf(10 + state.invites.length, body?.role as "admin" | "member", {
        prefix: INVITE_TOKEN.slice(0, 8),
        createdBy: state.me.user.id,
      });
      state.invites = [invite, ...state.invites];
      return json(201, { invite, token: INVITE_TOKEN, url: INVITE_URL });
    }
    const invite = /^\/api\/v1\/invites\/([^/]+)$/.exec(url)?.[1];
    if (invite && method === "DELETE") {
      state.invites = state.invites.filter((i) => i.id !== invite);
      return new Response(null, { status: 204 });
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
    const reply = (await opts.override?.(call)) ?? handle(call) ?? shellGet(input, init);
    if (!reply) throw new Error(`예상 밖 요청 ${call.method} ${call.url}`);
    return reply;
  });
  vi.stubGlobal("fetch", fetch);

  return {
    state,
    /** GET 밖의 요청(순서대로) */
    writes: () => calls.filter((c) => c.method !== "GET"),
    teamCalls: () => calls.filter((c) => /^\/api\/v1\/(members|invites)(\/|$)/.test(c.url)),
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
  };
}
