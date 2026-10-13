import {
  CONTROL_CALL_TIMEOUT_MS,
  CONTROL_RESULT_UNKNOWN_MESSAGE,
  CONTROL_TOOLS,
  type RunnerControlCall,
} from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { createRunBridge } from "../src/connection";
import { CONTROL_TOOL_FULL_NAMES, type ControlCallOutcome, createControlTools } from "../src/control-tools";
import { createDodokMcpServer } from "../src/post-tool";
import { buildQueryOptions, RUNNER_DISALLOWED_TOOLS, runOnce, type RunContext } from "../src/run";
import type { SdkMcpServer, SdkMcpTool } from "../src/sdk";
import { createFakeBridge, type FakeBridge } from "./helpers/fake-bridge";
import { createFakeSdk, script, type FakeSdk } from "./helpers/fake-query";
import { AGENT, RUN_ID, runStart } from "./helpers/fixtures";

const RUN_2 = "0192f000-0000-7000-8000-00000000a002";
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const call = (t: SdkMcpTool, args: unknown) =>
  (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});

function toolsOf(outcome: (c: RunnerControlCall) => ControlCallOutcome = () => ({ ok: true, data: null })) {
  const bridge = createFakeBridge({ control: outcome });
  const tools = createControlTools({ runId: RUN_ID, call: (c) => bridge.control(c), newId: () => "call-1" });
  return { bridge, tools, find: (name: string) => tools.find((t) => t.name === name)! };
}

function harness(fake: FakeSdk, bridge: FakeBridge): RunContext {
  return {
    sdk: fake,
    bridge,
    agent: AGENT,
    claudeConfigDir: "/home/u/.dodok-runner/claude",
    baseEnv: { PATH: "/usr/bin" },
    costs: new Map(),
    signal: new AbortController().signal,
    closeGraceMs: 30,
    emit: { event: () => {}, final: () => {}, error: () => {} },
  };
}

describe("제어 도구 — dodok MCP 서버에 CONTROL_TOOLS 전부", () => {
  it("모델에게는 mcp__dodok__<tool> 로 전부 노출되고 입력 모양은 shared 스키마 그대로", () => {
    const fake = createFakeSdk();
    const { tools } = toolsOf();
    createDodokMcpServer({ sdk: fake, post: async () => ({ messageId: "m" }), tools });
    const names = fake.servers[0]!.map((t) => t.name);
    expect(names).toEqual(["post", ...CONTROL_TOOLS.map((t) => t.name)]);
    expect(CONTROL_TOOL_FULL_NAMES).toEqual(CONTROL_TOOLS.map((t) => `mcp__dodok__${t.name}`));
    for (const tool of CONTROL_TOOLS) {
      const found = tools.find((t) => t.name === tool.name)!;
      expect(found.description).toBe(tool.description);
      expect(found.inputSchema).toBe(tool.input.shape);
    }
  });

  it("호출하면 control.call {callId, runId, tool, args} — 성공은 data 의 JSON", async () => {
    const { bridge, find } = toolsOf(() => ({ ok: true, data: { channels: [{ name: "dev" }] } }));
    const out = await call(find("list_channels"), { archived: true });
    expect(bridge.controls).toEqual([
      { callId: "call-1", runId: RUN_ID, tool: "list_channels", args: { archived: true } },
    ]);
    expect(out).toEqual({
      content: [{ type: "text", text: JSON.stringify({ channels: [{ name: "dev" }] }) }],
    });
  });

  it("서버가 ok:false 면 isError + 그 코드·문구(던지지 않는다)", async () => {
    const { find } = toolsOf(() => ({
      ok: false,
      error: { code: "FORBIDDEN", message: "이 일은 admin 이상만 할 수 있습니다(시킨 사람: @mia, member)" },
    }));
    const out = await call(find("set_channel_prompt"), { channelId: RUN_ID, prompt: "x" });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0]!.text)).toEqual({
      code: "FORBIDDEN",
      message: "이 일은 admin 이상만 할 수 있습니다(시킨 사람: @mia, member)",
    });
  });

  it("답을 못 받은 호출은 실패가 아니라 「결과를 모른다」", async () => {
    const { find } = toolsOf(() => ({ unknown: true }));
    const out = await call(find("update_channel"), { channelId: RUN_ID, name: "ops" });
    expect(out).toEqual({ isError: true, content: [{ type: "text", text: CONTROL_RESULT_UNKNOWN_MESSAGE }] });
  });

  it("막는 도구 목록에 제어 도구가 없고, 허용 목록에는 전부 있다 — 쓰기는 서버 확인 카드가 묻는다", () => {
    for (const name of CONTROL_TOOL_FULL_NAMES) expect(RUNNER_DISALLOWED_TOOLS).not.toContain(name);
    const o = buildQueryOptions(AGENT, runStart(), {
      claudeConfigDir: "/c",
      baseEnv: {},
      mcpServer: {} as SdkMcpServer,
      resume: false,
    });
    for (const name of CONTROL_TOOL_FULL_NAMES) {
      expect(o.allowedTools).toContain(name);
      expect(o.disallowedTools).not.toContain(name);
    }
  });
});

