/**
 * 브리지 서버의 순수 부분 — 토큰 비교, 플러그인이 보낸 이벤트 파싱, 플러그인 연결 1개의 상태 전이.
 * Socket.IO·Fastify 에 닿지 않는다(단위 테스트 대상). 배선은 `server.ts`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BridgeHello, BridgeStatus, Id, OutboundMessage, type ErrorCode, type Result } from "@dodok/shared";
import { z } from "zod";

/** 길이가 달라도 비교 시간이 새지 않게 해시끼리 비교한다 */
export function verifyBridgeToken(expected: string, provided: unknown): boolean {
  if (!expected || typeof provided !== "string" || provided.length === 0) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

const OutboundTyping = z.object({ channelId: Id, agentId: z.string().min(1) });

const CLIENT_EVENT_SCHEMAS = {
  hello: BridgeHello,
  "outbound.message": OutboundMessage,
  "outbound.typing": OutboundTyping,
  status: BridgeStatus,
} as const;

export type BridgeClientEventName = keyof typeof CLIENT_EVENT_SCHEMAS;
export type BridgeClientEventPayload<E extends BridgeClientEventName> = z.output<
  (typeof CLIENT_EVENT_SCHEMAS)[E]
>;

export function parseBridgeClientEvent<E extends BridgeClientEventName>(
  event: E,
  payload: unknown,
): Result<BridgeClientEventPayload<E>> {
  const parsed = CLIENT_EVENT_SCHEMAS[event].safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data as BridgeClientEventPayload<E> };
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    },
  };
}

export type BridgeSessionPhase = "awaiting_hello" | "ready" | "closed";
export type BridgeCloseReason = "disconnect" | "replaced" | "shutdown";

export type OutboundAcceptance =
  | { kind: "new" }
  | { kind: "duplicate"; messageId: string }
  | { kind: "reject"; code: ErrorCode };

/** 플러그인 연결 1개. hello 전에는 아무것도 받지 않고, outboundId 로 재전송을 흡수한다 */
export class BridgeSessionState {
  readonly connectionId: string;
  readonly connectedAt = new Date();
  phase: BridgeSessionPhase = "awaiting_hello";
  hello: BridgeHello | undefined;
  closeReason: BridgeCloseReason | undefined;
  lastStatus: BridgeStatus | undefined;
  readonly #seen = new Map<string, string>();
  readonly #dedupeWindow: number;

  constructor(connectionId: string, opts: { dedupeWindow?: number } = {}) {
    this.connectionId = connectionId;
    this.#dedupeWindow = opts.dedupeWindow ?? 1000;
  }

  onHello(hello: BridgeHello): void {
    if (this.phase !== "awaiting_hello") throw new Error("hello already received");
    this.hello = hello;
    this.phase = "ready";
  }

  acceptOutbound(outboundId: string): OutboundAcceptance {
    if (this.phase !== "ready") return { kind: "reject", code: "PROTOCOL_MISMATCH" };
    const messageId = this.#seen.get(outboundId);
    return messageId ? { kind: "duplicate", messageId } : { kind: "new" };
  }

  recordOutbound(outboundId: string, messageId: string): void {
    this.#seen.set(outboundId, messageId);
    while (this.#seen.size > this.#dedupeWindow) {
      const oldest = this.#seen.keys().next().value as string;
      this.#seen.delete(oldest);
    }
  }

  close(reason: BridgeCloseReason): void {
    this.phase = "closed";
    this.closeReason = reason;
  }
}
