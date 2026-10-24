import {
  AdapterError,
  type ApprovalDecision,
  type ProviderApproval,
  parseDodokSessionKey,
  type RunnerApprovalRequested,
  type RunnerApprovalResolve,
} from "@dodok/shared";
import type { Runner } from "./connections";

/** 승인 기한 — SDK·CLI 에 기한이 없어 서버가 정한다(러너 스펙 6장, 계획 판정 P5) */
export const RUNNER_APPROVAL_TTL_MS = 600_000;
// 끝난 승인을 기억하는 수 — 뒤늦은 결정에 EXPIRED 로 답하려고 둔다. OpenClaw 어댑터의 승인 기억 상한과 같은 값
const SETTLED_MAX = 1_000;

type Entry = {
  approval: ProviderApproval;
  runner: Runner;
  /** 러너가 붙인 id — 러너에 보낼 때는 이것으로 */
  rawId: string;
  runId: string;
  timer?: ReturnType<typeof setTimeout>;
};

export type RunnerApprovalsOptions = {
  ttlMs: number;
  now: () => number;
  /** runner 는 그 승인을 낸 러너 — 어댑터가 이벤트의 연결 id(러너 토큰 id)로 싣는다 */
  emit: (approval: ProviderApproval, runner: Runner) => void;
  /** 그 러너가 아직 붙어 있는가 — 끊긴 러너에는 결정을 보낼 수 없다(판정 P6) */
  isLive: (runner: Runner) => boolean;
};

/**
 * 러너 승인 표. 서버 쪽 id 는 `runner:<토큰 id>:<러너 id>` — 승인 행의 providerApprovalId 는 제공자를 가리지 않고 유일하므로,
 * 러너가 고른 id 가 OpenClaw 승인이나 다른 러너의 승인 행을 덮지 못하게 토큰 id 로 가른다
 */
