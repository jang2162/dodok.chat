import {
  renderRunnerPrompt,
  type ErrorCode,
  type RunEventBody,
  type RunnerApprovalRequested,
  type RunnerOutboundAck,
  type RunnerOutboundPost,
  type RunnerRunFinal,
  type RunnerRunStart,
} from "@dodok/shared";
import { type ApprovalOutcome, createCanUseTool } from "./approvals";
import type { AttachmentsHttp } from "./attachments-http";
import type { ResolvedAgent } from "./config";
import { imageFailureNote, loadImageBlocks, type SdkImageBlock } from "./images";
import { createPathMasker, workdirRoots } from "./mask";
import { createDodokMcpServer, createPoster, POST_TOOL_FULL_NAME } from "./post-tool";
import type {
  CanUseTool,
  SdkMcpServer,
  SdkMessage,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkUserMessage,
} from "./sdk";
import { ABORTED_STOP_REASON, createStreamMapper, isAuthFailureText } from "./stream-map";

/**
 * CLI(와 그 도구가 여는 셸)로 넘기는 러너 env — SDK 기본값은 러너 env 전부라 러너 토큰·API 키가 샌다(ADR 0007 5.4).
 * 프록시·CA 는 사내 프록시·사설 CA 뒤에서 CLI 가 API 에 닿는 데 필요하고 비밀이 아니다(프록시 URL 에 자격을 넣은
 * 설정이면 그 자격도 CLI 로 간다 — CLI 가 그 프록시를 쓰려면 어차피 필요하다)
 */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "USER",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
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
    // dodok 도구는 늘 허용 — 승인 콜백은 입력 검증보다 먼저 와서 틀린 입력에도 카드가 뜬다(ADR 0007 4.2)
    allowedTools: [...new Set([...agent.allowedTools, POST_TOOL_FULL_NAME])],
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

// `--session-id` 로 연 세션의 전사가 이미 있으면 CLI 가 「Error: Session ID <id> is already in use.」로 끝나고, SDK 는
// 그 stderr 꼬리를 「Claude Code process exited with code 1」 오류 문구에 붙인다(번들 CLI 2.1.283 의 글자·sdk.mjs
// getProcessExitError). 판본마다 글이 바뀔 수 있어 넓게 본다 — 「address already in use」 류는 세션 낱말이 없어 빠진다
const SESSION_IN_USE = /\bsession\b[^\n]{0,120}?\balready (?:in use|exists)/i;
export const isSessionInUseText = (text: string): boolean => SESSION_IN_USE.test(text);

/** 중지로 끝난 런 — 메시지 없는 final(조율자 판정 R1). 러너는 수명 이벤트를 run.event 로 내지 않는다 */
export function abortedFinal(
  costKind: RunnerRunFinal["costKind"] = "subscription_estimate",
): Omit<RunnerRunFinal, "runId"> {
  return { text: "", stopReason: ABORTED_STOP_REASON, costKind };
}

export type RunEmitter = {
  event(event: RunEventBody): void;
  final(final: Omit<RunnerRunFinal, "runId">): void;
  error(code: ErrorCode, message: string): void;
};

/** 런이 서버와 주고받는 길 — 연결이 연결 세대에 묶어 만든다(끊긴 연결의 런은 새 연결로 보내지 않는다) */
export type RunBridge = {
  http: AttachmentsHttp;
  post(message: RunnerOutboundPost): Promise<RunnerOutboundAck>;
  requestApproval(request: RunnerApprovalRequested): void;
  withdrawApproval(providerApprovalId: string): void;
  /** approval.resolve 가 오면 풀리고 signal 이 끊기면 거절된다 */
  waitDecision(providerApprovalId: string, signal: AbortSignal): Promise<ApprovalOutcome>;
};

