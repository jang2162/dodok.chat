import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// 설정 마법사 계약(스펙 2026-09-24-setup-wizard-design.md 2.6·3장). 브리지 토큰 원문은 IssueBridgeTokenResult.token 에만 있다

/** sha256 hex(소문자 64자) — 플러그인 번들·tgz 가 같은 빌드인지 가르는 값(스펙 결정 5) */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** 목록·발급 결과의 토큰 한 줄 — 원문·해시는 싣지 않는다. prefix 는 원문의 dbt_ 뒤 6자 */
export const BridgeTokenRecord = z.object({
  id: Id,
  label: z.string().min(1).max(60),
  prefix: z.string().length(6),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  connected: z.boolean(), // 지금 이 토큰으로 붙은 브리지 세션이 있다
});
export type BridgeTokenRecord = z.infer<typeof BridgeTokenRecord>;

/** POST /api/v1/setup/bridge-tokens 본문 */
export const IssueBridgeTokenInput = z.object({ label: z.string().trim().min(1).max(60) });
export type IssueBridgeTokenInput = z.infer<typeof IssueBridgeTokenInput>;

/** 발급 응답(Cache-Control: no-store) — pluginConfig 는 Gateway 호스트에 넣을 channels.dodok 설정 조각 */
export const IssueBridgeTokenResult = z.object({
  token: z.string().regex(/^dbt_[A-Za-z0-9_-]{43}$/),
  record: BridgeTokenRecord,
  pluginConfig: z.unknown(),
});
export type IssueBridgeTokenResult = z.infer<typeof IssueBridgeTokenResult>;

/** GET /api/v1/setup/status 응답이자 wire setup.status 페이로드 */
export const SetupStatus = z.object({
  server: z.object({ version: z.string() }),
  gateway: z.object({
    state: z.enum(["connected", "reconnecting", "down"]),
    host: z.string(), // URL 의 호스트만 — 자격 증명·경로·쿼리·Gateway 토큰은 싣지 않는다
    version: z.string().nullable(),
    pinned: z.string(), // 저장소가 검증한 Gateway 버전(운영 보강 5.2)
    drift: z.boolean(), // version 이 있고 pinned 와 다르다
    pairing: z.object({ requestId: z.string(), since: IsoDateTime }).nullable(),
  }),
  bridge: z.object({
    state: z.enum(["connected", "down"]),
    publicUrl: z.string(), // BRIDGE_PUBLIC_URL, 없으면 APP_ORIGIN 의 wss: + /bridge
    plugin: z
      .object({
        version: z.string(),
        sdkVersion: z.string(),
        gatewayVersion: z.string().nullable(),
        bundleSha256: Sha256Hex.nullable(), // 옛 플러그인은 보내지 않는다
        tokenId: Id.nullable(),
        connectedAt: IsoDateTime,
      })
      .nullable(),
  }),
  pluginFile: z.discriminatedUnion("available", [
    z.object({
      available: z.literal(true),
      sha256: Sha256Hex,
      bundleSha256: Sha256Hex,
      bytes: z.int().min(0),
    }),
    z.object({ available: z.literal(false) }),
  ]),
  pluginMatches: z.boolean().nullable(), // 접속 플러그인과 서버가 품은 파일이 같은 빌드인가, 모르면 null
  envTokenIgnored: z.boolean(), // .env 에 BRIDGE_TOKEN 이 있는데 DB 활성 토큰과 다르다
});
export type SetupStatus = z.infer<typeof SetupStatus>;
