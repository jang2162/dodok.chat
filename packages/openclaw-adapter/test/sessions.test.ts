import { describe, expect, it } from "vitest";
import { parseChatHistory, sessionKeyFor } from "../src/gateway/sessions";

const CH = "01a09fc9-d204-7551-89d6-38544d07a202";

describe("sessionKeyFor", () => {
  it("agent:<providerAgentId>:dodok:channel:<channelId> 원형(접미사 없음)", () => {
    expect(sessionKeyFor("dev", CH)).toBe(`agent:dev:dodok:channel:${CH}`);
  });

  it("스레드 루트를 주면 스레드 하위 세션 키 — rootId 는 소문자", () => {
    const root = "01a09fc9-d204-7551-89d6-38544d07a2ab";
    expect(sessionKeyFor("dev", CH, root.toUpperCase())).toBe(`agent:dev:dodok:channel:${CH}:thread:${root}`);
  });

  it("shared 헬퍼를 쓴다 — OpenClaw agentId 가 아니면 던진다", () => {
    expect(() => sessionKeyFor("a b", CH)).toThrow();
  });
});

describe("parseChatHistory (ADR 0003 5장 실물)", () => {
  it('{ kind: "reset" } 은 reset', () => {
    expect(parseChatHistory({ kind: "reset" })).toEqual({ reset: true, messageCount: 0 });
  });

  it("커서 없는 응답: messages 건수와 deltaCursor(있을 때만)", () => {
    expect(
      parseChatHistory({ sessionKey: "k", messages: [{}, {}], deltaCursor: "c0", hasMore: false }),
    ).toEqual({ reset: false, messageCount: 2, deltaCursor: "c0" });
    expect(parseChatHistory({ sessionKey: "k", messages: [{}], completeSnapshot: true })).toEqual({
      reset: false,
      messageCount: 1,
    });
  });

  it('커서 응답 { kind: "delta" } 도 같은 모양으로 읽고, 모양이 틀리면 건수 0', () => {
    expect(parseChatHistory({ kind: "delta", messages: [], deltaCursor: "c1", sessionInfo: {} })).toEqual({
      reset: false,
      messageCount: 0,
      deltaCursor: "c1",
    });
    expect(parseChatHistory("nope")).toEqual({ reset: false, messageCount: 0 });
  });
});
