import { type ProviderApproval, parseSessionKey } from "@dodok/openclaw-adapter";
import type { AgentProvider, Approval, ApprovalDecision, ApprovalReason, RunSignal } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { RunEventBody } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents } from "../../db/schema.sqlite";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getChannel } from "../channels/service";
import { findOpenRunBySession } from "../runs/store";
import * as store from "./store";

export type ApprovalsLogger = Pick<Logger, "debug" | "warn" | "error">;

export type ApprovalsService = {
  /** 어댑터 승인 이벤트 1건을 반영한다. 새 사실이면 wire·런 이벤트까지 낸다. 절대 던지지 않는다 */
  ingest(a: ProviderApproval): void;
  /** 런이 끝났을 때 남은 승인을 닫는다 */
  cancelForRun(runId: string, reason: ApprovalReason): void;
  /** 구독 ack 의 pendingApprovals — 만료 시각이 지난 것은 뺀다 */
  pendingForChannel(channelId: string): Approval[];
};

export type ApprovalsDeps = {
  db: Db;
  bus: ServerBus;
  logger: ApprovalsLogger;
  /** 세션 키의 에이전트를 찾을 때 쓴다 — 어댑터의 provider */
  provider: AgentProvider;
  now?: () => Date;
  /** orchestrator.signal — 런 상태머신에 넘긴다(상태 전이·타임아웃 정지는 오케스트레이터 몫) */
  onSignal(runId: string, signal: RunSignal): void;
  /** orchestrator.applyRunEvent — 활동 타임라인이 순서대로 읽게 남긴다 */
  appendEvent(runId: string, event: RunEventBody): void;
};

/**
 * 설계 4.2 — 승인의 저장·상관·중계. Gateway 페이로드에 `runId` 가 없어 `sessionKey` 로 채널·에이전트·열린 런을 찾는다.
 * 같은 승인이 두 경로(전역 `plugin.approval.*` · 세션 `session.approval` 되감기)로 오므로
 * `providerApprovalId` 유일 인덱스 upsert 가 중복을 흡수하고, **새 사실일 때만** 런 이벤트·신호·wire 를 낸다.
 */
export function createApprovalsService(deps: ApprovalsDeps): ApprovalsService {
  const { db, bus, logger } = deps;
  const now = deps.now ?? (() => new Date());

  function publish(approval: Approval): void {
    if (approval.runId !== undefined) {
      const runId = approval.runId;
      if (approval.status === "pending") {
        deps.appendEvent(runId, {
          type: "APPROVAL_REQUESTED",
          runId,
          approvalId: approval.id,
          kind: approval.kind,
          title: approval.title,
          severity: approval.severity,
          allowedDecisions: approval.allowedDecisions,
          ...(approval.toolCallId === undefined ? {} : { toolCallId: approval.toolCallId }),
          expiresAt: approval.expiresAt,
        });
        deps.onSignal(runId, { kind: "approval_requested" });
      } else {
        const { decision, reason } = resolvedOutcome(approval);
        deps.appendEvent(runId, {
          type: "APPROVAL_RESOLVED",
          runId,
          approvalId: approval.id,
          decision,
          reason,
          ...(approval.decidedBy === undefined ? {} : { decidedBy: approval.decidedBy }),
        });
        deps.onSignal(runId, { kind: "approval_resolved", decision });
      }
    }
    bus.emit(approval.status === "pending" ? "approval.requested" : "approval.resolved", { approval });
  }

  return {
    ingest(a) {
      try {
        // 어댑터가 이미 걸렀지만 서버도 방어한다 — 토큰·본문·툴 인자는 찍지 않는다
        const session = parseSessionKey(a.sessionKey);
        if (!session) {
          logger.warn({ sessionKey: a.sessionKey }, "approval for unknown session");
          return;
        }
        const channel = getChannel(db, session.channelId);
        const agentId =
          channel && findAgentId(db, channel.workspaceId, deps.provider, session.providerAgentId);
        if (!channel || !agentId) {
          logger.warn({ sessionKey: a.sessionKey }, "approval for unknown session");
          return;
        }
        const receivedAt = now();
        // FIFO 직렬화라 그 세션의 열린 런 중 맨 앞(가장 먼저 만든 것)이 지금 Gateway 에서 도는 런이다
        const run = findOpenRunBySession(db, a.sessionKey);
        const { approval, changed } = store.upsertApproval(db, {
          providerApprovalId: a.providerApprovalId,
          kind: a.kind,
          channelId: channel.id,
          agentId,
          runId: run?.id,
          toolCallId: a.toolCallId,
          toolName: a.toolName,
          pluginId: a.pluginId,
          title: a.title,
          description: a.description,
          detail: a.detail,
          severity: a.severity,
          allowedDecisions: a.allowedDecisions,
          urlPath: a.urlPath,
          status: a.status,
          decision: a.decision,
          reason: a.reason,
          // 다른 디바이스(TUI·다른 탭)가 해결한 승인이다 — decidedBy 는 비우고 시각만 채운다(p2-t2 리뷰 이월 5)
          decidedAt: a.status === "pending" ? undefined : (isoToDate(a.resolvedAt) ?? receivedAt),
          createdAt: isoToDate(a.createdAt) ?? receivedAt,
          expiresAt: isoToDate(a.expiresAt),
        });
        if (!changed) {
          logger.debug(
            { approvalId: approval.id, status: approval.status },
            "approval already known — not relayed",
          );
          return;
        }
        publish(approval);
      } catch (err) {
        // 한 건이 깨져도 다음 승인·다음 이벤트를 막지 않는다(어댑터 이벤트 루프 안에서 불린다)
        logger.error({ err, providerApprovalId: a.providerApprovalId }, "approval ingest failed");
      }
    },

    cancelForRun(runId, reason) {
      const at = now();
      for (const pending of store.listPendingApprovalsByRun(db, runId)) {
        try {
          publish(store.markApproval(db, pending.id, { status: "cancelled", reason, decidedAt: at }));
        } catch (err) {
          logger.error({ err, approvalId: pending.id, runId }, "approval cancel failed");
        }
      }
    },

    pendingForChannel(channelId) {
      return store.listPendingApprovals(db, channelId, now());
    },
  };
}

/**
 * 런 이벤트 `APPROVAL_RESOLVED` 는 `decision`·`reason` 이 필수인데 Gateway 는 만료·취소를 그 값 없이 준다 —
 * 설계 3.2 대로 정규화한다(만료는 `deny` + `timeout`).
 */
export function resolvedOutcome(approval: Pick<Approval, "status" | "decision" | "reason">): {
  decision: ApprovalDecision;
  reason: ApprovalReason;
} {
  const decision = approval.decision ?? (approval.status === "allowed" ? "allow-once" : "deny");
  const reason =
    approval.reason ??
    (approval.status === "expired" ? "timeout" : approval.status === "cancelled" ? "run-aborted" : "user");
  return { decision, reason };
}

/** 세션 키의 `providerAgentId` → 우리 agents.id (워크스페이스·provider 안에서 유일하다) */
function findAgentId(
  db: DbOrTx,
  workspaceId: string,
  provider: AgentProvider,
  providerAgentId: string,
): string | undefined {
  return db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.provider, provider),
        eq(agents.providerAgentId, providerAgentId),
      ),
    )
    .get()?.id;
}

function isoToDate(iso: string | undefined): Date | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
