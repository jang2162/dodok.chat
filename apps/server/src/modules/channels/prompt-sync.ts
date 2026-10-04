/**
 * 채널 프롬프트를 OpenClaw Gateway 설정에 반영한다(서버 코어 스펙 3.4, 멀티 Gateway 계획 판정 PG10). Gateway 설정 경로(config.set)는
 * OpenClaw 몫이다 — 러너 어댑터는 채널 프롬프트를 매 런 싣는다(판정 P3). 보내는 때는 셋이다:
 * - 프롬프트를 바꿀 때 — 그 채널의 Gateway 들(channelGatewayIds)
 * - 채널에 Gateway 가 새로 들어올 때(에이전트를 넣거나 다른 Gateway 로 옮길 때) — 그 Gateway 에만
 * - Gateway 의 플러그인이 hello 할 때 — 그 Gateway 에 에이전트를 둔 채널들. 꺼졌던 Gateway 를 다시 켜거나 플러그인이 끊긴 사이
 *   프롬프트가 바뀌었어도 따라온다. 플러그인은 같은 값이면 설정 파일을 바꾸지 않고, 채널 항목은 계정 재시작 없이 읽힌다
 *   (packages/openclaw-plugin/src/config-writer.ts)
 * 채널 변경은 이미 유효하다 — 반영은 비동기, 실패는 system.notice 로만 알린다
 */
import { eq } from "drizzle-orm";
import type { AdapterRegistry } from "../../adapters/registry";
import { type GatewaySetupEntry, hasGateways } from "../../adapters/types";
import type { DbOrTx } from "../../db/client";
import { gateways } from "../../db/schema.sqlite";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { type ChannelRecord, channelGatewayIds, channelsOnGateway, getChannel } from "./service";

export type PromptSyncContext = {
  db: DbOrTx;
  bus: ServerBus;
  logger: Logger;
  registry: Pick<AdapterRegistry, "forProvider">;
};

function send(ctx: PromptSyncContext, channel: ChannelRecord, gatewayId: string): void {
  const openclaw = ctx.registry.forProvider("openclaw");
  if (!openclaw) return;
  void openclaw
    .syncChannelConfig(channel.id, { systemPrompt: channel.prompt ?? "" }, gatewayId)
    .catch((err: unknown) => {
      ctx.logger.warn({ err, channelId: channel.id, gatewayId }, "syncChannelConfig failed");
      const reason = err instanceof Error ? err.message : String(err);
      ctx.bus.emit("system.notice", {
        level: "warn",
        message: `#${channel.name} 채널 프롬프트를 Gateway 에 반영하지 못했다: ${reason}`,
      });
    });
}

/** 프롬프트를 바꿨을 때 — 그 채널의 켜진 Gateway 마다 한 번. OpenClaw 에이전트가 없는 채널은 보내지 않는다 */
export function syncChannelPrompt(ctx: PromptSyncContext, channel: ChannelRecord): void {
  for (const gatewayId of channelGatewayIds(ctx.db, channel.id)) send(ctx, channel, gatewayId);
}

/** 그 채널의 프롬프트를 그 Gateway 하나에 — 꺼진 Gateway 는 건너뛴다(다시 켜면 hello 때 보낸다) */
export function syncPromptToGateway(ctx: PromptSyncContext, channelId: string, gatewayId: string): void {
  const channel = getChannel(ctx.db, channelId);
  if (!channel) return;
  const gateway = ctx.db
    .select({ enabled: gateways.enabled })
    .from(gateways)
    .where(eq(gateways.id, gatewayId))
    .get();
  if (gateway?.enabled !== true) return;
  send(ctx, channel, gatewayId);
}

/** 붙은 플러그인 하나를 가르는 값 — 다시 붙으면 connectedAt 이 바뀐다. 플러그인이 없거나 꺼진 Gateway 는 null */
function pluginKey(entry: GatewaySetupEntry): string | null {
  const plugin = entry.enabled ? entry.bridge.plugin : null;
  return plugin ? `${plugin.tokenId ?? ""}\u0000${plugin.connectedAt}` : null;
}

/**
 * Gateway 마다 플러그인 hello(setup 이벤트로 알게 된 새 플러그인)를 보고 그 Gateway 의 채널 프롬프트를 다시 보낸다. 시작할 때 이미
 * 붙어 있던 플러그인은 새 것으로 치지 않는다. 돌려준 함수로 그만둔다
 */
export function watchPluginHellos(
  ctx: PromptSyncContext & { registry: Pick<AdapterRegistry, "forProvider" | "onEvent"> },
): () => void {
  const openclaw = ctx.registry.forProvider("openclaw");
  if (!openclaw || !hasGateways(openclaw)) return () => {};
  const plugins = () => new Map(openclaw.gatewaySetupDetails().map((entry) => [entry.id, pluginKey(entry)]));
  let seen = plugins();
  return ctx.registry.onEvent((event) => {
    if (event.kind !== "setup") return;
    const now = plugins();
    for (const [gatewayId, key] of now) {
      if (key === null || seen.get(gatewayId) === key) continue;
      try {
        for (const channelId of channelsOnGateway(ctx.db, gatewayId))
          syncPromptToGateway(ctx, channelId, gatewayId);
      } catch (err) {
        ctx.logger.error({ err, gatewayId }, "channel prompt resync on plugin hello failed");
      }
    }
    seen = now;
  });
}
