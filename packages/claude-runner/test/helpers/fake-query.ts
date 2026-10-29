import type {
  CanUseTool,
  SdkMcpServer,
  SdkMcpTool,
  SdkMessage,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkUserMessage,
} from "../../src/drivers/claude/sdk";

/**
 * 대본 한 줄 — SDK 메시지이거나 흐름 제어.
 * - `{ throw }` 그 자리에서 반복자가 던진다(CLI 비정상 종료 흉내)
 * - `{ waitInterrupt }` interrupt() 가 불릴 때까지 멈췄다가 뒤의 메시지를 흘린다
 * - `{ hang }` close() 가 불릴 때까지 멈춘다(interrupt 에 반응하지 않는 CLI)
 * - `{ exit }` 입력이 닫히기를 기다리지 않고 곧바로 끝난다(result 없이 프로세스가 끝남)
 * - `{ sleep }` 그만큼 쉬었다가 뒤의 메시지를 흘린다(interrupt 뒤 턴을 닫는 데 걸리는 시간)
 * - `{ callTool }` dodok MCP 서버의 그 도구 handler 를 부르고 결과를 `toolResults` 에 적는다(CLI 가 SDK MCP 도구를 부름)
 * - `{ askPermission }` options.canUseTool 을 부르고 결과를 `permissions` 에 적는다. 콜백 signal 은 interrupt·close 에
 *   끊긴다(실제 SDK 는 CLI 의 control_cancel_request 를 받아 끊는다 — ADR 0007 4.2). `lateCancel` 이면 close 에만 끊긴다
 *   (CLI 가 취소를 늦게 보내는 경우)
 */
export type ScriptStep =
  | SdkMessage
  | { throw: Error }
  | { waitInterrupt: SdkMessage[] }
  | { hang: true }
  | { exit: true }
  | { sleep: number }
  | { callTool: { name: string; input: unknown } }
  | {
      askPermission: {
        toolName: string;
        input: Record<string, unknown>;
        toolUseID: string;
        suggestions?: Parameters<CanUseTool>[2]["suggestions"];
      };
    };

export type FakeToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
export type FakePermission = Awaited<ReturnType<CanUseTool>>;

export type FakeCall = {
  options: SdkOptions;
  prompt: SdkUserMessage | undefined;
  interrupts: number;
  closes: number;
  /** 대본을 다 흘린 뒤 입력(stdin)이 닫혔는가 — 러너가 런의 끝에서 입력을 닫아야 CLI 가 끝난다 */
  inputClosed: boolean;
  /** result 를 흘리는 순간 입력이 이미 끝나 있었는가 — 참이면 권한 콜백·SDK MCP 가 멈춘다(run.ts 입력 주석) */
  inputEndedBeforeResult: boolean;
  finished: boolean;
  toolResults: FakeToolResult[];
  permissions: FakePermission[];
};

export type FakeSdk = SdkPort & {
  calls: FakeCall[];
  /** 다음 query() 가 흘릴 대본 — 여러 번 부르면 순서대로 쓴다 */
  script(...steps: ScriptStep[]): void;
  sessions: Set<string>;
  servers: SdkMcpTool[][];
};

/** 테스트용 SDK 메시지 — 쓰는 필드만 채우고 SDK 타입으로 본다 */
export const sdkMsg = (m: Record<string, unknown>): SdkMessage => m as unknown as SdkMessage;

