import {
  type Approval,
  type ControlResult,
  findControlTool,
  type OpsStatus,
  type TeamRole,
} from "@dodok/shared";
import { roleOf } from "../../auth/roles";
import type { Db } from "../../db/client";
import { apiError, HttpError } from "../../http/errors";
import { parsePayload } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { josa } from "../../util/josa";
import type { AgentActionContext } from "../agents/actions";
import { getAgent } from "../agents/service";
import type { ApprovalsService } from "../approvals/service";
import type { ChannelActionContext } from "../channels/actions";
import { createSystemMessage } from "../messages/service";
import type { Limits } from "../ops/limits";
import { KeyedLimiter, monotonicNow } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import { type Confirmations, createConfirmations, userHandle } from "./confirm";
import { type AnyHandler, type HandlerContext, handlerFor } from "./handlers";
import type { Principal } from "./principal";

// 제어 서비스(제어 MCP 스펙 「실행 흐름」 장) — 바깥 MCP 클라이언트(/mcp)와 채널 안 에이전트(러너·플러그인)가 같은 입구로 부른다.
// 레이트 → 도구 찾기 → 입력 Zod → 역할(그때 읽은 시킨 사람의 역할, REST 와 같은 정책 함수) → (채널 안 에이전트의 쓰기면) 확인 카드
// → 허용 뒤 역할 다시 → 실행(REST 와 같은 액션 함수) → 운영 사건·시스템 메시지. 결과는 던지지 않고 ControlResult 로 돌려준다

export type ControlDeps = {
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  ops: Pick<OpsService, "record">;
  limits: Pick<Limits, "controlPerMin" | "controlWritePerMin">;
  approvals: Pick<ApprovalsService, "openControl" | "closeControl">;
  channels: ChannelActionContext;
  agents: AgentActionContext;
  opsStatus(): OpsStatus;
  /** 레이트리밋 시계(ms) — 테스트 주입. 기본 단조 시계 */
  now?: () => number;
  /** 카드 시각·검색 날짜의 벽시계 */
  clock?: () => Date;
  /** 확인 카드 기한 — 기본 CONTROL_CONFIRM_TTL_MS(10분) */
  confirmTtlMs?: number;
};

export type ControlService = {
  /** 도구 하나를 부른다. 절대 던지지 않는다 — 오류는 { ok: false, error: { code, message } }(ErrorCode 그대로) */
  call(principal: Principal, tool: string, args: unknown): Promise<ControlResult>;
  /** 런이 끝나면 오케스트레이터가 부른다 — 그 런의 대기 카드를 cancelled 로, 기다리던 호출은 EXPIRED */
  onRunEnded(runId: string): void;
  /** 승인 서비스가 확인 카드를 닫은 뒤 부른다 — 기다리던 호출을 이어 가거나 끝낸다 */
  onApprovalSettled(approval: Approval): void;
};

const ROLES: readonly TeamRole[] = ["member", "admin", "owner"];

/** 바꾼 값을 남기지 않는다 — 운영 사건 detail 은 누가·어디·무엇(도구)만(스펙 「실행 흐름」 장) */
type ChangeDetail = {
  userId: string;
  via: Principal["via"];
  agentId?: string;
  tool: string;
  channelId?: string;
  targetAgentId?: string;
};

