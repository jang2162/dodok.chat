/**
 * 러너 백그라운드 작업의 서버 몫(백그라운드 작업 스펙 5.5) — 러너가 알린 작업 목록을 메모리에 쥐고 채널 구독자에게 내며, CLI 가 작업이
 * 끝나 스스로 연 턴(run.followup)을 추가 응답 런으로 받는다. 작업 목록은 DB 에 두지 않는다(러너 연결의 RunnerLive 와 같은 결) — 서버를
 * 다시 띄우면 비고, 러너가 다시 붙으며 다시 보낸다
 */
import {
  BACKGROUND_TASKS_MAX,
  type BackgroundTask,
  type ChannelSubscribeResult,
  type ConversationBackgroundTasks,
  type Message,
  parseDodokSessionKey,
  type Run,
  type RunnerFollowupRequest,
  type RunnerFollowupResult,
  type RunnerTasksUpdate,
} from "@dodok/shared";
import { and, eq, sql } from "drizzle-orm";
import { agentConnectionId } from "../../adapters/connection";
import type { AdapterRegistry } from "../../adapters/registry";
import type { AgentAdapter } from "../../adapters/types";
import type { Db } from "../../db/client";
import { agentSessions, agents, conversations, runs } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getAgent, isAgentActive } from "../agents/service";
import { getChannel, isChannelArchived } from "../channels/service";
import { sessionAgentIds } from "../conversations/invited-agents";
import { isConversationClosed } from "../conversations/store";
import { createSystemMessage, getMessage } from "../messages/service";
import type { RunGate } from "../ops/budget";
import { findSessionRow } from "../sessions/service";
import { buildInboundDeliver } from "./context";
import type { Orchestrator } from "./orchestrator";
import * as store from "./store";

/** 러너가 다시 붙은 뒤 세션마다 작업 목록(빈 목록 포함)을 기다리는 시간 — 넘으면 그 세션의 작업은 죽은 것으로 본다(계획 Global Constraints) */
export const BACKGROUND_RESYNC_MS = 30_000;

/** 추가 응답을 막은 사유의 문구(설계 원문) — 「백그라운드 작업이 끝났지만 <사유> 이어서 답하지 못했습니다」 */
type RefusalReason = Exclude<RunnerFollowupResult, { ok: true }>["reason"];
const REFUSAL_TEXT: Record<RefusalReason, string | null> = {
  limit: "오늘 런 한도로",
  archived: "채널이 보관돼",
  inactive: "에이전트가 꺼져",
  closed: "세션이 닫혀",
  unknown: null,
};
export const followupRefusedText = (why: string): string =>
  `백그라운드 작업이 끝났지만 ${why} 이어서 답하지 못했습니다`;
export const BACKGROUND_LOST_TEXT = "백그라운드 작업이 끝나지 못했습니다 — 러너가 다시 시작됐습니다";

/** 러너 어댑터의 백그라운드 몫 — 레지스트리의 러너 어댑터에서 고른다(없으면 null) */
type RunnerBackgroundApi = {
  stopTask(connectionId: string, sessionKey: string, taskId: string): Promise<boolean>;
  releaseSession(connectionId: string, sessionKey: string): void;
  runnerInfo(tokenId: string): unknown;
};

function runnerApiOf(adapter: AgentAdapter | undefined): RunnerBackgroundApi | null {
  const candidate = adapter as Partial<RunnerBackgroundApi> | undefined;
  return typeof candidate?.stopTask === "function" &&
    typeof candidate.releaseSession === "function" &&
    typeof candidate.runnerInfo === "function"
    ? (candidate as RunnerBackgroundApi)
    : null;
}

