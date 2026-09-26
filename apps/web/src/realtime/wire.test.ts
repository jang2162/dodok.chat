import { WIRE_PROTOCOL } from "@dodok/shared";
import { WebSocket as WebSocketTransport } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSocket } from "../../test/fakeSocket";
import { CH } from "../../test/fixtures";
import { createWireSocket, emitAck, WireAckError, WireManager } from "./wire";

// test/setup.ts 는 createWireSocket 을 가짜로 바꾼다 — 이 파일은 원래 것을 잰다
vi.unmock("./wire");

describe("emitAck", () => {
  it("ack 이 ok 면 data 를 돌려준다", async () => {
    const fake = createFakeSocket();
    fake.onAck("channel.unsubscribe", () => ({ ok: true, data: null }));
    await expect(emitAck(fake.wire, "channel.unsubscribe", { channelId: CH })).resolves.toBeNull();
    expect(fake.sent).toEqual([{ event: "channel.unsubscribe", payload: { channelId: CH } }]);
    expect(fake.timeouts).toEqual([10_000]);
  });

  it("ack 이 ok:false 면 그 code 의 WireAckError 를 던진다", async () => {
    const fake = createFakeSocket();
    fake.onAck("channel.subscribe", () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "channel not found" },
    }));
    const err = await emitAck(fake.wire, "channel.subscribe", { channelId: CH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireAckError);
    expect(err).toMatchObject({ code: "NOT_FOUND", message: "channel not found" });
  });

  it("ack 오류의 details 를 버리지 않고 WireAckError.details 로 넘긴다(VALIDATION 의 issues 등)", async () => {
    const fake = createFakeSocket();
    const details = { issues: [{ path: ["fields", "title"], message: "Too small" }] };
    fake.onAck("channel.subscribe", () => ({
      ok: false,
      error: { code: "VALIDATION", message: "invalid values", details },
    }));
    const err = await emitAck(fake.wire, "channel.subscribe", { channelId: CH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireAckError);
    expect(err).toMatchObject({ code: "VALIDATION", message: "invalid values", details });
    // details 가 없는 오류는 없는 그대로
    fake.onAck("channel.subscribe", () => ({ ok: false, error: { code: "NOT_FOUND", message: "nope" } }));
    const bare = await emitAck(fake.wire, "channel.subscribe", { channelId: CH }).catch((e: unknown) => e);
    expect((bare as WireAckError).details).toBeUndefined();
  });

  it("응답이 없으면(emitWithAck 가 던짐) code TIMEOUT, 시간 초과 값은 넘긴 것을 쓴다", async () => {
    const fake = createFakeSocket();
    const err = await emitAck(fake.wire, "run.abort", { runId: CH }, 500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireAckError);
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(fake.timeouts).toEqual([500]);
  });

  it("타입: ack 없는 이벤트(typing)는 받지 않고, payload·data 는 계약 타입이다", () => {
    const fake = createFakeSocket();
    // @ts-expect-error typing 은 ack 이 없다
    const noAck = () => emitAck(fake.wire, "typing", { channelId: CH });
    // @ts-expect-error channel.subscribe 에는 channelId 가 있어야 한다
    const badPayload = () => emitAck(fake.wire, "channel.subscribe", { lastSeq: 1 });
    const typed = async () =>
      (await emitAck(fake.wire, "run.events.replay", { runId: CH, afterSeq: 0 })).events;
    expect([noAck, badPayload, typed]).toHaveLength(3);
  });
});

describe("createWireSocket", () => {
  it("자동 연결하지 않고, websocket 전송만 쓰며, auth 에는 토큰 없이 프로토콜만 싣는다", () => {
    const socket = createWireSocket();
    expect(socket.connected).toBe(false);
    expect(socket.active).toBe(false);
    expect(socket.auth).toEqual({ protocol: WIRE_PROTOCOL });
    expect(socket.auth).not.toHaveProperty("token");
    // polling 핸드셰이크 GET 에는 Origin 이 없어 쿠키 인증이 거부된다 — websocket 만(web-t0 보고)
    expect(socket.io.opts).toMatchObject({
      path: "/socket.io",
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
    });
  });
});

