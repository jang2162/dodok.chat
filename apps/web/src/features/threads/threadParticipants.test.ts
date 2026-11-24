import { describe, expect, it } from "vitest";
import { activeLabel, threadFaces } from "./threadParticipants";

const LAST = "2027-01-15T08:00:00.000Z";

describe("threadFaces", () => {
  it("falls back to agentIds without participants", () => {
    expect(threadFaces({ count: 2, lastAt: LAST, agentIds: ["a1", "a2"] }, [])).toEqual([
      { kind: "agent", id: "a1" },
      { kind: "agent", id: "a2" },
    ]);
  });

  it("uses participants when present — people and agents in order", () => {
    const summary = {
      count: 2,
      lastAt: LAST,
      agentIds: ["a1"],
      participants: [
        { kind: "user" as const, id: "u1" },
        { kind: "agent" as const, id: "a1" },
      ],
    };
    expect(threadFaces(summary, [])).toEqual([
      { kind: "user", id: "u1" },
      { kind: "agent", id: "a1" },
    ]);
  });

  it("active agent not in participants is prepended", () => {
    const summary = {
      count: 1,
      lastAt: LAST,
      agentIds: [],
      participants: [{ kind: "user" as const, id: "u1" }],
    };
    expect(threadFaces(summary, [{ agentId: "a9", status: "queued" }])).toEqual([
      { kind: "agent", id: "a9", active: "queued" },
      { kind: "user", id: "u1" },
    ]);
    // 요약이 없어도(답글 전) 진행 중 에이전트만으로
    expect(threadFaces(undefined, [{ agentId: "a9", status: "streaming" }])).toEqual([
      { kind: "agent", id: "a9", active: "streaming" },
    ]);
  });

  it("active agent already in participants is marked, not duplicated", () => {
    const summary = {
      count: 2,
      lastAt: LAST,
      agentIds: ["a1"],
      participants: [
        { kind: "user" as const, id: "u1" },
        { kind: "agent" as const, id: "a1" },
      ],
    };
    expect(threadFaces(summary, [{ agentId: "a1", status: "tool" }])).toEqual([
      { kind: "user", id: "u1" },
      { kind: "agent", id: "a1", active: "tool" },
    ]);
  });

  it("a person with the same id as an active agent is not marked", () => {
    const summary = {
      count: 1,
      lastAt: LAST,
      agentIds: [],
      participants: [{ kind: "user" as const, id: "x" }],
    };
    expect(threadFaces(summary, [{ agentId: "x", status: "streaming" }])).toEqual([
      { kind: "agent", id: "x", active: "streaming" },
      { kind: "user", id: "x" },
    ]);
  });
});

describe("activeLabel", () => {
  it("activeLabel one", () => {
    expect(activeLabel(["dev"], "streaming")).toBe("@dev 응답 중…");
  });

  it("activeLabel many", () => {
    expect(activeLabel(["dev", "fin"], "tool")).toBe("@dev 외 1명 도구 사용 중…");
    expect(activeLabel(["dev", "fin", "ops"], "queued")).toBe("@dev 외 2명 대기 중…");
  });
});
