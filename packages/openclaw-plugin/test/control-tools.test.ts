import { readFileSync } from "node:fs";
import {
  type BridgeControlCall,
  CONTROL_RESULT_UNKNOWN_MESSAGE,
  CONTROL_TOOLS,
  type ControlResult,
  type ControlUnknownResult,
  controlToolJsonSchema,
} from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeClient } from "../src/bridge-client";
import { registerBridge, releaseBridge, setCorrelation } from "../src/bridge-registry";
import {
  CONTROL_PLUGIN_TOOL_NAMES,
  CONTROL_TOOL_PREFIX,
  type ControlAgentTool,
  createControlToolFactory,
} from "../src/control-tools";
// 진입점은 SDK(channel-core)를 불러 무겁다 — 테스트 제한시간 밖에서 불러 둔다
import entry from "../src/index";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
const RUN_1 = "01a09fc9-d204-7551-89d6-38544d07a301";
const RUN_2 = "01a09fc9-d204-7551-89d6-38544d07a302";
// 다른 테스트 파일과 레지스트리(globalThis)를 나눠 쓰므로 이 파일만의 에이전트 id 로 세션 키를 만든다
const CHANNEL_KEY = `agent:ctl:dodok:channel:${CH}`;
const THREAD_KEY = `${CHANNEL_KEY}:thread:${ROOT}`;

let sent: BridgeControlCall[];
let reply: () => Promise<ControlResult | ControlUnknownResult>;
let bridge: BridgeClient;

beforeEach(() => {
  sent = [];
  reply = async () => ({ ok: true, data: { channels: [] } });
  bridge = {
    sendControl: async (call: BridgeControlCall) => {
      sent.push(call);
      return reply();
    },
  } as unknown as BridgeClient;
  registerBridge("default", bridge);
});

afterEach(() => {
  releaseBridge("default", bridge);
});

const factory = createControlToolFactory({ newId: () => "call-1" });
const toolOf = (tools: ControlAgentTool[] | null, name: string) =>
  tools!.find((t) => t.name === CONTROL_TOOL_PREFIX + name)!;

describe("제어 도구 팩토리 — dodok 세션에서만", () => {
  it("dodok 세션 키가 아니면(다른 채널·세션 문맥 없음) 도구를 내지 않는다", () => {
    expect(factory({})).toBeNull();
    expect(factory({ sessionKey: "agent:main:telegram:group:123" })).toBeNull();
    expect(factory({ sessionKey: "agent:main:main" })).toBeNull();
  });

  it("dodok 채널·스레드 세션이면 CONTROL_TOOLS 전부 — 이름은 dodok_ 접두, 설명·JSON Schema 는 shared 그대로", () => {
    for (const sessionKey of [CHANNEL_KEY, THREAD_KEY]) {
      const tools = factory({ sessionKey })!;
      expect(tools.map((t) => t.name)).toEqual(CONTROL_TOOLS.map((t) => `dodok_${t.name}`));
      for (const tool of CONTROL_TOOLS) {
        const found = toolOf(tools, tool.name);
        expect(found.description).toBe(tool.description);
        expect(found.parameters).toEqual(controlToolJsonSchema(tool));
        expect(found.label).toBeTruthy();
      }
    }
    expect(CONTROL_PLUGIN_TOOL_NAMES).toEqual(CONTROL_TOOLS.map((t) => `dodok_${t.name}`));
    // 세션 대화 id 를 얻는 길 — read_messages 가 conversationId 를 요구한다
    expect(CONTROL_PLUGIN_TOOL_NAMES).toContain("dodok_list_conversations");
  });

  it("매니페스트 contracts.tools 가 도구 이름과 같다 — 선언하지 않은 이름은 Gateway 가 등록을 거절한다", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.contracts.tools).toEqual([...CONTROL_PLUGIN_TOOL_NAMES]);
  });
});

describe("플러그인 진입점 — registerTool", () => {
  it("full·tool-discovery 등록에서 팩토리를 매니페스트와 같은 names 로 등록한다", () => {
    for (const registrationMode of ["full", "tool-discovery"]) {
      const registered: Array<{ tool: unknown; opts: unknown }> = [];
      entry.register({
        registrationMode,
        runtime: {},
        registerChannel: () => undefined,
        registerTool: (tool: unknown, opts: unknown) => void registered.push({ tool, opts }),
      } as never);
      expect(registered).toHaveLength(1);
      expect(registered[0]!.opts).toEqual({ names: [...CONTROL_PLUGIN_TOOL_NAMES] });
      const make = registered[0]!.tool as (ctx: { sessionKey?: string }) => ControlAgentTool[] | null;
      expect(make({ sessionKey: CHANNEL_KEY })?.map((t) => t.name)).toEqual([...CONTROL_PLUGIN_TOOL_NAMES]);
      expect(make({ sessionKey: "agent:main:main" })).toBeNull();
    }
  });
});

