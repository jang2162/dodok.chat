import {
  type Message,
  type OutboundMessage,
  type Run,
  type RunSignal,
  type RunState,
  type RunStatus,
  RunUsage,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { AdapterError, type AgentAdapter, type RunEventBody } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channels, messages } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getAgent } from "../agents/service";
import { createAgentMessage, createSystemMessage } from "../messages/service";
import type { RunPlan } from "../router/decide";
import { ensureSession } from "../sessions/service";
import { buildInboundDeliver } from "./context";
import { type RunPatch, TERMINAL_STATUSES, transition } from "./machine";
import * as store from "./store";
import { createRunTimers } from "./timers";

export type RunTimeouts = {
  queuedMs: number;
  runMs: number;
  finalizingMs: number;
  coalesceMs: number;
  maxInflight: number;
};

/** 계획 Global Constraints 의 기본값 */
export const DEFAULT_RUN_TIMEOUTS: RunTimeouts = {
  queuedMs: 120_000,
  runMs: 600_000,
  finalizingMs: 10_000,
  coalesceMs: 50,
  maxInflight: 32,
};

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
  /** 브리지 정본 도착. 돌려준 messageId 를 어댑터가 플러그인 ack 로 쓴다 */
  onCanonical(msg: OutboundMessage): Promise<{ messageId?: string }>;
  activeRuns(channelId: string): RunState[];
  recoverOnBoot(): Promise<number>;
  /** 타이머 전부 해제·어댑터 구독 해제 */
  stop(): void;
}

export type OrchestratorLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

export type OrchestratorDeps = {
  db: Db;
  bus: ServerBus;
  adapter: AgentAdapter;
  logger: OrchestratorLogger;
  /** 라우터(태스크 9) — 정본 저장 직후, canonical_received 신호 전에 부른다 */
  onAgentMessage: (message: Message, run: Run) => Promise<void>;
  now?: () => Date;
  timeouts?: Partial<RunTimeouts>;
};

const USAGE_EVENT = "openclaw.usage";
/** queued 에서 이 상태로 나가면 Gateway 가 런을 시작한 것 — RUN_STARTED·startedAt·run 타이머 */
const STARTED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "streaming",
  "tool",
  "awaiting_approval",
  "finalizing",
]);
/** 사람에게 run_error 시스템 메시지로 알리는 코드(디스패치 실패·타임아웃). SERVER_RESTART·INTERNAL·Gateway 오류는 알리지 않는다 */
const NOTIFY_CODES: ReadonlySet<string> = new Set(["TIMEOUT", "ADAPTER_UNAVAILABLE", "ADAPTER_PROTOCOL"]);

type Coalescable = Extract<RunEventBody, { type: "TEXT_MESSAGE_CONTENT" | "TOOL_CALL_ARGS" }>;
type DeltaBuffer = { channelId: string; type: Coalescable["type"]; key: string; delta: string };
type Pending = { sessionKey: string; order: number; trigger: EnqueueTrigger };

