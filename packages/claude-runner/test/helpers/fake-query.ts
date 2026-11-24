import type {
  CanUseTool,
  SdkContextUsage,
  SdkMcpServer,
  SdkMcpTool,
  SdkMessage,
  SdkModelInfo,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkSlashCommand,
  SdkUserMessage,
} from "../../src/drivers/claude/sdk";

/**
 * 대본 한 줄 — SDK 메시지이거나 흐름 제어.
 * - `{ throw }` 그 자리에서 반복자가 던진다(CLI 비정상 종료 흉내)
 * - `{ waitInterrupt }` interrupt() 가 불릴 때까지 멈췄다가 뒤의 메시지를 흘린다
 * - `{ hang }` close() 가 불릴 때까지 멈춘다(interrupt 에 반응하지 않는 CLI)
 * - `{ exit }` 입력이 닫히기를 기다리지 않고 곧바로 끝난다(result 없이 프로세스가 끝남)
 * - `{ sleep }` 그만큼 쉬었다가 뒤의 메시지를 흘린다(interrupt 뒤 턴을 닫는 데 걸리는 시간)
 * - `{ waitInput }` 다음 사용자 입력을 기다렸다가 `prompts` 에 적고 뒤를 흘린다(붙든 프로세스의 다음 턴). 입력이 닫히면 끝난다
 * - `{ waitStopTask }` 그 작업의 stopTask() 를 기다렸다가 then 을 흘린다(끈 작업의 알림)
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
  | { waitInput: true }
  | { waitStopTask: string; then: SdkMessage[] }
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
  /** 받은 사용자 입력 전부 — 첫 것이 prompt */
  prompts: SdkUserMessage[];
  /** 붙든 프로세스 제어(setModel·setPermissionMode·applyFlagSettings·setMcpServers·stopTask) — 부른 차례 */
  controls: Array<{ method: string; arg: unknown }>;
  /** 입력을 받은 순간마다 그때까지의 controls 수 — 설정을 턴 전에 바꿨는지 본다 */
  controlsAtPrompt: number[];
  interrupts: number;
  closes: number;
  /** 대본을 다 흘린 뒤 입력(stdin)이 닫혔는가 — 러너가 런의 끝에서 입력을 닫아야 CLI 가 끝난다 */
  inputClosed: boolean;
  /** result 를 흘리는 순간 입력이 이미 끝나 있었는가 — 참이면 권한 콜백·SDK MCP 가 멈춘다(run.ts 입력 주석) */
  inputEndedBeforeResult: boolean;
  finished: boolean;
  toolResults: FakeToolResult[];
  permissions: FakePermission[];
  /** getContextUsage 를 부른 인자 — 부를 때마다 하나 */
  contextUsageCalls: Array<{ detail?: "summary" | "full" } | undefined>;
  /** 런의 query 에서 supportedCommands() 를 부른 수 — 답은 FakeSdk.commands */
  supportedCommandsCalls: number;
};

export type FakeSdk = SdkPort & {
  calls: FakeCall[];
  /** 다음 query() 가 흘릴 대본 — 여러 번 부르면 순서대로 쓴다 */
  script(...steps: ScriptStep[]): void;
  sessions: Set<string>;
  servers: SdkMcpTool[][];
  /**
   * getContextUsage 의 답 — 시험이 바꿔 끼운다(멈춤·던짐). 기본은 FAKE_CONTEXT_USAGE. 실제 CLI 처럼 입력(stdin)이 닫힌 뒤
   * 부르면 던진다 — 러너가 입력을 닫기 전에 물어야 한다
   */
  contextUsage: (call: FakeCall) => Promise<SdkContextUsage>;
  /** listModels 의 답 — 시험이 바꿔 끼운다(던짐·멈춤). 기본은 FAKE_MODELS */
  models: (options: SdkOptions) => Promise<SdkModelInfo[]>;
  /** listModels 를 부른 options — 부를 때마다 하나(CLI 를 몇 번 띄웠나) */
  listModelsCalls: SdkOptions[];
  /** listCommands 의 답 — 시험이 바꿔 끼운다. 기본은 FAKE_COMMANDS */
  commands: (options: SdkOptions) => Promise<SdkSlashCommand[]>;
  /** listCommands 를 부른 options */
  listCommandsCalls: SdkOptions[];
};

