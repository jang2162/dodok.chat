import type {
  SdkMcpServer,
  SdkMcpTool,
  SdkMessage,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkUserMessage,
} from "../../src/sdk";

/**
 * 대본 한 줄 — SDK 메시지이거나 흐름 제어.
 * - `{ throw }` 그 자리에서 반복자가 던진다(CLI 비정상 종료 흉내)
 * - `{ waitInterrupt }` interrupt() 가 불릴 때까지 멈췄다가 뒤의 메시지를 흘린다
 * - `{ hang }` close() 가 불릴 때까지 멈춘다(interrupt 에 반응하지 않는 CLI)
 * - `{ exit }` 입력이 닫히기를 기다리지 않고 곧바로 끝난다(result 없이 프로세스가 끝남)
 */
export type ScriptStep =
  | SdkMessage
  | { throw: Error }
  | { waitInterrupt: SdkMessage[] }
  | { hang: true }
  | { exit: true };

export type FakeCall = {
  options: SdkOptions;
  prompt: SdkUserMessage | undefined;
  interrupts: number;
  closes: number;
  /** 대본을 다 흘린 뒤 입력(stdin)이 닫혔는가 — 러너가 런의 끝에서 입력을 닫아야 CLI 가 끝난다 */
  inputClosed: boolean;
  finished: boolean;
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

export function createFakeSdk(): FakeSdk {
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
      finished: false,
    };
    calls.push(call);
    let onInterrupt: (() => void) | undefined;
    let onClose: (() => void) | undefined;
    let closed = false;
    const closedSignal = new Promise<void>((resolve) => (onClose = resolve));

    async function* run(): AsyncGenerator<SdkMessage> {
      const input = args.prompt[Symbol.asyncIterator]();
      const first = await input.next();
      if (!first.done) call.prompt = first.value;
      try {
        for (const step of steps) {
          if (closed) return;
          if ("throw" in step) throw step.throw;
          if ("exit" in step) return;
          if ("hang" in step) {
            await closedSignal;
            return;
          }
          if ("waitInterrupt" in step) {
            const interrupted = new Promise<void>((resolve) => (onInterrupt = resolve));
            await Promise.race([interrupted, closedSignal]);
            if (closed) return;
            for (const m of step.waitInterrupt) yield m;
            continue;
          }
          yield step as SdkMessage;
        }
        // 실제 CLI 는 stdin 이 닫혀야 끝난다 — 러너가 입력을 닫지 않으면 여기서 멈춘다
        await Promise.race([input.next(), closedSignal]);
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
        onInterrupt?.();
      },
      close: () => {
        call.closes += 1;
        closed = true;
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
      return { type: "sdk", name: "dodok", instance: {} } as unknown as SdkMcpServer;
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
