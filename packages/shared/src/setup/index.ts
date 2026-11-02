import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// 설정 마법사 계약(스펙 2026-09-24-setup-wizard-design.md 2.6·3장). 브리지 토큰 원문은 IssueBridgeTokenResult.token 에만 있다

/**
 * OpenClaw 플러그인 설치 스크립트(로그인 없음) — 서버 라우트·발급 대화상자의 한 줄 명령·`llms.txt` 가 이 경로 하나를 쓴다
 * (설치 한 줄 명령 스펙 2026-11-02 1절)
 */
export const PLUGIN_INSTALL_SCRIPT_PATH = "/api/v1/setup/plugin-install.sh";

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

/** POST /api/v1/gateways/:id/bridge-tokens 본문 */
export const IssueBridgeTokenInput = z.object({ label: z.string().trim().min(1).max(60) });
export type IssueBridgeTokenInput = z.infer<typeof IssueBridgeTokenInput>;

/** 발급 응답(Cache-Control: no-store) — pluginConfig 는 Gateway 호스트에 넣을 channels.dodok 설정 조각 */
export const IssueBridgeTokenResult = z.object({
  token: z.string().regex(/^dbt_[A-Za-z0-9_-]{43}$/),
  record: BridgeTokenRecord,
  pluginConfig: z.unknown(),
});
export type IssueBridgeTokenResult = z.infer<typeof IssueBridgeTokenResult>;

/** 러너 토큰 목록·발급 결과의 한 줄(러너 스펙 5장) — 브리지 토큰과 같은 모양. prefix 는 원문의 drn_ 뒤 6자, connected 는 지금 이 토큰으로 붙은 러너가 있다 */
export const RunnerTokenRecord = BridgeTokenRecord.extend({
  // 그 러너(연결)의 주인 — 발급한 사람(연결 탭 통합 스펙 5.1)
  ownerUserId: Id.nullable(),
});
export type RunnerTokenRecord = z.infer<typeof RunnerTokenRecord>;

/** POST /api/v1/setup/runner-tokens 본문 — 라벨은 러너 머신 이름 */
export const IssueRunnerTokenInput = IssueBridgeTokenInput;
export type IssueRunnerTokenInput = z.infer<typeof IssueRunnerTokenInput>;

/** 러너 설정 파일에 적을 값 — 토큰 원문은 설정 파일이 아니라 tokenFile 에 둔다 */
export const RunnerConfigSnippet = z.object({ serverUrl: z.string(), tokenFile: z.string() });
export type RunnerConfigSnippet = z.infer<typeof RunnerConfigSnippet>;

/** 발급 응답(Cache-Control: no-store) — 원문은 여기에만 있다 */
export const IssueRunnerTokenResult = z.object({
  token: z.string().regex(/^drn_[A-Za-z0-9_-]{43}$/),
  record: RunnerTokenRecord,
  runnerConfig: RunnerConfigSnippet,
});
export type IssueRunnerTokenResult = z.infer<typeof IssueRunnerTokenResult>;

/** POST /api/v1/setup/runner-tokens/:id/reissue 응답 — 발급과 같은 모양, 원문은 여기에만(같은 행·같은 러너, 옛 원문은 곧바로 안 통한다) */
export const ReissueRunnerTokenResult = IssueRunnerTokenResult;
export type ReissueRunnerTokenResult = z.infer<typeof ReissueRunnerTokenResult>;

/**
 * 지금 붙은 러너 하나(러너 스펙 5장) — 어댑터 `setupDetail()` 의 runner 변형과 「연결」 탭 러너 상세가 같은 모양을 쓴다.
 * claudeCodeVersion 은 hello 의 claude 프로그램 판본(없으면 빈 문자열). 러너의 프로젝트·에이전트는 러너 REST(GET /api/v1/runners)
 */
export const RunnerConnection = z.object({
  tokenId: Id,
  label: z.string(),
  runnerVersion: z.string(),
  sdkVersion: z.string(),
  claudeCodeVersion: z.string(),
  bundleSha256: Sha256Hex.nullable(),
  capabilities: z.array(z.string()),
  connectedAt: IsoDateTime,
});
export type RunnerConnection = z.infer<typeof RunnerConnection>;

/** 서버가 품은 tgz(플러그인·러너) — 서버 안 경로는 싣지 않는다 */
const PackedFile = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    sha256: Sha256Hex,
    bundleSha256: Sha256Hex,
    bytes: z.int().min(0),
  }),
  z.object({ available: z.literal(false) }),
]);

/** 「연결」 탭 Gateway 상세의 Gateway 하나(멀티 Gateway 계획 판정 PG7) — 공유 토큰은 싣지 않는다 */
export const GatewaySetup = z.object({
  id: Id,
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  // admin 이상이 승인했는가 — 아니면 켜져 있어도 연결하지 않는다(state disabled, 연결 탭 통합 스펙 5.4)
  approved: z.boolean(),
  gateway: z.object({
    // disabled — 꺼 두었거나 승인 전인 Gateway(연결하지 않는다)
    state: z.enum(["connected", "reconnecting", "down", "disabled"]),
    host: z.string(), // URL 의 호스트만 — 자격 증명·경로·쿼리·Gateway 토큰은 싣지 않는다
    version: z.string().nullable(),
    pinned: z.string(), // 저장소가 검증한 Gateway 버전(운영 보강 5.2)
    drift: z.boolean(), // version 이 있고 pinned 와 다르다
    pairing: z.object({ requestId: z.string(), since: IsoDateTime }).nullable(),
  }),
  bridge: z.object({
    state: z.enum(["connected", "down"]),
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
  pluginMatches: z.boolean().nullable(), // 접속 플러그인과 서버가 품은 파일이 같은 빌드인가, 모르면 null
});
export type GatewaySetup = z.infer<typeof GatewaySetup>;

/** GET /api/v1/setup/status 응답이자 wire setup.status 페이로드 */
export const SetupStatus = z.object({
  server: z.object({ version: z.string() }),
  // Gateway 와 상관없는 머리 값 — 모든 Gateway 의 플러그인이 같은 bridgeUrl 로 붙는다
  bridge: z.object({
    publicUrl: z.string(), // BRIDGE_PUBLIC_URL, 없으면 APP_ORIGIN 의 wss: + /bridge
  }),
  pluginFile: PackedFile,
  gateways: z.array(GatewaySetup), // 더한 차례
  runners: z.object({
    list: z.array(RunnerConnection),
    // 서버 이미지가 품은 러너 tgz — pluginFile 과 같은 모양
    runnerFile: PackedFile,
  }),
});
export type SetupStatus = z.infer<typeof SetupStatus>;
