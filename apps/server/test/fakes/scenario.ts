/**
 * 대본 시나리오 — 가짜 플러그인이 받은 인바운드마다 에이전트 대본을 골라, 실물 순서대로 흘린다.
 *
 * 실제 플러그인은 런이 시작될 때 dispatch 를 ack 하고(ADR 0002), 그 뒤 Gateway WS 에 lifecycle·툴·델타·final 이 흐르며,
 * 정본 답은 플러그인 `outbound.message` 로 온다. 여기서는 ack 를 먼저 보낸 뒤(`setImmediate`) 가짜 Gateway 이벤트를 쓰고,
 * 그 쓰기가 끝난 뒤 정본을 보낸다.
 */
import type { InboundDeliver } from "@dodok/shared";
import type { FakeGateway } from "./fake-gateway";
import type { FakePlugin } from "./fake-plugin";

export type ScenarioTurn = { delivery: InboundDeliver; index: number };

export type ScenarioScript = {
  deltas?: string[];
  /** 정본 본문(`outbound.message.text`)이자 chat final 의 스냅샷 */
  reply: string;
  tool?: { name: string; args: Record<string, unknown>; result: unknown };
  /** 있으면 런 없이 `{ admission: "drop", reason }` 만 ack 한다(봇 루프 보호 등) */
  drop?: string;
};

/** `index` 는 그 에이전트가 받은 인바운드 순번(0부터) */
export type ScenarioAgent = (turn: ScenarioTurn) => ScenarioScript;

export type Scenario = {
  /** 대본을 고른 인바운드, 도착 순서(drop 포함) */
  readonly turns: Array<{ agentId: string; delivery: InboundDeliver }>;
  /** ack 뒤 재생 중 난 오류(정본 거절·플러그인 끊김 등) — 처리되지 않은 reject 로 새지 않게 모은다 */
  readonly errors: unknown[];
};

export function createScenario(opts: {
  gateway: FakeGateway;
  plugin: FakePlugin;
  /** providerAgentId → 대본 */
  agents: Record<string, ScenarioAgent>;
}): Scenario {
  const { gateway, plugin } = opts;
  const turns: Scenario["turns"] = [];
  const errors: unknown[] = [];
  const counts = new Map<string, number>();

  async function play(delivery: InboundDeliver, script: ScenarioScript): Promise<void> {
    const { runId, sessionKey, agentId, channelId } = delivery;
    await gateway.lifecycleStart(runId, sessionKey, agentId);
    if (script.tool) {
      const toolCallId = `toolu_${runId}`;
      const { name, args, result } = script.tool;
      await gateway.toolStart(runId, sessionKey, agentId, { toolCallId, name, args });
      await gateway.toolResult(runId, sessionKey, agentId, { toolCallId, result });
    }
    for (const delta of script.deltas ?? []) await gateway.chatDelta(runId, sessionKey, agentId, delta);
    await gateway.chatFinal(runId, sessionKey, agentId, script.reply);
    await plugin.sendOutbound({
      channelId,
      agentId,
      sessionKey,
      runId,
      replyToInboundId: delivery.message.id,
      text: script.reply,
      attachments: [],
    });
  }

  plugin.onInbound = (delivery) => {
    const agent = opts.agents[delivery.agentId];
    if (!agent) throw new Error(`scenario: no script for agent "${delivery.agentId}"`);
    const index = counts.get(delivery.agentId) ?? 0;
    counts.set(delivery.agentId, index + 1);
    turns.push({ agentId: delivery.agentId, delivery });
    const script = agent({ delivery, index });
    if (script.drop !== undefined) return { admission: "drop", reason: script.drop };
    // ack 가 먼저 나가도록 다음 틱에 재생한다
    setImmediate(() => {
      play(delivery, script).catch((error: unknown) => errors.push(error));
    });
    return { admission: "dispatch", providerRunId: delivery.runId };
  };

  return { turns, errors };
}
