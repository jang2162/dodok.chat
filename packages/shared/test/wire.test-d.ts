import { describe, expectTypeOf, it } from "vitest";
import type { Ack } from "../src/common";
import type { Conversation, Message } from "../src/domain";
import type { OpsEvent, OpsUnacked } from "../src/ops";
import type { ChannelActivity, ConversationRead, ConversationReadUpdate } from "../src/reads";
import type { SetupStatus } from "../src/setup";
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
      | "presence.update"
      | "conversation.read"
      | "reaction.set"
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
      | "channel.created"
      | "channel.updated"
      | "channel.member.changed"
      | "conversation.created"
      | "conversation.updated"
      | "conversation.read"
      | "channel.activity"
      | "people.changed"
      | "agents.changed"
      | "typing"
      | "adapter.status"
      | "setup.status"
      | "ops.event"
      | "system.notice"
      | "presence.snapshot"
      | "presence.changed"
      | "me.status"
    >();
  });
  it("setup.status 페이로드는 { status } 로 감싼다", () => {
    expectTypeOf<Parameters<ServerToClientEvents["setup.status"]>[0]>().toEqualTypeOf<{
      status: SetupStatus;
    }>();
  });
  it("agents.changed 는 본문이 없다 — 받은 쪽이 다시 받는다", () => {
    expectTypeOf<Parameters<ServerToClientEvents["agents.changed"]>[0]>().toEqualTypeOf<
      Record<string, never>
    >();
  });
  it("ops.event 페이로드는 { event, unacked }", () => {
    expectTypeOf<Parameters<ServerToClientEvents["ops.event"]>[0]>().toEqualTypeOf<{
      event: OpsEvent;
      unacked: OpsUnacked;
    }>();
  });
  it("conversation.read — 클라이언트는 seq 를 보내고 ack 으로 읽음 위치를, 서버는 그 사용자의 다른 소켓에 읽음 위치를", () => {
    expectTypeOf<
      Parameters<ClientToServerEvents["conversation.read"]>[0]
    >().toEqualTypeOf<ConversationRead>();
    expectTypeOf<Parameters<ClientToServerEvents["conversation.read"]>[1]>().toEqualTypeOf<
      Ack<{ lastReadSeq: number }>
    >();
    expectTypeOf<
      Parameters<ServerToClientEvents["conversation.read"]>[0]
    >().toEqualTypeOf<ConversationReadUpdate>();
  });
  it("channel.activity 페이로드는 본문 없는 ChannelActivity", () => {
    expectTypeOf<Parameters<ServerToClientEvents["channel.activity"]>[0]>().toEqualTypeOf<ChannelActivity>();
  });
  it("message.send의 페이로드와 ack 타입", () => {
    expectTypeOf<Parameters<ClientToServerEvents["message.send"]>[0]>().toEqualTypeOf<MessageSend>();
    expectTypeOf<Parameters<ClientToServerEvents["message.send"]>[1]>().toEqualTypeOf<
      Ack<{ message: Message; conversation?: Conversation }>
    >();
  });
  it("conversation.created·updated 페이로드는 { conversation }", () => {
    expectTypeOf<Parameters<ServerToClientEvents["conversation.created"]>[0]>().toEqualTypeOf<{
      conversation: Conversation;
    }>();
    expectTypeOf<Parameters<ServerToClientEvents["conversation.updated"]>[0]>().toEqualTypeOf<{
      conversation: Conversation;
    }>();
  });
});
