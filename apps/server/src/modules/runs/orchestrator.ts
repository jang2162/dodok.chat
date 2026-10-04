import {
  isOpenClawAgentId,
  type Message,
  type OutboundMessage,
  parseDodokSessionKey,
  type Run,
  type RunSignal,
  type RunState,
  type RunStatus,
  RunUsage,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { agentConnectionId, agentOnConnection } from "../../adapters/connection";
import type { AdapterRegistry } from "../../adapters/registry";
import {
  type AdapterProvider,
  AdapterError,
  type AgentAdapter,
  type RunEventBody,
} from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channels, messages } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { josa } from "../../util/josa";
import { getAgent, providerAgentIdIs } from "../agents/service";
import { createAgentMessage, createSystemMessage } from "../messages/service";
import type { ApprovalsService } from "../approvals/service";
import type { RunPlan } from "../router/decide";
import { RETRY_RUN_ITEM } from "../router/service";
import {
  ensureProviderSessionId,
  ensureSession,
  INVALID_AGENT_ID_REASON,
  renewSessionOnPromptChange,
} from "../sessions/service";
import { buildInboundDeliver } from "./context";
import {
  createMediaLineFilter,
  endMediaLineFilter,
  feedMediaLineFilter,
  type MediaLineFilter,
  stripMediaLines,
} from "./media-lines";
import { type RunPatch, TERMINAL_STATUSES, transition } from "./machine";
import * as store from "./store";
import { createRunTimers } from "./timers";

export type RunTimeouts = {
  queuedMs: number;
  runMs: number;
  finalizingMs: number;
  /** 스냅샷의 단독 줄 `MEDIA:` 하나마다 finalizing 상한에 더한다 — 플러그인이 미디어를 올린 뒤에 정본을 보낸다(Ruling 2) */
  finalizingMediaLineMs: number;
  /** 연장된 finalizing 상한의 최대값 */
  finalizingMaxMs: number;
  coalesceMs: number;
  maxInflight: number;
};

/** 계획 Global Constraints 의 기본값 */
export const DEFAULT_RUN_TIMEOUTS: RunTimeouts = {
  queuedMs: 120_000,
  runMs: 600_000,
  finalizingMs: 10_000,
  finalizingMediaLineMs: 30_000,
  finalizingMaxMs: 120_000,
  coalesceMs: 50,
  maxInflight: 32,
};

/** final_timeout 으로 done(plugin) 이 된 런은 어댑터가 gateway_final 을 못 봤다 — 늦은 usage 를 받을 만큼 기다렸다 잊는다 */
const FORGET_AFTER_FINAL_TIMEOUT_MS = 60_000;

/** 승인 만료 감시의 여유(설계 4.3) — Gateway 가 먼저 resolved(timeout) 를 주므로 보통 이 타이머는 쓰이지 않는다 */
const APPROVAL_WATCHDOG_GRACE_MS = 5_000;

export type EnqueueTrigger = {
  message?: Message;
  /** interaction·continue 런: component_interactions.id — runs.triggerInteractionId 로 저장 */
  interactionId?: string;
  interactionText?: string;
  interactionMessageId?: string;
};

export interface Orchestrator {
  enqueueRun(plan: RunPlan & { channelId: string }, trigger: EnqueueTrigger): Promise<Run>;
  /** 어댑터·타이머·사용자가 부른다. ctx.message 는 gateway_final 의 WS 스냅샷 본문 */
  signal(runId: string, s: RunSignal, ctx?: { message?: string }): Promise<void>;
  /** 델타 코얼레싱·run_events 저장·팬아웃. seq·ts 는 여기서 붙인다 */
  applyRunEvent(runId: string, event: RunEventBody): Promise<void>;
  abort(runId: string): Promise<void>;
  /**
   * 에이전트 최종 메시지 도착(OpenClaw 는 브리지 정본). 돌려준 messageId 를 어댑터가 ack 로 쓴다.
   * provider·connectionId 는 보낸 어댑터와 그 연결 — msg.agentId(제공자 쪽 id)를 그 연결의 에이전트로 푼다. 틀리면 replyTo 상관·런
   * 없는 정본이 「unknown agent」로 버려진다
   */
  onCanonical(
    msg: OutboundMessage,
    provider: AdapterProvider,
    connectionId: string,
  ): Promise<{ messageId?: string }>;
  activeRuns(channelId: string): RunState[];
  recoverOnBoot(): Promise<number>;
  /** 타이머 전부 해제·어댑터 구독 해제 */
  stop(): void;
}

export type OrchestratorLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

export type OrchestratorDeps = {
  db: Db;
  bus: ServerBus;
  /** 런은 에이전트 행의 provider 어댑터로 보낸다. 이벤트는 모든 어댑터에서 받는다 */
  registry: AdapterRegistry;
  logger: OrchestratorLogger;
  /** 라우터(태스크 9) — 정본 저장 직후, canonical_received 신호 전에 부른다 */
  onAgentMessage: (message: Message, run: Run) => Promise<void>;
  /** 어댑터 승인 이벤트를 넘길 곳(wiring.ts 가 잇는다). 없으면 승인 이벤트는 로그만 남기고 버린다 */
  approvals?: Pick<ApprovalsService, "ingest" | "cancelForRun" | "expireForRun" | "earliestPendingExpiry">;
  now?: () => Date;
  timeouts?: Partial<RunTimeouts>;
};

/** usage CUSTOM 이벤트 — OpenClaw 어댑터와 러너 어댑터(판정 P8)가 같은 모양으로 낸다 */
const USAGE_EVENTS: ReadonlySet<string> = new Set(["openclaw.usage", "dodok.usage"]);
/** queued 에서 이 상태로 나가면 Gateway 가 런을 시작한 것 — RUN_STARTED·startedAt·run 타이머 */
const STARTED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "streaming",
  "tool",
  "awaiting_approval",
  "finalizing",
]);
/**
 * run_error 카드의 1회용 「다시 실행」 — 트리거 메시지가 있는 런에만 붙인다(상호작용·이어가기는 다시 만들 트리거가 없다).
 * 수명은 계약 상한(24시간)이다 — 기본 30분이면 한도에 막혀 버튼을 남겨 둔 사람이 한도가 풀린 뒤 누를 수 없다
 */
const RETRY_COMPONENTS = {
  ttlMs: 86_400_000,
  blocks: [
    {
      type: "actions" as const,
      items: [{ type: "button" as const, id: RETRY_RUN_ITEM, label: "다시 실행", style: "primary" as const }],
    },
  ],
};
/** 스레드 런인데 붙은 플러그인이 스레드를 모른다(hello capabilities 에 threads 없음) — 재설치하면 다시 실행으로 푼다 */
const PLUGIN_OUTDATED = "PLUGIN_OUTDATED";
/** 저장된 providerAgentId 가 세션 키 규칙 밖 — 키를 못 만들어 런을 보낼 수 없다. 다시 실행해도 같다 */
const INVALID_AGENT_ID = "INVALID_AGENT_ID";
/** 러너의 Claude 로그인이 없거나 풀렸다(러너 스펙 8장) — 사람이 러너 머신에서 다시 로그인한 뒤 다시 실행으로 푼다 */
const PROVIDER_AUTH = "PROVIDER_AUTH";
/**
 * 사람에게 run_error 시스템 메시지로 알리는 코드(디스패치 실패·타임아웃·러너 로그인). SERVER_RESTART·INTERNAL·Gateway 오류는
 * 알리지 않는다
 */
