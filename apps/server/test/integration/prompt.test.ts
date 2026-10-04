/**
 * 서버 코어 스펙 9.2 시나리오 8 — 채널 프롬프트 리비전: 변경 → 다음 인바운드에 channelPrompt 동봉 + 플러그인 config.set,
 * 「새 대화」 리셋 → 동봉 없음, sessions.reset 권한이 없으면 409.
 */
import type { InboundDeliver } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessions } from "../../src/db/schema.sqlite";
import { getChannel } from "../../src/modules/channels/service";
import { createScenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import {
  openChannelWire,
  type RelayChannel,
  rest,
  sendMessage,
  setupRelayChannel,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { openclawOf } from "../helpers/openclaw";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };

describe("통합 시나리오 8 — 채널 프롬프트 리비전", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  /** devTurn 이 이미 기다린 런 */
  const seen = new Set<string>();

  async function boot(opts: LiveAppOptions = {}) {
    live = await bootLiveApp(opts);
  }

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

  describe("Gateway 가 operator.admin 을 준다(grantAdmin: true)", () => {
    beforeEach(async () => {
      seen.clear();
      await boot();
    });

    it("8(a)·(b) — PATCH prompt → config.set 1건(채널에 처음 들어올 때의 1건 뒤) + 다음 인바운드 channelPrompt, 「새 대화」 리셋 → promptRevisionAtStart 갱신·info 메시지·다음 인바운드 channelPrompt 없음", async () => {
      const setup = await setupRelayChannel(live, RELAY_POLICY);
      const { channel, dev } = setup;
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

      // (a) 프롬프트 변경
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

      // (b) 「새 대화」
      const reset = await rest(live, "POST", `/channels/${channel.id}/agents/${dev.id}/reset`);
      expect(reset).toEqual({ status: 200, body: { ok: true } });
      const sessionKey = `agent:dev:dodok:channel:${channel.id}`;
      expect(live.gateway.requests.filter((r) => r.method === "sessions.reset")).toEqual([
        expect.objectContaining({ params: { key: sessionKey } }),
      ]);
      const row = sessionRow(setup);
      expect(row?.promptRevisionAtStart).toBe(revision);
      expect(row?.sessionKey).toBe(sessionKey);
      expect(row?.lifecycleRevision).toEqual(expect.any(String));
      expect(row?.sessionStartedAt).toBeInstanceOf(Date);
      const info = await log.until(
        () => log.created.find((m) => m.kind === "system" && m.systemMeta?.kind === "info"),
        "info 시스템 메시지",
      );
      expect(info).toMatchObject({
        kind: "system",
        authorType: "system",
        bodyMd: "@dev 의 대화를 새로 시작했습니다",
        systemMeta: { kind: "info" },
      });

      const third = await devTurn(setup, log, "셋째 턴");
      expect(third.context.channelPrompt).toBeUndefined();
      expect(third.sessionKey).toBe(sessionKey);
      // 리셋은 설정을 다시 보내지 않는다 — config.set 은 여전히 위의 2건
      expect(live.plugin.configSets).toHaveLength(2);
      expect(scenario.errors).toEqual([]);
    });
  });

  describe("Gateway 가 operator.admin 을 주지 않는다(grantAdmin: false)", () => {
    beforeEach(async () => {
      seen.clear();
      await boot({ grantAdmin: false });
    });

    it("8(c) — POST reset → 409 CONFLICT(ADAPTER_CAPABILITY_MISSING), 세션 리비전·메시지 변화 없음", async () => {
      const setup = await setupRelayChannel(live, RELAY_POLICY);
      const { channel, dev } = setup;
      const log = await openChannelWire(live, channel.id, sockets);

      const reset = await rest<{ code: string; message: string }>(
        live,
        "POST",
        `/channels/${channel.id}/agents/${dev.id}/reset`,
      );
      expect(reset.status).toBe(409);
      expect(reset.body).toEqual({
        code: "CONFLICT",
        message: "ADAPTER_CAPABILITY_MISSING: sessions.reset 권한 없음",
      });
      // Gateway 가 MISSING_SCOPE 로 거절했고 어댑터가 capability 를 내렸다 — 두 번째도 같은 409
      expect(live.gateway.requests.filter((r) => r.method === "sessions.reset")).toHaveLength(1);
      expect(openclawOf(live.app).capabilities().sessionReset).toBe(false);
      const again = await rest(live, "POST", `/channels/${channel.id}/agents/${dev.id}/reset`);
      expect(again).toEqual({ status: 409, body: reset.body });
      expect(live.gateway.requests.filter((r) => r.method === "sessions.reset")).toHaveLength(1);

      const row = sessionRow(setup);
      expect(row?.promptRevisionAtStart).toBe(getChannel(live.app.db, channel.id)?.promptRevision);
      expect(row?.lifecycleRevision).toBeNull();
      const page = await log.socket.emitWithAck("channel.subscribe", { channelId: channel.id, lastSeq: 0 });
      if (!page.ok) throw new Error(page.error.code);
      expect(page.data.messages).toEqual([]);
      expect(log.created).toEqual([]);
    });
  });
});