/**
 * 스펙 3.8 — 프로세스에 하나. 런의 진실은 runs 행이고, 메모리에는 세션 큐·타이머·스트리밍 버퍼·WS 스냅샷만 둔다.
 * DB 쓰기는 동기(better-sqlite3)라 신호 적용은 await 없이 한 번에 끝난다 — 어댑터 이벤트 순서가 그대로 보존된다.
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { db, bus, adapter, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const overrides = Object.entries(deps.timeouts ?? {}).filter(([, v]) => v !== undefined);
  const timeouts: RunTimeouts = { ...DEFAULT_RUN_TIMEOUTS, ...Object.fromEntries(overrides) };
  const timers = createRunTimers();

  const sessionQueues = new Map<string, string[]>(); // sessionKey → FIFO runId (맨 앞이 디스패치 대상)
  const pending = new Map<string, Pending>(); // 이 프로세스가 enqueue 한 미종료 런
  const inflight = new Set<string>();
  const buffers = new Map<string, DeltaBuffer>();
  const snapshots = new Map<string, string>();
  let order = 0;
  let stopped = false;

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
  function coalesce(run: Run, event: Coalescable): void {
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

  function recordUsage(run: Run, value: unknown): void {
    const parsed = RunUsage.safeParse(value);
    if (!parsed.success) {
      logger.warn({ runId: run.id, issues: parsed.error.issues }, "usage event violates contract");
      return;
    }
    const fields = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    store.updateRun(db, run.id, { usage: { ...run.usage, ...fields } });
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

  function rearmTimers(runId: string, prev: RunStatus, next: RunStatus): void {
    if (stopped) return;
    if (next === "finalizing") {
      timers.clear(runId, "queued");
      timers.clear(runId, "run");
      timers.set(runId, "finalizing", timeouts.finalizingMs, () => {
        void api.signal(runId, { kind: "final_timeout" });
      });
    } else if (prev === "queued" && next !== "queued") {
      timers.clear(runId, "queued");
      timers.set(runId, "run", timeouts.runMs, () => {
        void timeOut(runId, { kind: "run_timeout" });
      });
    }
  }

  /**
   * 타임아웃으로 닫힌 런에는 Gateway 종료 신호가 오지 않았다 — Gateway 런을 멈추고(best-effort) 어댑터가 쥔 추적 상태를 버린다
   * (sc-t8 걱정 1·sc-t11 걱정 3). recoverOnBoot 의 SERVER_RESTART 는 어댑터 연결 전이라 여기로 오지 않는다.
   */
  async function timeOut(runId: string, s: Extract<RunSignal, { kind: "queue_timeout" | "run_timeout" }>) {
    try {
      const before = store.getRun(db, runId);
      await api.signal(runId, s);
      if (!before || TERMINAL_STATUSES.has(before.status)) return;
      if (!TERMINAL_STATUSES.has(store.getRun(db, runId)?.status ?? before.status)) return;
      try {
        await adapter.abort(runId, before.sessionKey);
      } catch (err) {
        logger.warn({ err, runId }, "adapter abort after timeout failed");
      }
      adapter.forgetRun?.(runId);
    } catch (err) {
      logger.error({ err, runId, signal: s.kind }, "run timeout handling failed");
    }
  }

  /** 종료된 런의 메모리 상태를 치운다. 세션 큐에서 빼고 슬롯을 비운다(pump 는 호출자가). */
  function release(runId: string): void {
    const info = pending.get(runId);
    pending.delete(runId);
    inflight.delete(runId);
    timers.clear(runId);
    buffers.delete(runId);
    snapshots.delete(runId);
    if (!info) return;
    const queue = sessionQueues.get(info.sessionKey);
    if (!queue) return;
    const i = queue.indexOf(runId);
    if (i >= 0) queue.splice(i, 1);
    if (queue.length === 0) sessionQueues.delete(info.sessionKey);
  }

  function notifyRunError(run: Run): void {
    const code = run.error?.code;
    if (run.status !== "error" || code === undefined) return;
    if (!NOTIFY_CODES.has(code) && !code.startsWith("DROPPED:") && !code.startsWith("ADAPTER_ERROR:")) return;
    try {
      const handle = getAgent(db, run.agentId)?.handle ?? "unknown";
      const bodyMd =
        code === "DROPPED:bot-loop-protection"
          ? `@${handle} 이(가) 봇 루프 보호로 메시지를 받지 않았습니다`
          : `@${handle} 실행이 실패했습니다: ${code}`;
      createSystemMessage(db, bus, {
        channelId: run.channelId,
        kind: "run_error",
        bodyMd,
        systemMeta: { kind: "run_error", runId: run.id },
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

    flushBuffer(runId); // 앞서 받은 조각이 상태 이벤트보다 먼저 seq 를 받게
    const prev = run.status;
    const ts = now();
    const started = prev === "queued" && STARTED.has(next);
    const terminal = TERMINAL_STATUSES.has(next);
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

    if (terminal) release(runId);
    else rearmTimers(runId, prev, next);
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
      const { session, needsPromptContext } = ensureSession(db, adapter, {
        channelId: run.channelId,
        agentId: run.agentId,
      });
      const inbound = buildInboundDeliver(db, { run, trigger, session, needsPromptContext, now: now() });
      const result = await adapter.send(inbound);
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
      if (result.providerRunId !== undefined && current.providerRunId === undefined) {
        store.updateRun(db, runId, { providerRunId: result.providerRunId });
      }
      if (current.status === "queued") {
        timers.set(runId, "queued", timeouts.queuedMs, () => {
          void timeOut(runId, { kind: "queue_timeout" });
        });
      }
    } catch (err) {
      if (stopped) {
        logger.debug({ err, runId }, "run dispatch settled after stop");
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

  // ── 정본 ────────────────────────────────────────────────────

  function agentIdFor(msg: OutboundMessage): string | undefined {
    return db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(channels, eq(channels.workspaceId, agents.workspaceId))
      .where(
        and(
          eq(channels.id, msg.channelId),
          eq(agents.provider, adapter.provider),
          eq(agents.providerAgentId, msg.agentId),
        ),
      )
      .get()?.id;
  }

  /** 계약 스펙 5.1: runId → sessionKey 의 미종료 런 → replyToInboundId 가 트리거한 런. 다른 채널 런은 쓰지 않는다. */
  function correlate(msg: OutboundMessage): Run | undefined {
    const inChannel = (run: Run | undefined) => (run?.channelId === msg.channelId ? run : undefined);
    const byRunId = msg.runId === undefined ? undefined : inChannel(store.getRun(db, msg.runId));
    if (byRunId) return byRunId;
    const bySession = inChannel(store.findOpenRunBySession(db, msg.sessionKey));
    if (bySession) return bySession;
    if (msg.replyToInboundId === undefined) return undefined;
    const agentId = agentIdFor(msg);
    if (agentId === undefined) return undefined;
    return inChannel(store.findRunByTriggerMessage(db, msg.replyToInboundId, agentId));
  }

  function storeAgentMessage(msg: OutboundMessage, agentId: string, runId: string | undefined): Message {
    return createAgentMessage(db, bus, {
      channelId: msg.channelId,
      agentId,
      runId,
      externalId: msg.outboundId,
      bodyMd: msg.text, // 평문 @handle — createAgentMessage 가 토큰화한다
      components: msg.components,
      replyTo: msg.replyToInboundId,
    });
  }

  async function routeAgentMessage(message: Message, run: Run): Promise<void> {
    try {
      await deps.onAgentMessage(message, run);
    } catch (err) {
      logger.error({ err, runId: run.id, messageId: message.id }, "agent message routing failed");
    }
  }

  /** finalizing 상한 — 정본이 없으면 WS 스냅샷(비어 있지 않을 때)을 에이전트 메시지로 저장하고 done(gateway). */
  async function finalizeFromSnapshot(runId: string): Promise<void> {
    const run = store.getRun(db, runId);
    let message: Message | undefined;
    const text = snapshots.get(runId) ?? "";
    // 라우팅을 기다리는 사이 정본이 이미 저장됐으면 스냅샷으로 겹쳐 쓰지 않는다
    if (
      run?.status === "finalizing" &&
      text.trim() !== "" &&
      store.listRunMessageIds(db, runId).length === 0
    ) {
      try {
        message = createAgentMessage(db, bus, {
          channelId: run.channelId,
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
    if (message && updated) await routeAgentMessage(message, updated);
  }

  // ── 공개 API ───────────────────────────────────────────────

  const api: Orchestrator = {
    async enqueueRun(plan, trigger) {
      const ts = now();
      const { session } = ensureSession(db, adapter, { channelId: plan.channelId, agentId: plan.agentId });
      const queue = sessionQueues.get(session.sessionKey) ?? [];
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
          sessionKey: session.sessionKey,
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
      pending.set(run.id, { sessionKey: run.sessionKey, order: ++order, trigger });
      queue.push(run.id);
      sessionQueues.set(run.sessionKey, queue);
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
        const updated = applySignal(runId, s);
        // 스냅샷은 실제로 finalizing 에 있을 때만 보관한다 — 종료된 런에 늦게 온 final 이 맵에 남지 않게(sc-t8 리뷰 R1).
        // finalizing 타이머는 다음 틱 이후에 울리므로 전이 뒤에 넣어도 늦지 않다.
        if (s.kind === "gateway_final" && ctx?.message !== undefined && updated?.status === "finalizing") {
          snapshots.set(runId, ctx.message);
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
        if (event.type === "CUSTOM" && event.name === USAGE_EVENT) {
          recordUsage(run, event.value); // 종료 뒤에 와도 반영한다(usage 는 final 과 순서가 없다)
          return;
        }
        if (TERMINAL_STATUSES.has(run.status)) {
          logger.debug({ runId, type: event.type, status: run.status }, "run event after end dropped");
          return;
        }
        const body = { ...event, runId };
        if (body.type === "TEXT_MESSAGE_CONTENT" || body.type === "TOOL_CALL_ARGS") {
          coalesce(run, body);
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
      if (inflight.has(runId) || run.providerRunId !== undefined) {
        try {
          await adapter.abort(runId, run.sessionKey);
        } catch (err) {
          logger.warn({ err, runId }, "adapter abort failed");
        }
      }
      await api.signal(runId, { kind: "abort_requested" });
    },

    async onCanonical(msg) {
      const existing = db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.externalId, msg.outboundId))
        .get();
      if (existing) return { messageId: existing.id };

      const run = correlate(msg);
      if (!run) {
        const agentId = agentIdFor(msg);
        const where = { outboundId: msg.outboundId, channelId: msg.channelId, sessionKey: msg.sessionKey };
        if (agentId === undefined) {
          logger.warn({ ...where, providerAgentId: msg.agentId }, "canonical message from unknown agent");
          throw apiError("NOT_FOUND", "agent not found");
        }
        const message = storeAgentMessage(msg, agentId, undefined);
        logger.warn({ ...where, runId: msg.runId, messageId: message.id }, "canonical message without run");
        return { messageId: message.id };
      }

      const message = storeAgentMessage(msg, run.agentId, run.id);
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
      for (const runId of buffers.keys()) {
        try {
          flushBuffer(runId);
        } catch (err) {
          logger.error({ err, runId }, "run event flush on stop failed");
        }
      }
      timers.clearAll();
    },
  };

  const unsubscribe = adapter.onEvent((e) => {
    switch (e.kind) {
      case "run_event":
        void api.applyRunEvent(e.runId, e.event);
        return;
      case "run_signal":
        void api.signal(
          e.runId,
          e.signal,
          e.snapshotText === undefined ? undefined : { message: e.snapshotText },
        );
        return;
      case "canonical":
        return; // 저장은 어댑터가 onCanonical 훅으로 직접 부른다 — 이벤트는 알림용
      case "status":
        bus.emit("adapter.status", e.status);
        return;
    }
  });

  return api;
}

/** 스펙 8장 — send 거부 코드를 런 오류 코드로 */
function dispatchError(err: unknown): { code: string; message: string } {
  const message = errorMessage(err);
  if (err instanceof AdapterError || (err instanceof Error && err.name === "AdapterError")) {
    const code = (err as AdapterError).code;
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
