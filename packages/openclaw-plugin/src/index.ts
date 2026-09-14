import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { dodokChannelPlugin } from "./channel";
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
});