/** 테스트가 여닫는 날 WebSocket — 엔진의 websocket 전송이 이것을 만든다 */
class RawSocket {
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  /** 업그레이드가 되고 엔진 핸드셰이크(open 패킷)까지 온다 */
  handshake(): void {
    this.onopen?.();
    this.onmessage?.({
      data: `0${JSON.stringify({ sid: "s", upgrades: [], pingInterval: 25_000, pingTimeout: 20_000, maxPayload: 1e6 })}`,
    });
  }
  /** close 프레임만 — error 없이 깨끗이 닫힌다(브라우저 검증 결함 1 의 재현: 핸드셰이크 전에 이렇게 닫힌다) */
  closeCleanly(): void {
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
  }
}

describe("WireManager", () => {
  const raws: RawSocket[] = [];
  class FakeTransport extends WebSocketTransport {
    override createSocket(): never {
      const raw = new RawSocket();
      raws.push(raw);
      return raw as never;
    }
  }
  afterEach(() => {
    raws.length = 0;
    vi.useRealTimers();
  });

  it("다시 붙기가 핸드셰이크 전에 깨끗이 닫혀도 연결 제한시간(20초)을 기다리지 않고 백오프 안에 다시 시도한다", async () => {
    vi.useFakeTimers();
    const manager = new WireManager({
      transports: [FakeTransport],
      autoConnect: false,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
      randomizationFactor: 0,
    });
    const socket = manager.socket("/");
    socket.connect();
    raws[0]!.handshake();
    await vi.advanceTimersByTimeAsync(0);

    // 살아 있던 연결이 끊긴다 → 1초 뒤 첫 재시도
    raws[0]!.closeCleanly();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(raws).toHaveLength(2);

    // 그 시도는 업그레이드까지 되고 핸드셰이크 전에 깨끗이 닫힌다(실패) → 다음 백오프(2초) 안에 다시
    raws[1]!.onopen?.();
    raws[1]!.closeCleanly();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(raws).toHaveLength(3);

    // 그 시도는 붙는다
    raws[2]!.handshake();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.engine.readyState).toBe("open");
    socket.disconnect();
  });

  it("처음 붙기가 핸드셰이크 전에 깨끗이 닫혀도 connect_error 를 내고 백오프 뒤 다시 시도한다", async () => {
    vi.useFakeTimers();
    const manager = new WireManager({
      transports: [FakeTransport],
      autoConnect: false,
      reconnectionDelay: 1_000,
      randomizationFactor: 0,
    });
    const socket = manager.socket("/");
    const errors: string[] = [];
    socket.on("connect_error", (e) => errors.push(e.message));
    socket.connect();
    raws[0]!.onopen?.();
    raws[0]!.closeCleanly();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(["transport close before handshake"]);
    // 앱 재시도(handlers 의 retryLater)는 active 가 아닐 때만 — socket.io 가 다시 붙는다
    expect(socket.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(raws).toHaveLength(2);
    socket.disconnect();
  });

  it("핸드셰이크가 끝난 뒤의 close 는 engine error 를 내지 않는다", async () => {
    vi.useFakeTimers();
    const manager = new WireManager({
      transports: [FakeTransport],
      autoConnect: false,
      reconnectionDelay: 1_000,
    });
    const socket = manager.socket("/");
    const errors: unknown[] = [];
    manager.on("error", (e) => errors.push(e));
    socket.connect();
    raws[0]!.handshake();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.engine.readyState).toBe("open");

    // 살아 있던 연결이 정상적으로(전송 close) 끊긴다 — 핸드셰이크 전 close 와 달리 engine error 를 만들지 않는다
    raws[0]!.closeCleanly();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    socket.disconnect();
  });
});
