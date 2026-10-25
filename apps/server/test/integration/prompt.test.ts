/**
 * 서버 코어 스펙 9.2 시나리오 8 — 채널 프롬프트 리비전: 변경 → 다음 인바운드에 channelPrompt 동봉 + 플러그인 config.set.
 */
import type { InboundDeliver } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessions } from "../../src/db/schema.sqlite";
import { getChannel } from "../../src/modules/channels/service";
import { createScenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import {
  openChannelWire,
  type RelayChannel,
  rest,
  sendMessage,
  setupRelayChannel,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };

describe("통합 시나리오 8 — 채널 프롬프트 리비전", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  /** devTurn 이 이미 기다린 런 */
  const seen = new Set<string>();

  beforeEach(async () => {
    seen.clear();
    live = await bootLiveApp();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /** @dev 한 턴을 끝까지 돌리고 그 인바운드를 돌려준다 */
  async function devTurn(setup: RelayChannel, log: WireLog, text: string): Promise<InboundDeliver> {
    const before = live.plugin.received.length;
    await sendMessage(log.socket, setup.channel.id, `@dev ${text}`);
    const run = await log.until(
      () => log.states.find((s) => s.agentId === setup.dev.id && s.status === "queued" && !seen.has(s.id)),
      `@dev ${text} 런`,
    );
    seen.add(run.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    expect(live.plugin.received).toHaveLength(before + 1);
    const delivery = live.plugin.received.at(-1) as InboundDeliver;
    expect(delivery.runId).toBe(run.id);
    return delivery;
  }

  function sessionRow(setup: RelayChannel) {
    return live.app.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.channelId, setup.channel.id), eq(agentSessions.agentId, setup.dev.id)))
      .get();
  }

  it("8(a) — PATCH prompt → config.set 1건(채널에 처음 들어올 때의 1건 뒤) + 다음 인바운드 channelPrompt", async () => {
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const { channel } = setup;
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: ({ index }) => ({ reply: `답 ${index + 1}` }) },
    });

    // 세션이 만들어지는 첫 턴 — 그때의 채널 프롬프트는 설정 경로가 담으므로 동봉하지 않는다(스펙 3.9)
    const first = await devTurn(setup, log, "첫 턴");
    expect(first.context.channelPrompt).toBeUndefined();
    const revisionAtStart = sessionRow(setup)?.promptRevisionAtStart;
    expect(revisionAtStart).toBe(getChannel(live.app.db, channel.id)?.promptRevision);

    // 프롬프트 변경
    const patched = await rest<{ channel: { prompt?: string } }>(live, "PATCH", `/channels/${channel.id}`, {
      prompt: "정중하게",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.channel.prompt).toBe("정중하게");
    const revision = getChannel(live.app.db, channel.id)?.promptRevision as number;
    expect(revision).toBe((revisionAtStart as number) + 1);

    const second = await devTurn(setup, log, "둘째 턴");
    // config.set 은 같은 브리지 연결에서 인바운드보다 먼저 나갔다 — 인바운드를 받았으면 이미 기록돼 있다. 앞의 한 건은 dev 를
    // 채널에 넣을 때 이 Gateway 가 채널에 처음 들어와 보낸 빈 프롬프트다(멀티 Gateway 계획 판정 PG10 — fin 때는 이미 있어 없다)
    expect(live.plugin.configSets).toEqual([
      { channelId: channel.id, config: { systemPrompt: "" } },
      { channelId: channel.id, config: { systemPrompt: "정중하게" } },
    ]);
    expect(second.context.channelPrompt).toBe("정중하게");
    expect(sessionRow(setup)?.promptRevisionAtStart).toBe(revisionAtStart);

    expect(scenario.errors).toEqual([]);
  });
});
