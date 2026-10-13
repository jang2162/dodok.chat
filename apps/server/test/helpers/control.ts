import type { Agent, ControlResult, Run } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import type { App } from "../../src/app";
import { createAgent } from "../../src/modules/agents/service";
import { addMember, type ChannelRecord, createChannel } from "../../src/modules/channels/service";
import type { Principal } from "../../src/modules/control/principal";
import { insertRun, updateRun } from "../../src/modules/runs/store";
import type { BusEvents } from "../../src/realtime/bus";
import { FAKE_GATEWAY_ID } from "./gateways";

// 제어 서비스 테스트의 무대 — 채널 하나에 에이전트 하나, 그 에이전트의 열린 런(시킨 사람을 정해서)

let n = 0;

export function newAgent(app: App, handle = `ops${++n}`): Agent {
  return createAgent(app.db, {
    gatewayId: FAKE_GATEWAY_ID,
    workspaceId: app.workspaceId,
    providerAgentId: handle,
    handle,
    name: handle,
  });
}

export function newChannel(app: App, opts: { name?: string; members?: string[] } = {}): ChannelRecord {
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: opts.name ?? `ctl-${++n}`,
  });
  for (const userId of opts.members ?? [])
    addMember(app.db, channel.id, { memberType: "user", memberId: userId }, app.logger);
  return channel;
}

/** 채널 + 그 채널의 에이전트 + 그 에이전트의 열린 런(tool 상태 — 도구를 부르는 중). requestedBy 가 그 런을 시킨 사람 */
export function openRun(
  app: App,
  requestedBy: string | null,
  opts: { channel?: ChannelRecord; agent?: Agent } = {},
): { channel: ChannelRecord; agent: Agent; run: Run; principal: Principal } {
  const channel = opts.channel ?? newChannel(app);
  const agent = opts.agent ?? newAgent(app);
  if (!opts.agent) addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
  const queued = insertRun(app.db, {
    channelId: channel.id,
    agentId: agent.id,
    triggerKind: "mention",
    rootMessageId: uuid(),
    relayDepth: 0,
    sessionKey: `agent:${agent.providerAgentId}:dodok:channel:${channel.id}`,
    connectionId: FAKE_GATEWAY_ID,
    requestedBy,
    createdAt: new Date(),
  });
  const run = updateRun(app.db, queued.id, { status: "tool", startedAt: new Date() });
  return {
    channel,
    agent,
    run,
    principal: { userId: requestedBy, via: "agent", agentId: agent.id, runId: run.id },
  };
}

export const pat = (userId: string): Principal => ({ userId, via: "pat" });

/** 버스 이벤트 이름을 순서대로 모은다 — 돌려준 함수로 그만둔다 */
export function recordBus(app: App, names: Array<keyof BusEvents>): { seen: string[]; stop(): void } {
  const seen: string[] = [];
  const offs = names.map((name) => app.bus.on(name, () => seen.push(name)));
  return { seen, stop: () => offs.forEach((off) => off()) };
}

export function expectOk(result: ControlResult): unknown {
  if (!result.ok) throw new Error(`control call failed: ${result.error.code} ${result.error.message}`);
  return result.data;
}

export function errorOf(result: ControlResult): { code: string; message: string } {
  if (result.ok) throw new Error("control call succeeded");
  return result.error;
}
