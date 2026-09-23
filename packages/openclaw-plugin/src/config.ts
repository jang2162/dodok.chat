/**
 * `channels.dodok` 설정 스키마와 해석. `openclaw` 를 import 하지 않는다 — 단위 테스트 대상.
 *
 * 매니페스트(`openclaw.plugin.json` 의 `channelConfigs.dodok.schema`)는 이 스키마의 JSON Schema 이고,
 * `test/manifest.test.ts` 가 둘이 어긋나지 않는지 잰다.
 */
import { ATTACHMENT_LIMITS, Id, type ConfigSet } from "@dodok/shared";
import { z } from "zod";

export const DEFAULT_ACCOUNT_ID = "default";

const BridgeUrl = z
  .url()
  .refine((value) => /^(wss?|https?):\/\//.test(value), { message: "ws/wss/http/https URL 이어야 한다" });

/** OpenClaw `ChannelBotLoopProtectionSchema` 와 같은 모양 (docs/channels/bot-loop-protection.md) */
export const BotLoopProtectionConfig = z
  .object({
    enabled: z.boolean().optional(),
    maxEventsPerWindow: z.int().min(1).optional(),
    windowSeconds: z.int().min(1).optional(),
    cooldownSeconds: z.int().min(0).optional(),
  })
  .strict();
export type BotLoopProtectionConfig = z.infer<typeof BotLoopProtectionConfig>;

export const DodokAccountConfig = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().max(80).optional(),
    bridgeUrl: BridgeUrl,
    token: z.string().min(1),
    /** 에이전트가 보내는 파일 하나의 상한(MiB). 없으면 20 — `ATTACHMENT_LIMITS.agentFileMaxBytes` 를 넘지 않는다 */
    mediaMaxMb: z.int().min(1).max(20).optional(),
  })
  .strict();
export type DodokAccountConfig = z.infer<typeof DodokAccountConfig>;

/** 계획서 5.2 — 채널별 설정 (Discord `channels.<id>.*` 관례) */
export const DodokChannelEntryConfig = z
  .object({
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().max(20_000).optional(),
    botLoopProtection: BotLoopProtectionConfig.optional(),
  })
  .strict();
export type DodokChannelEntryConfig = z.infer<typeof DodokChannelEntryConfig>;

export const DodokChannelSection = z
  .object({
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    accounts: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), DodokAccountConfig).optional(),
    channels: z.record(Id, DodokChannelEntryConfig).optional(),
    botLoopProtection: BotLoopProtectionConfig.optional(),
  })
  .strict();
export type DodokChannelSection = z.infer<typeof DodokChannelSection>;

export type ResolvedDodokAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  bridgeUrl?: string;
  token?: string;
  /** 아웃바운드 미디어 한 파일의 상한(바이트) */
  mediaMaxBytes: number;
  /** 검증 실패 경로·메시지. 값(토큰 등)은 싣지 않는다 */
  issues: string[];
};

function mediaMaxBytesOf(mediaMaxMb: number | undefined): number {
  return Math.min((mediaMaxMb ?? 20) * 1024 * 1024, ATTACHMENT_LIMITS.agentFileMaxBytes);
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

function parseSection(section: unknown): { data?: DodokChannelSection; issues: string[] } {
  if (section === undefined || section === null) return { data: {}, issues: [] };
  const parsed = DodokChannelSection.safeParse(section);
  return parsed.success ? { data: parsed.data, issues: [] } : { issues: issuesOf(parsed.error) };
}

export function listDodokAccountIds(section: unknown): string[] {
  const { data } = parseSection(section);
  return Object.keys(data?.accounts ?? {});
}

export function resolveDodokAccount(
  section: unknown,
  accountId: string | null | undefined,
): ResolvedDodokAccount {
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const { data, issues } = parseSection(section);
  const mediaMaxBytes = mediaMaxBytesOf(undefined);
  if (!data) return { accountId: id, enabled: false, configured: false, mediaMaxBytes, issues };
  const account = data.accounts?.[id];
  if (!account)
    return { accountId: id, enabled: data.enabled !== false, configured: false, mediaMaxBytes, issues: [] };
  return {
    accountId: id,
    enabled: data.enabled !== false && account.enabled !== false,
    configured: true,
    bridgeUrl: account.bridgeUrl,
    token: account.token,
    mediaMaxBytes: mediaMaxBytesOf(account.mediaMaxMb),
    issues: [],
  };
}

export type ResolvedDodokChannelEntry = {
  requireMention: boolean;
  systemPrompt?: string;
  botLoopProtection?: BotLoopProtectionConfig;
  sectionBotLoopProtection?: BotLoopProtectionConfig;
};

export function resolveDodokChannelEntry(section: unknown, channelId: string): ResolvedDodokChannelEntry {
  const { data } = parseSection(section);
  const entry = data?.channels?.[channelId];
  const resolved: ResolvedDodokChannelEntry = { requireMention: entry?.requireMention ?? true };
  if (entry?.systemPrompt !== undefined) resolved.systemPrompt = entry.systemPrompt;
  if (entry?.botLoopProtection) resolved.botLoopProtection = entry.botLoopProtection;
  if (data?.botLoopProtection) resolved.sectionBotLoopProtection = data.botLoopProtection;
  return resolved;
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing))
    return existing as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

/**
 * 브리지 `config.set` 을 Gateway 설정 초안(`mutateConfigFile` 의 draft)에 반영한다.
 * 바뀐 값이 있으면 true — false 면 쓰기를 건너뛸 수 있다.
 */
export function applyChannelConfigSet(draft: Record<string, unknown>, payload: ConfigSet): boolean {
  const entry = objectAt(
    objectAt(objectAt(objectAt(draft, "channels"), "dodok"), "channels"),
    payload.channelId,
  );
  let changed = false;
  for (const key of ["requireMention", "systemPrompt"] as const) {
    const value = payload.config[key];
    if (value === undefined || entry[key] === value) continue;
    entry[key] = value;
    changed = true;
  }
  return changed;
}