const NOTIFY_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "ADAPTER_UNAVAILABLE",
  "ADAPTER_PROTOCOL",
  PLUGIN_OUTDATED,
  INVALID_AGENT_ID,
  PROVIDER_AUTH,
]);
/** 다시 실행해도 같은 사유로 떨어지는 코드 — 누를 때마다 카드만 는다 */
const NO_RETRY_CODES: ReadonlySet<string> = new Set(["DROPPED:bot-loop-protection", INVALID_AGENT_ID]);

type Coalescable = Extract<RunEventBody, { type: "TEXT_MESSAGE_CONTENT" | "TOOL_CALL_ARGS" }>;
type DeltaBuffer = { channelId: string; type: Coalescable["type"]; key: string; delta: string };
type TextFilter = { channelId: string; messageId: string; state: MediaLineFilter };
type Pending = { queueKey: string; order: number; trigger: EnqueueTrigger };

/**
 * 세션 큐 키 — 연결 id + 세션 키(멀티 Gateway 계획 판정 PG3). 두 Gateway 의 같은 id 에이전트는 세션 키가 같지만 서로 다른 Gateway
 * 세션이라 서로를 기다리지 않는다. 연결이 아직 없는 런(묶임 없는 러너 에이전트)은 빈 연결로 모인다
 */
function queueKeyOf(connectionId: string | null, sessionKey: string): string {
  return `${connectionId ?? ""}\u0000${sessionKey}`;
}