export interface BackgroundService {
  /** 러너 → 서버 run.followup. 그 러너(connectionId)의 런과 그 런의 세션 키가 아니면 unknown 이고 아무 글도 남기지 않는다 */
  onFollowup(connectionId: string, req: RunnerFollowupRequest): Promise<RunnerFollowupResult>;
  /** 러너 → 서버 tasks.update, 또는 그 러너가 빠졌다({ disconnected: true }) */
  onTasks(connectionId: string, update: RunnerTasksUpdate | { disconnected: true }): void;
  /** 채널 구독 결과의 tasks — 그 채널 대화들의 지금 값 */
  snapshot(channelId: string): ChannelSubscribeResult["tasks"];
  /**
   * 화면의 「종료」 — 그 런이 띄운 작업 하나. 볼 권한은 부르는 쪽이 본다(run.abort 와 같다). 이미 끝난(목록에 없는) 작업이면 아무것도
   * 하지 않는다(끝난 런의 중지와 같다). 러너가 끊겼거나 끄지 못했으면 ADAPTER_UNAVAILABLE
   */
  stop(runId: string, taskId: string): Promise<void>;
  /** 그 대화(에이전트를 주면 그 에이전트만)의 러너 세션을 놓는다 — 작업을 모두 끄고 붙든 프로세스를 닫는다 */
  releaseConversation(conversationId: string, agentId?: string): void;
  /** 그 러너가 쥔 작업 수 — 러너 상세의 업데이트 확인(「백그라운드 작업 N개가 꺼집니다」) */
  taskCount(runnerTokenId: string): number;
  close(): void;
}

type Entry = {
  connectionId: string;
  sessionKey: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  tasks: BackgroundTask[];
  runnerConnected: boolean;
  /** 러너가 다시 붙은 뒤 이 세션의 목록(빈 목록 포함)이 왔나 — 다시 붙은 동안만 false */
  resynced: boolean;
};

