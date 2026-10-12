import { describe, expectTypeOf, it } from "vitest";
import type {
  BridgeClientToServerEvents,
  BridgeServerToClientEvents,
  InboundDeliver,
  InboundDeliverResult,
} from "../src/bridge";
import type { Ack } from "../src/common";

describe("bridge event maps", () => {
  it("이벤트 이름", () => {
    expectTypeOf<keyof BridgeClientToServerEvents>().toEqualTypeOf<
      "hello" | "outbound.message" | "outbound.typing" | "status" | "control.call"
    >();
    expectTypeOf<keyof BridgeServerToClientEvents>().toEqualTypeOf<
      "inbound.deliver" | "config.set" | "agents.list" | "system.notice"
    >();
  });
  it("inbound.deliver 페이로드와 ack", () => {
    expectTypeOf<
      Parameters<BridgeServerToClientEvents["inbound.deliver"]>[0]
    >().toEqualTypeOf<InboundDeliver>();
    expectTypeOf<Parameters<BridgeServerToClientEvents["inbound.deliver"]>[1]>().toEqualTypeOf<
      Ack<InboundDeliverResult>
    >();
  });
});