export class RunnerApprovals {
  readonly #opts: RunnerApprovalsOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: RunnerApprovalsOptions) {
    this.#opts = opts;
  }

  /**
   * 새 요청이면 pending 을 내고 기한 타이머를 건다. 이미 쓴 id(같은 토큰으로 다시 붙은 러너가 옛 승인의 id 를 다시 쓴 경우 포함)면
   * 무시한다 — 버린 까닭은 돌려주는 값으로 호출자가 로그에 남긴다. sessionKey 는 호출자가 런과 대조했다
   */
  request(runner: Runner, req: RunnerApprovalRequested): "requested" | "duplicate" | "invalid-session" {
    const id = this.#id(runner, req.providerApprovalId);
    if (this.#entries.has(id)) return "duplicate";
    const session = parseDodokSessionKey(req.sessionKey);
    if (!session) return "invalid-session";
    const at = this.#opts.now();
    const approval: ProviderApproval = {
      providerApprovalId: id,
      kind: "tool",
      sessionKey: req.sessionKey,
      providerAgentId: session.providerAgentId,
      conversationId: session.conversationId,
      ...(session.threadRootId === undefined ? {} : { threadRootId: session.threadRootId }),
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      title: req.toolName,
      detail: req.summary,
      severity: "warning",
      allowedDecisions: req.canAllowAlways ? ["allow-once", "allow-always", "deny"] : ["allow-once", "deny"],
      status: "pending",
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.#opts.ttlMs).toISOString(),
    };
    const entry: Entry = { approval, runner, rawId: req.providerApprovalId, runId: req.runId };
    entry.timer = setTimeout(() => this.#expire(entry), this.#opts.ttlMs);
    this.#entries.set(id, entry);
    this.#opts.emit(approval, runner);
    return "requested";
  }

  /** 그 러너가 그 id 를 이미 썼는가(기다리는 중이든 끝났든) */
  used(runner: Runner, rawId: string): boolean {
    return this.#entries.has(this.#id(runner, rawId));
  }

  /** 그 러너의 그 id 승인이 아직 기다리는 중인가 */
  isPending(runner: Runner, rawId: string): boolean {
    return this.#entries.get(this.#id(runner, rawId))?.approval.status === "pending";
  }

  /** 러너가 콜백 signal 끊김을 알렸다 */
  withdraw(runner: Runner, rawId: string): void {
    const entry = this.#entries.get(this.#id(runner, rawId));
    if (entry?.approval.status === "pending")
      this.#settle(entry, { status: "cancelled", reason: "run-aborted" });
  }

  /** 사람이 결정했다. 결정을 러너에 보내고 확정 스냅숏을 돌려준다 */
  resolve(providerApprovalId: string, decision: ApprovalDecision): ProviderApproval {
    const entry = this.#entries.get(providerApprovalId);
    if (!entry) throw new AdapterError("NOT_FOUND", "unknown runner approval");
    const { approval } = entry;
    if (approval.status === "expired") throw new AdapterError("EXPIRED", "approval expired");
    // 이미 결정된 승인은 그 스냅숏 그대로 — OpenClaw 의 applied:false 와 같은 뜻
    if (approval.status === "allowed" || approval.status === "denied") return approval;
    if (!this.#opts.isLive(entry.runner))
      throw new AdapterError("ADAPTER_UNAVAILABLE", "runner disconnected");
    if (approval.status !== "pending") throw new AdapterError("CONFLICT", "approval withdrawn");
    if (!approval.allowedDecisions.includes(decision)) {
      throw new AdapterError("VALIDATION", `decision ${decision} is not allowed for this approval`);
    }
    this.#send(entry, { providerApprovalId: entry.rawId, decision });
    return this.#settle(
      entry,
      {
        status: decision === "deny" ? "denied" : "allowed",
        decision,
        reason: "user",
      },
      false,
    );
  }

  /** 그 런이 끝났다 — 남은 승인은 철회로 닫는다(서버도 런 종료 때 닫는다 — 같은 사실이라 겹쳐도 된다) */
  cancelForRun(runId: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.runId === runId && entry.approval.status === "pending") {
        this.#settle(entry, { status: "cancelled", reason: "run-aborted" });
      }
    }
  }

  cancelForRunner(runner: Runner): void {
    for (const entry of this.#entries.values()) {
      if (entry.runner === runner && entry.approval.status === "pending") {
        this.#settle(entry, { status: "cancelled", reason: "run-aborted" });
      }
    }
  }

  close(): void {
    for (const entry of this.#entries.values()) clearTimeout(entry.timer);
    this.#entries.clear();
  }

  #id(runner: Runner, rawId: string): string {
    return `runner:${runner.tokenId}:${rawId}`;
  }

  #send(entry: Entry, payload: RunnerApprovalResolve): void {
    if (this.#opts.isLive(entry.runner)) entry.runner.socket.emit("approval.resolve", payload);
  }

  /** 기한이 먼저 왔다 — 러너가 도구를 거절로 돌려받아 런이 끝까지 가게 deny 를 보낸다(Review Focus 4) */
  #expire(entry: Entry): void {
    entry.timer = undefined;
    if (entry.approval.status !== "pending") return;
    this.#send(entry, { providerApprovalId: entry.rawId, decision: "deny", reason: "expired" });
    // 만료는 Gateway 경로와 같은 모양(deny + timeout)으로 — 서버 승인 서비스가 같은 사실을 같은 행으로 적는다
    this.#settle(entry, { status: "expired", decision: "deny", reason: "timeout" });
  }

  #settle(
    entry: Entry,
    patch: Pick<ProviderApproval, "status" | "decision" | "reason">,
    emit = true,
  ): ProviderApproval {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const approval: ProviderApproval = {
      ...entry.approval,
      ...patch,
      resolvedAt: new Date(this.#opts.now()).toISOString(),
    };
    if (approval.decision === undefined) delete approval.decision;
    entry.approval = approval;
    // 다시 넣어 맨 뒤로 — 끝난 것 중 오래된 것부터 잊는다. 떠 있는 승인은 잊지 않는다
    const id = approval.providerApprovalId;
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    let settled = 0;
    for (const e of this.#entries.values()) if (e.approval.status !== "pending") settled += 1;
    for (const [key, e] of this.#entries) {
      if (settled <= SETTLED_MAX) break;
      if (e.approval.status === "pending") continue;
      this.#entries.delete(key);
      settled -= 1;
    }
    if (emit) this.#opts.emit(approval, entry.runner);
    return approval;
  }
}
