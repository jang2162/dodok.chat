import { type ProviderApproval, parseSessionKey } from "@dodok/openclaw-adapter";
import type { Approval, ApprovalDecision, ApprovalReason, ApprovalStatus, RunSignal } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { AdapterError, type AgentAdapter, type RunEventBody } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getChannel } from "../channels/service";
import { findOpenRunBySession } from "../runs/store";
import * as store from "./store";

export type ApprovalsLogger = Pick<Logger, "debug" | "warn" | "error">;

export type ResolveInput = { approvalId: string; decision: ApprovalDecision; userId: string };

export type ApprovalsService = {
  /** 어댑터 승인 이벤트 1건을 반영한다. 새 사실이면 wire·런 이벤트까지 낸다. 절대 던지지 않는다 */
  ingest(a: ProviderApproval): void;
  /**
   * 사용자가 카드를 눌렀다 — 설계 4.4 의 검사를 순서대로 통과할 때만 Gateway 로 보낸다.
   * 검사에 걸리면 `HttpError`(FORBIDDEN·NOT_FOUND·CONFLICT·VALIDATION·ADAPTER_UNAVAILABLE)를 던진다.
   */
  resolve(input: ResolveInput): Promise<Approval>;
  /** 런이 끝났을 때 남은 승인을 닫는다. 런은 이미 끝나는 중이라 런 신호는 보내지 않는다 */
  cancelForRun(runId: string, reason: ApprovalReason): void;
  /** 만료 감시 타이머가 부른다 — 남은 승인을 expired(timeout)로 닫고 런 신호로 시계를 다시 켠다 */
  expireForRun(runId: string): void;
  /** 그 런의 미해결 승인 중 가장 이른 만료 시각 — 감시 타이머를 거는 근거 */
  earliestPendingExpiry(runId: string): Date | undefined;
  /** 구독 ack 의 pendingApprovals — 만료 시각이 지난 것은 뺀다 */
  pendingForChannel(channelId: string): Approval[];
};

/** 승인 서비스가 쓰는 어댑터 면 — 해결 RPC 와 연결 상태(설계 4.4 마지막 검사) */
export type ApprovalsAdapter = Pick<AgentAdapter, "provider" | "status" | "resolveApproval">;

