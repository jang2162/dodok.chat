/** 설정 마법사의 연결 상태 조립(스펙 3장 SetupStatus) — Gateway 행·어댑터 상세·플러그인 파일·서버 버전을 모은다. 입출력 없음 */
import type { GatewaySetup, RunnerConnection, SetupStatus } from "@dodok/shared";
import type { GatewaySetupEntry } from "../../adapters/types";
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

/**
 * Gateway 목록은 DB 행이 정본(id·이름·주소·켜짐, 더한 차례)이고 연결 상태는 어댑터의 Gateway 별 상세에서 id 로 짝짓는다
 * (계획 판정 PG7). 어댑터가 아직 모르는 행(넣기 전·넣다 실패)은 켜졌으면 down, 꺼졌으면 disabled 로 보인다
 */
export function buildSetupStatus(input: {
  gateways: Array<{ id: string; name: string; url: string; enabled: boolean }>;
  /** OpenClaw 어댑터의 gatewaySetupDetails() */
  details: GatewaySetupEntry[];
  pluginFile: PluginFile | null;
  /** 러너 블록 — 러너 어댑터가 붙인 러너들(setupDetail 의 claude 변형)과 품은 러너 tgz. 러너 어댑터가 없으면 빈 목록 */
  runners: RunnerConnection[];
  runnerFile: PluginFile | null;
  serverVersion: string;
  publicUrl: string;
}): SetupStatus {
  const { pluginFile } = input;
  const details = new Map(input.details.map((entry) => [entry.id, entry]));
  return {
    server: { version: input.serverVersion },
    bridge: { publicUrl: input.publicUrl },
    pluginFile: packedFile(pluginFile),
    gateways: input.gateways.map((row): GatewaySetup => {
      const detail = details.get(row.id);
      const plugin = row.enabled ? (detail?.bridge.plugin ?? null) : null;
      const version = detail?.gateway.version ?? null;
      return {
        id: row.id,
        name: row.name,
        url: row.url,
        enabled: row.enabled,
        gateway: {
          state: !row.enabled ? "disabled" : (detail?.gateway.state ?? "down"),
          host: detail?.gateway.host ?? hostOf(row.url),
          version,
          ...gatewayPin(version),
          pairing: row.enabled ? (detail?.gateway.pairing ?? null) : null,
        },
        bridge: { state: plugin ? "connected" : "down", plugin: plugin ? { ...plugin } : null },
        // 같은 빌드인가는 tgz 안의 번들 sha256 끼리 — 한쪽이라도 모르면 null(옛 플러그인은 bundleSha256 을 보내지 않는다)
        pluginMatches:
          pluginFile && plugin?.bundleSha256 ? plugin.bundleSha256 === pluginFile.bundleSha256 : null,
      };
    }),
    runners: { list: input.runners, runnerFile: packedFile(input.runnerFile) },
  };
}

/** 주소의 호스트(포트 포함)만 — 자격 증명·경로·쿼리는 싣지 않는다 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 서버 안 파일 경로는 싣지 않는다 */
function packedFile(file: PluginFile | null): SetupStatus["pluginFile"] {
  return file
    ? { available: true, sha256: file.sha256, bundleSha256: file.bundleSha256, bytes: file.bytes }
    : { available: false };
}
