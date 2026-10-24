/**
 * 대본 시나리오 — 가짜 플러그인이 받은 인바운드마다 에이전트 대본을 골라, 실물 순서대로 흘린다.
 *
 * 실제 플러그인은 런이 시작될 때 dispatch 를 ack 하고(ADR 0002), 그 뒤 Gateway WS 에 lifecycle·툴·델타·final 이 흐르며,
 * 정본 답은 플러그인 `outbound.message` 로 온다. 여기서는 ack 를 먼저 보낸 뒤(`setImmediate`) 가짜 Gateway 이벤트를 쓰고,
 * 서버가 그 이벤트를 처리한 뒤(`gateway.flush`) 정본을 보낸다 — 실물은 첫 델타와 정본 사이가 수백 ms 이상이다(live-smoke 5.3).
 * 재생 중 가짜 Gateway 가 그 런의 `chat.abort` 를 받으면(가짜 Gateway 가 chat aborted 를 낸다) 실물처럼 거기서 멈춘다 — 남은 델타·final·정본 없음.
 * 대본에 `approval` 이 있으면 툴 start 뒤 승인을 띄우고(`plugin.approval.requested`) 결정이 날 때까지 툴 result 를 미룬다(승인 스파이크 4.2).
 * 정본은 실제 플러그인의 `buildOutboundMessage` 로 만든다 — `components` 가 플러그인 검증(`ComponentsV1`)을 실제로 지나고,
 * 어기면 실물처럼 보내기 전에 거절된다(`errors` 에 남는다). 하네스가 실물보다 친절하면 결함이 숨는다(p2-t6 F2).
 */
import type { ApprovalDecision, Attachment, ComponentsV1, InboundDeliver } from "@dodok/shared";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { buildOutboundMessage } from "../../../../packages/openclaw-plugin/src/outbound";
import type { FakeApprovalOutcome, FakeGateway } from "./fake-gateway";
import type { FakePlugin } from "./fake-plugin";

/** 승인을 요구하는 툴의 인자 — 실물 프레임과 같은 꼴(승인 스파이크 3.2) */
const APPROVAL_TOOL_ARGS = { file_path: "/tmp/dodok-approval.txt", content: "hello\n" };
const DEFAULT_APPROVAL_TOOL = "Write";
/** 거절·만료 뒤 실제로 오는 툴 결과 문구(승인 스파이크 4.3) */
const deniedToolResult = (toolName: string) =>
  `PreToolUse:${toolName} hook error: OpenClaw user denied native tool use (${toolName}).`;

/**
 * 툴이 요구하는 승인 하나. 대본은 툴 start 를 낸 **뒤** 승인을 띄우고(실물은 그 사이가 13ms, 4.2)
 * 결정이 날 때까지 툴 result 를 내지 않는다 — 승인 대기는 「start 는 왔는데 result 가 안 오는 구간」이다.
 */
export type ScenarioApproval = {
  /** 기본 `plugin:<uuid>` — Gateway 둘이 같은 승인 id 를 내는 경우를 잴 때 고정한다 */
  approvalId?: string;
  /** 기본 `claude-cli native tool: Write` */
  title?: string;
  /** 기본 `Write` */
  toolName?: string;
  /** 기본 `["allow-once", "deny"]`(claude-cli 실물) */
  allowedDecisions?: ApprovalDecision[];
  /** 아무도 해결하지 않으면 이만큼 뒤 만료(실물 기본 120초) */
  ttlMs: number;
  /** 결정 뒤 이어갈 모양. 생략하면 결정대로 — 허용이면 툴 성공, 거절·만료면 툴 오류(4.2·4.3) */
  onDecision?: "continue" | "toolError";
  /** 만료 프레임을 Gateway 가 내는가. `"silent"` 면 서버의 만료 감시 타이머가 닫아야 한다 */
  onTimeout?: "gateway" | "silent";
  /** 확정 짝(`session.approval(terminal)` + `plugin.approval.resolved`)의 순서. 기본은 실물 관측 순서(session 먼저) */
  settleFrameOrder?: "session-first" | "plugin-first";
};

export type ScenarioTurn = { delivery: InboundDeliver; index: number };