/** 가짜 supportedCommands() 의 기본 답 — 스파이크 2절의 꼴(내장은 builtin, 사람 것은 플러그인 접두사·설명 앞 `(이름) `) */
export const FAKE_COMMANDS = [
  {
    name: "compact",
    description: "Clear conversation history but keep a summary",
    argumentHint: "<instructions>",
    builtin: true,
  },
  { name: "login", description: "Sign in", argumentHint: "", builtin: true },
  { name: "insights", description: "Summarize your sessions", argumentHint: "", builtin: true },
  { name: "model", description: "Set the AI model", argumentHint: "[model]", builtin: true },
  { name: "user:user-cmd", description: "(user) SPIKE user command desc", argumentHint: "<topic>" },
  {
    name: "user:user-skill",
    description: "(user) SPIKE user skill desc",
    argumentHint: "<thing>",
    aliases: ["user-skill"],
  },
  { name: "project:proj-cmd", description: "(project) SPIKE project command desc", argumentHint: "" },
] as SdkSlashCommand[];

/** 가짜 supportedModels() 의 기본 답 — 실제 응답처럼 description 등 계약에 없는 필드도 싣는다 */
export const FAKE_MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Most capable",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    displayName: "Sonnet 5.5",
    description: "Everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  { value: "haiku", displayName: "Haiku 5.5", description: "Fastest" },
] as SdkModelInfo[];

