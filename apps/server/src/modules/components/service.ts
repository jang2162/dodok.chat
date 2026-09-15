import type { ComponentInteract, Message } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { componentInteractions, messages, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { getAgent } from "../agents/service";
import { getChannel, listMembers } from "../channels/service";
import { getMessage, rowToMessage } from "../messages/service";
import { CONTINUE_RELAY_ITEM } from "../router/service";
import type { Orchestrator } from "../runs/orchestrator";
import { getRun } from "../runs/store";
import { formatInteractionText, validateInteraction } from "./interact";

export type InteractDeps = {
  db: Db;
  bus: ServerBus;
  /** 메시지의 채널이 이 워크스페이스에 있어야 한다 */
  workspaceId: string;
  enqueue: Orchestrator["enqueueRun"];
  now?: () => Date;
};

export type InteractInput = ComponentInteract & { userId: string };

type Target = { agentId: string; triggerKind: "continue" | "interaction" };

/**
 * 스펙 3.10·계약 9.3 — 검사(NOT_FOUND → EXPIRED → FORBIDDEN → CONSUMED → VALIDATION) → component_interactions 저장
 * → 1회용이면 consumed 갱신 + message.updated → 대상 에이전트에 continue | interaction 런.
 * 검사·저장·소비는 한 동기 트랜잭션이라 같은 아이템을 동시에 눌러도 한 번만 통과한다.
 */
export async function interact(deps: InteractDeps, input: InteractInput): Promise<{ interactionId: string }> {
  const { db, bus } = deps;
  const now = deps.now?.() ?? new Date();

  const result = db.transaction((tx) => {
    const message = getMessage(tx, input.messageId);
    if (!message || !getChannel(tx, message.channelId, deps.workspaceId)) {
      throw apiError("NOT_FOUND", "message not found");
    }
    const checked = validateInteraction({
      message,
      componentId: input.componentId,
      itemId: input.itemId,
      userId: input.userId,
      values: input.values,
      now,
    });
    if (!checked.ok) throw apiError(checked.error.code, checked.error.message, checked.error.details);
    const components = message.components;
    const state = message.componentState;
    if (!components || !state) throw apiError("INTERNAL", "validated component without state");
    const target = targetOf(tx, message, input.itemId);
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

    let updated: Message | undefined;
    if (!components.reusable) {
      const row = tx
        .update(messages)
        .set({ componentState: { ...state, consumed: [...state.consumed, input.itemId] } })
        .where(eq(messages.id, message.id))
        .returning()
        .get();
      if (row) updated = rowToMessage(row);
    }
    const interactionText = formatInteractionText({
      userHandle: user.handle,
      components,
      found: checked.found,
      values: checked.values,
    });
    return { message, target, interactionId, interactionText, updated };
  });

  if (result.updated) bus.emit("message.updated", { message: result.updated });
  const { message, target, interactionId, interactionText } = result;
  await deps.enqueue(
    {
      agentId: target.agentId,
      channelId: message.channelId,
      triggerKind: target.triggerKind,
      rootMessageId: message.id,
      relayDepth: 0,
    },
    { interactionId, interactionText, interactionMessageId: message.id },
  );
  return { interactionId };
}

/** 시스템 메시지의 continue_relay → systemMeta.relay.toAgentId, 그 밖 → 컴포넌트를 쓴 에이전트(메시지 runId 의 런, 없으면 작성자) */
function targetOf(tx: DbOrTx, message: Message, itemId: string): Target {
  const target = resolveTarget(tx, message, itemId);
  assertDeliverable(tx, message.channelId, target.agentId);
  return target;
}

function resolveTarget(tx: DbOrTx, message: Message, itemId: string): Target {
  if (message.authorType === "system") {
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

/**
 * 카드가 만들어진 뒤 대상이 비활성됐거나 채널에서 빠졌을 수 있다 — 라우터를 거치지 않는 경로라 여기서 다시 본다(sc-t9 리뷰 R1).
 * 저장·소비 전에 던지므로 버튼은 살아 있고, 대상을 되살리면 다시 누를 수 있다.
 */
function assertDeliverable(tx: DbOrTx, channelId: string, agentId: string): void {
  const isMember = listMembers(tx, channelId).some((m) => m.memberType === "agent" && m.memberId === agentId);
  if (!isMember || !getAgent(tx, agentId)?.enabled) {
    throw apiError("VALIDATION", "target agent is disabled or not in the channel");
  }
}
