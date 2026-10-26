import { type ProviderApproval, parseSessionKey } from "@dodok/openclaw-adapter";
import type { Approval, ApprovalDecision, ApprovalReason, ApprovalStatus, RunSignal } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { agentConnectionId, agentOnConnection } from "../../adapters/connection";
import { canReadChannel } from "../../auth/channel-access";
import type { AdapterRegistry } from "../../adapters/registry";
import {
  type AdapterProvider,
  AdapterError,
  type AgentAdapter,
  type RunEventBody,
} from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getAgent, providerAgentIdIs } from "../agents/service";
import { getChannel } from "../channels/service";
import { getConversation } from "../conversations/store";
import { findOpenRunBySession, getRun } from "../runs/store";
import * as store from "./store";

export type ApprovalsLogger = Pick<Logger, "debug" | "warn" | "error">;

export type ResolveInput = { approvalId: string; decision: ApprovalDecision; userId: string };

/** 제어 서비스가 여는 확인 카드(제어 MCP 스펙 「확인 카드」 장) — 우리 서버가 낸 승인이라 연결이 없다(계획 판정 PC4) */
export type ControlApprovalInput = {
  runId: string;
  channelId: string;
  conversationId: string;
  agentId: string;
  /** 결정할 수 있는 사람 — 그 런의 requested_by */
  requestedBy: string;
  toolName: string;
  title: string;
  description?: string | undefined;
  detail?: string | undefined;
  createdAt: Date;
  expiresAt: Date;
};

/** 확인 카드의 결정 — 「항상 허용」은 받지 않는다(도구 호출 하나만 허락한다) */
const CONTROL_DECISIONS: ApprovalDecision[] = ["allow-once", "deny"];

export type ApprovalsService = {
  /**
   * 어댑터 승인 이벤트 1건을 반영한다 — provider·connectionId 는 승인을 낸 어댑터와 그 연결. 새 사실이면 wire·런 이벤트까지 낸다.
   * 절대 던지지 않는다
   */
  ingest(a: ProviderApproval, provider: AdapterProvider, connectionId: string): void;
  /**
   * 사용자가 카드를 눌렀다 — 설계 4.4 의 검사를 순서대로 통과할 때만 그 에이전트의 어댑터로 보낸다.
   * 검사에 걸리면 `HttpError`(FORBIDDEN·NOT_FOUND·CONFLICT·VALIDATION)를, 어댑터가 거부하면 그 코드(ADAPTER_UNAVAILABLE 등)를 던진다.
   */
  resolve(input: ResolveInput): Promise<Approval>;
  /**
   * 런이 끝났을 때 남은 승인을 닫는다. 런은 이미 끝나는 중이라 런 신호는 보내지 않는다. dodok_control 확인 카드는 닫지 않는다 —
   * 그 카드를 기다리는 도구 호출과 함께 제어 서비스(onRunEnded → closeControl)가 닫는다
   */
  cancelForRun(runId: string, reason: ApprovalReason): void;
  /** 확인 카드를 연다 — 새 사실이라 타임라인·런 신호(awaiting_approval)·wire 까지 낸다 */
  openControl(input: ControlApprovalInput): Approval;
  /**
   * 아직 pending 인 확인 카드를 만료(expired — 런은 대기 직전 상태로 돌아간다)나 취소(cancelled — 런이 끝나는 중)로 닫는다.
   * 이미 닫혔으면 아무것도 하지 않고 undefined
   */
  closeControl(approvalId: string, status: "expired" | "cancelled"): Approval | undefined;
  /**
   * 만료 감시 타이머가 부른다 — 미해결 승인 중 **만료 시각이 지난 것만** expired(timeout)로 닫고
   * 런 신호로 시계를 다시 켠다. 아직 살아 있는 승인은 Gateway 가 여전히 기다리므로 그대로 둔다.
   */
  expireForRun(runId: string): void;
  /** 그 런의 미해결 승인 중 가장 이른 만료 시각 — 감시 타이머를 거는 근거 */
  earliestPendingExpiry(runId: string): Date | undefined;
  /** 구독 ack 의 pendingApprovals — 만료 시각이 지난 것은 뺀다 */
  pendingForChannel(channelId: string): Approval[];
};

