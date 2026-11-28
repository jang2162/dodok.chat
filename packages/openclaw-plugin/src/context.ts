import {
  formatConversationBlock,
  formatDmLine,
  formatGroupDmLine,
  formatHeaderTime,
  formatLinkedMessages,
  formatParticipantLabel,
  formatReactionFacts,
  formatSessionInviteLine,
  formatSessionLine,
  formatThreadUpdates,
  formatTimeZoneLine,
  type InboundDeliver,
} from "@dodok/shared";

/**
 * 스펙 8.3: 인바운드 앞에 붙는 컨텍스트 헤더. 채널 프롬프트·오버라이드는 여기가 아니라 `channelPromptContext` 로.
 * 시각은 서버가 실은 워크스페이스 시간대(`context.timeZone`, 없으면 UTC)로 찍고, 릴레이 규칙 줄 다음에 그 시간대를 밝힌다.
 * `continuing` — 이 턴이 앞 턴을 실은 OpenClaw 세션을 그대로 이어 간다고 확신할 때만(session-continuity.ts) — 대화 블록이 지난 턴 뒤
 * 새 글만 싣는다(formatConversationBlock)
 */
export function formatInboundContext(d: InboundDeliver, opts: { continuing?: boolean } = {}): string {
  const tz = d.context.timeZone;
  const hhmm = (iso: string) => formatHeaderTime(iso, tz);
  const self = d.context.participants.find((p) => p.isSelf);
  const lines: string[] = [];
  const thread = d.context.thread;
  const threadPart = d.threadId ? ` thread=${d.threadId}` : "";
  // session= 은 대화 id — OpenClaw chat_id(`channel:<id>`)·세션 키의 그 id 다. 채널 id 만 실으면 에이전트가 둘을 다른 방으로 읽는다
  lines.push(
    `[dodok context] channel=${d.channelId} session=${d.conversationId}${threadPart} you=@${self?.handle ?? d.agentId}`,
  );
  if (d.dm) lines.push(formatDmLine(d.dm.ownerHandle));
  if (d.groupDm) lines.push(formatGroupDmLine());
  lines.push(formatSessionLine(d.conversationTitle));
  const sessionInvite = formatSessionInviteLine(d.context.participants);
  if (sessionInvite !== null) lines.push(sessionInvite);
  lines.push(`참여자: ${d.context.participants.map(formatParticipantLabel).join(", ")}`);
  lines.push(`릴레이 규칙: ${d.context.relayRules}`);
  lines.push(formatTimeZoneLine(tz, d.message.ts));
  const line = (m: { author: { handle: string }; text: string; ts: string }) =>
    `[${hhmm(m.ts)}] @${m.author.handle}: ${m.text}`;
  // 스레드 세션에는 채널 최근 대화를 싣지 않는다(스펙 2.3) — 서버가 비워 보내도 formatConversationBlock 이 한 번 더 막는다
  lines.push(...formatConversationBlock(d.context, { continuing: opts.continuing === true, line }));
  if (!thread) {
    // 스레드 소식은 대화 세션 런만 — 스레드 세션에는 서버가 싣지 않고, 실려 와도 여기서 한 번 더 막는다
    const threadUpdates = formatThreadUpdates(
      d.context.threadUpdates ?? [],
      d.context.threadUpdatesOmitted,
      hhmm,
    );
    if (threadUpdates) lines.push(threadUpdates);
  }
  // 트리거 글이 링크한 메시지(메시지 링크 스펙) — 대화·스레드 블록 다음, 반응 앞. 본문은 들여써 `---` 줄로 읽히지 않는다
  const linked = formatLinkedMessages(d.context.linkedMessages ?? [], hhmm);
  if (linked !== null) lines.push(linked);
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
export function buildInboundText(d: InboundDeliver, opts: { continuing?: boolean } = {}): string {
  return `${formatInboundContext(d, opts)}\n${d.message.text}`;
}
