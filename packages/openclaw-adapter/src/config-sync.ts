import type { ConfigSet, ConfigSetResult } from "@dodok/shared";
import { AdapterError, type AdapterLogger } from "./adapter-types";
import type { BridgeHandle } from "./bridge/server";

// 서버 코어 스펙 6.4 — 채널 설정을 브리지 config.set 으로 플러그인에 넘긴다. 플러그인이 없으면 기다리지 않고 거부한다
// (채널 모듈이 system.notice warn 으로 알린다). restart_required 는 MVP 에서 로그만.

const CONFIG_SET_TIMEOUT_MS = 10_000;

export async function syncChannelConfig(
  bridge: Pick<BridgeHandle, "setConfig">,
  logger: AdapterLogger,
  channelId: string,
  config: ConfigSet["config"],
): Promise<ConfigSetResult> {
  const res = await bridge.setConfig({ channelId, config }, CONFIG_SET_TIMEOUT_MS);
  if (!res.ok) throw new AdapterError(res.error.code, res.error.message);
  if (res.data.applied === "restart_required") {
    logger.warn({ channelId }, "channel config needs a gateway restart (ignored in MVP)");
  } else {
    logger.info({ channelId, applied: res.data.applied }, "channel config applied");
  }
  return res.data;
}