/** 가짜 getContextUsage 의 기본 답 — 실제 응답처럼 줄별 목록(memoryFiles·mcpTools·gridRows …)도 싣는다 */
export const FAKE_CONTEXT_USAGE = {
  categories: [
    { name: "System prompt", tokens: 3_100, color: "promptBorder", kind: "used" },
    { name: "System tools", tokens: 17_600, color: "inactive", kind: "used" },
    { name: "Messages", tokens: 215_200, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Free space", tokens: 518_400, color: "promptBorder", kind: "free" },
    { name: "Autocompact buffer", tokens: 33_000, color: "inactive", kind: "buffer" },
    {
      name: "MCP tools",
      tokens: 21_900,
      color: "cyan_FOR_SUBAGENTS_ONLY",
      isDeferred: true,
      kind: "deferred",
    },
  ],
  totalTokens: 235_900,
  maxTokens: 800_000,
  rawMaxTokens: 800_000,
  percentage: 29.4875,
  gridRows: [
    [{ color: "x", isFilled: true, categoryName: "Messages", tokens: 1, percentage: 1, squareFullness: 1 }],
  ],
  model: "claude-opus-5-5",
  memoryFiles: [{ path: "/home/u/repo/CLAUDE.md", type: "Project", tokens: 900 }],
  mcpTools: [{ name: "mcp__dodok__post", serverName: "dodok", tokens: 400, isLoaded: true }],
  agents: [{ agentType: "general-purpose", source: "built-in", tokens: 100 }],
  isAutoCompactEnabled: true,
  apiUsage: null,
} as unknown as SdkContextUsage;

/** 테스트용 SDK 메시지 — 쓰는 필드만 채우고 SDK 타입으로 본다 */
export const sdkMsg = (m: Record<string, unknown>): SdkMessage => m as unknown as SdkMessage;

/**
 * - `lateCancel` 권한 콜백 signal 을 close 에만 끊는다(CLI 가 취소를 늦게 보내는 경우)
 * - `eagerInput` query() 안에서 곧바로 입력의 첫 `next()` 를 부른다 — 실제 SDK 가 옵션이 단순한 query 에서 그렇게 한다(재리뷰
 *   N2 실측). 기본은 결과를 돌 때에야 입력을 당긴다
 */
export function createFakeSdk(opts: { lateCancel?: boolean; eagerInput?: boolean } = {}): FakeSdk {
  const scripts: ScriptStep[][] = [];
  const calls: FakeCall[] = [];
  const sessions = new Set<string>();
  const servers: SdkMcpTool[][] = [];
  const fake = {
    contextUsage: async (_call: FakeCall): Promise<SdkContextUsage> => FAKE_CONTEXT_USAGE,
    models: async (_options: SdkOptions): Promise<SdkModelInfo[]> => FAKE_MODELS,
    listModelsCalls: [] as SdkOptions[],
    commands: async (_options: SdkOptions): Promise<SdkSlashCommand[]> => FAKE_COMMANDS,
    listCommandsCalls: [] as SdkOptions[],
  };

  function query(args: { prompt: AsyncIterable<SdkUserMessage>; options: SdkOptions }): SdkQuery {
    const steps = scripts.shift() ?? [];
    const call: FakeCall = {
      options: args.options,
      prompt: undefined,
      prompts: [],
      controls: [],
      controlsAtPrompt: [],
      interrupts: 0,
      closes: 0,
      inputClosed: false,
      inputEndedBeforeResult: false,
      finished: false,
      toolResults: [],
      permissions: [],
      contextUsageCalls: [],
      supportedCommandsCalls: 0,
    };
    calls.push(call);
    let inputEnded = false;
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
    const stopWaiters = new Map<string, () => void>();

    const input = args.prompt[Symbol.asyncIterator]();
    const eagerFirst = opts.eagerInput ? input.next() : undefined;
    async function* run(): AsyncGenerator<SdkMessage> {
      const first = await (eagerFirst ?? input.next());
      if (!first.done) {
        call.prompt = first.value;
        call.prompts.push(first.value);
        call.controlsAtPrompt.push(call.controls.length);
      }
      // 다음 입력 — 값이면 waitInput 이 받고, 끝(done)이면 입력이 닫혔다
      let pending = first.done ? Promise.resolve(first) : input.next();
      const watch = (p: Promise<IteratorResult<SdkUserMessage>>) =>
        p.then((r) => {
          if (r.done) inputEnded = true;
          return r;
        });
      let next = watch(pending);
      try {
        for (const step of steps) {
          if (closed) return;
          if ("throw" in step) throw step.throw;
          if ("exit" in step) return;
          if ("sleep" in step) {
            await new Promise((r) => setTimeout(r, step.sleep));
            continue;
          }
          if ("waitInput" in step) {
            const r = await Promise.race([next, closedSignal.then(() => undefined)]);
            if (!r || r.done) return;
            call.prompts.push(r.value);
            call.controlsAtPrompt.push(call.controls.length);
            pending = input.next();
            next = watch(pending);
            continue;
          }
          if ("waitStopTask" in step) {
            const stopped = new Promise<void>((resolve) => stopWaiters.set(step.waitStopTask, resolve));
            await Promise.race([stopped, closedSignal]);
            if (closed) return;
            for (const m of step.then) yield m;
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
        // 실제 CLI 는 stdin 이 닫혀야 끝난다 — 러너가 입력을 닫지 않으면 여기서 멈춘다. 대본 밖의 입력은 적고 계속 기다린다
        for (;;) {
          const r = await Promise.race([next, closedSignal.then(() => undefined)]);
          if (!r || r.done) break;
          call.prompts.push(r.value);
          pending = input.next();
          next = watch(pending);
        }
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
      getContextUsage: async (opts) => {
        call.contextUsageCalls.push(opts);
        // 제어 요청은 stdin 으로 가고 답은 그 뒤에 온다 — 한 틱 뒤에 보아야 같은 틱에 닫은 입력도 잡힌다
        await new Promise((r) => setImmediate(r));
        if (inputEnded || closed) throw new Error("fake: getContextUsage after input closed");
        return fake.contextUsage(call);
      },
      supportedCommands: async () => {
        call.supportedCommandsCalls += 1;
        return fake.commands(args.options);
      },
      setModel: async (model) => void call.controls.push({ method: "setModel", arg: model }),
      setPermissionMode: async (mode) => void call.controls.push({ method: "setPermissionMode", arg: mode }),
      applyFlagSettings: async (settings) =>
        void call.controls.push({ method: "applyFlagSettings", arg: settings }),
      setMcpServers: async (servers) => {
        call.controls.push({ method: "setMcpServers", arg: servers });
        return {};
      },
      stopTask: async (taskId) => {
        call.controls.push({ method: "stopTask", arg: taskId });
        stopWaiters.get(taskId)?.();
        stopWaiters.delete(taskId);
      },
    };
  }

  return Object.assign(fake, {
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
    listModels: async ({ options }) => {
      fake.listModelsCalls.push(options);
      return fake.models(options);
    },
    listCommands: async ({ options }) => {
      fake.listCommandsCalls.push(options);
      return fake.commands(options);
    },
  } satisfies Omit<
    FakeSdk,
    "contextUsage" | "models" | "listModelsCalls" | "commands" | "listCommandsCalls"
  >) as FakeSdk;
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
  // 작업 메시지(ADR 0007 5.11) — 셸은 local_bash, 서브에이전트는 local_agent
  tasksChanged: (
    tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>,
  ) => sdkMsg({ type: "system", subtype: "background_tasks_changed", tasks }),
  taskStarted: (task_id: string, extra: Record<string, unknown> = {}) =>
    sdkMsg({
      type: "system",
      subtype: "task_started",
      task_id,
      description: "sleep 3 && echo done",
      task_type: "local_bash",
      is_backgrounded: true,
      ...extra,
    }),
  taskProgress: (task_id: string, extra: Record<string, unknown> = {}) =>
    sdkMsg({
      type: "system",
      subtype: "task_progress",
      task_id,
      description: "",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
      ...extra,
    }),
  taskUpdated: (task_id: string, patch: Record<string, unknown>) =>
    sdkMsg({ type: "system", subtype: "task_updated", task_id, patch }),
  taskNotification: (
    task_id: string,
    status: "completed" | "failed" | "stopped" = "completed",
    extra: Record<string, unknown> = {},
  ) =>
    sdkMsg({
      type: "system",
      subtype: "task_notification",
      task_id,
      status,
      output_file: `/private/tmp/claude-501/x/tasks/${task_id}.output`,
      summary: "done",
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