export function createBackgroundService(deps: {
  db: Db;
  bus: ServerBus;
  orchestrator: Pick<Orchestrator, "adoptRun" | "signal">;
  gate: Pick<RunGate, "check">;
  registry: AdapterRegistry;
  logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
  now?: () => Date;
  resyncMs?: number;
}): BackgroundService {
  const { db, bus, logger, registry } = deps;
  const now = deps.now ?? (() => new Date());
  const resyncMs = deps.resyncMs ?? BACKGROUND_RESYNC_MS;
  const entries = new Map<string, Entry>(); // keyOf(연결, 세션 키) → 그 세션의 작업
  const down = new Set<string>(); // 끊긴 러너(연결) — 다시 붙으면 resync 를 시작한다
  const resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const keyOf = (connectionId: string, sessionKey: string) =>
    `${connectionId}\u0000${sessionKey.toLowerCase()}`;
  const runner = () => runnerApiOf(registry.forProvider("runner"));

  // ── 내보내기 ────────────────────────────────────────────────

  /** 그 대화의 지금 값 — 같은 대화의 세션 여럿(채널 세션·스레드 세션·다른 러너 에이전트)을 합친다. 하나라도 끊겼으면 끊김 */
  function conversationView(conversationId: string): ConversationBackgroundTasks {
    const list = [...entries.values()].filter((e) => e.conversationId === conversationId);
    return {
      conversationId,
      runnerConnected: list.every((e) => e.runnerConnected),
      tasks: list.flatMap((e) => e.tasks).slice(0, BACKGROUND_TASKS_MAX),
    };
  }

  function publish(channelId: string, conversationId: string): void {
    try {
      bus.emit("tasks.updated", { channelId, ...conversationView(conversationId) });
    } catch (err) {
      logger.error({ err, conversationId }, "tasks.updated emit failed");
    }
  }

  function remove(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    publish(entry.channelId, entry.conversationId);
  }

  // ── 자리 ────────────────────────────────────────────────────

  /**
   * 추가 응답이 쓸 스레드(스펙 5.5) — 스레드 런·추가 응답 런이면 그 스레드, 아니면 그 런의 첫 정본 메시지, 없으면(도구만 쓰고 답이 없던
   * 런) 트리거 메시지. 그것도 없으면 undefined
   */
  function replyThreadOf(origin: Run): string | undefined {
    if (origin.threadRootId !== undefined) return origin.threadRootId;
    return store.listRunMessageIds(db, origin.id)[0] ?? origin.triggerMessageId;
  }

  /** 러너 세션을 놓아야 하는 자리 — 닫힌 세션·보관한 채널·보관한 에이전트·세션 밖(내보냄·채널에서 뺌) */
  function released(target: { conversationId: string; channelId: string; agentId: string }): boolean {
    if (isConversationClosed(db, target.conversationId) || isChannelArchived(db, target.channelId))
      return true;
    const agent = getAgent(db, target.agentId);
    if (!agent || agent.archivedAt != null) return true;
    if (getChannel(db, target.channelId)?.kind !== "channel") return false;
    return !sessionAgentIds(db, {
      channelId: target.channelId,
      conversationId: target.conversationId,
    }).includes(target.agentId);
  }

  /**
   * 그 연결이 보낸 세션 키의 주인 — 그 연결에 묶인 러너 에이전트의 세션이거나, 그 연결이 맡았던 런의 세션이어야 한다(남의 러너 세션의
   * 작업을 띄우지 못하게). 못 찾으면 undefined
   */
  function ownedSession(
    connectionId: string,
    sessionKey: string,
  ): { conversationId: string; channelId: string; agentId: string } | undefined {
    const row = db
      .select({ agentId: agentSessions.agentId, conversationId: agentSessions.conversationId })
      .from(agentSessions)
      .innerJoin(agents, eq(agents.id, agentSessions.agentId))
      .where(
        and(
          sql`lower(${agentSessions.sessionKey}) = ${sessionKey.toLowerCase()}`,
          eq(agents.provider, "runner"),
        ),
      )
      .get();
    if (!row) return undefined;
    const bound = agentConnectionId(db, row.agentId) === connectionId;
    const ranHere =
      bound ||
      db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.connectionId, connectionId),
            eq(runs.agentId, row.agentId),
            sql`lower(${runs.sessionKey}) = ${sessionKey.toLowerCase()}`,
          ),
        )
        .limit(1)
        .get() !== undefined;
    if (!ranHere) return undefined;
    const channelId = db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId))
      .get()?.channelId;
    if (channelId === undefined) return undefined;
    return { conversationId: row.conversationId, channelId, agentId: row.agentId };
  }

  /** 작업의 원래 런이 그 세션의 대화·에이전트 런인가 — 다른 대화의 런 카드에 줄을 붙이지 못하게 */
  function ownTask(task: BackgroundTask, target: { conversationId: string; agentId: string }): boolean {
    const origin = store.getRun(db, task.originRunId);
    return origin?.conversationId === target.conversationId && origin.agentId === target.agentId;
  }

  // ── 알림 ────────────────────────────────────────────────────

  function notice(conversationId: string, threadRootId: string, bodyMd: string): void {
    try {
      createSystemMessage(db, bus, { conversationId, threadRootId, kind: "info", bodyMd });
    } catch (err) {
      logger.error({ err, conversationId, threadRootId }, "background notice failed");
    }
  }

  /** 죽은 작업마다 원래 런의 응답 스레드에 — 같은 스레드에는 한 번 */
  function noticeLost(lost: Entry[]): void {
    const threads = new Map<string, { conversationId: string; threadRootId: string }>();
    for (const entry of lost) {
      for (const task of entry.tasks) {
        const origin = store.getRun(db, task.originRunId);
        const thread = origin && replyThreadOf(origin);
        if (thread !== undefined)
          threads.set(`${entry.conversationId}:${thread}`, {
            conversationId: entry.conversationId,
            threadRootId: thread,
          });
      }
    }
    for (const t of threads.values()) notice(t.conversationId, t.threadRootId, BACKGROUND_LOST_TEXT);
  }

  // ── 끊김·다시 붙음 ───────────────────────────────────────────

  function beginResync(connectionId: string): void {
    if (!down.delete(connectionId) || closed) return;
    for (const entry of entries.values()) if (entry.connectionId === connectionId) entry.resynced = false;
    clearTimeout(resyncTimers.get(connectionId));
    const timer = setTimeout(() => {
      resyncTimers.delete(connectionId);
      expire(connectionId);
    }, resyncMs);
    timer.unref?.();
    resyncTimers.set(connectionId, timer);
  }

  /** 다시 붙은 뒤 목록이 오지 않은 세션 — 러너가 다시 시작돼 작업이 사라졌다. 빈 목록이 온 세션은 이미 지웠다(알림 없음) */
  function expire(connectionId: string): void {
    const lost: Array<[string, Entry]> = [...entries].filter(
      ([, e]) => e.connectionId === connectionId && !e.resynced,
    );
    if (lost.length === 0) return;
    logger.info({ connectionId, sessions: lost.length }, "background tasks lost after runner reconnect");
    for (const [key] of lost) remove(key);
    noticeLost(lost.map(([, e]) => e));
  }

  function onDisconnected(connectionId: string): void {
    clearTimeout(resyncTimers.get(connectionId));
    resyncTimers.delete(connectionId);
    const touched = [...entries.values()].filter((e) => e.connectionId === connectionId);
    if (touched.length > 0) down.add(connectionId);
    for (const entry of touched) {
      entry.runnerConnected = false;
      entry.resynced = false;
    }
    const conversations = new Map(touched.map((e) => [e.conversationId, e.channelId]));
    for (const [conversationId, channelId] of conversations) publish(channelId, conversationId);
  }

  /** 러너가 붙거나 끊겼다(어댑터 setup 이벤트) — 끊겼던 러너가 다시 붙었으면 resync 를 시작한다 */
  const offSetup = registry.onEvent((event) => {
    if (event.kind !== "setup" || closed) return;
    const api = runner();
    // 순회 중 현재 항목 삭제(beginResync)는 안전하다
    for (const connectionId of down) if (api?.runnerInfo(connectionId)) beginResync(connectionId);
  });

  // ── 놓기 ────────────────────────────────────────────────────

  function release(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    try {
      runner()?.releaseSession(entry.connectionId, entry.sessionKey);
    } catch (err) {
      logger.warn({ err, connectionId: entry.connectionId }, "runner session release failed");
    }
    remove(key);
  }

  /** 닫기·보관·내보내기 뒤 — 놓아야 하는 세션을 모두 놓는다. 쥔 세션은 작업이 있는 것뿐이라 몇 개 안 된다 */
  function sweep(): void {
    if (closed) return;
    // 순회 중 현재 항목 삭제(release)는 안전하다
    for (const [key, entry] of entries) {
      try {
        if (released(entry)) release(key);
      } catch (err) {
        logger.error({ err, conversationId: entry.conversationId }, "background sweep failed");
      }
    }
  }
  const offBus = [
    bus.on("conversation.updated", sweep),
    bus.on("channel.updated", sweep),
    bus.on("agents.changed", sweep),
    bus.on("conversation.agents", sweep),
    bus.on("channel.member.changed", sweep),
  ];

  // ── 추가 응답 ────────────────────────────────────────────────

  function refuse(
    reason: RefusalReason,
    at?: { conversationId: string; threadRootId: string },
  ): RunnerFollowupResult {
    const why = REFUSAL_TEXT[reason];
    if (why !== null && at) notice(at.conversationId, at.threadRootId, followupRefusedText(why));
    return { ok: false, reason };
  }

  async function onFollowup(connectionId: string, req: RunnerFollowupRequest): Promise<RunnerFollowupResult> {
    const origin = store.getRun(db, req.originRunId);
    // 그 러너가 맡은 런과 그 런의 세션 키여야 한다 — 다른 러너가 남의 런 id 로 남의 대화에 글(거절 알림 포함)을 만들지 못하게
    if (
      !origin ||
      store.getRunConnectionId(db, origin.id) !== connectionId ||
      origin.sessionKey.toLowerCase() !== req.sessionKey.toLowerCase()
    ) {
      logger.warn(
        { connectionId, originRunId: req.originRunId },
        "runner followup for a run of another runner or session — refused",
      );
      return { ok: false, reason: "unknown" };
    }
    const threadRootId = replyThreadOf(origin);
    if (threadRootId === undefined) return { ok: false, reason: "unknown" };
    const at = { conversationId: origin.conversationId, threadRootId };
    if (isConversationClosed(db, origin.conversationId)) return refuse("closed", at);
    if (isChannelArchived(db, origin.channelId)) return refuse("archived", at);
    const agent = getAgent(db, origin.agentId);
    if (!agent || !isAgentActive(agent)) return refuse("inactive", at);
    // 관문의 run_limit 알림은 남기지 않는다 — 거절 글이 「오늘 런 한도」 사유를 이미 말해 같은 스레드에 글이 둘이 된다
    if (deps.gate.check(origin.conversationId, threadRootId, { announce: false })) return refuse("limit", at);
    const message: Message | undefined =
      (origin.triggerMessageId === undefined ? undefined : getMessage(db, origin.triggerMessageId)) ??
      getMessage(db, threadRootId);
    if (!message) return { ok: false, reason: "unknown" };
    let run: Run;
    try {
      run = await deps.orchestrator.adoptRun(
        {
          agentId: origin.agentId,
          channelId: origin.channelId,
          conversationId: origin.conversationId,
          triggerKind: "background",
          rootMessageId: origin.rootMessageId,
          relayDepth: origin.relayDepth,
        },
        {
          message,
          requestedBy: store.getRunRequestedBy(db, origin.id),
          backgroundOriginRunId: origin.id,
          threadRootId,
          sessionKey: origin.sessionKey,
          connectionId,
        },
      );
    } catch (err) {
      logger.warn({ err, originRunId: origin.id }, "follow-up run refused");
      return { ok: false, reason: "unknown" };
    }
    try {
      const session = findSessionRow(db, {
        conversationId: origin.conversationId,
        agentId: origin.agentId,
        threadRootId: parseDodokSessionKey(origin.sessionKey)?.threadRootId,
      });
      if (!session) throw apiError("NOT_FOUND", "session of the origin run not found");
      const built = buildInboundDeliver(db, {
        run,
        trigger: { message },
        session,
        needsPromptContext: false,
        now: now(),
      });
      logger.info(
        { runId: run.id, originRunId: origin.id, tasks: req.taskIds.length },
        "follow-up run adopted",
      );
      return {
        ok: true,
        runId: run.id,
        deliver: { ...built, kind: "background", sessionKey: origin.sessionKey },
      };
    } catch (err) {
      logger.error({ err, runId: run.id }, "follow-up deliver build failed");
      await deps.orchestrator.signal(run.id, {
        kind: "gateway_error",
        code: "INTERNAL",
        message: "follow-up deliver build failed",
      });
      return { ok: false, reason: "unknown" };
    }
  }

  // ── 작업 목록 ────────────────────────────────────────────────

  function onTasks(connectionId: string, update: RunnerTasksUpdate | { disconnected: true }): void {
    if (closed) return;
    if ("disconnected" in update) {
      onDisconnected(connectionId);
      return;
    }
    const target = ownedSession(connectionId, update.sessionKey);
    if (!target) {
      logger.warn({ connectionId }, "runner tasks.update for a session of another runner — dropped");
      return;
    }
    // 끊겼던 러너가 보낸 첫 목록 — setup 이벤트보다 먼저 올 수 있다
    if (down.has(connectionId)) beginResync(connectionId);
    const key = keyOf(connectionId, update.sessionKey);
    if (released(target)) {
      // 닫힌·보관한 자리의 작업 — 러너에 그 세션을 놓으라고 한다(끊긴 사이 닫았다)
      if (update.tasks.length > 0) runner()?.releaseSession(connectionId, update.sessionKey);
      remove(key);
      return;
    }
    const tasks = update.tasks.filter((task) => {
      if (ownTask(task, target)) return true;
      logger.warn({ connectionId, taskId: task.taskId }, "background task of another run dropped");
      return false;
    });
    if (tasks.length === 0) {
      // 빈 목록 — 끝났거나 끊긴 사이 비워졌다. 알림 없이 지운다
      if (entries.has(key)) remove(key);
      return;
    }
    entries.set(key, {
      connectionId,
      sessionKey: update.sessionKey,
      ...target,
      tasks,
      runnerConnected: true,
      resynced: true,
    });
    publish(target.channelId, target.conversationId);
  }

  return {
    onFollowup,
    onTasks,
    snapshot(channelId) {
      const conversations = new Set(
        [...entries.values()].filter((e) => e.channelId === channelId).map((e) => e.conversationId),
      );
      return [...conversations].map(conversationView);
    },
    async stop(runId, taskId) {
      const entry = [...entries.values()].find((e) =>
        e.tasks.some((t) => t.taskId === taskId && t.originRunId === runId),
      );
      if (!entry) return;
      if (!entry.runnerConnected) throw apiError("ADAPTER_UNAVAILABLE", "runner is not connected");
      const api = runner();
      const ok = api ? await api.stopTask(entry.connectionId, entry.sessionKey, taskId) : false;
      if (!ok) throw apiError("ADAPTER_UNAVAILABLE", "runner did not stop the task");
    },
    releaseConversation(conversationId, agentId) {
      // 순회 중 현재 항목 삭제(release)는 안전하다
      for (const [key, entry] of entries) {
        if (entry.conversationId === conversationId && (agentId === undefined || entry.agentId === agentId))
          release(key);
      }
    },
    taskCount(runnerTokenId) {
      let n = 0;
      for (const entry of entries.values()) if (entry.connectionId === runnerTokenId) n += entry.tasks.length;
      return n;
    },
    close() {
      if (closed) return;
      closed = true;
      offSetup();
      for (const off of offBus) off();
      for (const timer of resyncTimers.values()) clearTimeout(timer);
      resyncTimers.clear();
    },
  };
}
