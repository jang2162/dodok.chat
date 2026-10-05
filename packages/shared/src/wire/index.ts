import { z } from "zod";
import type { Ack } from "../common";
import { Id } from "../common";
import {
  ATTACHMENT_LIMITS,
  Approval,
  ApprovalDecision,
  type Channel,
  type ChannelMember,
  Message,
  RunState,
} from "../domain";
import { RunEvent } from "../events";
import type { Person } from "../members";
import type { OpsEvent, OpsUnacked } from "../ops";
import type { SetupStatus } from "../setup";

// ── 클라이언트 → 서버 (ack 있음) ──
export const ChannelSubscribe = z.object({ channelId: Id, lastSeq: z.int().min(0).optional() });
export type ChannelSubscribe = z.infer<typeof ChannelSubscribe>;
export const ChannelSubscribeResult = z.object({
  messages: z.array(Message), // lastSeq 이후, 최대 200개. lastSeq 가 있으면 스레드 답글도 들어간다
  hasMore: z.boolean(),
  activeRuns: z.array(RunState), // 종료되지 않은 런
  pendingApprovals: z.array(Approval),
  // lastSeq 재동기화만 — messages 의 답글이 가리키는 루트 중 messages 에 없는 것(최신 threadSummary 를 실었다).
  // 끊긴 사이 발행된 루트 message.updated 를 소켓이 못 받았으므로 웹은 이것으로 칩을 고친다
  threadRoots: z.array(Message).optional(),
});
export type ChannelSubscribeResult = z.infer<typeof ChannelSubscribeResult>;

export const MessageSend = z
  .object({
    channelId: Id,
    clientMsgId: z.string().min(1).max(64),
    bodyMd: z.string().max(100_000), // 토큰 본문. 첨부가 있으면 비어도 된다
    attachments: z.array(Id).max(ATTACHMENT_LIMITS.perMessage).optional(), // 업로드 API로 먼저 올린 첨부 id
    replyTo: Id.optional(),
    threadRootId: Id.optional(), // 답글을 가리키면 서버가 VALIDATION 으로 거절한다 — 웹이 루트를 보낸다
  })
  .refine((v) => v.bodyMd.trim() !== "" || (v.attachments?.length ?? 0) > 0, {
    message: "본문이나 첨부 중 하나는 있어야 한다",
    path: ["bodyMd"],
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

// 이 소켓의 탭이 보이는가·어느 채널을 보고 있는가 — 서버가 「보고 있으면 푸시 안 보냄」에 쓴다(스펙 5.3)
export const PresenceUpdate = z.object({ visible: z.boolean(), channelId: Id.optional() });
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;

export interface ClientToServerEvents {
  "channel.subscribe": (p: ChannelSubscribe, ack: Ack<ChannelSubscribeResult>) => void;
  "channel.unsubscribe": (p: { channelId: Id }, ack: Ack<null>) => void;
  "message.send": (p: MessageSend, ack: Ack<{ message: Message }>) => void;
  "run.abort": (p: RunAbort, ack: Ack<null>) => void;
  "run.events.replay": (p: RunEventsReplay, ack: Ack<RunEventsReplayResult>) => void;
  "component.interact": (p: ComponentInteract, ack: Ack<{ interactionId: Id }>) => void;
  "approval.resolve": (p: ApprovalResolve, ack: Ack<null>) => void;
  typing: (p: Typing) => void; // ack 없음, 클라이언트가 3초 스로틀
  "presence.update": (p: PresenceUpdate) => void; // ack 없음
}

// ── 서버 → 클라이언트 (룸 channel:<id> 또는 user:<id>) ──
/** Gateway WS 하나의 상태 — 꺼진 Gateway 는 disabled(멀티 Gateway 스펙 「웹」 절의 「꺼짐」) */
export const GatewayLinkState = z.enum(["connected", "reconnecting", "down", "disabled"]);
export type GatewayLinkState = z.infer<typeof GatewayLinkState>;

/** OpenClaw Gateway 하나의 연결 상태 — 꺼진 Gateway 는 enabled false·gateway disabled */
export const OpenClawGatewayStatus = z.object({
  id: Id,
  name: z.string(),
  enabled: z.boolean(),
  gateway: GatewayLinkState,
  bridge: z.enum(["connected", "down"]),
});
export type OpenClawGatewayStatus = z.infer<typeof OpenClawGatewayStatus>;

/**
 * 어댑터마다 따로 나간다(러너 계획 판정 P7) — 소비자는 provider 로 좁혀 읽고 모르는 provider 는 무시한다.
 * OpenClaw 는 Gateway 마다 한 줄(더한 차례, 멀티 Gateway 스펙 「어댑터 계약」 절) — Gateway 가 없으면 빈 목록이다
 */
export const AdapterStatus = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("openclaw"),
    gateways: z.array(OpenClawGatewayStatus),
  }),
  // runners — 지금 붙은 러너 수 / 폐기되지 않은 러너 토큰 수
  z.object({
    provider: z.literal("claude"),
    runners: z.object({ connected: z.int().min(0), tokens: z.int().min(0) }),
  }),
]);
export type AdapterStatus = z.infer<typeof AdapterStatus>;

export interface ServerToClientEvents {
  "message.created": (p: { message: Message }) => void;
  "message.updated": (p: { message: Message }) => void; // 수정, 컴포넌트 소비/만료
  "run.state": (p: { run: RunState; resync?: boolean }) => void;
  "run.event": (p: { event: RunEvent }) => void;
  // 승인 둘은 workspace 룸 — 구독하지 않은 채널의 승인도 받는다(다른 채널을 보고 있어도 알려야 한다)
  "approval.requested": (p: { approval: Approval }) => void;
  "approval.resolved": (p: { approval: Approval }) => void;
  "channel.created": (p: { channel: Channel }) => void; // workspace 룸 — 채널 룸에는 아직 아무도 없다
  "channel.updated": (p: { channel: Channel }) => void;
  "channel.member.changed": (p: { channelId: Id; members: ChannelMember[] }) => void;
  "people.changed": (p: { people: Person[] }) => void; // workspace 룸 — 가입·역할·표시 이름·비활성화·다시 활성화 뒤 전체 목록
  // workspace 룸 — 에이전트 등록·수정·옮기기·보관·되살리기 뒤. 본문이 없다: 받은 쪽이 에이전트·채널 멤버 목록을 다시 받는다
  "agents.changed": (p: Record<string, never>) => void;
  typing: (p: { channelId: Id; actorType: "user" | "agent"; actorId: Id }) => void;
  "adapter.status": (p: AdapterStatus) => void; // user 룸
  "setup.status": (p: { status: SetupStatus }) => void; // owner 사용자 룸에만
  "ops.event": (p: { event: OpsEvent; unacked: OpsUnacked }) => void; // owner·admin 사용자 룸에만
  "system.notice": (p: { level: "info" | "warn" | "error"; message: string }) => void;
}
