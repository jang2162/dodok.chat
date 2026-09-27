import { realpathSync } from "node:fs";
import {
  renderRunnerPrompt,
  type ErrorCode,
  type RunEventBody,
  type RunnerRunFinal,
  type RunnerRunStart,
} from "@dodok/shared";
import type { ResolvedAgent } from "./config";
import { createPathMasker } from "./mask";
import type {
  CanUseTool,
  SdkMcpServer,
  SdkMessage,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkUserMessage,
} from "./sdk";
import { createStreamMapper, isAuthFailureText } from "./stream-map";

/** CLI(와 그 도구가 여는 셸)로 넘기는 러너 env — SDK 기본값은 러너 env 전부라 러너 토큰·API 키가 샌다(ADR 0007 5.4) */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "USER",
];
/** run.abort 뒤 interrupt 에 턴이 끝나지 않으면 close() 까지 기다리는 시간(스펙 4.5) */
export const ABORT_CLOSE_MS = 5000;
const ERROR_MESSAGE_MAX = 2000;

// system/init 의 apiKeySource — 'none' 은 claude.ai 로그인(구독)이다. 구독의 달러는 청구액이 아니라 공시 단가 환산(ADR 0007 4.8)
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

export function buildQueryOptions(
  agent: ResolvedAgent,
  start: RunnerRunStart,
  deps: {
    claudeConfigDir: string;
    baseEnv: NodeJS.ProcessEnv;
    mcpServer: unknown;
    canUseTool?: CanUseTool;
    resume: boolean;
  },
): SdkOptions {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = deps.baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = deps.claudeConfigDir;
  // 켜 두면 메모리 자리가 cwd 로 정해져 작업 디렉터리가 같은 채널·스레드가 한 메모리를 나눠 쓴다(ADR 0007 5.10)
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";

  return {
    cwd: agent.workdir,
    model: agent.model,
    permissionMode: agent.permissionMode,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    // sessionId 와 resume 은 함께 못 쓴다. title 을 주면 새 세션 제목을 짓는 보조 모델 호출이 없어진다(ADR 0007 4.8)
    ...(deps.resume
      ? { resume: start.providerSessionId }
      : { sessionId: start.providerSessionId, ...(start.sessionTitle ? { title: start.sessionTitle } : {}) }),
    // preset 을 생략하면 빈 시스템 프롬프트다(5.1). snapshot 을 생략하면 바뀐 채널 규칙이 기존 세션에 실리지 않는다(5.3)
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: start.channelRulesAppend,
      snapshot: false,
    },
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: start.turnFacts },
            }),
          ],
        },
      ],
    },
    // alwaysLoad 는 서버 설정이 아니라 도구마다 _meta 로 실린다 — sdk.ts createMcpServer 가 붙인다
    mcpServers: { dodok: deps.mcpServer as SdkMcpServer },
    // strictMcpConfig 이 없으면 로그인한 계정의 claude.ai 커넥터가 MCP 로 붙는다(5.6).
    // settingSources [] — 사람 저장소의 .claude/settings.json·CLAUDE.md 를 끌어오지 않는다(6의 2)
    strictMcpConfig: true,
    settingSources: [],
    includePartialMessages: true,
    env,
    ...(deps.canUseTool ? { canUseTool: deps.canUseTool } : {}),
  };
}

export type RunEmitter = {
  event(event: RunEventBody): void;
  final(final: Omit<RunnerRunFinal, "runId">): void;
  error(code: ErrorCode, message: string): void;
};

export type RunContext = {
  sdk: SdkPort;
  agent: ResolvedAgent;
  claudeConfigDir: string;
  baseEnv: NodeJS.ProcessEnv;
  /** 세션별 마지막 total_cost_usd(세션 누적값 — ADR 0007 5.9). 러너 프로세스 메모리에만 있다 */
  costs: Map<string, number>;
  signal: AbortSignal;
  emit: RunEmitter;
  now?: () => number;
  closeGraceMs?: number;
};

function workdirRoots(workdir: string): string[] {
  try {
    return [workdir, realpathSync(workdir)];
  } catch {
    return [workdir];
  }
}

/**
 * 런 하나 = query() 하나 = CLI 프로세스 하나, 프롬프트도 하나(ADR 0007 6의 1). 턴 사실은 훅 문맥에만 있으므로
 * 훅 문맥이 요청에서 빠지는 두 경우(앞 턴 처리 중 보낸 프롬프트·interrupt 직후 프롬프트 — 4.5)를 만들지 않도록
 * 이 query() 에 프롬프트를 더 보내지 않는다. 결과는 ctx.emit 으로만 나간다 — 던지지 않는다
 */
