/**
 * 브리지 `config.set` → Gateway 설정 파일(`channels.dodok.channels.<id>`) 갱신.
 * `runtime.config.mutateConfigFile` 로 쓰고, 채널 항목은 `reload.noopPrefixes` 라 계정 재시작 없이
 * 다음 디스패치가 `runtime.config.current()` 로 읽는다 — 그래서 반영 여부를 current() 로 확인해 돌려준다.
 */
import type { ConfigSet, ConfigSetResult } from "@dodok/shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { BridgeLogger } from "./bridge-client";
import { applyChannelConfigSet, resolveDodokChannelEntry } from "./config";

const LIVE_WAIT_MS = 10_000;
const LIVE_POLL_MS = 200;

function isReflected(runtime: PluginRuntime, payload: ConfigSet): boolean {
  const current = resolveDodokChannelEntry(
    (runtime.config.current() as { channels?: Record<string, unknown> }).channels?.["dodok"],
    payload.channelId,
  );
  return (
    (payload.config.systemPrompt === undefined || current.systemPrompt === payload.config.systemPrompt) &&
    (payload.config.requireMention === undefined || current.requireMention === payload.config.requireMention)
  );
}

export async function writeChannelConfig(
  runtime: PluginRuntime,
  payload: ConfigSet,
  logger: BridgeLogger,
): Promise<ConfigSetResult> {
  const startedAt = Date.now();
  let changed = false;
  const result = await runtime.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      changed = applyChannelConfigSet(draft as Record<string, unknown>, payload);
    },
  });
  // 파일 쓰기 뒤 런타임 스냅샷(current())은 리로드 평가가 끝나야 바뀐다 — 반영될 때까지 짧게 기다린다
  let live = false;
  let liveAfterMs: number | null = null;
  for (let waited = 0; waited <= LIVE_WAIT_MS; waited += LIVE_POLL_MS) {
    if (isReflected(runtime, payload)) {
      live = true;
      liveAfterMs = Date.now() - startedAt;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
  }
  logger.info(
    `dodok:config-set ${JSON.stringify({
      channelId: payload.channelId,
      changed,
      live,
      liveAfterMs,
      followUp: result.followUp,
      afterWrite: result.afterWrite,
      elapsedMs: Date.now() - startedAt,
    })}`,
  );
  return { applied: live && !result.followUp.requiresRestart ? "live" : "restart_required" };
}