export function createFakeSdk(opts: { lateCancel?: boolean } = {}): FakeSdk {
  const scripts: ScriptStep[][] = [];
  const calls: FakeCall[] = [];
  const sessions = new Set<string>();
  const servers: SdkMcpTool[][] = [];

  function query(args: { prompt: AsyncIterable<SdkUserMessage>; options: SdkOptions }): SdkQuery {
    const steps = scripts.shift() ?? [];
    const call: FakeCall = {
      options: args.options,
      prompt: undefined,
      interrupts: 0,
      closes: 0,
      inputClosed: false,
      inputEndedBeforeResult: false,
      finished: false,
      toolResults: [],
      permissions: [],
    };
    calls.push(call);
    let onInterrupt: (() => void) | undefined;
    // 권한 콜백의 signal — interrupt·close 가 끊는다
    const permissionControllers = new Set<AbortController>();
    const cancelPermissions = () => {
      for (const c of permissionControllers) c.abort();
      permissionControllers.clear();
    };
    let onClose: (() => void) | undefined;
    let closed = false;
    const closedSignal = new Promise<void>((resolve) => (onClose = resolve));

    async function* run(): AsyncGenerator<SdkMessage> {
      const input = args.prompt[Symbol.asyncIterator]();
      const first = await input.next();
      if (!first.done) call.prompt = first.value;
      let inputEnded = false;
      const rest = input.next().then(() => void (inputEnded = true));
      try {
        for (const step of steps) {
          if (closed) return;
          if ("throw" in step) throw step.throw;
          if ("exit" in step) return;
          if ("sleep" in step) {
            await new Promise((r) => setTimeout(r, step.sleep));
            continue;
          }
          if ("hang" in step) {
            await closedSignal;
            return;
          }
          if ("callTool" in step) {
            const server = args.options.mcpServers?.dodok as unknown as { tools?: SdkMcpTool[] } | undefined;
            const found = server?.tools?.find((t) => t.name === step.callTool.name);
            if (!found) throw new Error(`fake: no dodok tool ${step.callTool.name}`);
            const handler = found.handler as (a: unknown, extra: unknown) => Promise<FakeToolResult>;
            call.toolResults.push(await handler(step.callTool.input, {}));
            continue;
          }
          if ("askPermission" in step) {
            const canUseTool = args.options.canUseTool;
            if (!canUseTool) throw new Error("fake: no canUseTool");
            const controller = new AbortController();
            permissionControllers.add(controller);
            const { toolName, input, toolUseID, suggestions } = step.askPermission;
            call.permissions.push(
              await canUseTool(toolName, input, {
                signal: controller.signal,
                toolUseID,
                requestId: `req-${toolUseID}`,
                ...(suggestions ? { suggestions } : {}),
              }),
            );
            permissionControllers.delete(controller);
            continue;
          }
          if ("waitInterrupt" in step) {
            // 앞 단계(권한 대기 등) 중에 이미 interrupt 됐으면 기다리지 않는다
            const interrupted =
              call.interrupts > 0
                ? Promise.resolve()
                : new Promise<void>((resolve) => (onInterrupt = resolve));
            await Promise.race([interrupted, closedSignal]);
            if (closed) return;
            for (const m of step.waitInterrupt) yield m;
            continue;
          }
          if ((step as { type?: string }).type === "result" && inputEnded) call.inputEndedBeforeResult = true;
          yield step as SdkMessage;
        }
        // 실제 CLI 는 stdin 이 닫혀야 끝난다 — 러너가 입력을 닫지 않으면 여기서 멈춘다
        await Promise.race([rest, closedSignal]);
        call.inputClosed = !closed;
      } finally {
        call.finished = true;
      }
    }

    const gen = run();
    return {
      [Symbol.asyncIterator]: () => gen,
      interrupt: async () => {
        call.interrupts += 1;
        if (!opts.lateCancel) cancelPermissions();
        onInterrupt?.();
      },
      close: () => {
        call.closes += 1;
        closed = true;
        cancelPermissions();
        onClose?.();
      },
    };
  }

  return {
    calls,
    sessions,
    servers,
    script: (...steps) => void scripts.push(steps),
    query,
    sessionExists: async (sessionId) => sessions.has(sessionId),
    createMcpServer: (tools) => {
      servers.push(tools);
      // tools 는 가짜만 싣는다 — callTool 단계가 handler 를 찾는다
      return { type: "sdk", name: "dodok", instance: {}, tools } as unknown as SdkMcpServer;
    },
  };
}

/** 대본 조각 — ADR 0007 4.1 의 턴 하나 모양 */
export const script = {
  init: (apiKeySource = "none") => sdkMsg({ type: "system", subtype: "init", apiKeySource }),
  messageStart: (id: string) =>
    sdkMsg({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id } },
    }),
  blockStart: (index: number, block: Record<string, unknown>) =>
    sdkMsg({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index, content_block: block },
    }),
  textDelta: (index: number, text: string) =>
    sdkMsg({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    }),
  jsonDelta: (index: number, partial_json: string) =>
    sdkMsg({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } },
    }),
  blockStop: (index: number) =>
    sdkMsg({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index } }),
  messageStop: () =>
    sdkMsg({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } }),
  toolResult: (toolUseId: string, content: unknown, isError = false) =>
    sdkMsg({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
    }),
  success: (result: string, extra: Record<string, unknown> = {}) =>
    sdkMsg({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...extra,
    }),
  errorResult: (subtype: string, errors: string[], extra: Record<string, unknown> = {}) =>
    sdkMsg({
      type: "result",
      subtype,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      errors,
      ...extra,
    }),
  /** 텍스트 답 한 턴 — message_start 부터 result 까지 */
  textTurn: (
    messageId: string,
    chunks: string[],
    result = chunks.join(""),
    extra: Record<string, unknown> = {},
  ) => [
    script.messageStart(messageId),
    script.blockStart(0, { type: "text", text: "" }),
    ...chunks.map((c) => script.textDelta(0, c)),
    script.blockStop(0),
    script.messageStop(),
    script.success(result, extra),
  ],
};
