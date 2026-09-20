import { z } from "zod";
import type { Ack } from "../common";
import { Id } from "../common";
import {
  AgentProvider,
  Approval,
  ApprovalDecision,
  type Channel,
  type ChannelMember,
  Message,
  RunState,
} from "../domain";
import { RunEvent } from "../events";

// ── 클라이언트 → 서버 (ack 있음) ──
export const ChannelSubscribe = z.object({ channelId: Id, lastSeq: z.int().min(0).optional() });
export type ChannelSubscribe = z.infer<typeof ChannelSubscribe>;
export const ChannelSubscribeResult = z.object({
  messages: z.array(Message), // lastSeq 이후, 최대 200개
  hasMore: z.boolean(),
  activeRuns: z.array(RunState), // 종료되지 않은 런
  pendingApprovals: z.array(Approval),
});
export type ChannelSubscribeResult = z.infer<typeof ChannelSubscribeResult>;

export const MessageSend = z.object({
  channelId: Id,
  clientMsgId: z.string().min(1).max(64),
  bodyMd: z.string().min(1).max(100_000), // 토큰 본문
  attachments: z.array(Id).max(10).optional(), // 업로드 API로 먼저 올린 첨부 id
  replyTo: Id.optional(),
});
export type MessageSend = z.infer<typeof MessageSend>;

export const RunAbort = z.object({ runId: Id });
export type RunAbort = z.infer<typeof RunAbort>;

export const RunEventsReplay = z.object({ runId: Id, afterSeq: z.int().min(0).default(0) });
export type RunEventsReplay = z.infer<typeof RunEventsReplay>;
export const RunEventsReplayResult = z.object({ events: z.array(RunEvent), run: RunState });
export type RunEventsReplayResult = z.infer<typeof RunEventsReplayResult>;

export const ComponentInteract = z.object({
  messageId: Id,
  componentId: z.string(),
  blockId: z.string().optional(),
  itemId: z.string(),
  values: z.record(z.string(), z.unknown()),
});
export type ComponentInteract = z.infer<typeof ComponentInteract>;

// 서버가 그 승인의 allowedDecisions 안인지 먼저 검증한 뒤에만 Gateway 로 보낸다(스파이크 4.4).
// note 는 Gateway 가 받지 않는다 — 두지 않는다.
export const ApprovalResolve = z.object({ approvalId: Id, decision: ApprovalDecision });
export type ApprovalResolve = z.infer<typeof ApprovalResolve>;

export const Typing = z.object({ channelId: Id });
export type Typing = z.infer<typeof Typing>;

export interface ClientToServerEvents {
  "channel.subscribe": (p: ChannelSubscribe, ack: Ack<ChannelSubscribeResult>) => void;
  "channel.unsubscribe": (p: { channelId: Id }, ack: Ack<null>) => void;
  "message.send": (p: MessageSend, ack: Ack<{ message: Message }>) => void;
  "run.abort": (p: RunAbort, ack: Ack<null>) => void;
  "run.events.replay": (p: RunEventsReplay, ack: Ack<RunEventsReplayResult>) => void;
  "component.interact": (p: ComponentInteract, ack: Ack<{ interactionId: Id }>) => void;
  "approval.resolve": (p: ApprovalResolve, ack: Ack<null>) => void;
  typing: (p: Typing) => void; // ack 없음, 클라이언트가 3초 스로틀
}

// ── 서버 → 클라이언트 (룸 channel:<id> 또는 user:<id>) ──
export const AdapterStatus = z.object({
  provider: AgentProvider,
  gateway: z.enum(["connected", "reconnecting", "down"]),
  bridge: z.enum(["connected", "down"]),
});
export type AdapterStatus = z.infer<typeof AdapterStatus>;

export interface ServerToClientEvents {
  "message.created": (p: { message: Message }) => void;
  "message.updated": (p: { message: Message }) => void; // 수정, 컴포넌트 소비/만료
  "run.state": (p: { run: RunState; resync?: boolean }) => void;
  "run.event": (p: { event: RunEvent }) => void;
  "approval.requested": (p: { approval: Approval }) => void;
  "approval.resolved": (p: { approval: Approval }) => void;
  "channel.created": (p: { channel: Channel }) => void; // workspace 룸 — 채널 룸에는 아직 아무도 없다
  "channel.updated": (p: { channel: Channel }) => void;
  "channel.member.changed": (p: { channelId: Id; members: ChannelMember[] }) => void;
  typing: (p: { channelId: Id; actorType: "user" | "agent"; actorId: Id }) => void;
  "adapter.status": (p: AdapterStatus) => void; // user 룸
  "system.notice": (p: { level: "info" | "warn" | "error"; message: string }) => void;
}
