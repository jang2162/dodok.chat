import { Message, RunEvent, RunState } from "@dodok/shared";

/** uuid 모양 id. uuid v7 은 생성 순 = 문자열 순이라 n 이 작을수록 앞선다 */
export const uid = (n: number) => `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const CH = uid(1);
export const CH2 = uid(2);
export const USER = uid(10);
export const AGENT = uid(11);
export const RUN = uid(101);
export const RUN2 = uid(102);
const TS = "2027-01-15T08:00:00.000Z";

/** 픽스처는 shared 스키마를 통과시켜 계약과 맞춘다 */
export const msg = (seq: number, over: Partial<Message> = {}): Message =>
  Message.parse({
    id: uid(10_000 + seq),
    channelId: CH,
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
