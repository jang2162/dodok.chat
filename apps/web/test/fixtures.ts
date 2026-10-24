import { Approval, Message, RunEvent, RunState } from "@dodok/shared";

/** uuid 모양 id. uuid v7 은 생성 순 = 문자열 순이라 n 이 작을수록 앞선다 */
export const uid = (n: number) => `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const CH = uid(1);
export const CH2 = uid(2);
export const USER = uid(10);
export const AGENT = uid(11);
export const RUN = uid(101);
export const RUN2 = uid(102);
export const APPROVAL = uid(201);
export const APPROVAL2 = uid(202);
const TS = "2027-01-15T08:00:00.000Z";
/** 승인 TTL 기본값(plugin 실물) — 픽스처의 expiresAt 은 createdAt + 이만큼 */
export const TTL_MS = 120_000;
export const iso = (ms: number) => new Date(ms).toISOString();

/** 픽스처는 shared 스키마를 통과시켜 계약과 맞춘다 */
export const msg = (seq: number, over: Partial<Message> = {}): Message =>
  Message.parse({
    id: uid(10_000 + seq),
    channelId: CH,
    // 채널마다 대화가 하나이고 id 가 채널 id 와 같다(채널 세션 계획 판정 PS1)
    conversationId: over.channelId ?? CH,
    seq,
    kind: "normal",
    authorType: "user",
    authorId: USER,
    bodyMd: `m${seq}`,
    mentions: { users: [], agents: [] },
    attachments: [],
    createdAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    ...over,
  });

export const runState = (over: Partial<RunState> = {}): RunState =>
  RunState.parse({
    id: RUN,
    channelId: CH,
    conversationId: over.channelId ?? CH,
    agentId: AGENT,
    status: "streaming",
    relayDepth: 0,
    hasCanonical: false,
    ...over,
  });

export const runEvent = (e: Record<string, unknown>): RunEvent =>
  RunEvent.parse({ runId: RUN, ts: TS, ...e });
export const textDelta = (seq: number, delta: string, runId = RUN): RunEvent =>
  runEvent({ type: "TEXT_MESSAGE_CONTENT", runId, seq, messageId: "m", delta });

/**
 * 승인 하나. 기본은 「미해결 · Write · 이번만 허용/거절 · TTL 120초」다(가짜 Gateway 대본과 같은 모양).
 * 카운트다운을 재는 테스트는 `expiresAt` 을 그 테스트의 시계에 맞춰 넘긴다
 */
export const approval = (over: Partial<Approval> = {}): Approval =>
  Approval.parse({
    id: APPROVAL,
    providerApprovalId: "plugin:0f0f0f0f-0000-4000-8000-000000000001",
    kind: "plugin",
    channelId: CH,
    conversationId: over.channelId ?? CH,
    agentId: AGENT,
    runId: RUN,
    toolCallId: "toolu_01",
    toolName: "Write",
    title: "claude-cli native tool: Write",
    description: '{"file_path":"/tmp/a.txt","content":"hi"}',
    severity: "warning",
    allowedDecisions: ["allow-once", "deny"],
    status: "pending",
    createdAt: TS,
    expiresAt: iso(Date.parse(TS) + TTL_MS),
    ...over,
  });