/** 승인 서비스가 쓰는 어댑터 면 — 해결 RPC. 연결 검사는 어댑터 안에 있다(러너 계획 판정 P6) */
export type ApprovalsAdapter = Pick<AgentAdapter, "resolveApproval">;

export type ApprovalsDeps = {
  db: Db;
  bus: ServerBus;
  logger: ApprovalsLogger;
  /** 해결을 승인 행의 에이전트 provider 어댑터로 보낸다 */
  registry: Pick<AdapterRegistry, "forAgent">;
  /** 이 워크스페이스의 채널만 다룬다(REST·wire 와 같은 경계) */
  workspaceId: string;
  now?: () => Date;
  /** orchestrator.signal — 런 상태머신에 넘긴다(상태 전이·타임아웃 정지는 오케스트레이터 몫) */
  onSignal(runId: string, signal: RunSignal): void;
  /** orchestrator.applyRunEvent — 활동 타임라인이 순서대로 읽게 남긴다 */
  appendEvent(runId: string, event: RunEventBody): void;
  /**
   * dodok_control 확인 카드가 어떤 길로든(결정·만료·취소) 닫힌 뒤 — 제어 서비스가 기다리던 도구 호출을 이어 가거나 끝낸다.
   * 던져도 승인 처리는 막지 않는다
   */
  onControlSettled?: (approval: Approval) => void;
};

