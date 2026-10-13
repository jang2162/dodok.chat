/**
 * 바깥 MCP 입구 `/mcp`(제어 MCP 스펙 「바깥 — /mcp」 절) — 개인 토큰 인증·실패 카운터, MCP 프로토콜(initialize·tools/list·tools/call),
 * 역할 판정, 카드 없는 쓰기, 405, 응답·로그에 토큰 원문 없음. 도구 처리 자체는 control.service.test.ts
 */
import { CONTROL_TOOLS, controlToolJsonSchema } from "@dodok/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { approvals, memberships } from "../src/db/schema.sqlite";
import { createLogger } from "../src/logger";
import { getChannel } from "../src/modules/channels/service";
import { issuePersonalToken } from "../src/modules/tokens/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { newChannel } from "./helpers/control";

const MAX_FAILURES = 4;
const ACCEPT = "application/json, text/event-stream";

describe("/mcp", () => {
  let app: App;
  let clock = 0;
  const lines: string[] = [];
  let ownerHeaders: { authorization: string };
  let n = 0;

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    app = await bootTestApp(
      { LOG_LEVEL: "trace" },
      {
        logger: createLogger("trace", sink),
        limitClock: () => clock,
        limits: {
          bridgeFail: { maxFailures: MAX_FAILURES, windowMs: 60_000, blockMs: 60_000, maxAddresses: 64 },
        },
      },
    );
    ownerHeaders = (await login(app)).headers;
  });
  afterAll(async () => {
    await app.close();
  });
  // 테스트마다 실패 창·막힘·레이트 창을 넘긴다 — 앞 테스트의 실패가 다음 테스트를 막지 않게
  beforeEach(() => {
    clock += 10 * 60_000;
  });

  const tokenFor = (userId: string) => issuePersonalToken(app.db, userId, `t${++n}`).raw;
  const post = (token: string | undefined, body: unknown) =>
    app.fastify.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: ACCEPT,
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      payload: JSON.stringify(body),
    });
  const rpc = async (token: string, method: string, params: object = {}) => {
    const res = await post(token, { jsonrpc: "2.0", id: ++n, method, params });
    expect(res.statusCode).toBe(200);
    return res.json() as { result?: Record<string, unknown>; error?: unknown };
  };
  const callTool = async (token: string, name: string, args: object) => {
    const { result } = await rpc(token, "tools/call", { name, arguments: args });
    const content = (result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "null";
    return { isError: result?.isError === true, value: JSON.parse(content) as unknown };
  };
  const initialize = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  };

  it("토큰이 없으면 401 JSON — 실패로 센다", async () => {
    const res = await post(undefined, initialize);
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("틀린 토큰·폐기한 토큰은 401 이고 실패 카운터가 오른다 — 막히면 맞는 토큰도 429 [Review Focus 5]", async () => {
    const good = tokenFor(app.ownerUserId);
    const revoked = issuePersonalToken(app.db, app.ownerUserId, "old");
    const del = await app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/me/tokens/${revoked.token.id}`,
      headers: ownerHeaders,
    });
    expect(del.statusCode).toBe(204);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await post(i % 2 === 0 ? revoked.raw : "dpt_nope", initialize);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await post(good, initialize);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    clock += 2 * 60_000;
    expect((await post(good, initialize)).statusCode).toBe(200);
  });

  it("비활성화된 사람의 토큰은 401, 다시 활성화해도 401 [Review Focus 5]", async () => {
    const mia = await userWithRole(app, `mcp-mia${++n}`, "member");
    const token = tokenFor(mia.id);
    expect((await post(token, initialize)).statusCode).toBe(200);
    const deactivate = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${mia.id}/deactivate`,
      headers: ownerHeaders,
    });
    expect(deactivate.statusCode).toBe(200);
    expect((await post(token, initialize)).statusCode).toBe(401);
    const reactivate = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${mia.id}/reactivate`,
      headers: ownerHeaders,
    });
    expect(reactivate.statusCode).toBe(200);
    expect((await post(token, initialize)).statusCode).toBe(401);
  });

  it("membership 이 비활성이면 폐기되지 않은 토큰도 401 — 역할은 요청마다 읽는다", async () => {
    const kim = await userWithRole(app, `mcp-kim${++n}`, "member");
    const token = tokenFor(kim.id);
    app.db
      .update(memberships)
      .set({ deactivatedAt: new Date() })
      .where(and(eq(memberships.userId, kim.id), eq(memberships.workspaceId, app.workspaceId)))
      .run();
    const res = await post(token, initialize);
    expect(res.statusCode).toBe(401);
  });

  it("initialize → tools/list 가 CONTROL_TOOLS 전부를 같은 JSON Schema 로", async () => {
    const token = tokenFor(app.ownerUserId);
    const init = await post(token, initialize);
    expect(init.statusCode).toBe(200);
    expect(init.json()).toMatchObject({
      result: { serverInfo: { name: "dodok" }, capabilities: { tools: {} } },
    });
    const { result } = await rpc(token, "tools/list");
    const tools = result?.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    expect(tools.map((t) => t.name)).toEqual(CONTROL_TOOLS.map((t) => t.name));
    for (const tool of CONTROL_TOOLS) {
      const listed = tools.find((t) => t.name === tool.name);
      expect(listed?.description).toBe(tool.description);
      expect(listed?.inputSchema).toEqual(controlToolJsonSchema(tool));
    }
  });

  it("tools/call list_channels 는 제어 서비스의 결과를 텍스트 JSON 으로", async () => {
    const channel = newChannel(app, { name: `mcp-list${++n}` });
    const { isError, value } = await callTool(tokenFor(app.ownerUserId), "list_channels", {});
    expect(isError).toBe(false);
    expect(JSON.stringify(value)).toContain(channel.id);
  });

  it("member 토큰의 set_channel_prompt 는 isError + FORBIDDEN, 프롬프트는 그대로", async () => {
    const mia = await userWithRole(app, `mcp-member${++n}`, "member");
    const channel = newChannel(app, { members: [mia.id] });
    const { isError, value } = await callTool(tokenFor(mia.id), "set_channel_prompt", {
      channelId: channel.id,
      prompt: "새 규칙",
    });
    expect(isError).toBe(true);
    expect(value).toMatchObject({ code: "FORBIDDEN" });
    expect(getChannel(app.db, channel.id, app.workspaceId)?.prompt ?? null).toBeNull();
  });

  it("owner 토큰의 쓰기는 확인 카드 없이 곧바로 바뀐다", async () => {
    const channel = newChannel(app);
    const name = `mcp-renamed${++n}`;
    const { isError } = await callTool(tokenFor(app.ownerUserId), "update_channel", {
      channelId: channel.id,
      name,
    });
    expect(isError).toBe(false);
    expect(getChannel(app.db, channel.id, app.workspaceId)?.name).toBe(name);
    expect(app.db.select().from(approvals).where(eq(approvals.kind, "dodok_control")).all()).toEqual([]);
  });

  it("입력이 틀리면 isError + VALIDATION, 모르는 도구는 NOT_FOUND", async () => {
    const token = tokenFor(app.ownerUserId);
    expect(await callTool(token, "get_channel", { channelId: 42 })).toMatchObject({
      isError: true,
      value: { code: "VALIDATION" },
    });
    expect(await callTool(token, "post_message", {})).toMatchObject({
      isError: true,
      value: { code: "NOT_FOUND" },
    });
  });

  it("GET·DELETE 는 405 — 토큰이 있어도", async () => {
    const token = tokenFor(app.ownerUserId);
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.fastify.inject({
        method,
        url: "/mcp",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe("POST");
    }
  });

  it("응답·로그 어디에도 토큰 원문이 없다 — 맞는 토큰·틀린 토큰 모두", async () => {
    const good = tokenFor(app.ownerUserId);
    const wrong = `dpt_${"x".repeat(43)}`;
    lines.length = 0;
    const bodies = [
      (await post(good, initialize)).body,
      (await post(good, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_channels" } }))
        .body,
      (await post(wrong, initialize)).body,
    ];
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [good.slice(4), wrong.slice(4)]) {
      expect(lines.join("").includes(secret)).toBe(false);
      expect(bodies.join("").includes(secret)).toBe(false);
    }
  });

  it("공식 SDK 클라이언트가 붙어 도구 목록을 받고 부른다", async () => {
    const token = tokenFor(app.ownerUserId);
    const address = await app.fastify.listen({ port: 0, host: "127.0.0.1" });
    const client = new Client({ name: "dodok-test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(CONTROL_TOOLS.length);
      const result = await client.callTool({ name: "list_people", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });
});
