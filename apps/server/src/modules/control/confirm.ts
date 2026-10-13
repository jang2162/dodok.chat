import { type Approval, CONTROL_CONFIRM_TTL_MS, type Message } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { approvals as approvalsTable, componentInteractions, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import { josa } from "../../util/josa";
import { getAgent } from "../agents/service";
import type { ApprovalsService } from "../approvals/service";
import { getChannel } from "../channels/service";
import { getMessage } from "../messages/service";
import { TERMINAL_STATUSES } from "../runs/machine";
import { getRun } from "../runs/store";
import { mentionHandleOf } from "../search/service";
import { readableMentions } from "../search/readable";

// 확인 카드(제어 MCP 스펙 「확인 카드」 장) — 채널 안 에이전트의 쓰기는 그 런을 시킨 사람이 허용해야 실행된다. 카드 행은 승인 서비스가
// 저장·중계하고(kind dodok_control), 이 모듈은 카드를 기다리는 도구 호출·만료 타이머·런 종료를 맡는다

/** 출처 줄에 싣는 트리거 글의 앞부분 */
const ORIGIN_EXCERPT_MAX = 120;
/** 릴레이 사슬을 거슬러 올라갈 상한 — 릴레이 깊이 상한(maxRelayTurns ≤ 32)보다 넉넉하게 */
const ORIGIN_HOPS_MAX = 40;

export type ConfirmDeps = {
  db: DbOrTx;
  logger: Pick<Logger, "warn" | "error">;
  approvals: Pick<ApprovalsService, "openControl" | "closeControl">;
  workspaceId: string;
  now(): Date;
  ttlMs?: number;
};

export type ConfirmRequest = {
  runId: string;
  requestedBy: string;
  agentId: string;
  toolName: string;
  /** 「…하려 합니다」 — 카드 제목의 술어(handlers.ts Wording.want) */
  want: string;
  summary?: string | undefined;
};

export type Confirmations = {
  /** 카드를 열고, 어떤 길로든 닫히면 그때의 카드를 돌려준다(allowed·denied·expired·cancelled) */
  request(req: ConfirmRequest): Promise<Approval>;
  /** 승인 서비스가 확인 카드를 닫은 뒤 부른다(wiring.ts onControlSettled) */
  onApprovalSettled(approval: Approval): void;
  /** 런이 끝났다 — 그 런의 대기 카드를 cancelled 로 닫는다(오케스트레이터가 terminal 전이 전에 부른다) */
  onRunEnded(runId: string): void;
};

type Waiter = { runId: string; settle(approval: Approval): void; timer: ReturnType<typeof setTimeout> };

export function createConfirmations(deps: ConfirmDeps): Confirmations {
  const { db, logger } = deps;
  const ttlMs = deps.ttlMs ?? CONTROL_CONFIRM_TTL_MS;
  const waiters = new Map<string, Waiter>();

  function expire(approvalId: string): void {
    try {
      // 닫히면 승인 서비스가 onApprovalSettled 로 되돌려 부른다 — 이미 닫혔으면(결정이 먼저 왔다) 아무것도 하지 않는다
      deps.approvals.closeControl(approvalId, "expired");
    } catch (err) {
      logger.error({ err, approvalId }, "control confirmation expire failed");
    }
  }

  return {
    request(req) {
      const run = getRun(db, req.runId);
      // 끝난 런에 카드를 열면 닫아 줄 런 종료가 다시 오지 않는다 — 주체를 만든 뒤 런이 끝났으면 여기서 거절한다
      if (!run || TERMINAL_STATUSES.has(run.status)) throw apiError("NOT_FOUND", "run is not open");
      const agent = getAgent(db, req.agentId)?.handle ?? "unknown";
      const createdAt = deps.now();
      const approval = deps.approvals.openControl({
        runId: run.id,
        channelId: run.channelId,
        agentId: run.agentId,
        requestedBy: req.requestedBy,
        toolName: req.toolName,
        title: clip(`@${agent} ${josa(agent, "이", "가")} ${req.want}`, 200),
        description: req.summary === undefined ? undefined : clip(req.summary, 512),
        detail: originText(db, deps.workspaceId, run.id, req.requestedBy),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + ttlMs),
      });
      return new Promise<Approval>((resolve) => {
        const timer = setTimeout(() => expire(approval.id), ttlMs);
        timer.unref?.();
        waiters.set(approval.id, { runId: run.id, settle: resolve, timer });
      });
    },

    onApprovalSettled(approval) {
      const waiter = waiters.get(approval.id);
      if (!waiter) return;
      waiters.delete(approval.id);
      clearTimeout(waiter.timer);
      waiter.settle(approval);
    },

    onRunEnded(runId) {
      // 기억(waiters)이 아니라 행을 본다 — 이 프로세스가 기다리지 않는 카드(재시작 전에 연 것)도 닫는다
      const pending = db
        .select({ id: approvalsTable.id })
        .from(approvalsTable)
        .where(
          and(
            eq(approvalsTable.runId, runId),
            eq(approvalsTable.kind, "dodok_control"),
            eq(approvalsTable.status, "pending"),
          ),
        )
        .all();
      for (const { id } of pending) {
        try {
          deps.approvals.closeControl(id, "cancelled");
        } catch (err) {
          logger.error({ err, approvalId: id, runId }, "control confirmation cancel failed");
        }
      }
    },
  };
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** 사람의 핸들 — 지운 사람이면 undefined */
export function userHandle(db: DbOrTx, userId: string): string | undefined {
  return db.select({ handle: users.handle }).from(users).where(eq(users.id, userId)).get()?.handle;
}

/**
 * 카드의 출처 줄 — 시킨 사람과, 그 런을 시작한 글(릴레이면 사슬을 거슬러 처음 사람·자동화 글까지). 릴레이가 물려받는
 * 시킨 사람은 아웃바운드 글의 runId 대조를 믿으므로, 결정하는 사람이 「내가 시킨 일인가」를 눈으로 확인하게 한다
 */
function originText(db: DbOrTx, workspaceId: string, runId: string, requestedBy: string): string {
  const handleOf = mentionHandleOf(db, workspaceId);
  const lines = [`시킨 사람: @${userHandle(db, requestedBy) ?? "알 수 없음"}`];
  let run = getRun(db, runId);
  const relay: string[] = [];
  for (let hop = 0; run && hop < ORIGIN_HOPS_MAX; hop++) {
    if (run.triggerInteractionId !== undefined) {
      const by = db
        .select({ userId: componentInteractions.userId })
        .from(componentInteractions)
        .where(eq(componentInteractions.id, run.triggerInteractionId))
        .get()?.userId;
      lines.push(`시작: @${(by && userHandle(db, by)) ?? "알 수 없음"} 의 카드 누름`);
      break;
    }
    const message = run.triggerMessageId === undefined ? undefined : getMessage(db, run.triggerMessageId);
    if (!message) break;
    if (message.authorType === "agent" && message.runId !== undefined) {
      const handle = `@${(message.authorId && handleOf("a", message.authorId)) ?? "알 수 없음"}`;
      relay.unshift(handle);
      run = getRun(db, message.runId);
      // 릴레이의 시킨 사람은 글에 실린 앞 런의 값이다(runs/orchestrator.ts requesterOf) — 끝난 런의 이름으로 온 글(늦은 정본, 또는
      // 연결이 옛 런 id 를 단 글)이면 시킨 사람이 그 일을 시키지 않았을 수 있다
      if (run?.endedAt !== undefined && Date.parse(message.createdAt) > Date.parse(run.endedAt)) {
        lines.push(`주의: ${handle} 의 글은 그 런이 끝난 뒤에 왔습니다 — 직접 시킨 일인지 확인하세요`);
      }
      continue;
    }
    lines.push(`시작한 글: ${messageRef(db, handleOf, message)}`);
    break;
  }
  if (relay.length > 0) lines.push(`릴레이: ${relay.join(" → ")}`);
  return lines.join("\n");
}

function messageRef(db: DbOrTx, handleOf: (kind: "a" | "u", id: string) => string | undefined, m: Message) {
  const channel = getChannel(db, m.channelId)?.name;
  const author =
    m.authorType === "user" && m.authorId !== undefined
      ? `@${handleOf("u", m.authorId) ?? "알 수 없음"}`
      : m.authorType === "automation"
        ? "자동화"
        : m.authorType;
  const excerpt = clip(readableMentions(m.bodyMd, handleOf).replace(/\s+/g, " ").trim(), ORIGIN_EXCERPT_MAX);
  return `${author} · #${channel ?? "?"} · ${m.seq}번째 글 「${excerpt}」`;
}
