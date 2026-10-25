import type { ComponentInteract, Message, Run } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { componentInteractions, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { getAgent, isAgentActive } from "../agents/service";
import { assertChannelWritable, getChannel, listMembers } from "../channels/service";
import { consumeComponentItem, getMessage } from "../messages/service";
import type { RunGate } from "../ops/budget";
import { isPairAllowed } from "../router/decide";
import { CONTINUE_RELAY_ITEM, RETRY_RUN_ITEM } from "../router/service";
import { getRun, getRunRequestedBy } from "../runs/store";
import { formatInteractionText, validateInteraction } from "./interact";

export type InteractDeps = {
  db: Db;
  bus: ServerBus;
  /** 메시지의 채널이 이 워크스페이스에 있어야 한다 */
  workspaceId: string;
  /** 런 관문 — 상호작용 런(interaction·continue·retry)도 일일 한도를 지난다 */
  gate: RunGate;
  now?: () => Date;
};

export type InteractInput = ComponentInteract & { userId: string };

type Target =
  | { agentId: string; triggerKind: "continue" | "interaction" }
  /** run_error 의 retry_run — 원래 런의 트리거 메시지로 같은 런을 다시 만든다 */
  | { agentId: string; triggerKind: "retry"; run: Run; triggerMessage: Message };

type Checked = {
  message: Message;
  checked: Extract<ReturnType<typeof validateInteraction>, { ok: true }>;
  target: Target;
};

/**
 * 스펙 3.10·계약 9.3 — 검사(NOT_FOUND → CHANNEL_ARCHIVED → EXPIRED → FORBIDDEN → CONSUMED → VALIDATION) → 관문(RUN_LIMIT) → component_interactions 저장
 * → 1회용이면 consumed 갱신 → message.updated(상호작용마다, 설계 4.3) → 대상 에이전트에 continue | interaction | 다시 실행 런.
 * 검사·저장·소비는 한 동기 트랜잭션이라 같은 아이템을 동시에 눌러도 한 번만 통과한다.
 * 버스로 내보내는 Message 에는 상호작용 기록을 붙이지 않는다 — 붙이는 것은 wire 팬아웃(realtime/events.ts)이다.
 */
export async function interact(deps: InteractDeps, input: InteractInput): Promise<{ interactionId: string }> {
  const { db, bus } = deps;
  const now = deps.now?.() ?? new Date();

  // 관문은 저장·소비 전에 본다 — 막히면 버튼이 살아 있어 한도가 풀린 뒤 다시 누른다(Review Focus 5).
  // 검사를 먼저 한 번 돌려 누를 수 없는 아이템(만료·소비·대상 없음)은 한도보다 그 사유로 거절한다
  const pre = checkInteraction(db, deps.workspaceId, input, now);
  if (deps.gate.check(pre.message.conversationId, threadOf(pre.target, pre.message))) {
    throw apiError("RUN_LIMIT", "daily run limit reached");
  }

  const result = db.transaction((tx) => {
    const { message, checked, target } = checkInteraction(tx, deps.workspaceId, input, now);
    const components = message.components;
    const state = message.componentState;
    if (!components || !state) throw apiError("INTERNAL", "validated component without state");
    const user = tx.select({ handle: users.handle }).from(users).where(eq(users.id, input.userId)).get();
    if (!user) throw apiError("NOT_FOUND", "user not found");

    const interactionId = uuidv7();
    tx.insert(componentInteractions)
      .values({
        id: interactionId,
        messageId: message.id,
        componentId: input.componentId,
        userId: input.userId,
        blockId: checked.found.kind === "modal" ? null : (checked.found.blockId ?? null),
        itemId: input.itemId,
        values: checked.values,
        createdAt: now,
      })
      .run();

    // 재사용 카드도 결과 줄이 실시간으로 늘어야 하므로 상호작용마다 방송한다 — 소비는 1회용만(설계 4.3)
    const updated = components.reusable ? message : consumeComponentItem(tx, message, input.itemId);
    const interactionText = formatInteractionText({
      userHandle: user.handle,
      components,
      found: checked.found,
      values: checked.values,
    });
    return { message, target, interactionId, interactionText, updated };
  });

  bus.emit("message.updated", { message: result.updated });
  const { message, target, interactionId, interactionText } = result;
  if (target.triggerKind === "retry") {
    const { run } = target;
    await deps.gate.enqueue(
      {
        agentId: run.agentId,
        channelId: run.channelId,
        conversationId: run.conversationId,
        triggerKind: run.triggerKind,
        rootMessageId: run.rootMessageId,
        relayDepth: run.relayDepth,
        parentRunId: run.id,
        ...withThread(threadOf(target, message)),
      },
      { message: target.triggerMessage, requestedBy: getRunRequestedBy(deps.db, run.id) },
    );
    return { interactionId };
  }
  await deps.gate.enqueue(
    {
      agentId: target.agentId,
      channelId: message.channelId,
      conversationId: message.conversationId,
      triggerKind: target.triggerKind,
      rootMessageId: message.id,
      relayDepth: 0,
      ...withThread(threadOf(target, message)),
    },
    { interactionId, interactionText, interactionMessageId: message.id },
  );
  return { interactionId };
}

/**
 * 새 런이 돌 스레드(스펙 2.2) — 다시 실행은 원래 런의 스레드, 그 밖(카드·이어가기)은 누른 메시지가 있는 스레드.
 * 채널 최상위면 undefined
 */
function threadOf(target: Target, message: Message): string | undefined {
  return target.triggerKind === "retry" ? target.run.threadRootId : message.threadRootId;
}

function withThread(threadRootId: string | undefined): { threadRootId?: string } {
  return threadRootId === undefined ? {} : { threadRootId };
}

/**
 * 저장 없이 검사만 — 통과하면 메시지·검사 결과·대상을 돌려주고, 아니면 그 사유의 apiError 를 던진다. 보관한 채널의 카드는 다른 사유보다
 * 먼저 409 CHANNEL_ARCHIVED 다(계획 판정 PC1) — 저장·소비 전이라 보관 해제하면 같은 카드를 다시 누른다
 */
function checkInteraction(tx: DbOrTx, workspaceId: string, input: InteractInput, now: Date): Checked {
  const message = getMessage(tx, input.messageId);
  if (!message || !getChannel(tx, message.channelId, workspaceId)) {
    throw apiError("NOT_FOUND", "message not found");
  }
  assertChannelWritable(tx, message.channelId, workspaceId);
  const checked = validateInteraction({
    message,
    componentId: input.componentId,
    itemId: input.itemId,
    userId: input.userId,
    values: input.values,
    now,
  });
  if (!checked.ok) throw apiError(checked.error.code, checked.error.message, checked.error.details);
  return { message, checked, target: targetOf(tx, message, input.itemId) };
}

/**
 * 시스템 메시지의 continue_relay → systemMeta.relay.toAgentId, retry_run → systemMeta.runId 의 런을 쓴 에이전트,
 * 그 밖 → 컴포넌트를 쓴 에이전트(메시지 runId 의 런, 없으면 작성자)
 */
function targetOf(tx: DbOrTx, message: Message, itemId: string): Target {
  const target = resolveTarget(tx, message, itemId);
  assertDeliverable(tx, message.channelId, target.agentId);
  return target;
}

function resolveTarget(tx: DbOrTx, message: Message, itemId: string): Target {
  if (message.authorType === "system") {
    if (itemId === RETRY_RUN_ITEM) return retryTarget(tx, message);
    const relay = message.systemMeta?.relay;
    if (itemId !== CONTINUE_RELAY_ITEM || !relay) {
      throw apiError("VALIDATION", "system component has no agent to deliver to");
    }
    return { agentId: relay.toAgentId, triggerKind: "continue" };
  }
  const run = message.runId === undefined ? undefined : getRun(tx, message.runId);
  const agentId = run?.agentId ?? (message.authorType === "agent" ? message.authorId : undefined);
  if (!agentId) throw apiError("VALIDATION", "component message has no agent to deliver to");
  return { agentId, triggerKind: "interaction" };
}

/** 다시 실행은 error 로 끝난, 트리거 메시지가 있는 런만 — 1회용 버튼 소비가 「한 번만」을 맡는다 */
function retryTarget(tx: DbOrTx, message: Message): Target {
  const runId = message.systemMeta?.runId;
  const run = runId === undefined ? undefined : getRun(tx, runId);
  if (!run || run.status !== "error" || run.triggerMessageId === undefined) {
    throw apiError("VALIDATION", "run is not retryable");
  }
  const triggerMessage = getMessage(tx, run.triggerMessageId);
  if (!triggerMessage) throw apiError("VALIDATION", "run is not retryable");
  // 판정 R2 — 사람이 누른 것이라 이어가기처럼 턴 상한·반복은 다시 보지 않지만, 쌍 허용은 이어가기로도 못 뚫는 차단이라 지금 정책으로 다시 본다
  if (run.triggerKind === "relay") {
    const from = triggerMessage.authorType === "agent" ? triggerMessage.authorId : undefined;
    const channel = getChannel(tx, run.channelId);
    if (!channel || from === undefined || !isPairAllowed(channel.relayPolicy, from, run.agentId)) {
      throw apiError("VALIDATION", "relay pair is not allowed");
    }
  }
  return { agentId: run.agentId, triggerKind: "retry", run, triggerMessage };
}

/**
 * 카드가 만들어진 뒤 대상이 비활성·보관됐거나 채널에서 빠졌을 수 있다 — 라우터를 거치지 않는 경로라 여기서 다시 본다(sc-t9 리뷰 R1).
 * 저장·소비 전에 던지므로 버튼은 살아 있고, 대상을 되살리면 다시 누를 수 있다. 보관한 에이전트는 채널 멤버 조회에서 빠지므로 먼저
 * 가른다 — 사람에게 「삭제된 에이전트입니다」로 보인다
 */
function assertDeliverable(tx: DbOrTx, channelId: string, agentId: string): void {
  const agent = getAgent(tx, agentId);
  if (agent && agent.archivedAt !== null) {
    throw apiError("AGENT_ARCHIVED", "삭제된 에이전트입니다", { agentId });
  }
  const isMember = listMembers(tx, channelId).some((m) => m.memberType === "agent" && m.memberId === agentId);
  if (!isMember || !agent || !isAgentActive(agent)) {
    throw apiError("VALIDATION", "target agent is disabled or not in the channel");
  }
}
