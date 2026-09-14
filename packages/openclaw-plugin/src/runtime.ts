import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

export const { setRuntime: setDodokRuntime, getRuntime: getDodokRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "dodok",
    errorMessage: "dodok channel runtime not initialized",
  });