describe("제어 도구 실행 — control.call", () => {
  it("control.call {callId, sessionKey, runId: 그 세션 상관관계의 runId, tool: 접두 없는 이름, args} (Review Focus 4)", async () => {
    setCorrelation(THREAD_KEY, { runId: RUN_1, replyToInboundId: ROOT });
    const tool = toolOf(factory({ sessionKey: THREAD_KEY }), "get_channel");
    const out = await tool.execute("tc1", { channelId: CH });
    expect(sent).toEqual([
      {
        callId: "call-1",
        sessionKey: THREAD_KEY,
        runId: RUN_1,
        tool: "get_channel",
        args: { channelId: CH },
      },
    ]);
    expect(out).toEqual({
      content: [{ type: "text", text: JSON.stringify({ channels: [] }) }],
      details: { ok: true },
    });
  });

  it("객체가 아닌 params(배열·null·원시값)는 args {} 로 보낸다 — 서버 Zod 가 그 도구의 필드로 거른다", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1, replyToInboundId: ROOT });
    const tool = toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels");
    for (const params of [[1], null, "x", 7]) await tool.execute("tc1", params as never);
    expect(sent.map((call) => call.args)).toEqual([{}, {}, {}, {}]);
  });

  const callWith = async (tool: ControlAgentTool, hostRunId: string | undefined, id = "tc1") => {
    await tool.prepareBeforeToolCallParams(
      {},
      { toolCallId: id, hookContext: hostRunId === undefined ? undefined : { runId: hostRunId } },
    );
    return tool.execute(id, {});
  };

  it("같은 OpenClaw 런이면 보낸다 — runId 는 실행할 때의 상관관계(providerRunId 가 있으면 그것과 대조)", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1, providerRunId: "host-1" });
    const tool = toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels");
    setCorrelation(CHANNEL_KEY, { runId: RUN_2, providerRunId: "host-2" });
    await callWith(tool, "host-2");
    expect(sent.map((c) => c.runId)).toEqual([RUN_2]);
  });

  it("providerRunId 가 없으면 runId 와 대조한다", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1 });
    const tool = toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels");
    await callWith(tool, RUN_1);
    expect(sent).toHaveLength(1);
  });

  it("다른 OpenClaw 런의 늦은 호출은 보내지 않고 EXPIRED — 서버가 닫은 런이 같은 세션 다음 런의 권한을 빌리지 못하게(t5 리뷰 R1)", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1, providerRunId: "host-1" });
    const tool = toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels");
    setCorrelation(CHANNEL_KEY, { runId: RUN_2, providerRunId: "host-2" });
    const out = await callWith(tool, "host-1");
    expect(sent).toEqual([]);
    expect(out.details).toEqual({ ok: false, code: "EXPIRED" });
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ message: "이 런은 dodok 에서 이미 끝났습니다" });
  });

  it("hookContext.runId 가 없으면 대조하지 않고 보낸다(호환)", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1, providerRunId: "host-1" });
    const tool = toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels");
    await callWith(tool, undefined);
    await tool.execute("never-prepared", {});
    expect(sent).toHaveLength(2);
  });

  it("훅이 잡은 런 id 는 한 호출에만 쓰인다 — 다음 호출(같은 toolCallId)로 새지 않는다", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1, providerRunId: "host-1" });
    const tool = toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels");
    await callWith(tool, "host-old");
    expect(sent).toEqual([]);
    await tool.execute("tc1", {});
    expect(sent).toHaveLength(1);
  });

  it("상관관계가 없으면(dodok 인바운드 없이 돈 런) 보내지 않고 오류 결과", async () => {
    const key = `agent:ctl-none:dodok:channel:${CH}`;
    const out = await toolOf(factory({ sessionKey: key }), "list_channels").execute("tc1", {});
    expect(sent).toEqual([]);
    expect(out.details).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("브리지가 없으면(globalThis 레지스트리에 없음) 오류 결과 — 던지지 않는다", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1 });
    releaseBridge("default", bridge);
    const out = await toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels").execute("tc1", {});
    expect(out.details).toEqual({ ok: false, code: "ADAPTER_UNAVAILABLE" });
  });

  it("계정은 도구 문맥의 agentAccountId — 그 계정의 브리지로 보낸다", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1 });
    const other: BridgeControlCall[] = [];
    const office = {
      sendControl: async (call: BridgeControlCall) => {
        other.push(call);
        return { ok: true as const, data: null };
      },
    } as unknown as BridgeClient;
    registerBridge("office", office);
    try {
      await toolOf(factory({ sessionKey: CHANNEL_KEY, agentAccountId: "office" }), "list_channels").execute(
        "tc1",
        {},
      );
    } finally {
      releaseBridge("office", office);
    }
    expect(other).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("서버가 ok:false 면 그 코드·문구, details.ok false(Gateway 가 오류로 본다)", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1 });
    reply = async () => ({ ok: false, error: { code: "FORBIDDEN", message: "@mia 가 거절했습니다" } });
    const out = await toolOf(factory({ sessionKey: CHANNEL_KEY }), "set_channel_prompt").execute("tc1", {
      channelId: CH,
      prompt: "규칙",
    });
    expect(out).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ code: "FORBIDDEN", message: "@mia 가 거절했습니다" }) },
      ],
      details: { ok: false, code: "FORBIDDEN" },
    });
  });

  it("답을 못 받은 호출(끊김·시간 초과)은 「결과를 모른다」 — 실패 코드가 아니다(태스크 4 리뷰 L2)", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_1 });
    reply = async () => ({ unknown: true });
    const out = await toolOf(factory({ sessionKey: CHANNEL_KEY }), "update_channel").execute("tc1", {
      channelId: CH,
      name: "ops",
    });
    expect(out).toEqual({
      content: [{ type: "text", text: CONTROL_RESULT_UNKNOWN_MESSAGE }],
      details: { ok: false },
    });
  });

  it("런이 이미 멈췄으면(signal aborted) 보내지 않는다 — 늦은 호출이 다음 인바운드의 runId 를 집지 않게", async () => {
    setCorrelation(CHANNEL_KEY, { runId: RUN_2 });
    const controller = new AbortController();
    controller.abort();
    const out = await toolOf(factory({ sessionKey: CHANNEL_KEY }), "list_channels").execute(
      "tc1",
      {},
      controller.signal,
    );
    expect(sent).toEqual([]);
    expect(out.details).toEqual({ ok: false, code: "EXPIRED" });
  });
});
