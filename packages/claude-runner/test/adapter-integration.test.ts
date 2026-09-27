import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdapterEvent,
  type Attachment,
  BridgeAuthGuard,
  dodokSessionKey,
  type InboundDeliver,
  type OutboundMessage,
  type ProviderApproval,
} from "@dodok/shared";
import { createRunnerAdapter, type RunnerAdapter } from "@dodok/runner-adapter";
import { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttachmentsHttp } from "../src/attachments-http";
import type { ResolvedAgent } from "../src/config";
import { startRunnerConnection, type RunnerConnection } from "../src/connection";
import { POST_STOPPED_MESSAGE } from "../src/post-tool";
import { createFakeSdk, script, type FakeSdk } from "./helpers/fake-query";
import { AGENT, CHANNEL_ID } from "./helpers/fixtures";

// 실제 러너 어댑터(@dodok/runner-adapter, 실제 socket.io 서버)와 러너(연결·런·가짜 query)를 붙인다 — 두 태스크가 따로 맞춘
// 계약(조율자 판정 R1: 중지는 run.final aborted, outbound.post 는 열린 런에 묶임, 승인 왕복, 교체·재시작)이 실제로 맞물리는지.
// 판정은 어댑터가 오케스트레이터에 내는 AdapterEvent 로 한다. 모델 런 0 — CLI 를 띄우지 않는다

const TOKEN = "drn_integration_token_0123456789abcdefghijklmnop";
const TOKEN_ID = "7a0e2d3c-2d1f-4f5e-9a6b-000000000001";
const SESSION_ID = "0192f000-0000-4000-8000-00000000e001";
const RUN_1 = "0192f000-0000-7000-8000-00000000a101";
const RUN_2 = "0192f000-0000-7000-8000-00000000a102";
const UPLOADED = "0192f000-0000-7000-8000-0000000000f1";
const SUGGESTION = {
  type: "addRules" as const,
  rules: [{ toolName: "Bash", ruleContent: "npm test" }],
  behavior: "allow" as const,
  destination: "localSettings" as const,
};

type ServerSide = {
  http: HttpServer;
  io: Server;
  adapter: RunnerAdapter;
  url: string;
  port: number;
  events: AdapterEvent[];
  outbound: Array<{ message: OutboundMessage; messageId: string }>;
  close(): Promise<void>;
};

let n = 0;
async function startServer(port = 0, opts: { approvalTtlMs?: number } = {}): Promise<ServerSide> {
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const actual = (http.address() as AddressInfo).port;
  const events: AdapterEvent[] = [];
  const outbound: ServerSide["outbound"] = [];
  const adapter = createRunnerAdapter({
    io,
    verifyToken: (presented) => (presented === TOKEN ? { tokenId: TOKEN_ID, label: "laptop" } : null),
    clientAddress: (socket) => socket.handshake.address,
    authGuard: new BridgeAuthGuard({ maxFailures: 3 }),
    onBlocked: () => {},
    now: Date.now,
    serverVersion: "integration",
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    channelName: () => "dev",
    onOutbound: async (message) => {
      n += 1;
      const messageId = `0192f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
      outbound.push({ message, messageId });
      return { messageId };
    },
    tokenCount: () => 1,
    ...(opts.approvalTtlMs === undefined ? {} : { approvalTtlMs: opts.approvalTtlMs }),
  });
  adapter.onEvent((e) => events.push(e));
  await adapter.connect();
  let closed = false;
  return {
    http,
    io,
    adapter,
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    events,
    outbound,
    async close() {
      if (closed) return;
      closed = true;
      // 서버 종료 순서 그대로 — 어댑터가 먼저 전송만 닫고(DISCONNECT 패킷 없음) 그 뒤 io 를 닫는다. 러너는 transport close 로
      // 보고 다시 붙는다(종료 코드 2 가 아니다)
      await adapter.close();
      await new Promise<void>((resolve) => void io.close(() => resolve()));
    },
  };
}

async function waitFor(check: () => boolean, label: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`기다린 조건이 오지 않았다: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let workdir: string;
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "dodok-int-"));
  writeFileSync(join(workdir, "report.md"), "# 보고");
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(workdir, { recursive: true, force: true });
});

