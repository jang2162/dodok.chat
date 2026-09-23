import { z } from "zod";
import type { Ack } from "../common";
import { BRIDGE_PROTOCOL, Id, IsoDateTime } from "../common";
import { ComponentsV1 } from "../components";
import { ATTACHMENT_LIMITS, Attachment } from "../domain";

export const BridgeCapability = z.enum(["agents.list", "config.set", "typing", "run_id_in_outbound"]);
export type BridgeCapability = z.infer<typeof BridgeCapability>;

export const BridgeHello = z.object({
  pluginId: z.literal("dodok"),
  version: z.string(), // 플러그인 패키지 버전
  sdkVersion: z.string(), // openclaw 패키지 버전
  gatewayVersion: z.string().optional(),
  capabilities: z.array(BridgeCapability),
});
export type BridgeHello = z.infer<typeof BridgeHello>;
export const BridgeHelloResult = z.object({
  serverVersion: z.string(),
  protocol: z.literal(BRIDGE_PROTOCOL),
});
export type BridgeHelloResult = z.infer<typeof BridgeHelloResult>;

export const InboundAuthor = z.object({
  type: z.enum(["user", "agent", "system"]),
  handle: z.string(),
  displayName: z.string(),
});
export type InboundAuthor = z.infer<typeof InboundAuthor>;

export const InboundContext = z.object({
  recentMessages: z.array(z.object({ author: InboundAuthor, text: z.string(), ts: IsoDateTime })).max(20),
  participants: z.array(
    z.object({
      type: z.enum(["user", "agent"]),
      handle: z.string(),
      displayName: z.string(),
      isSelf: z.boolean(),
    }),
  ),
  relayRules: z.string(), // 사람이 읽는 한 문단
  channelPrompt: z.string().optional(),
  promptOverride: z.string().optional(),
});
export type InboundContext = z.infer<typeof InboundContext>;

export const InboundDeliver = z.object({
  deliveryId: Id,
  kind: z.enum(["message", "interaction", "continue"]),
  channelId: Id,
  agentId: z.string(), // providerAgentId (OpenClaw agentId)
  sessionKey: z.string(), // agent:<agentId>:dodok:channel:<channelId>
  runId: Id, // 우리 런 id
  message: z.object({
    id: Id,
    author: InboundAuthor,
    text: z.string(), // renderForAgent 결과 (@handle 평문)
    attachments: z.array(Attachment).max(ATTACHMENT_LIMITS.perMessage),
    ts: IsoDateTime,
  }),
  context: InboundContext,
  options: z
    .object({ queueMode: z.enum(["steer", "followup", "collect", "interrupt"]).optional() })
    .default({}),
});
export type InboundDeliver = z.infer<typeof InboundDeliver>;
export const InboundDeliverResult = z.object({
  admission: z.enum(["dispatch", "drop"]), // 계획서 10장 #14 — drop 은 런 없이 끝났다는 뜻(봇 루프 보호 등)
  reason: z.string().optional(), // drop 사유 (예: "bot-loop-protection")
  providerRunId: z.string().optional(), // ADR 0002 4.3: 값은 우리 runId 와 같다(replyOptions.runId)
});
export type InboundDeliverResult = z.infer<typeof InboundDeliverResult>;

export const ConfigSet = z.object({
  channelId: Id,
  config: z.object({ requireMention: z.boolean().optional(), systemPrompt: z.string().optional() }),
});
export type ConfigSet = z.infer<typeof ConfigSet>;
export const ConfigSetResult = z.object({ applied: z.enum(["live", "restart_required"]) });
export type ConfigSetResult = z.infer<typeof ConfigSetResult>;

export const OutboundMessage = z.object({
  outboundId: z.string().min(1).max(128), // 중복 제거 키 (messages.external_id)
  channelId: Id,
  agentId: z.string(), // providerAgentId
  sessionKey: z.string(),
  runId: Id.optional(), // 인바운드에서 받은 우리 런 id
  providerRunId: z.string().optional(),
  replyToInboundId: Id.optional(), // InboundDeliver.message.id
  text: z.string().max(100_000), // 평문 (@handle) — 서버가 tokenize
  components: ComponentsV1.optional(),
  /** 브리지 HTTP 로 먼저 올린 첨부 id(스펙 3장 2). 이름·크기·MIME 은 서버 기록이 정본이다 */
  attachmentIds: z.array(Id).max(ATTACHMENT_LIMITS.perMessage).default([]),
  ts: IsoDateTime,
});
export type OutboundMessage = z.infer<typeof OutboundMessage>;

export const BridgeStatus = z.object({
  gateway: z.enum(["connected", "reconnecting", "down"]),
  queueDepth: z.int().min(0),
});
export type BridgeStatus = z.infer<typeof BridgeStatus>;

export interface BridgeClientToServerEvents {
  // 플러그인 → 서버
  hello: (p: BridgeHello, ack: Ack<BridgeHelloResult>) => void;
  "outbound.message": (p: OutboundMessage, ack: Ack<{ messageId: Id }>) => void;
  "outbound.typing": (p: { channelId: Id; agentId: string }) => void;
  status: (p: BridgeStatus) => void;
}
export interface BridgeServerToClientEvents {
  // 서버 → 플러그인
  "inbound.deliver": (p: InboundDeliver, ack: Ack<InboundDeliverResult>) => void;
  "config.set": (p: ConfigSet, ack: Ack<ConfigSetResult>) => void;
  "agents.list": (
    p: Record<string, never>,
    ack: Ack<{ agents: Array<{ agentId: string; name?: string }> }>,
  ) => void;
  "system.notice": (p: { reason: "replaced" | "shutdown"; message: string }) => void;
}

/** 브리지 HTTP 첨부 경로와 헤더(스펙 3장 5). 인증은 `Authorization: Bearer <브리지 토큰>` */
export const BRIDGE_ATTACHMENTS_PATH = "/bridge/attachments";
export const BRIDGE_ATTACHMENT_HEADERS = {
  fileName: "x-dodok-file-name",
  channelId: "x-dodok-channel-id",
} as const;