export async function runOnce(start: RunnerRunStart, ctx: RunContext): Promise<void> {
  if (ctx.signal.aborted) return;
  const sessionId = start.providerSessionId;
  const now = ctx.now ?? Date.now;
  const mask = createPathMasker(workdirRoots(ctx.agent.workdir));
  const mapper = createStreamMapper(now, { runId: start.deliver.runId, mask });

  let resume = false;
  try {
    resume = await ctx.sdk.sessionExists(sessionId, ctx.agent.workdir);
  } catch {
    // 전사를 못 읽으면 새 세션으로 연다 — 같은 id 의 전사가 실제로 있으면 CLI 가 거절해 run.error 로 드러난다
  }
  if (ctx.signal.aborted) return;

  let finishInput!: () => void;
  const inputDone = new Promise<void>((resolve) => (finishInput = resolve));
  const promptMessage: SdkUserMessage = {
    type: "user",
    message: { role: "user", content: renderRunnerPrompt(start.deliver) },
    parent_tool_use_id: null,
  };
  // 입력은 런의 끝(프롬프트 턴의 result)까지 열어 둔다 — 닫으면 SDK 가 stdin 을 닫아 권한 콜백·SDK MCP 가 멈춘다
  async function* prompt(): AsyncGenerator<SdkUserMessage> {
    yield promptMessage;
    await inputDone;
  }

  const failed = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    const code: ErrorCode = isAuthFailureText(text) ? "PROVIDER_AUTH" : "INTERNAL";
    const head = code === "PROVIDER_AUTH" ? "러너의 Claude 로그인을 확인하세요" : "Claude Code 실행 실패";
    ctx.emit.error(code, `${head}: ${mask(text)}`.slice(0, ERROR_MESSAGE_MAX));
  };

  let q: SdkQuery;
  try {
    q = ctx.sdk.query({
      prompt: prompt(),
      options: buildQueryOptions(ctx.agent, start, {
        claudeConfigDir: ctx.claudeConfigDir,
        baseEnv: ctx.baseEnv,
        mcpServer: ctx.sdk.createMcpServer([]),
        resume,
      }),
    });
  } catch (error) {
    failed(error);
    return;
  }

  const graceMs = ctx.closeGraceMs ?? ABORT_CLOSE_MS;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const closeLater = () => {
    closeTimer ??= setTimeout(() => q.close(), graceMs);
  };
  let interrupted = false;
  const onAbort = () => {
    interrupted = true;
    mapper.markInterrupted();
    q.interrupt().catch(() => {});
    closeLater();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  let ended = false;
  let costKind: RunnerRunFinal["costKind"] = "subscription_estimate";
  const end = () => {
    ended = true;
    finishInput();
    // 입력을 닫으면 CLI 가 끝난다 — 끝나지 않으면 유예 뒤 닫는다
    closeLater();
  };

  // total_cost_usd 는 세션 누적값이다 — resume 한 프로세스의 첫 result 에 앞 런 비용이 이미 들어 있다(ADR 0007 5.9)
  let costRecorded = false;
  const recordCost = (total: number | undefined): number | undefined => {
    costRecorded = true;
    if (typeof total !== "number") return undefined;
    const prev = ctx.costs.get(sessionId);
    const cost = !resume ? total : prev === undefined ? undefined : Math.max(0, total - prev);
    // 비정상 종료한 CLI 의 result 는 0 을 실을 수 있다 — 이어 간 세션의 알던 누적값을 0 으로 되돌리지 않는다
    if (total > 0 || !resume) ctx.costs.set(sessionId, total);
    return cost;
  };

  try {
    for await (const m of q as AsyncIterable<SdkMessage>) {
      if (ended) continue;
      const raw = m as { type?: string; subtype?: string; apiKeySource?: string; total_cost_usd?: number };
      if (raw.type === "system" && raw.subtype === "init" && raw.apiKeySource) {
        costKind = API_KEY_SOURCES.has(raw.apiKeySource) ? "api" : "subscription_estimate";
      }
      for (const item of mapper.map(m)) {
        if (item.event) {
          ctx.emit.event(item.event);
          if (item.event.type === "RUN_ABORTED") end();
        } else if (item.final) {
          const { totalCostUsd, ...rest } = item.final;
          const costUsd = recordCost(totalCostUsd);
          ctx.emit.final({ ...rest, ...(costUsd === undefined ? {} : { costUsd }), costKind });
          end();
        } else if (item.error) {
          ctx.emit.error(item.error.code, item.error.message);
          end();
        }
      }
      // 오류·중지로 끝난 턴도 누적 비용을 싣는다 — 다음 런의 차이가 맞도록 기록만 한다
      if (ended && raw.type === "result" && !costRecorded) recordCost(raw.total_cost_usd);
    }
    if (!ended) {
      if (interrupted) ctx.emit.event({ type: "RUN_ABORTED", runId: start.deliver.runId, by: "user" });
      else ctx.emit.error("INTERNAL", "Claude Code 가 결과 없이 끝났습니다");
    }
  } catch (error) {
    // 마지막 result 뒤에 CLI 가 exit 1 로 끝나 반복자가 던질 수 있다(ADR 0007 4.4) — 런은 이미 끝났다
    if (!ended) {
      if (interrupted) ctx.emit.event({ type: "RUN_ABORTED", runId: start.deliver.runId, by: "user" });
      else failed(error);
    }
  } finally {
    ended = true;
    ctx.signal.removeEventListener("abort", onAbort);
    finishInput();
    if (closeTimer) clearTimeout(closeTimer);
    q.close();
  }
}
