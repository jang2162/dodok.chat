/**
 * 바깥 MCP 클라이언트의 입구 `POST /mcp`(제어 MCP 스펙 「바깥 — /mcp」 절). 개인 토큰(`Authorization: Bearer dpt_…`)의 주인이 주체이고,
 * 도구는 제어 서비스가 그 사람의 지금 역할로 처리한다 — 확인 카드 없이(바깥 클라이언트는 자기 확인을 한다).
 *
 * 공식 SDK 의 Streamable HTTP 서버 트랜스포트를 상태 없는 모드(sessionIdGenerator 없음)로, 요청마다 서버·트랜스포트를 새로 만들어
 * 처리하고 닫는다. 웹 표준(Request·Response) 쪽 트랜스포트를 쓴다 — Node 쪽(StreamableHTTPServerTransport)은 같은 것을 @hono/node-server 로
 * 감싼 것이라 응답을 직접 써야 해서 Fastify 의 오류 처리·inject 를 비켜 간다. 응답은 SSE 대신 JSON(enableJsonResponse) — 바깥
 * 호출은 카드를 기다리지 않으니 흘려 보낼 것이 없다
 */
import { CONTROL_TOOLS, type ControlResult, controlToolJsonSchema } from "@dodok/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { roleOf } from "../../auth/roles";
import type { Db } from "../../db/client";
import { type AgentTokenGuard, requireAgentToken } from "../../http/agent-token";
import { verifyPersonalToken } from "../tokens/service";
import type { ControlService } from "./service";

export const MCP_PATH = "/mcp";

export type McpRouteContext = {
  db: Db;
  workspaceId: string;
  control: Pick<ControlService, "call">;
  /** 브리지·러너 토큰과 같은 실패 카운터(스펙 「개인 토큰(PAT)」 절) — 막힌 주소는 토큰을 보지 않고 429 */
  guard: AgentTokenGuard;
  serverVersion: string;
  /** lastUsedAt 시계 — 테스트 주입 */
  now?: () => Date;
};

type Verified = { tokenId: string; userId: string };

// 트랜스포트가 보는 머리만 넘긴다 — Authorization·쿠키는 SDK 안으로 들이지 않는다
const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"] as const;

function webRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(`http://${request.host}${MCP_PATH}`, { method: "POST", headers });
}

/** 결과는 텍스트 JSON 하나, 오류는 isError + { code, message }(ErrorCode 그대로 — 스펙 「실행 흐름」 장) */
function toolResult(result: ControlResult): CallToolResult {
  if (result.ok) return { content: [{ type: "text", text: JSON.stringify(result.data ?? null) }] };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(result.error) }] };
}

function mcpServer(ctx: McpRouteContext, userId: string): Server {
  const server = new Server({ name: "dodok", version: ctx.serverVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: CONTROL_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: controlToolJsonSchema(tool) as { type: "object" },
    })),
  }));
  // 입력 검사는 제어 서비스가 도구의 Zod 스키마로 한다(VALIDATION) — 여기서 따로 보지 않는다
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    toolResult(
      await ctx.control.call({ userId, via: "pat" }, request.params.name, request.params.arguments ?? {}),
    ),
  );
  return server;
}

export function registerMcpRoute(fastify: FastifyInstance, ctx: McpRouteContext): void {
  const now = ctx.now ?? (() => new Date());
  const verified = new WeakMap<FastifyRequest, unknown>();
  const auth = requireAgentToken({
    verify: (presented) => verifyPersonalToken(ctx.db, presented, now()) ?? null,
    guard: ctx.guard,
    path: "mcp",
    route: MCP_PATH,
    verified,
    // 비활성화는 토큰을 모두 폐기하지만(멤버 비활성화와 같은 트랜잭션), 역할은 호출 때마다 읽는다(결정 7) — membership 이 없으면
    // 맞는 토큰이어도 401. 맞혀 본 것이 아니라 실패로 세지 않는다
    accept: (result) => roleOf(ctx.db, ctx.workspaceId, (result as Verified).userId) !== undefined,
  });

  fastify.post(MCP_PATH, { onRequest: auth }, async (request, reply) => {
    const { userId } = verified.get(request) as Verified;
    const server = mcpServer(ctx, userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(webRequest(request), { parsedBody: request.body });
      reply.status(response.status);
      response.headers.forEach((value, name) => {
        reply.header(name, value);
      });
      const body = await response.text();
      return reply.send(body.length === 0 ? undefined : body);
    } finally {
      await server.close();
    }
  });

  // 상태 없는 서버라 SSE 스트림(GET)·세션 끝내기(DELETE)가 없다 — MCP 규격대로 405
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header("allow", "POST")
      .send({ code: "VALIDATION", message: "method not allowed — POST only" });
  fastify.get(MCP_PATH, notAllowed);
  fastify.delete(MCP_PATH, notAllowed);
}
