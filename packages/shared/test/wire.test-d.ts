import { describe, expectTypeOf, it } from "vitest";
import type { Ack } from "../src/common";
import type { Message } from "../src/domain";
import type { ClientToServerEvents, MessageSend, ServerToClientEvents } from "../src/wire";

describe("wire event maps", () => {
  it("클라이언트→서버 이벤트 이름", () => {
    expectTypeOf<keyof ClientToServerEvents>().toEqualTypeOf<
      | "channel.subscribe"
      | "channel.unsubscribe"
      | "message.send"
      | "run.abort"
      | "run.events.replay"
      | "component.interact"
      | "approval.resolve"
      | "typing"
    >();
  });
  it("서버→클라이언트 이벤트 이름", () => {
    expectTypeOf<keyof ServerToClientEvents>().toEqualTypeOf<
      | "message.created"
      | "message.updated"
      | "run.state"
      | "run.event"
      | "approval.requested"
      | "approval.resolved"
      | "channel.updated"
      | "channel.member.changed"
      | "typing"
      | "adapter.status"
      | "system.notice"
    >();
  });
  it("message.send의 페이로드와 ack 타입", () => {
    expectTypeOf<Parameters<ClientToServerEvents["message.send"]>[0]>().toEqualTypeOf<MessageSend>();
    expectTypeOf<Parameters<ClientToServerEvents["message.send"]>[1]>().toEqualTypeOf<
      Ack<{ message: Message }>
    >();
  });
});