export function createControlService(deps: ControlDeps): ControlService {
  const { db, logger, workspaceId } = deps;
  const clock = deps.clock ?? (() => new Date());
  const now = deps.now ?? monotonicNow;
  const allCalls = new KeyedLimiter({ perMin: deps.limits.controlPerMin, now });
  const writeCalls = new KeyedLimiter({ perMin: deps.limits.controlWritePerMin, now });
  const confirmations: Confirmations = createConfirmations({
    db,
    logger,
    approvals: deps.approvals,
    workspaceId,
    now: clock,
    ...(deps.confirmTtlMs === undefined ? {} : { ttlMs: deps.confirmTtlMs }),
  });
  const ctx: HandlerContext = {
    db,
    workspaceId,
    channels: deps.channels,
    agents: deps.agents,
    opsStatus: deps.opsStatus,
    now: clock,
  };

  /** 주체마다 — 같은 사람이라도 개인 토큰과 각 에이전트는 따로 센다 */
  const principalKey = (p: Principal) => `${p.via}:${p.userId ?? "-"}:${p.agentId ?? "-"}`;

  function limited(bucket: KeyedLimiter, p: Principal): boolean {
    if (bucket.take(principalKey(p))) return false;
    deps.ops.record({ kind: "ratelimit", key: `control:${p.via}`, severity: "info" });
    return true;
  }

  /** 시킨 사람이 없으면(자동화 글로 시작한 사슬) 읽기만 — member 만큼 읽는다 */
  function roleFor(p: Principal, write: boolean): TeamRole | undefined {
    if (p.userId === null) {
      if (write) throw apiError("FORBIDDEN", "사람이 시킨 런에서만 바꿀 수 있습니다");
      return "member";
    }
    return roleOf(db, workspaceId, p.userId);
  }

  /**
   * 같은 REST 정책 함수로 판정하고, 거절이면 「이 일은 admin 이상만 할 수 있습니다(시킨 사람: @mia, member)」로 다시 쓴다. 최소 역할은
   * 정책 함수에 역할을 하나씩 넣어 본다 — 도구마다 역할 표를 따로 두지 않는다(계획 판정 PC1)
   */
  function authorize(
    handler: AnyHandler,
    p: Principal,
    role: TeamRole | undefined,
    raw: Record<string, unknown>,
  ): void {
    try {
      handler.authorize(role, raw);
    } catch (err) {
      if (!(err instanceof HttpError) || err.body.code !== "FORBIDDEN") throw err;
      const min = ROLES.find((r) => passes(handler, r, raw));
      const need = min === undefined ? "이 일은 할 수 없습니다" : `이 일은 ${min} 이상만 할 수 있습니다`;
      const who = p.userId === null ? undefined : `@${userHandle(db, p.userId) ?? "알 수 없음"}`;
      const current = role ?? "멤버 아님";
      const why = p.via === "agent" ? `(시킨 사람: ${who}, ${current})` : `(지금 역할: ${current})`;
      throw apiError("FORBIDDEN", `${need}${why}`);
    }
  }

  async function run(p: Principal, toolName: string, args: unknown): Promise<unknown> {
    if (limited(allCalls, p)) throw apiError("RATE_LIMITED", "제어 도구 호출이 너무 많습니다");
    const tool = findControlTool(toolName);
    if (!tool) throw apiError("NOT_FOUND", `unknown tool: ${toolName}`);
    const write = tool.access === "write";
    if (write && limited(writeCalls, p)) throw apiError("RATE_LIMITED", "제어 도구 쓰기가 너무 많습니다");
    const input = parsePayload(tool.input, args);
    const raw = args as Record<string, unknown>;
    const handler = handlerFor(tool);
    authorize(handler, p, roleFor(p, write), raw);
    handler.check?.(ctx, input);
    if (write && p.via === "agent") {
      await confirm(p, tool.name, handler, input);
      // 허용 때 다시 — 기다리는 사이 강등·비활성화·보관이 있었을 수 있다(결정 7)
      authorize(handler, p, roleFor(p, write), raw);
      handler.check?.(ctx, input);
    }
    const data = await handler.run(ctx, input, p);
    if (write) recordChange(p, tool.name, handler, input, data);
    return data;
  }

  async function confirm(p: Principal, toolName: string, handler: AnyHandler, input: unknown) {
    if (p.userId === null || p.runId === undefined || p.agentId === undefined)
      throw apiError("FORBIDDEN", "사람이 시킨 런에서만 바꿀 수 있습니다");
    const wording = handler.wording?.(ctx, input);
    const settled = await confirmations.request({
      runId: p.runId,
      requestedBy: p.userId,
      agentId: p.agentId,
      toolName,
      want: wording?.want ?? `${toolName} 을 부르려 합니다`,
      summary: handler.summary?.(ctx, input),
    });
    switch (settled.status) {
      case "allowed":
        return;
      case "denied": {
        const who = userHandle(db, p.userId) ?? "알 수 없음";
        throw apiError("FORBIDDEN", `@${who} ${josa(who, "이", "가")} 거절했습니다`);
      }
      case "expired":
        throw apiError("EXPIRED", "확인 카드가 만료되었습니다");
      default:
        throw apiError("EXPIRED", "런이 끝나 확인 카드가 닫혔습니다");
    }
  }

  /** 쓰기 뒤 — 운영 사건과(채널 설정이면) 그 채널의 시스템 메시지. 실패해도 바꾼 것은 그대로다(로그만) */
  function recordChange(
    p: Principal,
    toolName: string,
    handler: AnyHandler,
    input: unknown,
    data: unknown,
  ): void {
    if (p.userId === null) return;
    try {
      const channelId = handler.channelId?.(input) ?? createdChannelId(data);
      const targetAgentId = handler.targetAgentId?.(input) ?? createdAgentId(data);
      const detail: ChangeDetail = {
        userId: p.userId,
        via: p.via,
        tool: toolName,
        ...(p.agentId === undefined ? {} : { agentId: p.agentId }),
        ...(channelId === undefined ? {} : { channelId }),
        ...(targetAgentId === undefined ? {} : { targetAgentId }),
      };
      deps.ops.record({ kind: "control_change", key: `control:${toolName}`, severity: "info", detail });
      const done = handler.wording?.(ctx, input).done;
      if (handler.channelId === undefined || channelId === undefined || done === undefined) return;
      const who = userHandle(db, p.userId) ?? "알 수 없음";
      const agent = p.agentId === undefined ? undefined : (getAgent(db, p.agentId)?.handle ?? "unknown");
      const bodyMd =
        agent === undefined
          ? `@${who} ${josa(who, "이", "가")} MCP 로 ${done}`
          : `@${who} 의 요청으로 @${agent} ${josa(agent, "이", "가")} ${done}`;
      createSystemMessage(db, deps.bus, { channelId, kind: "info", bodyMd, systemMeta: { kind: "info" } });
    } catch (err) {
      logger.error({ err, tool: toolName }, "control change record failed");
    }
  }

  return {
    async call(principal, tool, args) {
      try {
        return { ok: true, data: await run(principal, tool, args) };
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.body.code === "INTERNAL") logger.error({ err, tool }, "control call failed");
          return { ok: false, error: { code: err.body.code, message: err.body.message } };
        }
        logger.error({ err, tool }, "control call failed");
        return { ok: false, error: { code: "INTERNAL", message: "internal error" } };
      }
    },
    onRunEnded: (runId) => confirmations.onRunEnded(runId),
    onApprovalSettled: (approval) => confirmations.onApprovalSettled(approval),
  };
}

function passes(handler: AnyHandler, role: TeamRole, raw: Record<string, unknown>): boolean {
  try {
    handler.authorize(role, raw);
    return true;
  } catch {
    return false;
  }
}

/** create_channel·register_agent 는 만든 뒤에야 id 를 안다 */
function createdChannelId(data: unknown): string | undefined {
  const id = (data as { channel?: { id?: unknown } } | undefined)?.channel?.id;
  return typeof id === "string" ? id : undefined;
}

function createdAgentId(data: unknown): string | undefined {
  const id = (data as { agent?: { id?: unknown } } | undefined)?.agent?.id;
  return typeof id === "string" ? id : undefined;
}