function startRunner(server: { url: string }, fake: FakeSdk, opts: { uploadGate?: Promise<void> } = {}) {
  const fatal: number[] = [];
  const logs: string[] = [];
  const uploads: string[] = [];
  const attachmentsHttp: AttachmentsHttp = {
    upload: async ({ name, bytes }) => {
      uploads.push(name);
      await opts.uploadGate;
      return {
        id: UPLOADED,
        kind: "file",
        url: `artifact://${UPLOADED}`,
        name,
        mime: "text/plain",
        size: bytes.length,
      } satisfies Attachment;
    },
    download: async () => {
      throw new Error("not used");
    },
  };
  const agent: ResolvedAgent = { ...AGENT, workdir };
  const conn: RunnerConnection = startRunnerConnection({
    config: { serverUrl: server.url, claudeConfigDir: "/c", maxConcurrentRuns: 3, agents: [agent] },
    token: TOKEN,
    sdk: fake,
    versions: {
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.283",
      claudeCodeVersion: "2.1.283",
      bundleSha256: null,
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    onFatal: (code) => fatal.push(code),
    baseEnv: { PATH: "/usr/bin" },
    backoff: { minMs: 20, maxMs: 50 },
    closeGraceMs: 30,
    attachmentsHttp,
  });
  cleanups.push(() => conn.stop());
  return { conn, fatal, logs, uploads };
}

function deliver(runId: string): InboundDeliver {
  return {
    deliveryId: runId.replace(/a1(\d\d)$/, "d1$1"),
    kind: "message",
    channelId: CHANNEL_ID,
    agentId: "coder",
    sessionKey: dodokSessionKey("coder", CHANNEL_ID),
    runId,
    message: {
      id: runId.replace(/a1(\d\d)$/, "b1$1"),
      author: { type: "user", handle: "mia", displayName: "Mia" },
      text: "@coder 테스트 돌려 줘",
      attachments: [],
      ts: "2026-09-27T01:02:03.000Z",
    },
    context: {
      recentMessages: [],
      participants: [{ type: "agent", handle: "coder", displayName: "코더", isSelf: true }],
      relayRules: "릴레이 규칙",
    },
    options: {},
  };
}

const signals = (s: ServerSide, runId: string) =>
  s.events.flatMap((e) => (e.kind === "run_signal" && e.runId === runId ? [e.signal.kind] : []));
const runEvents = (s: ServerSide, runId: string) =>
  s.events.flatMap((e) => (e.kind === "run_event" && e.runId === runId ? [e.event] : []));
const approvals = (s: ServerSide) =>
  s.events.flatMap((e): ProviderApproval[] => (e.kind === "approval" ? [e.approval] : []));

async function ready(server: ServerSide) {
  await waitFor(
    () =>
      server.adapter.status().runners.connected === 1 &&
      server.adapter.setupDetail().runners[0]?.agents.some((a) => a.id === "coder") === true,
    "러너 hello",
  );
}

describe("러너 ↔ 실제 러너 어댑터", () => {
  it("hello — 에이전트가 목록에 오르고 approvals·attachments 능력을 알린다", async () => {
    const server = await startServer();
    cleanups.push(() => server.close());
    startRunner(server, createFakeSdk());
    await ready(server);
    expect(await server.adapter.listAgents()).toEqual([
      { providerAgentId: "coder", name: "코더", hint: "laptop · my-repo · sonnet" },
    ]);
    expect(server.adapter.setupDetail().runners[0]!.capabilities).toEqual([
      "threads",
      "interrupt",
      "approvals",
      "attachments",
    ]);
    expect(JSON.stringify(server.adapter.setupDetail())).not.toContain(workdir);
  });

  it("run.start → 글·도구·승인 왕복·post(파일) → 최종 답 — post 는 열린 런에 묶여 통과한다", async () => {
    const server = await startServer();
    cleanups.push(() => server.close());
    const fake = createFakeSdk();
    const runner = startRunner(server, fake);
    await ready(server);
    fake.script(
      script.init(),
      script.messageStart("msg_1"),
      script.blockStart(0, { type: "text", text: "" }),
      script.textDelta(0, "확인합니다 "),
      script.blockStop(0),
      script.blockStart(1, { type: "tool_use", id: "toolu_01", name: "Bash" }),
      script.jsonDelta(1, '{"command":"npm test"}'),
      script.blockStop(1),
      script.messageStop(),
      {
        askPermission: {
          toolName: "Bash",
          input: { command: "npm test" },
          toolUseID: "toolu_01",
          suggestions: [SUGGESTION],
        },
      },
      script.toolResult("toolu_01", "ok"),
      { callTool: { name: "post", input: { text: "보고서입니다", files: ["report.md"] } } },
      ...script.textTurn("msg_2", ["끝났습니다"]),
    );

    const sent = await server.adapter.send(deliver(RUN_1), { providerSessionId: SESSION_ID });
    expect(sent).toEqual({ admission: "dispatch", providerRunId: RUN_1 });

    // 승인 카드가 서버에 뜬다 — 요약은 명령, 항상 허용 가능
    await waitFor(() => approvals(server).some((a) => a.status === "pending"), "승인 요청");
    const pending = approvals(server)[0]!;
    expect(pending).toMatchObject({
      providerApprovalId: `runner:${TOKEN_ID}:toolu_01`,
      kind: "tool",
      sessionKey: dodokSessionKey("coder", CHANNEL_ID),
      toolCallId: "toolu_01",
      toolName: "Bash",
      detail: "npm test",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    const resolved = await server.adapter.resolveApproval(pending.providerApprovalId, "tool", "allow-always");
    expect(resolved).toMatchObject({ status: "allowed", decision: "allow-always" });

    await waitFor(() => signals(server, RUN_1).includes("gateway_final"), "최종 답");
    expect(fake.calls[0]!.permissions).toEqual([
      {
        behavior: "allow",
        updatedInput: { command: "npm test" },
        updatedPermissions: [{ ...SUGGESTION, destination: "session" }],
      },
    ]);

    // post — 파일을 올리고, 런의 채널·에이전트·세션 그대로 어댑터를 통과해 메시지가 된다
    expect(runner.uploads).toEqual(["report.md"]);
    const [post, final] = server.outbound;
    expect(post!.message).toMatchObject({
      channelId: CHANNEL_ID,
      agentId: "coder",
      sessionKey: dodokSessionKey("coder", CHANNEL_ID),
      runId: RUN_1,
      text: "보고서입니다",
      attachmentIds: [UPLOADED],
    });
    expect(post!.message.outboundId).toMatch(/^runner-post:/);
    expect(fake.calls[0]!.toolResults).toEqual([
      { content: [{ type: "text", text: `보냈습니다(메시지 ${post!.messageId})` }] },
    ]);
    expect(server.events).toContainEqual({ kind: "canonical", message: post!.message });
    expect(final!.message).toMatchObject({
      outboundId: `runner-final:${RUN_1}`,
      text: "끝났습니다",
      runId: RUN_1,
    });
    expect(server.outbound).toHaveLength(2);

    expect(signals(server, RUN_1)).toEqual([
      "gateway_started",
      "text_delta",
      "tool_start",
      "tool_end",
      "text_delta",
      "gateway_final",
    ]);
    const types = runEvents(server, RUN_1).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]),
    );
    expect(runEvents(server, RUN_1).at(-1)).toMatchObject({ type: "CUSTOM", name: "dodok.usage" });
    expect(types).not.toContain("RUN_ERROR");
  });

  it("중지 — 떠 있던 승인은 철회로, 중지된 런의 post 는 보내지 않고, final aborted 는 메시지 없는 중지로(판정 R1)", async () => {
    const server = await startServer();
    cleanups.push(() => server.close());
    const fake = createFakeSdk();
    startRunner(server, fake);
    await ready(server);
    fake.script(
      script.init(),
      script.messageStart("msg_1"),
      script.blockStart(0, { type: "text", text: "" }),
      script.textDelta(0, "빌드합니다 "),
      script.blockStop(0),
      { askPermission: { toolName: "Bash", input: { command: "make" }, toolUseID: "toolu_02" } },
      // interrupt 뒤에도 CLI 가 도구를 부르는 경우 — 러너가 런 signal 을 보고 보내지 않는다
      { callTool: { name: "post", input: { text: "늦은 글" } } },
      { waitInterrupt: [script.errorResult("error_during_execution", ["interrupted"])] },
    );
    await server.adapter.send(deliver(RUN_2), { providerSessionId: SESSION_ID });
    await waitFor(() => approvals(server).some((a) => a.status === "pending"), "승인 요청");

    await server.adapter.abort(RUN_2, dodokSessionKey("coder", CHANNEL_ID));
    await waitFor(() => signals(server, RUN_2).includes("gateway_aborted"), "중지 신호");

    expect(fake.calls[0]!.interrupts).toBeGreaterThanOrEqual(1);
    expect(approvals(server).map((a) => a.status)).toEqual(["pending", "cancelled"]);
    expect(fake.calls[0]!.permissions).toEqual([{ behavior: "deny", message: "승인 요청이 철회됐습니다" }]);
    expect(fake.calls[0]!.toolResults).toEqual([
      { isError: true, content: [{ type: "text", text: POST_STOPPED_MESSAGE }] },
    ]);
    // 메시지 없는 중지 — 중간 답도 늦은 글도 채널에 가지 않는다
    expect(server.outbound).toEqual([]);
    expect(runEvents(server, RUN_2).filter((e) => e.type === "RUN_ABORTED")).toEqual([
      { type: "RUN_ABORTED", runId: RUN_2, by: "user" },
    ]);
    expect(signals(server, RUN_2).filter((s) => s === "gateway_final" || s === "gateway_error")).toEqual([]);
  });

  it("서버가 런을 닫은 뒤 run.abort 가 닿기 전에 나간 post 는 어댑터가 FORBIDDEN — 도구 결과로 돌아온다", async () => {
    const server = await startServer();
    cleanups.push(() => server.close());
    const fake = createFakeSdk();
    let releaseUpload!: () => void;
    const runner = startRunner(server, fake, { uploadGate: new Promise((r) => (releaseUpload = r)) });
    await ready(server);
    fake.script(
      script.init(),
      script.messageStart("msg_1"),
      { callTool: { name: "post", input: { text: "보고서", files: ["report.md"] } } },
      { waitInterrupt: [script.errorResult("error_during_execution", ["interrupted"])] },
    );
    await server.adapter.send(deliver(RUN_2), { providerSessionId: SESSION_ID });
    await waitFor(() => runner.uploads.length === 1, "올리기 시작");

    // 서버는 곧바로 런을 닫는다 — 같은 틱에 올리기를 풀면 러너는 run.abort 를 받기 전에 post 를 보낸다
    void server.adapter.abort(RUN_2, dodokSessionKey("coder", CHANNEL_ID));
    releaseUpload();
    await waitFor(() => fake.calls[0]!.toolResults.length === 1, "post 결과");
    await waitFor(() => signals(server, RUN_2).includes("gateway_aborted"), "중지 신호");

    expect(fake.calls[0]!.toolResults[0]).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "보내지 못했습니다(FORBIDDEN): post must belong to an open run of this runner",
        },
      ],
    });
    expect(server.outbound).toEqual([]);
  });

  it("승인 기한이 지나면 어댑터가 만료로 닫고, 러너는 「승인 시간이 지났습니다」로 거절해 런을 끝까지 간다(Review Focus 4)", async () => {
    const server = await startServer(0, { approvalTtlMs: 40 });
    cleanups.push(() => server.close());
    const fake = createFakeSdk();
    startRunner(server, fake);
    await ready(server);
    fake.script(
      script.init(),
      { askPermission: { toolName: "Bash", input: { command: "rm -rf build" }, toolUseID: "toolu_03" } },
      ...script.textTurn("msg_1", ["거절돼서 멈춥니다"]),
    );
    await server.adapter.send(deliver(RUN_1), { providerSessionId: SESSION_ID });
    await waitFor(() => signals(server, RUN_1).includes("gateway_final"), "최종 답");

    expect(approvals(server).map((a) => a.status)).toEqual(["pending", "expired"]);
    expect(fake.calls[0]!.permissions).toEqual([{ behavior: "deny", message: "승인 시간이 지났습니다" }]);
    expect(server.outbound.map((o) => o.message.text)).toEqual(["거절돼서 멈춥니다"]);
  });

  it("서버가 재시작하면(전송 끊김) 러너는 도는 런을 멈추고 같은 주소로 다시 붙는다", async () => {
    const first = await startServer();
    cleanups.push(() => first.close());
    const fake = createFakeSdk();
    const runner = startRunner(first, fake);
    await ready(first);
    fake.script(script.messageStart("msg_1"), { hang: true });
    await first.adapter.send(deliver(RUN_1), { providerSessionId: SESSION_ID });
    await waitFor(() => fake.calls.length === 1, "런 시작");

    await first.close();
    await waitFor(() => !runner.conn.connected, "러너 끊김");
    await waitFor(() => fake.calls[0]!.finished, "끊기면 런을 멈춘다");
    expect(fake.calls[0]!.interrupts).toBe(1);

    const second = await startServer(first.port);
    cleanups.push(() => second.close());
    await ready(second);
    expect(runner.conn.connected).toBe(true);
    expect(runner.fatal).toEqual([]);
    // 끊긴 연결에서 시작한 런의 final 은 새 연결로 새지 않는다(서버는 그 런을 이미 닫았다)
    await new Promise((r) => setTimeout(r, 60));
    expect(second.events.filter((e) => e.kind === "run_event" || e.kind === "run_signal")).toEqual([]);
  });

  it("같은 토큰으로 두 번째 러너가 붙으면 앞 러너는 교체되어 종료 코드 2 로 끝난다 — 뒤가 이어 받는다", async () => {
    const server = await startServer();
    cleanups.push(() => server.close());
    const a = startRunner(server, createFakeSdk());
    await ready(server);
    const fakeB = createFakeSdk();
    const b = startRunner(server, fakeB);
    await waitFor(() => a.fatal.length === 1, "앞 러너 종료");
    expect(a.fatal).toEqual([2]);
    expect(a.logs.join("\n")).toMatch(/같은 토큰으로 다른 러너가 붙었거나/);
    await waitFor(() => b.conn.connected && server.adapter.status().runners.connected === 1, "뒤 러너");
    // 뒤 러너가 그 에이전트를 받는다 — 런이 뒤 러너로 간다
    fakeB.script(...script.textTurn("msg_1", ["뒤 러너"]));
    await server.adapter.send(deliver(RUN_1), { providerSessionId: SESSION_ID });
    await waitFor(() => signals(server, RUN_1).includes("gateway_final"), "뒤 러너의 최종 답");
    expect(server.outbound.map((o) => o.message.text)).toEqual(["뒤 러너"]);
    // 앞 러너는 다시 붙지 않는다
    await new Promise((r) => setTimeout(r, 80));
    expect(a.conn.connected).toBe(false);
    expect(server.adapter.status().runners.connected).toBe(1);
  });
});