/**
 * 스펙 3.8 — 프로세스에 하나. 런의 진실은 runs 행이고, 메모리에는 세션 큐·타이머·스트리밍 버퍼·WS 스냅샷만 둔다.
 * DB 쓰기는 동기(better-sqlite3)라 신호 적용은 await 없이 한 번에 끝난다 — 어댑터 이벤트 순서가 그대로 보존된다.
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { db, bus, registry, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const overrides = Object.entries(deps.timeouts ?? {}).filter(([, v]) => v !== undefined);
  const timeouts: RunTimeouts = { ...DEFAULT_RUN_TIMEOUTS, ...Object.fromEntries(overrides) };
  const timers = createRunTimers();

  const sessionQueues = new Map<string, string[]>(); // queueKeyOf(연결, 세션 키) → FIFO runId (맨 앞이 디스패치 대상)
  const pending = new Map<string, Pending>(); // 이 프로세스가 enqueue 한 미종료 런
  const inflight = new Set<string>();
  const awaitingAck = new Set<string>(); // adapter.send 를 기다리는 런(플러그인 대기·ack 재시도 중)
  const buffers = new Map<string, DeltaBuffer>();
  const textFilters = new Map<string, TextFilter>(); // 런별 MEDIA: 줄 필터(결함 A) — 텍스트 델타가 코얼레싱에 들어가기 전
  const snapshots = new Map<string, string>();
  const forgetTimers = new Set<ReturnType<typeof setTimeout>>();
  let order = 0;
  let stopped = false;

  // ── 어댑터 고르기 ───────────────────────────────────────────

  /** 그 에이전트의 provider 어댑터. 행이 없으면 NOT_FOUND, 어댑터가 없으면 AdapterError(ADAPTER_UNAVAILABLE) */
  function adapterForAgent(agentId: string): AgentAdapter {
    const agent = getAgent(db, agentId);
    if (!agent) throw apiError("NOT_FOUND", "agent not found");
    return registry.forAgent(agent);
  }

  /** 런을 만들자마자 닫아야 하는 사유 — 세션 키 규칙 밖 id, 어댑터가 없는 provider. 보낼 수 있으면 undefined */
  function refusalFor(agent: { provider: string; providerAgentId: string }) {
    if (!isOpenClawAgentId(agent.providerAgentId)) {
      return {
        code: INVALID_AGENT_ID,
        message: "providerAgentId is not a valid OpenClaw agentId",
        log: "providerAgentId outside session key rule",
      };
    }
    try {
      registry.forAgent(agent);
      return undefined;
    } catch (err) {
      return { ...dispatchError(err), log: "no adapter for the agent provider" };
    }
  }

  /** 그 런을 맡은 연결 — send 가 돌려준 값, 그 전이면 에이전트 행의 연결 */
  function connectionOfRun(run: Pick<Run, "id" | "agentId">): string | null {
    return store.getRunConnectionId(db, run.id) ?? agentConnectionId(db, run.agentId);
  }

  /**
   * 어댑터 이벤트가 그 런을 맡은 연결에서 왔는가 — 런 id 는 서버가 만든 것이라 연결을 가로질러 겹치지 않지만, 다른 Gateway·러너가
   * 남의 런 id 를 실어 그 런을 움직이지 못하게 한다. 연결이 아직 없는 런(send 결과 전 — 러너는 ack 전에도 이벤트를 보낸다)은 받는다
   */
  function fromRunConnection(runId: string, connectionId: string, kind: string): boolean {
    const owner = store.getRunConnectionId(db, runId);
    if (owner === null || owner === connectionId) return true;
    logger.warn(
      { runId, connectionId, runConnectionId: owner, kind },
      "adapter event from another connection dropped",
    );
    return false;
  }

  /** 멈춤·잊기처럼 best-effort 인 자리 — 보낼 어댑터가 없으면 할 일도 없다 */
  function adapterOfRun(run: Pick<Run, "agentId">): AgentAdapter | undefined {
    try {
      return adapterForAgent(run.agentId);
    } catch {
      return undefined;
    }
  }

  // ── 이벤트 쓰기 ─────────────────────────────────────────────

  function emitEvents(channelId: string, events: ReturnType<typeof store.appendRunEvent>[]): void {
    for (const event of events) bus.emit("run.event", { event, channelId });
  }

  function writeEvents(channelId: string, runId: string, bodies: RunEventBody[]): void {
    const ts = now();
    const events = db.transaction((tx) => bodies.map((b) => store.appendRunEvent(tx, runId, b, ts)));
    emitEvents(channelId, events);
  }

  function flushBuffer(runId: string): void {
    const buf = buffers.get(runId);
    if (!buf) return;
    buffers.delete(runId);
    timers.clear(runId, "coalesce");
    const body: RunEventBody =
      buf.type === "TEXT_MESSAGE_CONTENT"
        ? { type: buf.type, runId, messageId: buf.key, delta: buf.delta }
        : { type: buf.type, runId, toolCallId: buf.key, delta: buf.delta };
    writeEvents(buf.channelId, runId, [body]);
  }

  /** 같은 key 의 조각은 첫 조각 기준 coalesceMs 뒤 한 번에 저장한다(타이머를 다시 걸지 않아 무한 지연이 없다). */
  function coalesce(run: Pick<Run, "id" | "channelId">, event: Coalescable): void {
    const key = event.type === "TEXT_MESSAGE_CONTENT" ? event.messageId : event.toolCallId;
    const buf = buffers.get(run.id);
    if (buf && buf.type === event.type && buf.key === key) {
      buf.delta += event.delta;
      return;
    }
    flushBuffer(run.id);
    buffers.set(run.id, { channelId: run.channelId, type: event.type, key, delta: event.delta });
    timers.set(run.id, "coalesce", timeouts.coalesceMs, () => {
      try {
        flushBuffer(run.id);
      } catch (err) {
        logger.error({ err, runId: run.id }, "run event flush failed");
      }
    });
  }

  /**
   * 텍스트 델타를 코얼레싱(= 저장·팬아웃)에 넣기 전에 MEDIA: 줄을 걷는다(결함 A·Ruling 6). 경로가 델타 여럿으로 쪼개져 오므로
   * 줄 처음의 MEDIA: 후보만 붙잡고 나머지는 곧바로 흘린다. 붙잡은 것은 END·종료에서 drainTextFilter 가 판정한다.
   */
  function filterText(
    run: Pick<Run, "id" | "channelId">,
    event: Extract<Coalescable, { type: "TEXT_MESSAGE_CONTENT" }>,
  ) {
    const f = textFilterFor(run, event.messageId);
    const delta = feedMediaLineFilter(f.state, event.delta);
    if (delta !== "") coalesce(run, { ...event, delta });
  }

  function textFilterFor(run: Pick<Run, "id" | "channelId">, messageId: string): TextFilter {
    const f = textFilters.get(run.id);
    if (f?.messageId === messageId) return f;
    if (f) drainTextFilter(run.id);
    const created = { channelId: run.channelId, messageId, state: createMediaLineFilter() };
    textFilters.set(run.id, created);
    return created;
  }

  /**
   * 붙잡은 조각을 판정해 버퍼에 넣고 필터를 치운다 — MEDIA: 줄이면 버리고, 접두였을 뿐이면 내보낸다.
   * keepHeld=false 는 REPLACE — 본문이 통째 바뀌므로 붙잡은 조각도 버린다(걷은 줄 수는 그래도 남긴다).
   */
  function drainTextFilter(runId: string, keepHeld = true): void {
    const f = textFilters.get(runId);
    if (!f) return;
    textFilters.delete(runId);
    const rest = endMediaLineFilter(f.state);
    if (f.state.dropped > 0)
      logger.info({ runId, mediaLinesDropped: f.state.dropped }, "stream media lines dropped");
    if (rest === "" || !keepHeld) return;
    coalesce(
      { id: runId, channelId: f.channelId },
      { type: "TEXT_MESSAGE_CONTENT", runId, messageId: f.messageId, delta: rest },
    );
  }

  function recordUsage(run: Run, value: unknown): void {
    const parsed = RunUsage.safeParse(value);
    if (!parsed.success) {
      logger.warn({ runId: run.id, issues: parsed.error.issues }, "usage event violates contract");
      return;
    }
    const fields = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    store.updateRun(db, run.id, { usage: { ...run.usage, ...fields } });
  }

  // ── 진단 로그(본문·토큰 없이) ────────────────────────────────

  /** createdAt → at. 세션 큐 대기도 들어간다 */
  function sinceCreated(run: Pick<Run, "createdAt">, at: Date): number {
    return at.getTime() - Date.parse(run.createdAt);
  }

  /** 상한이 런을 닫을 때 — 전이를 적용하기 전에 찍어 「run ended」 보다 먼저 남긴다. final_timeout 은 정상 경로일 수 있어 info */
  function logClosedByTimeout(
    run: Run,
    reason: "queue_timeout" | "run_timeout" | "undelivered" | "final_timeout",
  ) {
    const line = { runId: run.id, reason, statusBefore: run.status, elapsedMs: sinceCreated(run, now()) };
    if (reason === "final_timeout") logger.info(line, "run closed by timeout");
    else logger.warn(line, "run closed by timeout");
  }

  function logRunEnded(run: Run, endedAt: Date) {
    logger.info(
      {
        runId: run.id,
        channelId: run.channelId,
        agentId: run.agentId,
        status: run.status,
        ...(run.finalSource === undefined ? {} : { finalSource: run.finalSource }),
        ...(run.error === undefined ? {} : { errorCode: run.error.code }),
        durationMs: sinceCreated(run, endedAt),
      },
      "run ended",
    );
  }

  // ── 상태 전이 ───────────────────────────────────────────────

  function terminalEvents(tx: DbOrTx, run: Run, s: RunSignal): RunEventBody[] {
    switch (run.status) {
      case "done":
        return [
          {
            type: "RUN_FINISHED",
            runId: run.id,
            messageIds: store.listRunMessageIds(tx, run.id),
            ...(run.usage ? { usage: run.usage } : {}),
          },
        ];
      case "error":
        // Gateway chat error 는 어댑터가 RUN_ERROR 를 이미 보냈다
        if (store.hasRunEvent(tx, run.id, "RUN_ERROR")) return [];
        return [
          {
            type: "RUN_ERROR",
            runId: run.id,
            message: run.error?.message ?? "run error",
            ...(run.error ? { code: run.error.code } : {}),
          },
        ];
      case "aborted":
        if (store.hasRunEvent(tx, run.id, "RUN_ABORTED")) return [];
        return [
          { type: "RUN_ABORTED", runId: run.id, by: s.kind === "gateway_aborted" ? "gateway" : "user" },
        ];
      default:
        return [];
    }
  }

  function patchChanges(run: Run, patch: RunPatch): boolean {
    return (Object.keys(patch) as (keyof RunPatch)[]).some(
      (k) => JSON.stringify(run[k]) !== JSON.stringify(patch[k]),
    );
  }

  function armRunTimer(runId: string): void {
    timers.set(runId, "run", timeouts.runMs, () => {
      void timeOut(runId, { kind: "run_timeout" });
    });
  }

  /**
   * 승인 대기의 유일한 상한 — 그 런의 미해결 승인 중 가장 이른 만료 시각 + 5초(설계 4.3).
   * 승인 행을 못 찾으면 시계를 아예 끄지 않는다 — 그러면 런이 영원히 산다.
   */
  function armApprovalWatchdog(runId: string): void {
    const expiresAt = deps.approvals?.earliestPendingExpiry(runId);
    if (!expiresAt) {
      logger.warn({ runId }, "awaiting approval without a pending approval row");
      armRunTimer(runId);
      return;
    }
    watchApprovalExpiry(runId, expiresAt);
  }

  function watchApprovalExpiry(runId: string, expiresAt: Date): void {
    const ms = Math.max(0, expiresAt.getTime() + APPROVAL_WATCHDOG_GRACE_MS - now().getTime());
    timers.set(runId, "approval", ms, () => {
      expireApprovals(runId);
    });
  }

  /**
   * 감시 타이머가 울렸다 — **실제로 만료된** 승인만 닫히고, 그 신호가 런 시계를 다시 켠다.
   * 아직 살아 있는 승인이 남았으면(한 런에 승인이 둘) 그 만료 시각으로 다시 감시한다 —
   * 대기에서 나오며 approval 슬롯이 지워지므로 여기서 다시 걸지 않으면 남은 승인이 감시 밖에 남는다.
   * 만료 시각이 이미 지난 행이 남았다면 닫기가 실패한 것이다(markApproval 오류) — 다시 걸면 0ms 로 도니 런 시계에 맡긴다.
   */
  function expireApprovals(runId: string): void {
    try {
      deps.approvals?.expireForRun(runId);
    } catch (err) {
      logger.error({ err, runId }, "approval expiry failed");
    }
    if (stopped) return;
    const run = store.getRun(db, runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return;
    const remaining = deps.approvals?.earliestPendingExpiry(runId);
    if (remaining && remaining.getTime() > now().getTime()) {
      watchApprovalExpiry(runId, remaining);
      return;
    }
    if (run.status === "awaiting_approval" && !timers.has(runId, "run")) armRunTimer(runId);
  }

  function rearmTimers(runId: string, prev: RunStatus, next: RunStatus): void {
    if (stopped) return;
    if (prev === "awaiting_approval") timers.clear(runId, "approval");
    if (next === "finalizing") {
      timers.clear(runId, "queued");
      timers.clear(runId, "run");
      timers.set(runId, "finalizing", timeouts.finalizingMs, () => {
        void api.signal(runId, { kind: "final_timeout" });
      });
      return;
    }
    if (next === "awaiting_approval") {
      // 대기 중에는 Gateway 가 아무 신호도 보내지 않는다(스파이크 6.3) — 무응답 시계를 멈추고 승인 만료만 감시한다
      timers.clear(runId, "queued");
      timers.clear(runId, "run");
      armApprovalWatchdog(runId);
      return;
    }
    if ((prev === "queued" || prev === "awaiting_approval") && next !== "queued") {
      timers.clear(runId, "queued");
      armRunTimer(runId);
    }
  }

  /**
   * 런이 끝난다 — 남은 승인을 닫는다. **terminal 전이 전에** 불러야 APPROVAL_RESOLVED 가 타임라인에 남는다
   * (applyRunEvent 가 종료된 런의 이벤트를 드롭한다 — p2-t4 리뷰 이월 5).
   */
  function cancelApprovals(runId: string): void {
    try {
      deps.approvals?.cancelForRun(runId, "run-aborted");
    } catch (err) {
      logger.error({ err, runId }, "approval cancel on run end failed");
    }
  }

  /**
   * 타임아웃으로 닫힌 런에는 Gateway 종료 신호가 오지 않았다 — Gateway 런을 멈추고(best-effort) 어댑터가 쥔 추적 상태를 버린다
   * (sc-t8 걱정 1·sc-t11 걱정 3). recoverOnBoot 의 SERVER_RESTART 는 어댑터 연결 전이라 여기로 오지 않는다.
   */
  async function timeOut(runId: string, s: Extract<RunSignal, { kind: "queue_timeout" | "run_timeout" }>) {
    try {
      const before = store.getRun(db, runId);
      // 종료 신호는 release → pump 로 같은 세션의 다음 런을 곧바로 보낸다. 그 전에 Gateway 에 abort 를 먼저 보내고(sc-t12 리뷰 R2),
      // 결과는 신호를 적용한 뒤에 기다린다 — 타임아웃 코드가 Gateway 의 aborted 이벤트에 덮이지 않게.
      let aborting: Promise<unknown> | undefined;
      if (before && !TERMINAL_STATUSES.has(before.status) && transition(before, s).next !== null) {
        logClosedByTimeout(before, s.kind);
        aborting = (
          adapterOfRun(before)?.abort(runId, before.sessionKey, connectionOfRun(before)) ?? Promise.resolve()
        ).then(
          () => undefined,
          (err: unknown) => err ?? new Error("adapter abort failed"),
        );
      }
      await api.signal(runId, s);
      if (!aborting || !before) return;
      const failure = await aborting;
      if (failure !== undefined) logger.warn({ err: failure, runId }, "adapter abort after timeout failed");
      const after = store.getRun(db, runId);
      if (!after || !TERMINAL_STATUSES.has(after.status)) return;
      adapterOfRun(before)?.forgetRun?.(runId);
    } catch (err) {
      logger.error({ err, runId, signal: s.kind }, "run timeout handling failed");
    }
  }

  /**
   * ack 전 상한 — 대개 플러그인에 전달되지 않은 런이다. 그래도 전달 도중(플러그인엔 도착했고 ack 만 오는 중)에 울렸을 수 있으니
   * Gateway 에 best-effort abort 를 먼저 보내고(sc-t14 리뷰 R1; 모르는 runId 면 무해), 어댑터가 쥔 전송을 버린 뒤(플러그인이 늦게 붙어도
   * 닫힌 런을 보내지 않게) ADAPTER_UNAVAILABLE 로 닫는다. 닫히면 release → pump 가 같은 세션의 다음 런을 보낸다.
   */
  function undelivered(runId: string): void {
    try {
      const run = store.getRun(db, runId);
      if (!awaitingAck.has(runId) || run?.status !== "queued") return;
      logClosedByTimeout(run, "undelivered");
      const adapter = adapterOfRun(run);
      void adapter
        ?.abort(runId, run.sessionKey, connectionOfRun(run))
        .catch((err: unknown) => logger.debug({ err, runId }, "adapter abort after undelivered failed"));
      adapter?.forgetRun?.(runId);
      applySignal(runId, {
        kind: "gateway_error",
        code: "ADAPTER_UNAVAILABLE",
        message: `inbound not delivered within ${timeouts.queuedMs}ms`,
      });
    } catch (err) {
      failRun(runId, err);
    }
  }

  /** 종료된 런의 메모리 상태를 치운다. 세션 큐에서 빼고 슬롯을 비운다(pump 는 호출자가). */
  function release(runId: string): void {
    const info = pending.get(runId);
    pending.delete(runId);
    inflight.delete(runId);
    timers.clear(runId);
    buffers.delete(runId);
    textFilters.delete(runId);
    snapshots.delete(runId);
    if (!info) return;
    const queue = sessionQueues.get(info.queueKey);
    if (!queue) return;
    const i = queue.indexOf(runId);
    if (i >= 0) queue.splice(i, 1);
    if (queue.length === 0) sessionQueues.delete(info.queueKey);
  }

  /** 채널 규칙이 바뀌어 러너 세션을 새로 열었다 — 「새 대화」 info 와 같은 모양으로 그 자리(스레드면 스레드)에 */
  function notifyRenewed(run: Run): void {
    try {
      const handle = getAgent(db, run.agentId)?.handle ?? "unknown";
      createSystemMessage(db, bus, {
        channelId: run.channelId,
        ...(run.threadRootId === undefined ? {} : { threadRootId: run.threadRootId }),
        kind: "info",
        bodyMd: `채널 규칙이 바뀌어 @${handle} 의 대화를 새로 시작했습니다`,
        systemMeta: { kind: "info" },
      });
    } catch (err) {
      logger.error({ err, runId: run.id }, "session renewed notice failed");
    }
  }

  function notifyRunError(run: Run): void {
    const code = run.error?.code;
    if (run.status !== "error" || code === undefined) return;
    if (!NOTIFY_CODES.has(code) && !code.startsWith("DROPPED:") && !code.startsWith("ADAPTER_ERROR:")) return;
    try {
      const handle = getAgent(db, run.agentId)?.handle ?? "unknown";
      createSystemMessage(db, bus, {
        channelId: run.channelId,
        ...(run.threadRootId === undefined ? {} : { threadRootId: run.threadRootId }),
        kind: "run_error",
        bodyMd: runErrorBody(code, handle),
        systemMeta: { kind: "run_error", runId: run.id },
        ...(run.triggerMessageId === undefined || NO_RETRY_CODES.has(code)
          ? {}
          : { components: RETRY_COMPONENTS }),
      });
    } catch (err) {
      logger.error({ err, runId: run.id }, "run_error system message failed");
    }
  }

  /**
   * transition → runs UPDATE + (RUN_STARTED) + STATE_SNAPSHOT + (종료 이벤트) 한 트랜잭션 → 팬아웃 → 타이머 재배치.
   * 상태·필드가 그대로인 전이(streaming 중 text_delta 등)는 아무것도 쓰지 않는다.
   */
  function applySignal(runId: string, s: RunSignal): Run | undefined {
    const run = store.getRun(db, runId);
    if (!run) {
      logger.warn({ runId, signal: s.kind }, "signal for unknown run");
      return undefined;
    }
    const t = transition(run, s);
    if (t.next === null) {
      logger.debug(
        { runId, channelId: run.channelId, agentId: run.agentId, status: run.status, signal: s.kind },
        `run signal ${t.reason}`,
      );
      return run;
    }
    const next = t.next;
    if (next === run.status && !patchChanges(run, t.patch)) return run;

    const terminal = TERMINAL_STATUSES.has(next);
    if (terminal) drainTextFilter(runId); // END 없이 끝나는 런(오류·중지) — 붙잡은 접두를 종료 이벤트 전에
    flushBuffer(runId); // 앞서 받은 조각이 상태 이벤트보다 먼저 seq 를 받게
    const prev = run.status;
    const ts = now();
    const started = prev === "queued" && STARTED.has(next);
    if (terminal) cancelApprovals(runId); // 전이 전에 — 종료된 런의 이벤트는 드롭된다
    const { updated, events } = db.transaction((tx) => {
      const updated = store.updateRun(tx, runId, {
        status: next,
        ...t.patch,
        ...(started ? { startedAt: ts } : {}),
        ...(terminal ? { endedAt: ts } : {}),
      });
      const bodies: RunEventBody[] = [];
      if (started) {
        bodies.push({
          type: "RUN_STARTED",
          runId,
          threadId: updated.channelId,
          agentId: updated.agentId,
          sessionKey: updated.sessionKey,
          ...(updated.providerRunId === undefined ? {} : { providerRunId: updated.providerRunId }),
        });
      }
      bodies.push({ type: "STATE_SNAPSHOT", runId, snapshot: store.toRunState(updated) });
      if (terminal) bodies.push(...terminalEvents(tx, updated, s));
      return { updated, events: bodies.map((b) => store.appendRunEvent(tx, runId, b, ts)) };
    });

    if (terminal) {
      release(runId);
      logRunEnded(updated, ts);
    } else rearmTimers(runId, prev, next);
    try {
      emitEvents(updated.channelId, events);
      bus.emit("run.state", { run: store.toRunState(updated) });
      if (terminal) notifyRunError(updated);
    } finally {
      if (terminal) pump();
    }
    return updated;
  }

  function failRun(runId: string, err: unknown): void {
    logger.error({ err, runId }, "run signal handling failed");
    try {
      applySignal(runId, { kind: "gateway_error", code: "INTERNAL", message: errorMessage(err) });
    } catch (inner) {
      logger.error({ err: inner, runId }, "closing failed run failed");
    }
  }

  // ── 직렬화·디스패치 ─────────────────────────────────────────

  /** 세션 큐 맨 앞(디스패치 안 된 것) 중 먼저 enqueue 한 것부터, 진행 중 런이 maxInflight 미만인 동안 보낸다. */
  function pump(): void {
    if (stopped) return;
    while (inflight.size < timeouts.maxInflight) {
      let pick: { runId: string; order: number } | undefined;
      for (const queue of sessionQueues.values()) {
        const head = queue[0];
        if (head === undefined || inflight.has(head)) continue;
        const headOrder = pending.get(head)?.order ?? Number.MAX_SAFE_INTEGER;
        if (!pick || headOrder < pick.order) pick = { runId: head, order: headOrder };
      }
      if (!pick) return;
      inflight.add(pick.runId);
      void dispatch(pick.runId);
    }
  }

  async function dispatch(runId: string): Promise<void> {
    try {
      const run = store.getRun(db, runId);
      if (!run || TERMINAL_STATUSES.has(run.status)) {
        release(runId);
        pump();
        return;
      }
      const trigger = pending.get(runId)?.trigger ?? {};
      const adapter = adapterForAgent(run.agentId);
      const connectionId = connectionOfRun(run);
      if (run.threadRootId !== undefined && lacksThreads(adapter, run.agentId, connectionId)) {
        applySignal(runId, {
          kind: "gateway_error",
          code: PLUGIN_OUTDATED,
          message: "connected plugin does not support threads",
        });
        return;
      }
      const { session, needsPromptContext } = ensureSession(db, adapter, {
        channelId: run.channelId,
        agentId: run.agentId,
        threadRootId: run.threadRootId,
      });
      const capabilities = adapter.capabilities();
      // 채널 프롬프트를 매 런 싣는 어댑터(판정 P3)는 리비전과 무관하게 늘 — 바뀐 뒤에는 채널 행의 새 값만 실린다
      const inbound = buildInboundDeliver(db, {
        run,
        trigger,
        session,
        needsPromptContext: needsPromptContext || capabilities.promptEveryRun,
        now: now(),
      });
      // 서버가 세션 id 를 정하는 어댑터(판정 P4)만 두 번째 인자를 받는다. 채널 규칙이 바뀐 뒤면 새 세션으로 연다 — 세션 큐가
      // 같은 세션의 런을 하나씩 보내므로 같은 리비전 변화에 한 번만 걸린다
      if (capabilities.serverSessionIds && renewSessionOnPromptChange(db, session.id)) notifyRenewed(run);
      const providerSessionId = capabilities.serverSessionIds
        ? ensureProviderSessionId(db, session.id)
        : undefined;
      // ack 전 상한 — 어댑터는 플러그인이 없으면 120s, ack 가 없으면 재시도로 더 기다린다. 그동안에도 런은 queued 이므로
      // queuedMs 안에 전달되지 않으면 닫는다(스펙 8장 「브리지 단절·ack 없음 → ADAPTER_UNAVAILABLE」). ack 뒤에는 아래에서 다시 건다.
      awaitingAck.add(runId);
      timers.set(runId, "queued", timeouts.queuedMs, () => {
        undelivered(runId);
      });
      let result: Awaited<ReturnType<AgentAdapter["send"]>>;
      try {
        result = await adapter.send(inbound, {
          connectionId,
          ...(providerSessionId === undefined ? {} : { providerSessionId }),
        });
      } finally {
        awaitingAck.delete(runId);
      }
      // 종료 중(stop 뒤 어댑터 close 가 대기를 끊었거나 ack 가 늦게 왔다) — 닫히는 DB 에 쓰지 않는다.
      // 이 런은 다음 부팅의 recoverOnBoot 가 SERVER_RESTART 로 닫는다(스펙 2장).
      if (stopped) return;

      const current = store.getRun(db, runId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return; // 기다리는 사이 abort·Gateway 오류로 끝났다
      if (result.admission === "drop") {
        const reason = result.reason ?? "unknown";
        applySignal(runId, { kind: "gateway_error", code: `DROPPED:${reason}`, message: reason });
        return;
      }
      // 실제로 맡은 연결(판정 PG4) — 묶임 없는 러너 에이전트는 여기서 처음 정해진다. 제공자 런 id 는 연결 안에서만 유일하므로 한 번에 쓴다.
      // 보낸 연결(저장값 ?? 에이전트의 지금 연결)이 아니라 저장값과 견준다 — 기다리는 사이 에이전트가 묶이면 둘이 같아도 저장값은 비어 있다
      const patch: store.RunRowPatch = {};
      if (result.connectionId !== undefined && result.connectionId !== store.getRunConnectionId(db, runId))
        patch.connectionId = result.connectionId;
      if (result.providerRunId !== undefined && current.providerRunId === undefined)
        patch.providerRunId = result.providerRunId;
      if (Object.keys(patch).length > 0) store.updateRun(db, runId, patch);
      if (current.status === "queued") {
        if (result.queued === true) {
          // 제공자 쪽 대기열(러너 동시 상한)에 섰다 — 앞 런이 몇 분 도는 것이 흔하니 queuedMs 로 닫지 않고 런 상한으로 잰다.
          // 러너가 끊기거나 토큰이 폐기되면 어댑터가 ADAPTER_UNAVAILABLE 로 닫는다(최종 리뷰 I1)
          timers.clear(runId, "queued");
          armRunTimer(runId);
        } else {
          timers.set(runId, "queued", timeouts.queuedMs, () => {
            void timeOut(runId, { kind: "queue_timeout" });
          });
        }
      }
    } catch (err) {
      if (stopped) {
        logger.debug({ err, runId }, "run dispatch settled after stop");
        return;
      }
      const ended = store.getRun(db, runId);
      if (ended && TERMINAL_STATUSES.has(ended.status)) {
        // 기다리는 사이 상한·abort 로 이미 닫혔다 — 상태는 건드리지 않는다. 어댑터 거부(forgetRun 된 전송 등)는 예상한 것이라 debug,
        // 그 밖의 예외는 버그일 수 있어 error 로 남긴다(sc-t14 리뷰 이월 B)
        if (isAdapterError(err)) {
          logger.debug({ err, runId, status: ended.status }, "run dispatch settled after run ended");
        } else {
          logger.error({ err, runId, status: ended.status }, "run dispatch failed after run ended");
        }
        return;
      }
      // 어댑터는 runId 를 전송 전에 등록하므로 gateway_started 뒤에 거부될 수 있다 — 상태와 무관하게 닫는다
      const error = dispatchError(err);
      if (error.code === "INTERNAL") logger.error({ err, runId }, "run dispatch failed");
      else logger.warn({ err, runId, code: error.code }, "run dispatch failed");
      try {
        applySignal(runId, { kind: "gateway_error", ...error });
      } catch (inner) {
        logger.error({ err: inner, runId }, "closing undispatched run failed");
      }
    }
  }

  /**
   * 그 에이전트를 맡은 쪽이 스레드를 모른다. OpenClaw 는 붙은 플러그인이 없으면 모른다고 단정하지 않는다 — 어댑터가 플러그인을 기다렸다
   * 보내고, 못 붙으면 ADAPTER_UNAVAILABLE 로 닫힌다(브리지가 잠깐 끊긴 사이의 스레드 멘션에 재설치 안내를 남기지 않게)
   */
  function lacksThreads(adapter: AgentAdapter, agentId: string, connectionId: string | null): boolean {
    const detail = adapter.setupDetail();
    if (detail.provider === "openclaw" && detail.bridge.plugin === null) return false;
    // 에이전트 행이 없으면 여기서 막지 않는다 — ensureSession 이 그 런을 닫는다
    const providerAgentId = getAgent(db, agentId)?.providerAgentId;
    return providerAgentId !== undefined && !adapter.supports(providerAgentId, connectionId, "threads");
  }

  // ── 정본 ────────────────────────────────────────────────────

  /**
   * 스펙 3.5 — threadId 는 세션 키의 스레드 접미사와, 런이 있으면 런의 스레드와도 같아야 한다. 스레드 발언이 채널에(또는 반대로)
   * 저장되지 않게 다르면 거절한다. 맞으면 저장할 스레드(없으면 undefined)를 돌려준다.
   */
  function canonicalThread(msg: OutboundMessage, run: Run | undefined): string | undefined {
    const thread = msg.threadId?.toLowerCase();
    const keyThread = parseDodokSessionKey(msg.sessionKey)?.threadRootId;
    if (thread !== keyThread || (run !== undefined && run.threadRootId !== thread)) {
      logger.warn(
        {
          outboundId: msg.outboundId,
          channelId: msg.channelId,
          sessionKey: msg.sessionKey,
          threadId: msg.threadId,
          ...(run ? { runId: run.id, runThreadRootId: run.threadRootId } : {}),
        },
        "canonical thread mismatch — rejected",
      );
      throw apiError("VALIDATION", "threadId does not match the session key or the run thread");
    }
    return thread;
  }

  /** 그 연결의 에이전트 가운데 msg.agentId — 두 Gateway 의 main 은 연결로 가른다 */
  function agentIdFor(
    msg: OutboundMessage,
    provider: AdapterProvider,
    connectionId: string,
  ): string | undefined {
    return db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(channels, eq(channels.workspaceId, agents.workspaceId))
      .where(
        and(
          eq(channels.id, msg.channelId),
          eq(agents.provider, provider),
          agentOnConnection(provider, connectionId),
          providerAgentIdIs(msg.agentId),
        ),
      )
      .get()?.id;
  }

  /**
   * 계약 스펙 5.1: runId → 연결·sessionKey 의 미종료 런 → replyToInboundId 가 트리거한 런. 다른 채널 런은 쓰지 않는다.
   * runId 가 다른 연결의 런을 가리키면 쓰지 않는다(fromRunConnection 과 같은 까닭)
   */
  function correlate(msg: OutboundMessage, provider: AdapterProvider, connectionId: string): Run | undefined {
    const inChannel = (run: Run | undefined) => (run?.channelId === msg.channelId ? run : undefined);
    const ours = (run: Run | undefined) => {
      const owner = run === undefined ? null : store.getRunConnectionId(db, run.id);
      return owner === null || owner === connectionId ? run : undefined;
    };
    const byRunId = msg.runId === undefined ? undefined : ours(inChannel(store.getRun(db, msg.runId)));
    if (byRunId) return byRunId;
    const bySession = inChannel(store.findOpenRunBySession(db, connectionId, msg.sessionKey));
    if (bySession) return bySession;
    if (msg.replyToInboundId === undefined) return undefined;
    const agentId = agentIdFor(msg, provider, connectionId);
    if (agentId === undefined) return undefined;
    return inChannel(store.findRunByTriggerMessage(db, msg.replyToInboundId, agentId));
  }

  function storeAgentMessage(
    msg: OutboundMessage,
    agentId: string,
    runId: string | undefined,
    threadRootId: string | undefined,
  ): Message {
    return createAgentMessage(
      db,
      bus,
      {
        channelId: msg.channelId,
        threadRootId,
        agentId,
        runId,
        externalId: msg.outboundId,
        bodyMd: msg.text, // 평문 @handle — createAgentMessage 가 토큰화한다
        components: msg.components,
        attachmentIds: msg.attachmentIds,
        replyTo: msg.replyToInboundId,
      },
      {
        onDroppedAttachments: (ids) =>
          logger.warn({ outboundId: msg.outboundId, dropped: ids }, "outbound attachments dropped"),
      },
    );
  }

  async function routeAgentMessage(message: Message, run: Run): Promise<void> {
    try {
      await deps.onAgentMessage(message, run);
    } catch (err) {
      logger.error({ err, runId: run.id, messageId: message.id }, "agent message routing failed");
    }
  }

  /**
   * Gateway 경로(gateway_final 을 본 런)는 어댑터가 스스로 지연 해제한다 — 여기는 정본만 온 퇴화 경로 전용이다.
   * 타이머는 unref, stop() 이 지운다.
   */
  function forgetLater(runId: string): void {
    if (stopped) return;
    const timer = setTimeout(() => {
      forgetTimers.delete(timer);
      const run = store.getRun(db, runId);
      if (run) adapterOfRun(run)?.forgetRun?.(runId);
    }, FORGET_AFTER_FINAL_TIMEOUT_MS);
    timer.unref?.();
    forgetTimers.add(timer);
  }

  /**
   * Ruling 2 — 스냅샷에 단독 줄 MEDIA: 가 있으면 플러그인이 그 미디어를 올린 **뒤에** 정본을 보낸다. 10초 상한이 먼저 끝나면
   * 스냅샷이 저장되고 늦은 정본이 두 번째 메시지가 된다 — 그때만 줄당 finalizingMediaLineMs 만큼(finalizingMaxMs 까지) 늘린다.
   * 스냅샷은 gateway_final 에서만 들어온다(델타는 쌓지 않는다) — 그래서 다시 거는 자리는 여기 하나다.
   */
  function extendFinalizingForMedia(runId: string, snapshot: string): void {
    if (stopped) return;
    const { dropped } = stripMediaLines(snapshot);
    if (dropped === 0) return;
    const ms = Math.min(
      timeouts.finalizingMs + dropped * timeouts.finalizingMediaLineMs,
      Math.max(timeouts.finalizingMaxMs, timeouts.finalizingMs),
    );
    timers.set(runId, "finalizing", ms, () => {
      void api.signal(runId, { kind: "final_timeout" });
    });
  }

  /** finalizing 상한 — 정본이 없으면 WS 스냅샷(비어 있지 않을 때)을 에이전트 메시지로 저장하고 done(gateway). */
  async function finalizeFromSnapshot(runId: string): Promise<void> {
    const run = store.getRun(db, runId);
    if (run?.status === "finalizing") logClosedByTimeout(run, "final_timeout");
    let message: Message | undefined;
    // 단독 줄 MEDIA: 는 호스트 경로다 — 채널에 저장하지 않는다(스펙 4.6). 바이트가 호스트에만 있어 이 경로의 미디어는 붙지 않는다
    const { text, dropped } = stripMediaLines(snapshots.get(runId) ?? "");
    if (dropped > 0)
      logger.warn({ runId, mediaLinesDropped: dropped }, "gateway snapshot media lines dropped");
    // 라우팅을 기다리는 사이 정본이 이미 저장됐으면 스냅샷으로 겹쳐 쓰지 않는다
    if (
      run?.status === "finalizing" &&
      text.trim() !== "" &&
      store.listRunMessageIds(db, runId).length === 0
    ) {
      try {
        message = createAgentMessage(db, bus, {
          channelId: run.channelId,
          threadRootId: run.threadRootId,
          agentId: run.agentId,
          runId,
          externalId: `gateway-final:${runId}`,
          bodyMd: text,
          replyTo: run.triggerMessageId,
        });
      } catch (err) {
        logger.error({ err, runId }, "gateway snapshot message failed");
      }
    }
    const updated = applySignal(runId, { kind: "final_timeout" });
    // 무시된 신호도 applySignal 은 그 런을 돌려준다 — 이 신호로 finalizing 을 닫았을 때만 건다
    if (run?.status === "finalizing" && updated?.status === "done" && updated.finalSource === "plugin") {
      forgetLater(runId);
    }
    if (message && updated) await routeAgentMessage(message, updated);
  }

  // ── 공개 API ───────────────────────────────────────────────

  const api: Orchestrator = {
    async enqueueRun(plan, trigger) {
      const ts = now();
      const agent = getAgent(db, plan.agentId);
      // 규칙 밖 id 는 세션 키를 못 만들고, 어댑터가 없는 provider 는 보낼 곳이 없다 — 조용히 던지지 않고 런을 남겨 사유 있는 run_error 로 닫는다.
      // 행이 없으면 아래 adapterForAgent 가 NOT_FOUND 를 던진다(런을 남기지 않는다)
      const refusal = agent === undefined ? undefined : refusalFor(agent);
      const sessionKey =
        refusal === undefined
          ? ensureSession(db, adapterForAgent(plan.agentId), {
              channelId: plan.channelId,
              agentId: plan.agentId,
              threadRootId: plan.threadRootId,
            }).session.sessionKey
          : "";
      const connectionId = agentConnectionId(db, plan.agentId);
      const queueKey = queueKeyOf(connectionId, sessionKey);
      const queue = refusal === undefined ? (sessionQueues.get(queueKey) ?? []) : [];
      const { run, event } = db.transaction((tx) => {
        const run = store.insertRun(tx, {
          channelId: plan.channelId,
          agentId: plan.agentId,
          triggerKind: plan.triggerKind,
          triggerMessageId: trigger.message?.id,
          triggerInteractionId: trigger.interactionId,
          rootMessageId: plan.rootMessageId,
          relayDepth: plan.relayDepth,
          relayHash: plan.relayHash,
          parentRunId: plan.parentRunId,
          sessionKey,
          threadRootId: plan.threadRootId,
          connectionId,
          createdAt: ts,
        });
        const event = store.appendRunEvent(
          tx,
          run.id,
          { type: "RUN_QUEUED", runId: run.id, position: queue.length },
          ts,
        );
        return { run, event };
      });
      if (refusal !== undefined) {
        emitEvents(run.channelId, [event]);
        bus.emit("run.state", { run: store.toRunState(run) });
        logger.warn({ runId: run.id, agentId: plan.agentId, code: refusal.code }, refusal.log);
        return (
          applySignal(run.id, { kind: "gateway_error", code: refusal.code, message: refusal.message }) ?? run
        );
      }
      pending.set(run.id, { queueKey, order: ++order, trigger });
      queue.push(run.id);
      sessionQueues.set(queueKey, queue);
      try {
        emitEvents(run.channelId, [event]);
        bus.emit("run.state", { run: store.toRunState(run) });
      } finally {
        pump();
      }
      return run;
    },

    async signal(runId, s, ctx) {
      try {
        if (s.kind === "final_timeout") {
          await finalizeFromSnapshot(runId);
          return;
        }
        const before = s.kind === "gateway_final" ? store.getRun(db, runId)?.status : undefined;
        const updated = applySignal(runId, s);
        // 스냅샷은 실제로 finalizing 에 있을 때만 보관한다 — 종료된 런에 늦게 온 final 이 맵에 남지 않게(sc-t8 리뷰 R1).
        // finalizing 타이머는 다음 틱 이후에 울리므로 전이 뒤에 넣어도 늦지 않다.
        if (s.kind === "gateway_final" && ctx?.message !== undefined && updated?.status === "finalizing") {
          snapshots.set(runId, ctx.message);
          // 이 final 로 finalizing 에 들어왔을 때만(중복 final 이 상한을 밀지 않게) 방금 rearmTimers 가 건 상한을 늘린다
          if (before !== "finalizing") extendFinalizingForMedia(runId, ctx.message);
        }
      } catch (err) {
        failRun(runId, err);
      }
    },

    async applyRunEvent(runId, event) {
      try {
        const run = store.getRun(db, runId);
        if (!run) {
          logger.warn({ runId, type: event.type }, "run event for unknown run");
          return;
        }
        if (event.type === "CUSTOM" && USAGE_EVENTS.has(event.name)) {
          recordUsage(run, event.value); // 종료 뒤에 와도 반영한다(usage 는 final 과 순서가 없다)
          return;
        }
        if (TERMINAL_STATUSES.has(run.status)) {
          logger.debug({ runId, type: event.type, status: run.status }, "run event after end dropped");
          return;
        }
        const body = { ...event, runId };
        if (body.type === "TEXT_MESSAGE_CONTENT") {
          filterText(run, body);
          return;
        }
        if (body.type === "TOOL_CALL_ARGS") {
          coalesce(run, body);
          return;
        }
        if (body.type === "TEXT_MESSAGE_END") drainTextFilter(runId);
        if (body.type === "TEXT_MESSAGE_REPLACE") {
          // 본문 통째 교체 — 새 필터로 걷고, 끝의 붙잡은 조각은 이어지는 델타와 함께 판정한다
          drainTextFilter(runId, false);
          const text = feedMediaLineFilter(textFilterFor(run, body.messageId).state, body.text);
          flushBuffer(runId);
          writeEvents(run.channelId, runId, [{ ...body, text }]);
          return;
        }
        flushBuffer(runId); // 순서 보존
        writeEvents(run.channelId, runId, [body]);
      } catch (err) {
        logger.error({ err, runId, type: event.type }, "run event failed");
      }
    },

    async abort(runId) {
      const run = store.getRun(db, runId);
      if (!run) throw apiError("NOT_FOUND", "run not found");
      if (TERMINAL_STATUSES.has(run.status)) return;
      const adapter = adapterOfRun(run);
      if (inflight.has(runId) || run.providerRunId !== undefined) {
        try {
          await adapter?.abort(runId, run.sessionKey, connectionOfRun(run));
        } catch (err) {
          logger.warn({ err, runId }, "adapter abort failed");
        }
      }
      // ack 전(플러그인 대기·재시도 중)이면 어댑터가 쥔 전송을 버린다 — 플러그인이 늦게 붙어도 중단한 런을 보내지 않게(sc-t14 리뷰 이월 A)
      if (awaitingAck.has(runId)) adapter?.forgetRun?.(runId);
      await api.signal(runId, { kind: "abort_requested" });
    },

    async onCanonical(msg, provider, connectionId) {
      const existing = db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.externalId, msg.outboundId))
        .get();
      if (existing) return { messageId: existing.id };

      const run = correlate(msg, provider, connectionId);
      const threadRootId = canonicalThread(msg, run);
      if (!run) {
        const agentId = agentIdFor(msg, provider, connectionId);
        const where = { outboundId: msg.outboundId, channelId: msg.channelId, sessionKey: msg.sessionKey };
        if (agentId === undefined) {
          logger.warn({ ...where, providerAgentId: msg.agentId }, "canonical message from unknown agent");
          throw apiError("NOT_FOUND", "agent not found");
        }
        const message = storeAgentMessage(msg, agentId, undefined, threadRootId);
        logger.warn({ ...where, runId: msg.runId, messageId: message.id }, "canonical message without run");
        return { messageId: message.id };
      }

      const message = storeAgentMessage(msg, run.agentId, run.id, threadRootId);
      await routeAgentMessage(message, run);
      await api.signal(run.id, { kind: "canonical_received" }); // 종료된 런이면 ignored — 저장·라우팅만
      return { messageId: message.id };
    },

    activeRuns(channelId) {
      return store
        .listOpenRuns(db)
        .filter((run) => run.channelId === channelId)
        .map(store.toRunState);
    },

    async recoverOnBoot() {
      // 부팅 시 메모리 큐는 비어 있다 — 대기 중이던 런도 다시 보내지 않고 닫는다
      const open = store.listOpenRuns(db).filter((run) => !pending.has(run.id));
      for (const run of open) {
        try {
          applySignal(run.id, {
            kind: "gateway_error",
            code: "SERVER_RESTART",
            message: "server restarted before the run finished",
          });
        } catch (err) {
          logger.error({ err, runId: run.id }, "closing run on boot failed");
        }
      }
      if (open.length > 0) logger.info({ count: open.length }, "closed unfinished runs on boot");
      return open.length;
    },

    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      for (const runId of textFilters.keys()) drainTextFilter(runId); // 순회 중 현재 항목 삭제는 안전하다
      for (const runId of buffers.keys()) {
        try {
          flushBuffer(runId);
        } catch (err) {
          logger.error({ err, runId }, "run event flush on stop failed");
        }
      }
      timers.clearAll();
      for (const timer of forgetTimers) clearTimeout(timer);
      forgetTimers.clear();
    },
  };

  const unsubscribe = registry.onEvent((e, from) => {
    switch (e.kind) {
      case "run_event":
        if (fromRunConnection(e.runId, e.connectionId, e.kind)) void api.applyRunEvent(e.runId, e.event);
        return;
      case "run_signal":
        if (!fromRunConnection(e.runId, e.connectionId, e.kind)) return;
        void api.signal(
          e.runId,
          e.signal,
          e.snapshotText === undefined ? undefined : { message: e.snapshotText },
        );
        return;
      case "approval":
        // 상관·저장·중계는 승인 서비스가 한다(설계 4.2). ingest 는 던지지 않는다 — 한 건이 이벤트 루프를 끊지 않게
        if (deps.approvals) deps.approvals.ingest(e.approval, from.provider, e.connectionId);
        else logger.warn({ providerApprovalId: e.approval.providerApprovalId }, "approval without service");
        return;
      case "canonical":
        return; // 저장은 어댑터가 onCanonical 훅으로 직접 부른다 — 이벤트는 알림용
      case "status":
        bus.emit("adapter.status", e.status); // 어댑터마다 자기 상태로(판정 P7)
        return;
    }
  });

  return api;
}

