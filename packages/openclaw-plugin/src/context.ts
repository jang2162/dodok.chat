import type { InboundDeliver } from "@dodok/shared";

export type ContextFormatOptions = {
  /** 최근 대화 시각 표기 시간대 (IANA). 기본 UTC */
  timeZone?: string;
  /** 채널 프롬프트가 Gateway 설정 경로로 못 들어갈 때만 true (스파이크 3 결과에 따라) */
  includeChannelPrompt?: boolean;
};

function hhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}

/** 스펙 8.3: 인바운드 앞에 붙는 컨텍스트 헤더 */
export function formatInboundContext(d: InboundDeliver, opts: ContextFormatOptions = {}): string {
  const tz = opts.timeZone ?? "UTC";
  const self = d.context.participants.find((p) => p.isSelf);
  const lines: string[] = [];
  lines.push(`[dodok context] channel=${d.channelId} you=@${self?.handle ?? d.agentId}`);
  lines.push(
    `참여자: ${d.context.participants
      .map((p) => `@${p.handle}(${p.type === "user" ? "사람" : "에이전트"}${p.isSelf ? ", 나" : ""})`)
      .join(", ")}`,
  );
  lines.push(`릴레이 규칙: ${d.context.relayRules}`);
  if (opts.includeChannelPrompt && d.context.channelPrompt)
    lines.push(`채널 프롬프트: ${d.context.channelPrompt}`);
  if (d.context.promptOverride) lines.push(`채널 지시: ${d.context.promptOverride}`);
  if (d.context.recentMessages.length > 0) {
    lines.push("최근 대화:");
    for (const m of d.context.recentMessages)
      lines.push(`[${hhmm(m.ts, tz)}] @${m.author.handle}: ${m.text}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** 채널 항목 `inboundChannelPrompt` — 인바운드가 실어 온 `context.channelPrompt` 를 어디에 넣는가 */
export type InboundChannelPromptMode = "prefix" | "context";

export type ChannelPromptPlacement = {
  contextOptions: ContextFormatOptions;
  /** OpenClaw `MsgContext.ChannelPromptContext` (시스템 지시가 아닌 채널 메타데이터로 현재 턴에 붙는다) */
  channelPromptContext?: string[];
};

/**
 * 계획서 5.2 주입 경로 선택. 모드가 없으면 인바운드에 싣지 않고 Gateway 설정 `systemPrompt`(GroupSystemPrompt)만 쓴다.
 * `prefix` = (b) 컨텍스트 헤더 줄(전사에 사용자 발화로 남는다), `context` = ChannelPromptContext.
 */
export function placeChannelPrompt(
  d: InboundDeliver,
  mode: InboundChannelPromptMode | undefined,
): ChannelPromptPlacement {
  const prompt = d.context.channelPrompt;
  if (!mode || !prompt) return { contextOptions: {} };
  if (mode === "prefix") return { contextOptions: { includeChannelPrompt: true } };
  return { contextOptions: {}, channelPromptContext: [`채널 프롬프트: ${prompt}`] };
}

/** 컨텍스트 헤더 + 인바운드 본문. 플러그인이 Gateway 인바운드로 넣는 최종 텍스트 */
export function buildInboundText(d: InboundDeliver, opts: ContextFormatOptions = {}): string {
  return `${formatInboundContext(d, opts)}\n${d.message.text}`;
}
