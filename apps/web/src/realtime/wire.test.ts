import { WIRE_PROTOCOL } from "@dodok/shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeSocket } from "../../test/fakeSocket";
import { CH } from "../../test/fixtures";
import { createWireSocket, emitAck, WireAckError } from "./wire";

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
