/**
 * 대본 시나리오 — 가짜 플러그인이 받은 인바운드마다 에이전트 대본을 골라, 실물 순서대로 흘린다.
 *
 * 실제 플러그인은 런이 시작될 때 dispatch 를 ack 하고(ADR 0002), 그 뒤 Gateway WS 에 lifecycle·툴·델타·final 이 흐르며,
 * 정본 답은 플러그인 `outbound.message` 로 온다. 여기서는 ack 를 먼저 보낸 뒤(`setImmediate`) 가짜 Gateway 이벤트를 쓰고,
 * 서버가 그 이벤트를 처리한 뒤(`gateway.flush`) 정본을 보낸다 — 실물은 첫 델타와 정본 사이가 수백 ms 이상이다(live-smoke 5.3).
 * 재생 중 가짜 Gateway 가 그 런의 `chat.abort` 를 받으면(가짜 Gateway 가 chat aborted 를 낸다) 실물처럼 거기서 멈춘다 — 남은 델타·final·정본 없음.
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
  /** true 면 lifecycle·툴·델타까지만 흘리고 멈춘다 — chat final 도 정본도 없어 런이 진행 중으로 남는다(재시작 복구를 잴 때) */
  holdFinal?: boolean;
  /** true 면 Gateway 이벤트를 하나도 보내지 않고 정본만 보낸다 — 구독 누락·WS 단절(Phase 1 실연)을 잴 때 */
  silentGateway?: boolean;
  /** 델타마다 앞에서 이만큼(ms) 기다린다(실제 시계). 없으면 곧바로 */
  deltaDelayMs?: number;
  /** 있으면 lifecycle start 뒤 chat error(errorMessage 로 이 값)로 끝낸다 — 툴·델타·final·정본 없음. silentGateway 면 무시 */
  fail?: string;
};

/** `index` 는 그 에이전트가 받은 인바운드 순번(0부터) */
export type ScenarioAgent = (turn: ScenarioTurn) => ScenarioScript;

export type Scenario = {
  /** 대본을 고른 인바운드, 도착 순서(drop 포함) */
  readonly turns: Array<{ agentId: string; delivery: InboundDeliver }>;
  /** ack 뒤 재생 중 난 오류(정본 거절·플러그인 끊김 등) — 처리되지 않은 reject 로 새지 않게 모은다 */
  readonly errors: unknown[];
  /** 지금 재생 중(ack 뒤 예약된 것 포함)인 런이 모두 끝나면 resolve — 기다리는 사이 새로 시작한 것도 기다린다. 「더 안 나온다」를 잴 때 */
  idle(): Promise<void>;
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
  const playing = new Set<Promise<void>>();

  /** 가짜 Gateway 가 이 런의 `chat.abort` 를 받았나 */
  const abortRequested = (runId: string): boolean =>
    gateway.requests.some(
      (r) => r.method === "chat.abort" && (r.params as { runId?: unknown } | undefined)?.runId === runId,
    );

  async function play(delivery: InboundDeliver, script: ScenarioScript): Promise<void> {
    const { runId, sessionKey, agentId, channelId } = delivery;
    const stopped = () => abortRequested(runId);
    if (!script.silentGateway) {
      await gateway.lifecycleStart(runId, sessionKey, agentId);
      if (script.fail !== undefined) {
        await gateway.chatError(runId, sessionKey, agentId, { errorMessage: script.fail });
        return;
      }
      if (stopped()) return;
      if (script.tool) {
        const toolCallId = `toolu_${runId}`;
        const { name, args, result } = script.tool;
        await gateway.toolStart(runId, sessionKey, agentId, { toolCallId, name, args });
        await gateway.toolResult(runId, sessionKey, agentId, { toolCallId, result });
      }
      for (const delta of script.deltas ?? []) {
        if (script.deltaDelayMs) await new Promise((resolve) => setTimeout(resolve, script.deltaDelayMs));
        if (stopped()) return;
        await gateway.chatDelta(runId, sessionKey, agentId, delta);
      }
      if (script.holdFinal || stopped()) return;
      await gateway.chatFinal(runId, sessionKey, agentId, script.reply);
      await gateway.flush();
    }
    if (stopped()) return;
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
    const played: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => play(delivery, script))
      .catch((error: unknown) => {
        errors.push(error);
      })
      .finally(() => playing.delete(played));
    playing.add(played);
    return { admission: "dispatch", providerRunId: delivery.runId };
  };

  return {
    turns,
    errors,
    async idle() {
      while (playing.size > 0) await Promise.all(playing);
    },
  };
}