/** run_error 카드 본문 — 사람이 할 일이 있는 코드는 사유를 쓴다 */
function runErrorBody(code: string, handle: string): string {
  switch (code) {
    case "DROPPED:bot-loop-protection":
      return `@${handle} ${josa(handle, "이", "가")} 봇 루프 보호로 메시지를 받지 않았습니다`;
    case PLUGIN_OUTDATED:
      return `@${handle} ${josa(handle, "이", "가")} 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)`;
    case INVALID_AGENT_ID:
      return `@${handle} 실행이 실패했습니다: ${INVALID_AGENT_ID_REASON}`;
    case PROVIDER_AUTH:
      return `@${handle} 실행이 실패했습니다: 러너의 Claude 로그인을 확인하세요`;
    default:
      return `@${handle} 실행이 실패했습니다: ${code}`;
  }
}

/** 패키지 경계를 넘어 클래스가 둘일 수 있어 이름도 본다 */
function isAdapterError(err: unknown): err is AdapterError {
  return err instanceof AdapterError || (err instanceof Error && err.name === "AdapterError");
}

/** 스펙 8장 — send 거부 코드를 런 오류 코드로 */
function dispatchError(err: unknown): { code: string; message: string } {
  const message = errorMessage(err);
  if (isAdapterError(err)) {
    const code = err.code;
    if (code === "TIMEOUT" || code === "ADAPTER_UNAVAILABLE") return { code, message };
    if (code === "INTERNAL" && message.startsWith("ADAPTER_PROTOCOL:"))
      return { code: "ADAPTER_PROTOCOL", message };
    return { code: `ADAPTER_ERROR:${code}`, message };
  }
  return { code: "INTERNAL", message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