export type RunContext = {
  sdk: SdkPort;
  bridge: RunBridge;
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

/**
 * 런 하나 = query() 하나 = CLI 프로세스 하나, 프롬프트도 하나(ADR 0007 6의 1). 턴 사실은 훅 문맥에만 있으므로
 * 훅 문맥이 요청에서 빠지는 두 경우(앞 턴 처리 중 보낸 프롬프트·interrupt 직후 프롬프트 — 4.5)를 만들지 않도록
 * 이 query() 에 프롬프트를 더 보내지 않는다. 결과는 ctx.emit 으로 한 번만 나간다(final·error 중 하나) — 던지지 않는다.
 * 예외 하나: 새 세션으로 연 CLI 가 「이미 있는 세션」으로 거절하면 resume 으로 한 번 다시 연다(첫 query 는 스트림 전에 죽었다)
 */
export async function runOnce(start: RunnerRunStart, ctx: RunContext): Promise<void> {
  // 중지로 끝난 런도 final 로 닫는다 — 어댑터가 dispatch 뒤 추적하던 런을 놓아준다(판정 R1)
  if (ctx.signal.aborted) return void ctx.emit.final(abortedFinal());
  const sessionId = start.providerSessionId;
  let resume = false;
  try {
    // SDK 는 요약을 뽑을 수 없는 세션도 undefined 로 돌려준다 — 그러면 아래 재시도가 받친다
    resume = await ctx.sdk.sessionExists(sessionId, ctx.agent.workdir);
  } catch {
    // 전사를 못 읽으면 새 세션으로 연다 — 같은 id 의 전사가 실제로 있으면 CLI 가 거절하고 아래 재시도가 받친다
  }
  if (ctx.signal.aborted) return void ctx.emit.final(abortedFinal());
  // 받기 실패는 그 이미지만 뺀다 — loadImageBlocks 는 던지지 않는다
  const images = await loadImageBlocks(start.deliver, ctx.bridge.http);
  if (ctx.signal.aborted) return void ctx.emit.final(abortedFinal());
  const outcome = await attempt(start, ctx, resume, images);
  if (outcome !== "session-in-use") return;
  if (ctx.signal.aborted) return void ctx.emit.final(abortedFinal());
  await attempt(start, ctx, true, images);
}

/** 이미지가 있으면 이미지 블록 뒤에 글(이미지를 글보다 앞에 두기를 Messages API 문서가 권한다), 못 불러온 수는 글 끝 한 줄 */
function promptContent(
  start: RunnerRunStart,
  images: { blocks: SdkImageBlock[]; failed: number },
): SdkUserMessage["message"]["content"] {
  const text =
    renderRunnerPrompt(start.deliver) + (images.failed > 0 ? `\n${imageFailureNote(images.failed)}` : "");
  return images.blocks.length > 0 ? [...images.blocks, { type: "text", text }] : text;
}

/** query() 하나. 새 세션으로 열었는데 스트림 전에 「이미 있는 세션」으로 거절됐으면 아무것도 내지 않고 알린다 */
async function attempt(
  start: RunnerRunStart,
  ctx: RunContext,
  resume: boolean,
  images: { blocks: SdkImageBlock[]; failed: number },
): Promise<"done" | "session-in-use"> {
  const sessionId = start.providerSessionId;
  const now = ctx.now ?? Date.now;
  const mask = createPathMasker(workdirRoots(ctx.agent.workdir));
  const mapper = createStreamMapper(now, { runId: start.deliver.runId, mask });

  let finishInput!: () => void;
  const inputDone = new Promise<void>((resolve) => (finishInput = resolve));
  const promptMessage: SdkUserMessage = {
    type: "user",
    message: { role: "user", content: promptContent(start, images) },
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
  const retryable = (error: unknown) =>
    !resume && isSessionInUseText(error instanceof Error ? error.message : String(error));

  let q: SdkQuery;
  try {
    q = ctx.sdk.query({
      prompt: prompt(),
      options: buildQueryOptions(ctx.agent, start, {
        claudeConfigDir: ctx.claudeConfigDir,
        baseEnv: ctx.baseEnv,
        mcpServer: createDodokMcpServer({
          sdk: ctx.sdk,
          post: createPoster({
            workdir: ctx.agent.workdir,
            deliver: start.deliver,
            http: ctx.bridge.http,
            send: (m) => ctx.bridge.post(m),
            mask,
            now,
          }),
        }),
        canUseTool: createCanUseTool({
          runId: start.deliver.runId,
          sessionKey: start.deliver.sessionKey,
          workdir: ctx.agent.workdir,
          emit: (p) => ctx.bridge.requestApproval(p),
          withdraw: (id) => ctx.bridge.withdrawApproval(id),
          waitDecision: (id, signal) => ctx.bridge.waitDecision(id, signal),
          signal: ctx.signal,
        }),
        resume,
      }),
    });
  } catch (error) {
    if (retryable(error)) return "session-in-use";
    failed(error);
    return "done";
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
  let sawMessage = false;
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
      sawMessage = true;
      if (ended) continue;
      const raw = m as { type?: string; subtype?: string; apiKeySource?: string; total_cost_usd?: number };
      if (raw.type === "system" && raw.subtype === "init" && raw.apiKeySource) {
        costKind = API_KEY_SOURCES.has(raw.apiKeySource) ? "api" : "subscription_estimate";
      }
      for (const item of mapper.map(m)) {
        if (item.event) {
          ctx.emit.event(item.event);
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
      // 오류로 끝난 턴도 누적 비용을 싣는다 — 다음 런의 차이가 맞도록 기록만 한다
      if (ended && raw.type === "result" && !costRecorded) recordCost(raw.total_cost_usd);
    }
    if (!ended) {
      if (interrupted) ctx.emit.final(abortedFinal(costKind));
      else ctx.emit.error("INTERNAL", "Claude Code 가 결과 없이 끝났습니다");
    }
  } catch (error) {
    // 마지막 result 뒤에 CLI 가 exit 1 로 끝나 반복자가 던질 수 있다(ADR 0007 4.4) — 런은 이미 끝났다
    if (!ended) {
      if (interrupted) ctx.emit.final(abortedFinal(costKind));
      else if (!sawMessage && retryable(error)) return "session-in-use";
      else failed(error);
    }
  } finally {
    ended = true;
    ctx.signal.removeEventListener("abort", onAbort);
    finishInput();
    if (closeTimer) clearTimeout(closeTimer);
    q.close();
  }
  return "done";
}