/**
 * 설계 4.2 — 승인의 저장·상관·중계. Gateway 페이로드에 `runId` 가 없어 연결 id + `sessionKey` 로 채널·에이전트·열린 런을 찾는다.
 * 같은 승인이 두 경로(전역 `plugin.approval.*` · 세션 `session.approval` 되감기)로 오므로
 * `(연결, providerApprovalId)` 유일 인덱스 upsert 가 중복을 흡수하고, **새 사실일 때만** 런 이벤트·신호·wire 를 낸다.
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
   * `announce:false` 는 같은 승인을 **두 번째로 읽었을 때** — 어댑터가 두 프레임을 병합해 다시 주면 값이 늦게 찬다
   * (대기 카드의 `urlPath`, 확정 짝 뒤엣것의 `decision`). 값은 wire 로 갱신하되 타임라인에 같은 카드를 또 쌓거나
   * 런을 다시 깨우지 않는다 — 요구도 해결도 마찬가지다.
   * 그래서 wire 에는 같은 승인 id 의 `approval.requested`(또는 `approval.resolved`)가 두 번 갈 수 있고, 둘째는 결함이 아니라
   * 늦게 찬 값(`toolCallId` — 웹이 툴 행과 승인을 잇는 값 — ·`urlPath`·`decision`)의 갱신이다. 받는 쪽은 id 로 병합한다
   * (웹 `features/approvals/approvalStore.ts` 의 mergeApproval). 막으면 그 값이 웹에 닿지 않는다. 푸시는 첫 번만(push seenApprovals).
   */
  function publish(
    approval: Approval,
    opts: { resumeRun: boolean; announce?: boolean } = { resumeRun: true },
  ): void {
    if (approval.runId !== undefined) {
      const runId = approval.runId;
      if (approval.status === "pending") {
        if (opts.announce === false) {
          bus.emit("approval.requested", { approval });
          return;
        }
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
        if (opts.announce === false) {
          bus.emit("approval.resolved", { approval });
          return;
        }
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
    if (approval.kind === "dodok_control" && approval.status !== "pending") {
      try {
        deps.onControlSettled?.(approval);
      } catch (err) {
        logger.error({ err, approvalId: approval.id }, "control approval settle hook failed");
      }
    }
  }

  /** 승인을 요구하기 직전의 런 상태를 기억해 둔다 — 해결 뒤 그 상태로 돌아간다(설계 4.3). 이미 대기 중이면 먼저 기억한 값이 진짜 「직전」이다 */
  function rememberResume(run: { id: string; status: string } | undefined): void {
    if (run && run.status !== "awaiting_approval") {
      resumeTo.set(run.id, run.status === "tool" ? "tool" : "streaming");
    }
  }

  /** 그 런의 미해결 승인 가운데 이 서비스가 닫을 것 — 확인 카드는 제어 서비스가 닫는다(cancelForRun 주석) */
  function pendingProviderApprovals(runId: string): Approval[] {
    return store.listPendingApprovalsByRun(db, runId).filter((a) => a.kind !== "dodok_control");
  }

  /**
   * 건네받은 미해결 승인들을 한 상태로 닫고 중계한다. 한 건이 깨져도 나머지를 닫는다.
   *
   * 행의 `decision` 은 **제공자가 실제로 보고한 결정**만 담는다:
   * - 만료는 Gateway 경로가 `deny`+`timeout` 으로 보고한다 — 우리 감시 타이머가 닫을 때도 같은 모양으로 적는다.
   *   한쪽만 비워 두면 같은 사실이 어느 경로로 닫혔느냐에 따라 행이 달라진다(p2-t6 실측 B).
   * - 취소는 런이 사라져 **우리가** 닫는 것이라 아무도 결정하지 않았다 — 비우고 `status`·`reason` 으로 말한다.
   */
  function close(
    pending: Approval[],
    status: Extract<ApprovalStatus, "cancelled" | "expired">,
    reason: ApprovalReason,
    opts: { resumeRun: boolean },
  ): void {
    const at = now();
    const decision: ApprovalDecision | undefined = status === "expired" ? "deny" : undefined;
    for (const row of pending) {
      try {
        publish(store.markApproval(db, row.id, { status, decision, reason, decidedAt: at }), opts);
      } catch (err) {
        logger.error({ err, approvalId: row.id, runId: row.runId, status }, "approval close failed");
      }
    }
  }

  return {
    ingest(a, provider, connectionId) {
      try {
        // 어댑터가 이미 걸렀지만 서버도 방어한다 — 토큰·본문·툴 인자는 찍지 않는다
        const session = parseSessionKey(a.sessionKey);
        if (!session) {
          logger.warn({ sessionKey: a.sessionKey }, "approval for unknown session");
          return;
        }
        // workspaceId 를 꼭 넘긴다 — 빠뜨리면 다른 워크스페이스 채널의 승인도 받아 적는다(socket.ts 와 같은 규칙)
        const conversation = getConversation(db, session.conversationId, deps.workspaceId);
        const channel = conversation && getChannel(db, conversation.channelId, deps.workspaceId);
        const agentId =
          channel && findAgentId(db, channel.workspaceId, provider, connectionId, session.providerAgentId);
        if (!conversation || !channel || !agentId) {
          logger.warn({ sessionKey: a.sessionKey }, "approval for unknown session");
          return;
        }
        const receivedAt = now();
        // FIFO 직렬화라 그 세션의 열린 런 중 맨 앞(가장 먼저 만든 것)이 지금 Gateway 에서 도는 런이다
        const run = findOpenRunBySession(db, connectionId, a.sessionKey);
        if (a.status === "pending") rememberResume(run);
        const { approval, changed, created, filled } = store.upsertApproval(db, {
          providerApprovalId: a.providerApprovalId,
          connectionId,
          kind: a.kind,
          channelId: channel.id,
          conversationId: conversation.id,
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
        // 처음 본 승인·처음 알게 된 결말만 타임라인 카드·런 신호까지 간다.
        // 두 번째 프레임이 채운 값(대기 카드의 `urlPath`·확정 짝 뒤엣것의 `decision`)은 wire 로만 흘린다
        publish(approval, { resumeRun: true, announce: approval.status === "pending" ? created : !filled });
      } catch (err) {
        // 한 건이 깨져도 다음 승인·다음 이벤트를 막지 않는다(어댑터 이벤트 루프 안에서 불린다)
        logger.error({ err, providerApprovalId: a.providerApprovalId }, "approval ingest failed");
      }
    },

    async resolve({ approvalId, decision, userId }) {
      // 설계 4.4 — 순서대로 검사하고 하나라도 어긋나면 Gateway 로 보내지 않는다.
      // 목록 밖 결정을 보내면 Gateway 가 조용히 거절(malformed-verdict)로 확정한다(스파이크 4.4)
      const approval = store.getApproval(db, approvalId);
      const channel = approval && getChannel(db, approval.channelId, deps.workspaceId);
      if (approval && !channel) {
        throw apiError("FORBIDDEN", "approval is not in this workspace");
      }
      if (!approval) throw apiError("NOT_FOUND", "approval not found");
      // DM 의 승인은 주인만 결정한다(에이전트 DM 계획 판정 PD7) — 남에게는 없는 승인과 같다. wire 가 앞에서 같은 판정을 하지만 결정자
      // 규칙은 여기에도 둔다(이 함수를 부르는 다른 길이 생겨도 주인 말고는 결정하지 못하게)
      if (channel && !canReadChannel({ userId }, channel)) throw apiError("NOT_FOUND", "approval not found");
      if (approval.status !== "pending") throw apiError("CONFLICT", "approval is already resolved");
      if (Date.parse(approval.expiresAt) <= now().getTime()) {
        throw apiError("CONFLICT", "approval has expired");
      }
      if (!approval.allowedDecisions.includes(decision)) {
        throw apiError("VALIDATION", "decision is not allowed for this approval");
      }
      // 확인 카드는 어댑터로 가지 않고 여기서 끝난다(계획 판정 PC4). 결정은 그 일을 시킨 사람 본인만 — 역할은 보지 않는다(wire 가
      // 멤버인지만 본다). 허용 뒤 역할 재확인·실행은 onControlSettled 를 받은 제어 서비스가 한다.
      // await 없이 읽기·쓰기를 한 번에 해 두 결정이 겹쳐도 먼저 쓴 쪽만 pending 을 본다
      if (approval.kind === "dodok_control") {
        if (approval.requestedBy !== userId) {
          throw apiError("FORBIDDEN", "이 확인은 그 일을 시킨 사람만 할 수 있다");
        }
        const marked = store.markApproval(db, approvalId, {
          status: decision === "deny" ? "denied" : "allowed",
          decision,
          reason: "user",
          decidedBy: userId,
          decidedAt: now(),
        });
        logger.debug({ approvalId, decision, userId }, "control approval decided");
        publish(marked);
        return marked;
      }
      // 연결 검사는 어댑터가 한다(판정 P6) — Gateway·러너가 없으면 resolveApproval 이 ADAPTER_UNAVAILABLE 을 던진다
      const agent = getAgent(db, approval.agentId);
      if (!agent) throw apiError("NOT_FOUND", "approval agent not found");
      let adapter: ApprovalsAdapter;
      try {
        adapter = deps.registry.forAgent(agent);
      } catch (err) {
        rethrowAdapterError(err);
      }

      // 승인이 온 연결로 보낸다 — 연결이 빈 행(연결 id 가 생기기 전에 저장된 것)은 에이전트의 지금 연결로
      const connectionId = store.getApprovalConnectionId(db, approvalId) ?? agentConnectionId(db, agent.id);
      if (connectionId === null) throw apiError("ADAPTER_UNAVAILABLE", "approval agent has no connection");
      logger.debug({ approvalId, decision, userId }, "approval resolve sent to adapter");
      const snapshot = await resolveOnAdapter(adapter, approval, decision, connectionId);

      // 기다리는 사이 Gateway 가 같은 사실을 이벤트로 먼저 줬을 수 있다 — 결과는 먼저 온 쪽이 이긴다(설계 4.4).
      // 그래도 이 승인을 해결한 것은 지금 approval.resolve 를 부른 사용자다 — 사람이 여럿인 팀에서는 누가
      // 허용·거절했는지가 감사 기록이라 decided_by 는 비어 있을 때만 채워 뒤늦게라도 남긴다(다른 사용자가
      // 거의 동시에 먼저 결정자로 남았으면 덮지 않는다 — store.claimDecidedBy). 단, 이 사용자의 결정이 실제로
      // 이겼을 때만 채운다 — 두 사람이 거의 동시에 **다른** 결정을 눌렀다면 진 사람의 userId 를 남기면 안 된다
      // (아래 정상 경로의 `outcome.decision === decision ? userId : undefined` 와 같은 비교)
      const current = store.getApproval(db, approvalId);
      if (current?.status !== "pending") {
        logger.debug({ approvalId, status: current?.status }, "approval already resolved — not relayed");
        if (current === undefined) return approval;
        const outcome = resolvedOutcome(current);
        return outcome.decision === decision
          ? (store.claimDecidedBy(db, approvalId, userId) ?? current)
          : current;
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
      // 런이 끝난다 — 만료 시각이 남았든 아니든 전부 닫는다.
      // 런 신호를 보내면 상태가 awaiting_approval 에서 되돌아갔다가 다시 종료로 간다
      close(pendingProviderApprovals(runId), "cancelled", reason, { resumeRun: false });
    },

    openControl(input) {
      rememberResume(getRun(db, input.runId));
      const { approval } = store.upsertApproval(db, {
        providerApprovalId: `control:${uuidv7()}`,
        kind: "dodok_control",
        channelId: input.channelId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        runId: input.runId,
        toolName: input.toolName,
        title: input.title,
        description: input.description,
        detail: input.detail,
        severity: "warning",
        allowedDecisions: CONTROL_DECISIONS,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        requestedBy: input.requestedBy,
      });
      publish(approval);
      return approval;
    },

    closeControl(approvalId, status) {
      const pending = store.getApproval(db, approvalId);
      if (pending?.kind !== "dodok_control" || pending.status !== "pending") return undefined;
      // 만료는 런이 계속 돈다 — 대기 직전 상태로 돌린다. 취소는 런이 끝나는 중이다(cancelForRun 과 같다)
      close([pending], status, status === "expired" ? "timeout" : "run-aborted", {
        resumeRun: status === "expired",
      });
      return store.getApproval(db, approvalId);
    },

    expireForRun(runId) {
      // 감시 타이머는 그 런의 **가장 이른** 만료 시각에 울린다 — 아직 만료되지 않은 승인은 Gateway 가 여전히
      // 기다리는 것이라 그대로 둔다. 쓸어 닫으면 사용자는 살아 있는 카드를 「만료됨」으로 보고 다시 누를 수도 없다
      const at = now().getTime();
      const expired = pendingProviderApprovals(runId).filter(
        (pending) => Date.parse(pending.expiresAt) <= at,
      );
      for (const pending of expired) {
        logger.warn(
          { approvalId: pending.id, runId, expiresAt: pending.expiresAt },
          "approval expired without a gateway verdict",
        );
      }
      close(expired, "expired", "timeout", { resumeRun: true });
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

/** 어댑터의 실패는 그 코드 그대로 사용자에게 돌려준다(연결 끊김·없는 승인·프로토콜·어댑터 없는 provider). */
async function resolveOnAdapter(
  adapter: ApprovalsAdapter,
  approval: Approval,
  decision: ApprovalDecision,
  connectionId: string,
): Promise<ProviderApproval> {
  try {
    return await adapter.resolveApproval(approval.providerApprovalId, approval.kind, decision, connectionId);
  } catch (err) {
    rethrowAdapterError(err);
  }
}

function rethrowAdapterError(err: unknown): never {
  // 패키지 경계를 넘어 클래스가 둘일 수 있어 이름도 본다(orchestrator 와 같은 규칙)
  if (err instanceof AdapterError || (err instanceof Error && err.name === "AdapterError")) {
    throw apiError((err as AdapterError).code, `approval resolve failed: ${err.message}`);
  }
  throw err;
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

/** 세션 키의 `providerAgentId` → 우리 agents.id (워크스페이스·provider·연결 안에서 유일하다) */
function findAgentId(
  db: DbOrTx,
  workspaceId: string,
  provider: AdapterProvider,
  connectionId: string,
  providerAgentId: string,
): string | undefined {
  return db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.provider, provider),
        agentOnConnection(provider, connectionId),
        providerAgentIdIs(providerAgentId),
      ),
    )
    .get()?.id;
}

function isoToDate(iso: string | undefined): Date | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
