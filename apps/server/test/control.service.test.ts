/**
 * 제어 서비스(제어 MCP 스펙 「실행 흐름」 장) — 도구마다 REST 와 같은 결과·버스 이벤트, 역할은 그때 읽은 시킨 사람의 것, 보관한 채널의
 * 미리 거절, 시킨 사람 없는 런은 읽기만, 쓰기 뒤 운영 사건·시스템 메시지, 레이트 둘. 확인 카드의 흐름은 control.confirm.test.ts
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { CONTROL_TOOLS, type ControlToolName } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { approvals, messages, opsEvents } from "../src/db/schema.sqlite";
import { addMember, getChannel } from "../src/modules/channels/service";
import { userHandle } from "../src/modules/control/confirm";
import { HANDLERS } from "../src/modules/control/handlers";
import { createAgentMessage, createUserMessage } from "../src/modules/messages/service";
import { LIMITS } from "../src/modules/ops/limits";
import { josa } from "../src/util/josa";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { errorOf, expectOk, newAgent, newChannel, openRun, pat, recordBus } from "./helpers/control";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { channelConversation, seedChannelWithAgent, seedConversation } from "./helpers/seed";

describe("제어 서비스", () => {
  let app: App;
  let owner: string;
  let ownerHandle: string;
  let mia: { id: string; token: string };
  let ada: { id: string; token: string };
  let headers: { authorization: string };
  /** 레이트 시계 — 테스트마다 1분씩 넘겨 앞 테스트의 호출이 상한을 채우지 않게 */
  let clock = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], limitClock: () => clock });
    owner = app.ownerUserId;
    ownerHandle = userHandle(app.db, owner) ?? "";
    mia = await userWithRole(app, "mia", "member");
    ada = await userWithRole(app, "ada", "admin");
    ({ headers } = await login(app));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    clock += 60_000;
  });

  const call = (principal: Parameters<App["control"]["call"]>[0], tool: string, args: unknown = {}) =>
    app.control.call(principal, tool, args);
  const controlRows = () => app.db.select().from(approvals).where(eq(approvals.kind, "dodok_control")).all();

  it("처리기가 CONTROL_TOOLS 전부에 하나씩 있다", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(CONTROL_TOOLS.map((t) => t.name).sort());
  });

  describe("읽기 — owner 개인 토큰", () => {
    it("list_channels·get_channel·list_agents·list_people", async () => {
      const { channel, agent } = openRun(app, owner);
      const listed = expectOk(await call(pat(owner), "list_channels")) as { channels: Array<{ id: string }> };
      expect(listed.channels.map((c) => c.id)).toContain(channel.id);
      const got = expectOk(await call(pat(owner), "get_channel", { channelId: channel.id })) as {
        channel: { id: string };
        members: Array<{ memberId: string; handle?: string }>;
      };
      expect(got.channel.id).toBe(channel.id);
      expect(got.members.find((m) => m.memberId === agent.id)?.handle).toBe(agent.handle);
      const agents = expectOk(await call(pat(owner), "list_agents")) as { agents: Array<{ id: string }> };
      expect(agents.agents.map((a) => a.id)).toContain(agent.id);
      const people = expectOk(await call(pat(owner), "list_people")) as { people: Array<{ handle: string }> };
      expect(people.people.map((p) => p.handle)).toEqual(expect.arrayContaining(["mia", "ada"]));
    });

    it("read_messages — 멘션은 @핸들, 작성자도 핸들, 스레드는 루트 + 답글", async () => {
      const { channel, agent } = openRun(app, owner);
      addMember(app.db, channel.id, { memberType: "user", memberId: mia.id }, app.logger);
      const root = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, channel.id),
        authorId: mia.id,
        bodyMd: `@${agent.handle} 안녕 **굵게**`,
        clientMsgId: `c-${channel.id}`,
      });
      createAgentMessage(app.db, app.bus, {
        externalId: `o-${channel.id}`,
        conversationId: channelConversation(app.db, channel.id),
        agentId: agent.id,
        bodyMd: "답글",
        threadRootId: root.id,
      });
      const conversationId = root.conversationId;
      const page = expectOk(await call(pat(owner), "read_messages", { conversationId })) as {
        messages: Array<{ id: string; author: string; text: string; replyCount?: number }>;
      };
      const first = page.messages.find((m) => m.id === root.id);
      expect(first).toMatchObject({ author: "@mia", text: `@${agent.handle} 안녕 **굵게**`, replyCount: 1 });
      expect(root.bodyMd).toContain("<@a:"); // 저장 본문은 토큰이다 — 도구가 푼 것이다
      const thread = expectOk(
        await call(pat(owner), "read_messages", { conversationId, threadRootId: root.id }),
      ) as { messages: Array<{ author: string; text: string }> };
      expect(thread.messages.map((m) => [m.author, m.text])).toEqual([
        ["@mia", `@${agent.handle} 안녕 **굵게**`],
        [`@${agent.handle}`, "답글"],
      ]);
    });

    it("read_messages — 그 세션의 글만, 같은 채널의 다른 세션 글·그 세션 밖 스레드는 섞지 않는다", async () => {
      const { channel } = openRun(app, owner);
      const here = channelConversation(app.db, channel.id);
      const side = seedConversation(app.db, channel.id, { title: "곁 세션" });
      const say = (conversationId: string, bodyMd: string) =>
        createUserMessage(app.db, app.bus, {
          conversationId,
          authorId: owner,
          bodyMd,
          clientMsgId: `${conversationId}-${bodyMd}`,
        });
      const a1 = say(here, "여기 하나");
      const b1 = say(side, "저기 하나");
      const a2 = say(here, "여기 둘");
      const page = expectOk(await call(pat(owner), "read_messages", { conversationId: here })) as {
        messages: Array<{ id: string }>;
      };
      expect(page.messages.map((m) => m.id)).toEqual([a1.id, a2.id]);
      const sidePage = expectOk(await call(pat(owner), "read_messages", { conversationId: side })) as {
        messages: Array<{ id: string }>;
      };
      expect(sidePage.messages.map((m) => m.id)).toEqual([b1.id]);
      // 다른 세션의 루트로 스레드를 읽으면 없는 스레드다
      expect(
        errorOf(await call(pat(owner), "read_messages", { conversationId: here, threadRootId: b1.id })),
      ).toMatchObject({ code: "NOT_FOUND" });
      // 없는 세션
      expect(
        errorOf(
          await call(pat(owner), "read_messages", { conversationId: "0199a000-0000-7000-8000-00000000dead" }),
        ),
      ).toMatchObject({ code: "NOT_FOUND" });
    });

    it("list_conversations — 그 채널의 세션만 최근 활동순, status 기본 open·closed, q 는 제목, REST 와 같은 쪽", async () => {
      const channel = newChannel(app);
      const other = newChannel(app);
      const at = (ms: number) => new Date(Date.UTC(2026, 9, 1) + ms);
      const old = seedConversation(app.db, channel.id, { title: "옛 기획", createdAt: at(1_000) });
      const recent = seedConversation(app.db, channel.id, { title: "새 기획", createdAt: at(2_000) });
      const closed = seedConversation(app.db, channel.id, { title: "닫은 회의", createdAt: at(3_000) });
      seedConversation(app.db, other.id, { title: "다른 채널", createdAt: at(4_000) });
      app.db.$client
        .prepare("UPDATE conversations SET closed_at = ?, closed_by = ? WHERE id = ?")
        .run(Date.now(), owner, closed);
      const ids = async (args: object) =>
        (
          expectOk(await call(pat(owner), "list_conversations", { channelId: channel.id, ...args })) as {
            conversations: Array<{ id: string }>;
          }
        ).conversations.map((c) => c.id);
      expect(await ids({})).toEqual([recent, old]);
      expect(await ids({ status: "closed" })).toEqual([closed]);
      expect(await ids({ q: "기획" })).toEqual([recent, old]);
      expect(await ids({ q: "옛" })).toEqual([old]);
      // REST 와 같은 결과 — 같은 함수·같은 쪽
      const rest = await app.fastify.inject({
        method: "GET",
        url: `/api/v1/channels/${channel.id}/conversations`,
        headers,
      });
      expect(expectOk(await call(pat(owner), "list_conversations", { channelId: channel.id }))).toEqual(
        rest.json(),
      );
      // read_messages 가 그 id 를 받는다
      expectOk(await call(pat(owner), "read_messages", { conversationId: recent }));
    });

    it("list_conversations — 다른 워크스페이스·없는 채널은 NOT_FOUND, 비활성 멤버는 FORBIDDEN, 시킨 사람 없는 런은 읽는다", async () => {
      const foreign = seedChannelWithAgent(app.db, { agentHandle: "ext", channelName: "밖" });
      expect(
        errorOf(await call(pat(owner), "list_conversations", { channelId: foreign.channelId })).code,
      ).toBe("NOT_FOUND");
      expect(
        errorOf(
          await call(pat(owner), "list_conversations", { channelId: "0199a000-0000-7000-8000-00000000dead" }),
        ).code,
      ).toBe("NOT_FOUND");
      const channel = newChannel(app);
      const gone = await userWithRole(app, "gone-conv", "member");
      expectOk(await call(pat(gone.id), "list_conversations", { channelId: channel.id }));
      app.db.$client
        .prepare("UPDATE memberships SET deactivated_at = ? WHERE user_id = ?")
        .run(Date.now(), gone.id);
      expect(errorOf(await call(pat(gone.id), "list_conversations", { channelId: channel.id })).code).toBe(
        "FORBIDDEN",
      );
      const { channel: runChannel, principal } = openRun(app, null);
      const listed = expectOk(await call(principal, "list_conversations", { channelId: runChannel.id })) as {
        conversations: Array<{ id: string }>;
      };
      expect(listed.conversations.map((c) => c.id)).toEqual([channelConversation(app.db, runChannel.id)]);
    });

    it("search_messages·get_run·ops_status·discover_agents", async () => {
      const { channel, run } = openRun(app, owner);
      createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, channel.id),
        authorId: owner,
        bodyMd: "제어검색어 하나",
        clientMsgId: `s-${channel.id}`,
      });
      const found = expectOk(await call(pat(owner), "search_messages", { q: "제어검색어" })) as {
        hits: unknown[];
      };
      expect(found.hits).toHaveLength(1);
      expect(expectOk(await call(pat(owner), "get_run", { runId: run.id }))).toMatchObject({
        run: { id: run.id, status: "tool" },
      });
      expect(expectOk(await call(pat(owner), "ops_status"))).toMatchObject({ workspaceId: app.workspaceId });
      expect(
        expectOk(
          await call(pat(owner), "discover_agents", { provider: "openclaw", gatewayId: FAKE_GATEWAY_ID }),
        ),
      ).toEqual({ agents: [{ providerAgentId: "dev", name: "dev" }, { providerAgentId: "fin" }] });
    });

    it("admin 읽기(ops_status·discover_agents)는 member 에게 FORBIDDEN — access 는 read 여도 역할은 정책 함수가 정한다(PC5)", async () => {
      expect(errorOf(await call(pat(mia.id), "ops_status"))).toEqual({
        code: "FORBIDDEN",
        message: "이 일은 admin 이상만 할 수 있습니다(지금 역할: member)",
      });
      expect(errorOf(await call(pat(mia.id), "discover_agents", { gatewayId: FAKE_GATEWAY_ID })).code).toBe(
        "FORBIDDEN",
      );
    });
  });

  describe("쓰기 — owner 개인 토큰은 카드 없이 REST 와 같은 결과·같은 버스 이벤트", () => {
    /** 같은 일을 도구와 REST 로 한 번씩 — 두 쪽의 버스 이벤트(도구만 내는 시스템 메시지·운영 사건 빼고)와 응답 키가 같아야 한다 */
    type Case = {
      tool: ControlToolName;
      setup?: () => void;
      args: () => Record<string, unknown>;
      rest: () => { method: "POST" | "PATCH" | "DELETE"; url: string; payload?: Record<string, unknown> };
    };
    const BUS: Parameters<typeof recordBus>[1] = [
      "channel.created",
      "channel.updated",
      "channel.member.changed",
      "agents.changed",
      "message.created",
      "ops.event",
    ];

    async function compare(
      c: { tool: ControlToolName; args: Record<string, unknown> },
      rest: ReturnType<Case["rest"]>,
    ) {
      const viaTool = recordBus(app, BUS);
      const result = await call(pat(owner), c.tool, c.args);
      viaTool.stop();
      const data = expectOk(result) as Record<string, unknown>;
      const viaRest = recordBus(app, BUS);
      const res = await app.fastify.inject({ ...rest, headers });
      viaRest.stop();
      expect(res.statusCode).toBeLessThan(300);
      const toolOnly = new Set(["message.created", "ops.event"]);
      expect(viaTool.seen.filter((e) => !toolOnly.has(e))).toEqual(
        viaRest.seen.filter((e) => !toolOnly.has(e)),
      );
      expect(Object.keys(data).sort()).toEqual(Object.keys(res.json() as object).sort());
      return data;
    }

    it("create_channel", async () => {
      const data = await compare(
        { tool: "create_channel", args: { name: "tool-made" } },
        { method: "POST", url: "/api/v1/channels", payload: { name: "rest-made" } },
      );
      expect(data).toMatchObject({ channel: { name: "tool-made", createdBy: owner } });
    });

    it("update_channel·set_channel_prompt·set_relay_policy·set_channel_run_limit", async () => {
      const a = newChannel(app);
      const b = newChannel(app);
      await compare(
        { tool: "update_channel", args: { channelId: a.id, name: "a2", topic: "t" } },
        { method: "PATCH", url: `/api/v1/channels/${b.id}`, payload: { name: "b2", topic: "t" } },
      );
      await compare(
        { tool: "set_channel_prompt", args: { channelId: a.id, prompt: "규칙" } },
        { method: "PATCH", url: `/api/v1/channels/${b.id}`, payload: { prompt: "규칙" } },
      );
      await compare(
        { tool: "set_channel_run_limit", args: { channelId: a.id, dailyRunLimit: 7 } },
        {
          method: "PATCH",
          url: `/api/v1/channels/${b.id}`,
          payload: { relayPolicy: { maxRelayTurns: 4, allowPairs: "all", dailyRunLimit: 7 } },
        },
      );
      // 릴레이 정책을 바꿔도 일일 한도는 남는다 — REST 는 통째로 바꾸므로 지금 값과 합쳐 보낸다
      await compare(
        {
          tool: "set_relay_policy",
          args: { channelId: a.id, relayPolicy: { maxRelayTurns: 2, allowPairs: "all" } },
        },
        {
          method: "PATCH",
          url: `/api/v1/channels/${b.id}`,
          payload: { relayPolicy: { maxRelayTurns: 2, allowPairs: "all", dailyRunLimit: 7 } },
        },
      );
      const after = getChannel(app.db, a.id);
      expect(after).toMatchObject({ name: "a2", topic: "t", prompt: "규칙" });
      expect(after?.relayPolicy).toEqual({ maxRelayTurns: 2, allowPairs: "all", dailyRunLimit: 7 });
      expect(after?.relayPolicy).toEqual(getChannel(app.db, b.id)?.relayPolicy);
      expectOk(await call(pat(owner), "set_channel_run_limit", { channelId: a.id, dailyRunLimit: null }));
      expect(getChannel(app.db, a.id)?.relayPolicy).toEqual({ maxRelayTurns: 2, allowPairs: "all" });
    });

    it("add_channel_agent·update_channel_agent·remove_channel_agent", async () => {
      const a = newChannel(app);
      const b = newChannel(app);
      const agent = newAgent(app);
      await compare(
        { tool: "add_channel_agent", args: { channelId: a.id, agentId: agent.id, aliases: ["opsx"] } },
        {
          method: "POST",
          url: `/api/v1/channels/${b.id}/members`,
          payload: { memberType: "agent", memberId: agent.id, aliases: ["opsx"] },
        },
      );
      await compare(
        { tool: "update_channel_agent", args: { channelId: a.id, agentId: agent.id, autoRespond: true } },
        {
          method: "PATCH",
          url: `/api/v1/channels/${b.id}/members/${agent.id}`,
          payload: { autoRespond: true },
        },
      );
      await compare(
        { tool: "remove_channel_agent", args: { channelId: a.id, agentId: agent.id } },
        { method: "DELETE", url: `/api/v1/channels/${b.id}/members/${agent.id}` },
      );
    });

    it("remove_channel_agent 에 사람 id 를 주면 NOT_FOUND — 사람 멤버를 빼지 않는다", async () => {
      const a = newChannel(app, { members: [mia.id] });
      expect(
        errorOf(await call(pat(owner), "remove_channel_agent", { channelId: a.id, agentId: mia.id })).code,
      ).toBe("NOT_FOUND");
    });

    it("archive_channel·unarchive_channel", async () => {
      const a = newChannel(app);
      const b = newChannel(app);
      await compare(
        { tool: "archive_channel", args: { channelId: a.id } },
        { method: "POST", url: `/api/v1/channels/${b.id}/archive` },
      );
      await compare(
        { tool: "unarchive_channel", args: { channelId: a.id } },
        { method: "POST", url: `/api/v1/channels/${b.id}/unarchive` },
      );
      expect(getChannel(app.db, a.id)?.archivedAt).toBeNull();
    });

    it("register_agent·update_agent·set_agent_enabled·archive_agent", async () => {
      const data = (await compare(
        {
          tool: "register_agent",
          args: { providerAgentId: "regtool", handle: "regtool", name: "R", gatewayId: FAKE_GATEWAY_ID },
        },
        {
          method: "POST",
          url: "/api/v1/agents",
          payload: { providerAgentId: "regrest", handle: "regrest", name: "R", gatewayId: FAKE_GATEWAY_ID },
        },
      )) as { agent: { id: string } };
      const other = newAgent(app);
      await compare(
        { tool: "update_agent", args: { agentId: data.agent.id, name: "R2" } },
        { method: "PATCH", url: `/api/v1/agents/${other.id}`, payload: { name: "R2" } },
      );
      await compare(
        { tool: "set_agent_enabled", args: { agentId: data.agent.id, enabled: false } },
        { method: "PATCH", url: `/api/v1/agents/${other.id}`, payload: { enabled: false } },
      );
      await compare(
        { tool: "archive_agent", args: { agentId: data.agent.id } },
        { method: "DELETE", url: `/api/v1/agents/${other.id}` },
      );
    });

    it("register_agent 의 OpenClaw gatewayId 빠짐은 REST 와 같은 VALIDATION", async () => {
      expect(
        errorOf(
          await call(pat(owner), "register_agent", { providerAgentId: "nogw", handle: "nogw", name: "n" }),
        ),
      ).toEqual({ code: "VALIDATION", message: "gatewayId is required for OpenClaw" });
    });
  });

  describe("역할 — 같은 REST 정책 함수로 그때 읽는다", () => {
    it("member 개인 토큰: set_channel_prompt FORBIDDEN, update_channel(이름) 성공", async () => {
      const channel = newChannel(app);
      expect(
        errorOf(await call(pat(mia.id), "set_channel_prompt", { channelId: channel.id, prompt: "x" })),
      ).toEqual({
        code: "FORBIDDEN",
        message: "이 일은 admin 이상만 할 수 있습니다(지금 역할: member)",
      });
      expectOk(await call(pat(mia.id), "update_channel", { channelId: channel.id, name: "mia-renamed" }));
      expect(getChannel(app.db, channel.id)?.name).toBe("mia-renamed");
      expect(getChannel(app.db, channel.id)?.prompt).toBeUndefined();
    });

    it("member 는 에이전트를 별칭만으로 넣을 수 있다 — 파싱이 채운 기본값(autoRespond)을 세지 않는다", async () => {
      const channel = newChannel(app);
      const agent = newAgent(app);
      expectOk(
        await call(pat(mia.id), "add_channel_agent", {
          channelId: channel.id,
          agentId: agent.id,
          aliases: ["al"],
        }),
      );
      const other = newAgent(app);
      expect(
        errorOf(
          await call(pat(mia.id), "add_channel_agent", {
            channelId: channel.id,
            agentId: other.id,
            autoRespond: true,
          }),
        ).code,
      ).toBe("FORBIDDEN");
    });

    it("비활성 멤버의 개인 토큰 — 어떤 도구도 FORBIDDEN", async () => {
      const gone = await userWithRole(app, "gone", "member");
      app.db.$client
        .prepare("UPDATE memberships SET deactivated_at = ? WHERE user_id = ?")
        .run(Date.now(), gone.id);
      expect(errorOf(await call(pat(gone.id), "list_channels")).code).toBe("FORBIDDEN");
    });
  });

  describe("보관한 채널 — 확인 카드 전에 미리 거절", () => {
    it("update_channel 은 CHANNEL_ARCHIVED(에이전트 주체도 카드 없이), unarchive_channel 은 받는다", async () => {
      const { channel, principal } = openRun(app, owner);
      expectOk(await call(pat(owner), "archive_channel", { channelId: channel.id }));
      const before = controlRows().length;
      expect(
        errorOf(await call(principal, "update_channel", { channelId: channel.id, name: "x" })).code,
      ).toBe("CHANNEL_ARCHIVED");
      expect(
        errorOf(await call(pat(owner), "update_channel", { channelId: channel.id, name: "x" })).code,
      ).toBe("CHANNEL_ARCHIVED");
      expect(errorOf(await call(pat(owner), "archive_channel", { channelId: channel.id })).code).toBe(
        "CHANNEL_ARCHIVED",
      );
      expect(controlRows()).toHaveLength(before);
      expectOk(await call(pat(owner), "unarchive_channel", { channelId: channel.id }));
      expect(getChannel(app.db, channel.id)?.archivedAt).toBeNull();
    });

    it("member 의 archive_channel 은 FORBIDDEN", async () => {
      const channel = newChannel(app);
      expect(errorOf(await call(pat(mia.id), "archive_channel", { channelId: channel.id })).code).toBe(
        "FORBIDDEN",
      );
    });
  });

  describe("그 런을 시킨 사람", () => {
    it("시킨 사람 없음(자동화 사슬) — 쓰기 FORBIDDEN 「사람이 시킨 런에서만…」, 읽기는 된다", async () => {
      const { channel, principal } = openRun(app, null);
      expect(errorOf(await call(principal, "update_channel", { channelId: channel.id, name: "x" }))).toEqual({
        code: "FORBIDDEN",
        message: "사람이 시킨 런에서만 바꿀 수 있습니다",
      });
      expectOk(await call(principal, "get_channel", { channelId: channel.id }));
      expect(controlRows().filter((r) => r.runId === principal.runId)).toHaveLength(0);
    });

    it("Review Focus 1 — mia(member)가 시킨 런의 set_channel_prompt 는 카드 없이 FORBIDDEN, 시킨 사람을 밝힌다", async () => {
      const { channel, principal } = openRun(app, mia.id);
      const result = await call(principal, "set_channel_prompt", { channelId: channel.id, prompt: "몰래" });
      expect(errorOf(result)).toEqual({
        code: "FORBIDDEN",
        message: "이 일은 admin 이상만 할 수 있습니다(시킨 사람: @mia, member)",
      });
      expect(controlRows().filter((r) => r.runId === principal.runId)).toHaveLength(0);
      expect(getChannel(app.db, channel.id)?.prompt).toBeUndefined();
    });
  });

  describe("쓰기 뒤 — 운영 사건 control_change·시스템 메시지", () => {
    it("개인 토큰: 「@owner 가 MCP 로 …」, 사건 detail 에 바꾼 값(프롬프트 원문)이 없다", async () => {
      const channel = newChannel(app);
      // 대화가 정해지지 않은 제어 메시지는 그 채널의 열린 세션에 남는다(채널 세션 계획 판정 PS3) — 세션 하나를 연다
      channelConversation(app.db, channel.id);
      const secret = "아주-비밀스러운-프롬프트-원문";
      expectOk(await call(pat(owner), "set_channel_prompt", { channelId: channel.id, prompt: secret }));
      const notice = app.db
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.kind, "system")))
        .all()
        .at(-1);
      expect(notice?.bodyMd).toBe(
        `@${ownerHandle} ${josa(ownerHandle, "이", "가")} MCP 로 채널 프롬프트를 바꿨습니다`,
      );
      const event = app.db
        .select()
        .from(opsEvents)
        .where(
          and(eq(opsEvents.kind, "control_change"), eq(opsEvents.key, `control:set_channel_prompt:${owner}`)),
        )
        .get();
      expect(event?.detail).toEqual({
        userId: owner,
        via: "pat",
        agentId: null,
        tool: "set_channel_prompt",
        channelId: channel.id,
        targetAgentId: null,
      });
      expect(JSON.stringify(event)).not.toContain(secret);
    });

    it("개인 토큰(바깥 /mcp — 런 없음): 그 채널의 최근 열린 세션에 남고, 열린 세션이 없으면 메시지 없이 운영 사건만", async () => {
      const notices = (conversationId: string) =>
        app.db
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), eq(messages.kind, "system")))
          .all();
      const channel = newChannel(app);
      const older = seedConversation(app.db, channel.id, { createdAt: new Date(Date.now() - 60_000) });
      const recent = seedConversation(app.db, channel.id);
      expectOk(await call(pat(owner), "update_channel", { channelId: channel.id, name: "mcp-새" }));
      expect(notices(recent)).toHaveLength(1);
      expect(notices(older)).toHaveLength(0);

      const empty = newChannel(app);
      expectOk(await call(pat(owner), "update_channel", { channelId: empty.id, name: "mcp-빈" }));
      expect(app.db.select().from(messages).where(eq(messages.channelId, empty.id)).all()).toEqual([]);
      expect(
        app.db
          .select()
          .from(opsEvents)
          .where(
            and(eq(opsEvents.kind, "control_change"), eq(opsEvents.key, `control:update_channel:${owner}`)),
          )
          .get()?.detail,
      ).toMatchObject({ channelId: empty.id });
    });

    it("에이전트 쓰기의 사건 detail 에 agentId·targetAgentId, 채널이 없는 도구는 시스템 메시지 없음", async () => {
      const target = newAgent(app);
      expectOk(
        await call(pat(owner), "update_agent", { agentId: target.id, basePrompt: "비밀-기본-프롬프트" }),
      );
      const event = app.db
        .select()
        .from(opsEvents)
        .where(and(eq(opsEvents.kind, "control_change"), eq(opsEvents.key, `control:update_agent:${owner}`)))
        .get();
      expect(event?.detail).toEqual({
        userId: owner,
        via: "pat",
        agentId: null,
        tool: "update_agent",
        channelId: null,
        targetAgentId: target.id,
      });
      expect(JSON.stringify(event)).not.toContain("비밀-기본-프롬프트");
    });

    it("읽기는 사건을 남기지 않는다", async () => {
      const before = app.db.select().from(opsEvents).where(eq(opsEvents.kind, "control_change")).all();
      expectOk(await call(pat(owner), "list_agents"));
      expect(app.db.select().from(opsEvents).where(eq(opsEvents.kind, "control_change")).all()).toEqual(
        before,
      );
    });
  });

  describe("입력·도구 이름", () => {
    it("입력 틀림은 VALIDATION(모르는 키 포함), 모르는 도구는 NOT_FOUND", async () => {
      const channel = newChannel(app);
      expect(errorOf(await call(pat(owner), "update_channel", { channelId: "nope" })).code).toBe(
        "VALIDATION",
      );
      expect(
        errorOf(await call(pat(owner), "update_channel", { channelId: channel.id, prompt: "섞어 보냄" }))
          .code,
      ).toBe("VALIDATION");
      expect(errorOf(await call(pat(owner), "post_message", {}))).toEqual({
        code: "NOT_FOUND",
        message: "unknown tool: post_message",
      });
    });
  });

  describe("레이트 — 주체마다", () => {
    it(`분당 ${LIMITS.controlPerMin + 1}번째 호출은 RATE_LIMITED`, async () => {
      const rate = await userWithRole(app, "rater", "member");
      for (let i = 0; i < LIMITS.controlPerMin; i++) expectOk(await call(pat(rate.id), "list_agents"));
      expect(errorOf(await call(pat(rate.id), "list_agents")).code).toBe("RATE_LIMITED");
      // 다른 주체는 따로 센다
      expectOk(await call(pat(ada.id), "list_agents"));
    });

    it(`쓰기 ${LIMITS.controlWritePerMin + 1}번째는 RATE_LIMITED`, async () => {
      const writer = await userWithRole(app, "writer", "member");
      const channel = newChannel(app);
      for (let i = 0; i < LIMITS.controlWritePerMin; i++)
        expectOk(await call(pat(writer.id), "update_channel", { channelId: channel.id, name: `w${i}` }));
      expect(
        errorOf(await call(pat(writer.id), "update_channel", { channelId: channel.id, name: "over" })).code,
      ).toBe("RATE_LIMITED");
      expectOk(await call(pat(writer.id), "list_agents"));
    });
  });
});
