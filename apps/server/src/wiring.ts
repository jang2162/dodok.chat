import type { OpenClawAdapterOptions } from "@dodok/openclaw-adapter";
import { eq } from "drizzle-orm";
import { connectionIdOf } from "./adapters/connection";
import type { AdapterRegistry } from "./adapters/registry";
import type { Db, DbOrTx } from "./db/client";
import { agentSessions, agents } from "./db/schema.sqlite";
import { apiError } from "./http/errors";
import type { Logger } from "./logger";
import { type ApprovalsService, createApprovalsService } from "./modules/approvals/service";
import { interact } from "./modules/components/service";
import { createRunGate } from "./modules/ops/budget";
import { createOpsService, type OpsService } from "./modules/ops/service";
import { createRouter, type Router } from "./modules/router/service";
import { createOrchestrator, type Orchestrator, type RunTimeouts } from "./modules/runs/orchestrator";
import * as store from "./modules/runs/store";
import type { ServerBus } from "./realtime/bus";
import type { RunsFacade } from "./realtime/types";

export type ServicesDeps = {
  db: Db;
  bus: ServerBus;
  logger: Logger;
  registry: AdapterRegistry;
  /** 런·메시지의 채널이 이 워크스페이스에 있어야 wire 가 다룬다(REST 와 같은 경계) */
  workspaceId: string;
  timeouts?: Partial<RunTimeouts> | undefined;
};

export type Services = {
  router: Router;
  orchestrator: Orchestrator;
  runs: RunsFacade;
  approvals: ApprovalsService;
  ops: OpsService;
};

export type SessionRecoverTarget = ReturnType<
  NonNullable<OpenClawAdapterOptions["sessionKeysToRecover"]>
>[number];

/**
 * OpenClaw 어댑터 재접속 복구 대상 — OpenClaw 에이전트의 agent_sessions 전부를 연결(Gateway)별로. agentId 는 Gateway 쪽 id
 * (providerAgentId), 커서는 저장된 것만 싣는다. 다른 provider 의 세션은 Gateway 에 없다
 */
export function sessionRecoverTargets(db: DbOrTx): Map<string, SessionRecoverTarget[]> {
  const rows = db
    .select({
      sessionKey: agentSessions.sessionKey,
      agentId: agents.providerAgentId,
      cursor: agentSessions.historyCursor,
      provider: agents.provider,
      gatewayId: agents.gatewayId,
    })
    .from(agentSessions)
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .where(eq(agents.provider, "openclaw"))
    .all();
  const byConnection = new Map<string, SessionRecoverTarget[]>();
  for (const { cursor, provider, gatewayId, ...target } of rows) {
    const connectionId = connectionIdOf({ provider, gatewayId, runnerTokenId: null });
    if (connectionId === null) continue;
    const list = byConnection.get(connectionId) ?? [];
    list.push(cursor === null ? target : { ...target, cursor });
    byConnection.set(connectionId, list);
  }
  return byConnection;
}

/**
 * 라우터 ↔ 오케스트레이터 상호 참조를 묶는다 — 라우터는 enqueue 로 오케스트레이터를 부르고,
 * 오케스트레이터는 정본 저장 직후 라우터로 릴레이를 판단한다.
 */
export function createServices(deps: ServicesDeps): Services {
  const { db, bus, logger, registry, workspaceId } = deps;
  const ops = createOpsService({ db, bus, logger, workspaceId });
  // 라우터를 먼저 만든다 — enqueue 는 메시지가 들어올 때(이 함수가 끝난 뒤) 불리므로 그때는 orchestrator 가 있다
  let orchestrator: Orchestrator;
  const enqueue: Orchestrator["enqueueRun"] = (plan, trigger) => orchestrator.enqueueRun(plan, trigger);
  // 런을 만드는 경로(라우터·상호작용·다시 실행)는 모두 관문을 지난다(스펙 3.2)
  const gate = createRunGate({ db, bus, ops, workspaceId, enqueue });
  const router = createRouter({ db, bus, logger, enqueue: gate.enqueue });
  // 승인 서비스도 같은 방식으로 먼저 만든다 — 런 이벤트·신호를 오케스트레이터로 되돌려 보내고,
  // 오케스트레이터는 어댑터 승인 이벤트를 이 서비스로 넘긴다(서로가 서로를 부른다)
  const approvals = createApprovalsService({
    db,
    bus,
    logger,
    registry,
    workspaceId,
    onSignal: (runId, signal) => void orchestrator.signal(runId, signal),
    appendEvent: (runId, event) => void orchestrator.applyRunEvent(runId, event),
  });
  orchestrator = createOrchestrator({
    db,
    bus,
    registry,
    logger,
    approvals,
    timeouts: deps.timeouts,
    onAgentMessage: (message) => router.routeMessage(message),
  });

  const visibleRun = (runId: string) => {
    const run = store.getRunInWorkspace(db, runId, workspaceId);
    if (!run) throw apiError("NOT_FOUND", "run not found");
    return run;
  };

  const runs: RunsFacade = {
    activeRuns: (channelId) => orchestrator.activeRuns(channelId),
    pendingApprovals: (channelId) => approvals.pendingForChannel(channelId),
    async resolveApproval({ approvalId, decision, userId }) {
      logger.info({ approvalId, decision, userId }, "approval resolve requested");
      await approvals.resolve({ approvalId, decision, userId });
    },
    async abort(runId, userId) {
      visibleRun(runId);
      logger.info({ runId, userId }, "run abort requested");
      await orchestrator.abort(runId);
    },
    async replay(runId, afterSeq) {
      const run = visibleRun(runId);
      return { events: store.listRunEvents(db, runId, afterSeq), run: store.toRunState(run) };
    },
    interact: (input) => interact({ db, bus, workspaceId, gate }, input),
  };

  return { router, orchestrator, runs, approvals, ops };
}
