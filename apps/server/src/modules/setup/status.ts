/** 설정 마법사의 연결 상태 조립(스펙 3장 SetupStatus) — 어댑터 상세·플러그인 파일·서버 버전을 모은다. 입출력 없음 */
import type { SetupStatus } from "@dodok/shared";
import type { AdapterSetupDetail, OpenClawSetupDetail } from "../../adapters/types";
import { gatewayPin } from "../ops/health";
import type { PluginFile } from "./plugin-file";

/** 플러그인 계정 설정의 bridgeUrl — BRIDGE_PUBLIC_URL, 없으면 APP_ORIGIN 의 https:→wss:·http:→ws: + /bridge */
export function bridgePublicUrl(config: {
  BRIDGE_PUBLIC_URL?: string | undefined;
  APP_ORIGIN: string;
}): string {
  if (config.BRIDGE_PUBLIC_URL) return config.BRIDGE_PUBLIC_URL;
  const origin = new URL(config.APP_ORIGIN);
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${origin.host}/bridge`;
}

/** 상세가 OpenClaw 것이 아닐 때 gateway·bridge 블록 — 붙은 것이 없는 모양 */
const OPENCLAW_ABSENT: OpenClawSetupDetail = {
  provider: "openclaw",
  gateway: { state: "down", host: "", version: null, pairing: null },
  bridge: { state: "down", plugin: null },
};

export function buildSetupStatus(input: {
  detail: AdapterSetupDetail;
  pluginFile: PluginFile | null;
  serverVersion: string;
  publicUrl: string;
  envTokenIgnored: boolean;
}): SetupStatus {
  const { pluginFile } = input;
  // gateway·bridge 블록은 OpenClaw 어댑터의 상세다
  const detail = input.detail.provider === "openclaw" ? input.detail : OPENCLAW_ABSENT;
  const plugin = detail.bridge.plugin;
  // 같은 빌드인가는 tgz 안의 번들 sha256 끼리 — 한쪽이라도 모르면 null(옛 플러그인은 bundleSha256 을 보내지 않는다)
  const pluginMatches =
    pluginFile && plugin?.bundleSha256 ? plugin.bundleSha256 === pluginFile.bundleSha256 : null;
  return {
    server: { version: input.serverVersion },
    gateway: {
      state: detail.gateway.state,
      host: detail.gateway.host,
      version: detail.gateway.version,
      ...gatewayPin(detail.gateway.version),
      pairing: detail.gateway.pairing,
    },
    bridge: { state: detail.bridge.state, publicUrl: input.publicUrl, plugin: plugin ? { ...plugin } : null },
    // 서버 안 파일 경로는 싣지 않는다
    pluginFile: pluginFile
      ? {
          available: true,
          sha256: pluginFile.sha256,
          bundleSha256: pluginFile.bundleSha256,
          bytes: pluginFile.bytes,
        }
      : { available: false },
    pluginMatches,
    envTokenIgnored: input.envTokenIgnored,
    runners: { list: [], runnerFile: { available: false } }, // 러너 어댑터가 서버에 붙기 전까지는 비어 있다
  };
}
