/**
 * 브리지 서버의 순수 부분 — 토큰 비교, 거절 로그 스로틀, 플러그인이 보낸 이벤트 파싱, 플러그인 연결 1개의 상태 전이.
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

/**
 * 핸드셰이크 거절 로그를 원격 주소별 `intervalMs`(기본 1분)에 한 번으로 줄인다 — 폐기된 토큰으로 재접속을 되풀이하는
 * 플러그인이 로그를 채우지 않게(설정 마법사 Review Focus 2). 주소 기억은 `max`(기본 256)개까지, 넘으면 가장 오래 로그한 주소부터 잊는다.
 */
export class RejectLogThrottle {
  readonly intervalMs: number;
  readonly max: number;
  // 로그할 때만 다시 넣는다 — 삽입 순서가 곧 마지막 로그 시각 순서다
  readonly #seen = new Map<string, { loggedAt: number; suppressed: number }>();

  constructor(opts: { intervalMs?: number; max?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.max = opts.max ?? 256;
  }

  get size(): number {
    return this.#seen.size;
  }

  /** 지금 로그할 차례면 지난 로그 뒤 눌러 둔 거절 수를, 아니면 null */
  take(address: string, nowMs: number): { suppressed: number } | null {
    const entry = this.#seen.get(address);
    if (entry && nowMs - entry.loggedAt < this.intervalMs) {
      entry.suppressed += 1;
      return null;
    }
    this.#seen.delete(address);
    this.#seen.set(address, { loggedAt: nowMs, suppressed: 0 });
    while (this.#seen.size > this.max) {
      const oldest = this.#seen.keys().next().value as string;
      this.#seen.delete(oldest);
    }
    return { suppressed: entry?.suppressed ?? 0 };
  }
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
export type BridgeCloseReason = "disconnect" | "replaced" | "shutdown" | "revoked" | "gateway_off";

export type OutboundAcceptance =
  | { kind: "new" }
  | { kind: "duplicate"; messageId: string }
  | { kind: "reject"; code: ErrorCode };

/**
 * 플러그인이 보낸 `outboundId` → 서버 messageId 기억. 브리지가 Gateway 마다 하나를 두고 그 Gateway 의 연결을 넘어 공유하고,
 * 최근 `max` 개만 남긴다(LRU — 조회해도 최근으로 올린다). 창 밖으로 밀린 id·서버 재시작 전 id 는 잊는다.
 */
export class OutboundDedupe {
  readonly #seen = new Map<string, string>();
  readonly #max: number;

  constructor(opts: { max?: number } = {}) {
    this.#max = opts.max ?? 1000;
  }

  get size(): number {
    return this.#seen.size;
  }

  lookup(outboundId: string): string | undefined {
    const messageId = this.#seen.get(outboundId);
    if (messageId === undefined) return undefined;
    this.#seen.delete(outboundId);
    this.#seen.set(outboundId, messageId);
    return messageId;
  }

  record(outboundId: string, messageId: string): void {
    this.#seen.delete(outboundId);
    this.#seen.set(outboundId, messageId);
    while (this.#seen.size > this.#max) {
      const oldest = this.#seen.keys().next().value as string;
      this.#seen.delete(oldest);
    }
  }
}

/**
 * 플러그인 연결 1개. hello 전에는 아무것도 받지 않는다. 중복 판정은 넘겨받은(연결을 넘어 공유되는) `OutboundDedupe` 로 한다.
 * `tokenId` 는 핸드셰이크에서 이 연결을 통과시킨 브리지 토큰의 id — 폐기 때 이 값으로 끊는다. `gatewayId` 는 그 토큰이 묶인
 * Gateway(멀티 Gateway 스펙 「브리지」 절) — 브리지는 이 값으로 「활성 플러그인 하나」·전송 대상을 가른다
 */
export class BridgeSessionState {
  readonly connectionId: string;
  readonly tokenId: string | null;
  readonly gatewayId: string | null;
  readonly connectedAt = new Date();
  phase: BridgeSessionPhase = "awaiting_hello";
  hello: BridgeHello | undefined;
  closeReason: BridgeCloseReason | undefined;
  lastStatus: BridgeStatus | undefined;
  readonly #dedupe: OutboundDedupe;

  constructor(
    connectionId: string,
    opts: { dedupe?: OutboundDedupe; tokenId?: string; gatewayId?: string } = {},
  ) {
    this.connectionId = connectionId;
    this.tokenId = opts.tokenId ?? null;
    this.gatewayId = opts.gatewayId ?? null;
    this.#dedupe = opts.dedupe ?? new OutboundDedupe();
  }

  onHello(hello: BridgeHello): void {
    if (this.phase !== "awaiting_hello") throw new Error("hello already received");
    this.hello = hello;
    this.phase = "ready";
  }

  acceptOutbound(outboundId: string): OutboundAcceptance {
    if (this.phase !== "ready") return { kind: "reject", code: "PROTOCOL_MISMATCH" };
    const messageId = this.#dedupe.lookup(outboundId);
    return messageId ? { kind: "duplicate", messageId } : { kind: "new" };
  }

  recordOutbound(outboundId: string, messageId: string): void {
    this.#dedupe.record(outboundId, messageId);
  }

  close(reason: BridgeCloseReason): void {
    this.phase = "closed";
    this.closeReason = reason;
  }
}