export type ApprovalsDeps = {
  db: Db;
  bus: ServerBus;
  logger: ApprovalsLogger;
  /** 세션 키의 에이전트를 찾고, 해결을 Gateway 로 보낸다 */
  adapter: ApprovalsAdapter;
  /** 이 워크스페이스의 채널만 다룬다(REST·wire 와 같은 경계) */
  workspaceId: string;
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
  /**
   * runId → 승인을 요구하기 직전의 런 상태(설계 4.3 「직전 상태로 복귀」). 런 행에 열을 더하지 않고 메모리에 둔다 —
   * 서버가 죽으면 그 런은 `recoverOnBoot` 가 닫으므로 기억을 잃어도 잃을 런이 없다. 그래도 남으면 `tool` 로 본다.
   */
  const resumeTo = new Map<string, "streaming" | "tool">();

  /**
   * 새 사실 하나를 활동 타임라인·wire 로 내보내고, 런 상태머신에 신호를 준다.
   * `resumeRun:false` 는 런이 끝나는 중일 때 — 대기 직전 상태로 되돌렸다가 다시 종료로 가는 깜빡임을 막는다.
   */
  function publish(approval: Approval, opts: { resumeRun: boolean } = { resumeRun: true }): void {
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
        // 재기동으로 기억이 없으면 툴 진행 중이었다고 본다(설계 4.3)
        const resume = resumeTo.get(runId) ?? "tool";
        // 그 런의 마지막 미해결 승인이었으면 기억도 버린다(런이 끝나지 않고도 정리된다)
        if (store.listPendingApprovalsByRun(db, runId).length === 0) resumeTo.delete(runId);
        if (opts.resumeRun) deps.onSignal(runId, { kind: "approval_resolved", decision, resumeTo: resume });
      }
    }
    bus.emit(approval.status === "pending" ? "approval.requested" : "approval.resolved", { approval });
  }

  /** 그 런의 미해결 승인을 한 상태로 닫고 중계한다. 한 건이 깨져도 나머지를 닫는다 */
  function closePending(
    runId: string,
    status: Extract<ApprovalStatus, "cancelled" | "expired">,
    reason: ApprovalReason,
    opts: { resumeRun: boolean },
  ): void {
    const at = now();
    for (const pending of store.listPendingApprovalsByRun(db, runId)) {
      try {
        publish(store.markApproval(db, pending.id, { status, reason, decidedAt: at }), opts);
      } catch (err) {
        logger.error({ err, approvalId: pending.id, runId, status }, "approval close failed");
      }
    }
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
        // workspaceId 를 꼭 넘긴다 — 빠뜨리면 다른 워크스페이스 채널의 승인도 받아 적는다(socket.ts 와 같은 규칙)
        const channel = getChannel(db, session.channelId, deps.workspaceId);
        const agentId =
          channel && findAgentId(db, channel.workspaceId, deps.adapter.provider, session.providerAgentId);
        if (!channel || !agentId) {
          logger.warn({ sessionKey: a.sessionKey }, "approval for unknown session");
          return;
        }
        const receivedAt = now();
        // FIFO 직렬화라 그 세션의 열린 런 중 맨 앞(가장 먼저 만든 것)이 지금 Gateway 에서 도는 런이다
        const run = findOpenRunBySession(db, a.sessionKey);
        // 승인을 요구하기 직전의 런 상태를 기억해 둔다 — 해결 뒤 그 상태로 돌아간다(설계 4.3).
        // 이미 대기 중이면(같은 런의 두 번째 승인) 먼저 기억한 값이 진짜 「직전」이다
        if (run && a.status === "pending" && run.status !== "awaiting_approval") {
          resumeTo.set(run.id, run.status === "tool" ? "tool" : "streaming");
        }
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

    async resolve({ approvalId, decision, userId }) {
      // 설계 4.4 — 순서대로 검사하고 하나라도 어긋나면 Gateway 로 보내지 않는다.
      // 목록 밖 결정을 보내면 Gateway 가 조용히 거절(malformed-verdict)로 확정한다(스파이크 4.4)
      const approval = store.getApproval(db, approvalId);
      if (approval && !getChannel(db, approval.channelId, deps.workspaceId)) {
        throw apiError("FORBIDDEN", "approval is not in this workspace");
      }
      if (!approval) throw apiError("NOT_FOUND", "approval not found");
      if (approval.status !== "pending") throw apiError("CONFLICT", "approval is already resolved");
      if (Date.parse(approval.expiresAt) <= now().getTime()) {
        throw apiError("CONFLICT", "approval has expired");
      }
      if (!approval.allowedDecisions.includes(decision)) {
        throw apiError("VALIDATION", "decision is not allowed for this approval");
      }
      if (deps.adapter.status().gateway !== "connected") {
        throw apiError("ADAPTER_UNAVAILABLE", "gateway is not connected");
      }

      logger.debug({ approvalId, decision, userId }, "approval resolve sent to gateway");
      const snapshot = await resolveOnGateway(deps.adapter, approval, decision);

      // 기다리는 사이 Gateway 가 같은 사실을 이벤트로 먼저 줬을 수 있다 — 먼저 온 쪽이 이긴다(설계 4.4)
      const current = store.getApproval(db, approvalId);
      if (current?.status !== "pending") {
        logger.debug({ approvalId, status: current?.status }, "approval already resolved — not relayed");
        return current ?? approval;
      }
      // Gateway 가 준 terminal 스냅샷이 정본이다. 읽을 수 없으면(pending) 우리가 보낸 결정으로 닫는다
      const status: ApprovalStatus =
        snapshot.status === "pending" ? (decision === "deny" ? "denied" : "allowed") : snapshot.status;
      const outcome = resolvedOutcome({
        status,
        decision: snapshot.decision ?? decision,
        reason: snapshot.reason,
      });
      const marked = store.markApproval(db, approvalId, {
        status,
        decision: outcome.decision,
        reason: outcome.reason,
        // 우리 사용자가 누른 결정이 그대로 확정됐을 때만 해결자를 적는다 — 다른 디바이스가 먼저 눌렀으면 비운다
        decidedBy: outcome.decision === decision ? userId : undefined,
        decidedAt: isoToDate(snapshot.resolvedAt) ?? now(),
      });
      publish(marked);
      return marked;
    },

    cancelForRun(runId, reason) {
      // 런이 끝나는 중이다 — 런 신호를 보내면 상태가 awaiting_approval 에서 되돌아갔다가 다시 종료로 간다
      closePending(runId, "cancelled", reason, { resumeRun: false });
    },

    expireForRun(runId) {
      for (const pending of store.listPendingApprovalsByRun(db, runId)) {
        logger.warn(
          { approvalId: pending.id, runId, expiresAt: pending.expiresAt },
          "approval expired without a gateway verdict",
        );
      }
      closePending(runId, "expired", "timeout", { resumeRun: true });
    },

    earliestPendingExpiry(runId) {
      let earliest: Date | undefined;
      for (const pending of store.listPendingApprovalsByRun(db, runId)) {
        const at = new Date(pending.expiresAt);
        if (earliest === undefined || at.getTime() < earliest.getTime()) earliest = at;
      }
      return earliest;
    },

    pendingForChannel(channelId) {
      return store.listPendingApprovals(db, channelId, now());
    },
  };
}

/** Gateway RPC 의 실패는 어댑터 코드 그대로 사용자에게 돌려준다(연결 끊김·없는 승인·프로토콜). */
async function resolveOnGateway(
  adapter: ApprovalsAdapter,
  approval: Approval,
  decision: ApprovalDecision,
): Promise<ProviderApproval> {
  try {
    return await adapter.resolveApproval(approval.providerApprovalId, approval.kind, decision);
  } catch (err) {
    // 패키지 경계를 넘어 클래스가 둘일 수 있어 이름도 본다(orchestrator 와 같은 규칙)
    if (err instanceof AdapterError || (err instanceof Error && err.name === "AdapterError")) {
      throw apiError((err as AdapterError).code, `approval resolve failed: ${err.message}`);
    }
    throw err;
  }
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
  provider: ApprovalsAdapter["provider"],
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