describe("runOnce — 제어 도구는 지금 런의 runId 를 싣는다", () => {
  it("같은 세션의 다음 런이 그 사이에 열렸어도 앞 런의 호출은 앞 런의 runId(Review Focus 4)", async () => {
    const fake = createFakeSdk();
    const bridge = createFakeBridge();
    // 첫 런은 잠깐 쉬었다가 도구를 부른다 — 그 사이 같은 세션의 둘째 런이 시작해 도구를 부르고 끝난다
    fake.script(
      script.init(),
      { sleep: 60 },
      { callTool: { name: "get_channel", input: { channelId: RUN_ID } } },
      ...script.textTurn("msg_1", ["끝"]),
    );
    fake.script(
      script.init(),
      { callTool: { name: "get_run", input: { runId: RUN_ID } } },
      ...script.textTurn("msg_2", ["끝"]),
    );
    const first = runOnce(runStart(), harness(fake, bridge));
    await new Promise((r) => setTimeout(r, 10));
    await runOnce(runStart({ runId: RUN_2 }), harness(fake, bridge));
    await first;
    expect(bridge.controls.map((c) => [c.tool, c.runId])).toEqual([
      ["get_run", RUN_2],
      ["get_channel", RUN_ID],
    ]);
    expect(fake.calls[0]!.toolResults).toEqual([{ content: [{ type: "text", text: "null" }] }]);
  });
});

describe("createRunBridge.control — 끊김·시간 초과는 「결과를 모른다」", () => {
  const http = {
    upload: async () => {
      throw new Error("not used");
    },
    download: async () => {
      throw new Error("not used");
    },
  };
  const controlCall: RunnerControlCall = { callId: "c1", runId: RUN_ID, tool: "list_channels", args: {} };

  function fakeSocket(reply: () => Promise<unknown>) {
    const timeouts: number[] = [];
    const sent: Array<[string, unknown]> = [];
    const socket = {
      emit: () => true,
      timeout: (ms: number) => {
        timeouts.push(ms);
        return {
          emitWithAck: async (event: string, payload: unknown) => {
            sent.push([event, payload]);
            return reply();
          },
        };
      },
    };
    return { socket: socket as never, timeouts, sent };
  }

  it("ack 를 shared CONTROL_CALL_TIMEOUT_MS(카드 기한 + 여유)까지 기다린다 — 짧은 기본값이 없다", async () => {
    const f = fakeSocket(async () => ({ ok: true, data: [] }));
    const bridge = createRunBridge({ socket: f.socket, live: () => true, http, decisions: new Map() });
    expect(await bridge.control(controlCall)).toEqual({ ok: true, data: [] });
    expect(f.sent).toEqual([["control.call", controlCall]]);
    expect(f.timeouts).toEqual([CONTROL_CALL_TIMEOUT_MS]);
  });

  it("보내기 전에 끊겨 있었으면 ADAPTER_UNAVAILABLE — 서버에 닿지 않았으니 실패로 알린다", async () => {
    const f = fakeSocket(async () => ({ ok: true, data: [] }));
    const bridge = createRunBridge({ socket: f.socket, live: () => false, http, decisions: new Map() });
    expect(await bridge.control(controlCall)).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    expect(f.sent).toEqual([]);
  });

  it("보낸 뒤 끊김(socket.io-client 의 거절)·시간 초과면 unknown", async () => {
    for (const message of ["socket has been disconnected", "operation has timed out"]) {
      const f = fakeSocket(async () => {
        throw new Error(message);
      });
      const bridge = createRunBridge({ socket: f.socket, live: () => true, http, decisions: new Map() });
      expect(await bridge.control(controlCall)).toEqual({ unknown: true });
    }
  });

  it("계약과 다른 ack 는 INTERNAL", async () => {
    const f = fakeSocket(async () => ({ ok: "yes" }));
    const bridge = createRunBridge({ socket: f.socket, live: () => true, http, decisions: new Map() });
    expect(await bridge.control(controlCall)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});
