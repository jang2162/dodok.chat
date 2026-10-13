import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { dodokChannelPlugin } from "./channel";
import { CONTROL_PLUGIN_TOOL_NAMES, createControlToolFactory } from "./control-tools";
import { setDodokRuntime } from "./runtime";

/**
 * `defineChannelPluginEntry` 는 `definePluginEntry({ register(api) { api.registerChannel({ plugin }) } })` 에
 * 런타임 주입(`setRuntime`)과 등록 모드 분기(cli-metadata / setup-only / full)를 얹은 SDK 권장 형태다.
 */
export default defineChannelPluginEntry({
  id: "dodok",
  name: "dodok",
  description: "dodok.chat channel — bridges OpenClaw agents to dodok channels over an outbound WebSocket.",
  plugin: dodokChannelPlugin,
  setRuntime: setDodokRuntime,
  // 제어 도구 — 팩토리가 dodok 세션에서만 도구를 낸다. names 는 매니페스트 contracts.tools 와 같아야 등록된다
  registerFull: (api) =>
    api.registerTool(createControlToolFactory() as unknown as Parameters<typeof api.registerTool>[0], {
      names: [...CONTROL_PLUGIN_TOOL_NAMES],
    }),
});
