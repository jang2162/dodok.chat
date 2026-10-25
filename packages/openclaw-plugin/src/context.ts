import { formatReactionFacts, formatSessionLine, type InboundDeliver } from "@dodok/shared";

export type ContextFormatOptions = {
  /** 최근 대화 시각 표기 시간대 (IANA). 기본 UTC */
  timeZone?: string;
};

function hhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}

/** 스펙 8.3: 인바운드 앞에 붙는 컨텍스트 헤더. 채널 프롬프트·오버라이드는 여기가 아니라 `channelPromptContext` 로 */
export function formatInboundContext(d: InboundDeliver, opts: ContextFormatOptions = {}): string {
  const tz = opts.timeZone ?? "UTC";
  const self = d.context.participants.find((p) => p.isSelf);
  const lines: string[] = [];
  const thread = d.context.thread;
  const threadPart = d.threadId ? ` thread=${d.threadId}` : "";
  lines.push(`[dodok context] channel=${d.channelId}${threadPart} you=@${self?.handle ?? d.agentId}`);
  lines.push(formatSessionLine(d.conversationTitle));
  lines.push(
    `참여자: ${d.context.participants
      .map((p) => `@${p.handle}(${p.type === "user" ? "사람" : "에이전트"}${p.isSelf ? ", 나" : ""})`)
      .join(", ")}`,
  );
  lines.push(`릴레이 규칙: ${d.context.relayRules}`);
  const line = (m: { author: { handle: string }; text: string; ts: string }) =>
    `[${hhmm(m.ts, tz)}] @${m.author.handle}: ${m.text}`;
  if (thread) {
    // 스레드 세션에는 채널 최근 대화를 싣지 않는다(스펙 2.3) — 서버가 비워 보내도 여기서 한 번 더 막는다
    lines.push(`스레드 루트: ${line(thread.root)}`);
    if (thread.recentMessages.length > 0) {
      lines.push("스레드 최근:");
      for (const m of thread.recentMessages) lines.push(line(m));
    }
  } else if (d.context.recentMessages.length > 0) {
    lines.push("최근 대화:");
    for (const m of d.context.recentMessages) lines.push(line(m));
  }
  const reactionFacts = formatReactionFacts(d.context.reactions ?? [], d.context.reactionsOmitted);
  if (reactionFacts) lines.push(reactionFacts);
  lines.push("---");
  return lines.join("\n");
}

/**
 * 스펙 8.3·계획서 10장 #1·#18 — OpenClaw `MsgContext.ChannelPromptContext` 항목. 헤더 줄로 넣으면 표시 전사에
 * 사용자 발화로 남으므로 채널 메타데이터로 현재 턴에 붙인다. 채울지(리비전 불일치)는 서버가 정하고, 값이 있으면 항상 싣는다.
 */
export function channelPromptContext(d: InboundDeliver): string[] | undefined {
  const items: string[] = [];
  if (d.context.channelPrompt) items.push(`채널 프롬프트: ${d.context.channelPrompt}`);
  if (d.context.promptOverride) items.push(`채널 지시: ${d.context.promptOverride}`);
  return items.length > 0 ? items : undefined;
}

/** 컨텍스트 헤더 + 인바운드 본문. 플러그인이 Gateway 인바운드로 넣는 최종 텍스트 */
export function buildInboundText(d: InboundDeliver, opts: ContextFormatOptions = {}): string {
  return `${formatInboundContext(d, opts)}\n${d.message.text}`;
}