export type ScenarioScript = {
  deltas?: string[];
  /** 정본 본문(`outbound.message.text`)이자 chat final 의 스냅샷 */
  reply: string;
  tool?: { name: string; args: Record<string, unknown>; result: unknown };
  /** 툴이 승인을 요구한다. 배열이면 한 런에 **겹쳐** 띄운다(만료 시각이 다른 승인 둘) */
  approval?: ScenarioApproval | ScenarioApproval[];
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
  /**
   * 정본 메시지에 실을 components v1. 모델이 message 툴에 채우는 모양(기본값은 생략해도 된다)이고,
   * 플러그인이 검증해 기본값을 채운 뒤 보낸다. 서버가 `id`·`componentState` 를 부여한다
   */
  components?: z.input<typeof ComponentsV1>;
  /**
   * 정본 전에 브리지 HTTP 로 올려 `attachmentIds` 에 실을 파일(실제 플러그인이 미디어를 먼저 올리고 정본을 보낸다, 스펙 5.2).
   * `reply: ""` 와 함께 쓰면 미디어만 있는 정본이다
   */
  attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>;
  /** 이미 올린 첨부 id 를 그대로 싣는다 — 다른 채널 id 가 섞이면 서버가 빼는지 잴 때 */
  attachmentIds?: string[];
  /** true 면 Gateway final(스냅샷)까지만 흘리고 정본을 보내지 않는다 — finalizing 상한의 스냅샷 폴백을 잴 때 */
  withholdCanonical?: boolean;
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
  /** `agents` 에 없는 에이전트의 대본 — 없으면 그 인바운드를 INTERNAL 로 거절한다 */
  fallback?: ScenarioAgent;
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

  /**
   * 대본의 승인을 순서대로 띄우고(둘 이상이면 겹친다) 결정을 기다렸다가 툴 result 를 낸다.
   * 재생을 이어가도 되면 true, 그 사이 런이 중지됐으면 false.
   */
  async function playApprovals(
    delivery: InboundDeliver,
    script: ScenarioScript,
    stopped: () => boolean,
  ): Promise<boolean> {
    const { runId, sessionKey, agentId } = delivery;
    const scripted = script.approval === undefined ? [] : [script.approval].flat();
    const waiting: Array<{
      approval: ScenarioApproval;
      toolCallId: string;
      outcome: Promise<FakeApprovalOutcome>;
    }> = [];
    for (const [index, approval] of scripted.entries()) {
      const toolCallId = `toolu_${runId}_a${index}`;
      await gateway.toolStart(runId, sessionKey, agentId, {
        toolCallId,
        name: approval.toolName ?? DEFAULT_APPROVAL_TOOL,
        args: APPROVAL_TOOL_ARGS,
      });
      if (stopped()) return false;
      // 결말을 기다리지 않고 다음으로 — 둘 이상이면 한 런에 승인이 겹친다
      waiting.push({
        approval,
        toolCallId,
        outcome: gateway.requestApproval(runId, sessionKey, agentId, {
          toolCallId,
          ttlMs: approval.ttlMs,
          ...(approval.approvalId === undefined ? {} : { approvalId: approval.approvalId }),
          ...(approval.title === undefined ? {} : { title: approval.title }),
          ...(approval.toolName === undefined ? {} : { toolName: approval.toolName }),
          ...(approval.allowedDecisions === undefined ? {} : { allowedDecisions: approval.allowedDecisions }),
          ...(approval.onTimeout === undefined ? {} : { onTimeout: approval.onTimeout }),
          ...(approval.settleFrameOrder === undefined ? {} : { settleFrameOrder: approval.settleFrameOrder }),
        }),
      });
    }
    for (const { approval, toolCallId, outcome } of waiting) {
      const decided = await outcome;
      if (stopped()) return false;
      const toolName = approval.toolName ?? DEFAULT_APPROVAL_TOOL;
      const failed =
        (approval.onDecision ?? (decided.decision === "deny" ? "toolError" : "continue")) === "toolError";
      await gateway.toolResult(runId, sessionKey, agentId, {
        toolCallId,
        ...(failed ? { result: deniedToolResult(toolName), isError: true } : { result: "ok" }),
      });
    }
    return true;
  }

  async function play(delivery: InboundDeliver, script: ScenarioScript): Promise<void> {
    const { runId, sessionKey, agentId, conversationId } = delivery;
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
      if (!(await playApprovals(delivery, script, stopped))) return;
      for (const delta of script.deltas ?? []) {
        if (script.deltaDelayMs) await new Promise((resolve) => setTimeout(resolve, script.deltaDelayMs));
        if (stopped()) return;
        await gateway.chatDelta(runId, sessionKey, agentId, delta);
      }
      if (script.holdFinal || stopped()) return;
      await gateway.chatFinal(runId, sessionKey, agentId, script.reply);
      await gateway.flush();
    }
    if (stopped() || script.withholdCanonical) return;
    // 실제 플러그인처럼 미디어를 먼저 올리고 정본을 보낸다(스펙 5.2)
    const uploaded: Attachment[] = [];
    for (const file of script.attachments ?? []) {
      uploaded.push(
        await plugin.uploadAttachment({
          conversationId,
          bytes: file.bytes,
          name: file.name,
          mime: file.mime,
        }),
      );
    }
    const built = buildOutboundMessage({
      outboundId: randomUUID(),
      conversationId,
      agentId,
      sessionKey,
      ...(delivery.threadId === undefined ? {} : { threadId: delivery.threadId }),
      text: script.reply,
      components: script.components,
      attachmentIds: [...uploaded.map((a) => a.id), ...(script.attachmentIds ?? [])],
      correlation: { runId, replyToInboundId: delivery.message.id },
      now: new Date(),
    });
    // 실제 플러그인도 여기서 던진다(channel.ts) — 스키마를 어긴 components 는 브리지에 닿지 않는다
    if (!built.ok) throw new Error(built.error);
    await plugin.sendOutbound(built.message);
  }

  plugin.onInbound = (delivery) => {
    const agent = opts.agents[delivery.agentId] ?? opts.fallback;
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
