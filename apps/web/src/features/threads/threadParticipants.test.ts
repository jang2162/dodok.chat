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

  it("active agent already in participants is marked, moved to front, not duplicated", () => {
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
      { kind: "agent", id: "a1", active: "tool" },
      { kind: "user", id: "u1" },
    ]);
  });

  it("active agent beyond the 4th moves to front", () => {
    const summary = {
      count: 6,
      lastAt: LAST,
      agentIds: ["a5", "a6"],
      participants: [
        { kind: "user" as const, id: "u1" },
        { kind: "user" as const, id: "u2" },
        { kind: "user" as const, id: "u3" },
        { kind: "user" as const, id: "u4" },
        { kind: "agent" as const, id: "a5" },
        { kind: "agent" as const, id: "a6" },
      ],
    };
    const faces = threadFaces(summary, [
      { agentId: "a6", status: "streaming" },
      { agentId: "a5", status: "tool" },
    ]);
    // 진행 중끼리는 런 순으로 앞에, 나머지는 원래 순서 — 보이는 4개(칩의 AVATARS_MAX)에 둘 다 든다
    expect(faces).toEqual([
      { kind: "agent", id: "a6", active: "streaming" },
      { kind: "agent", id: "a5", active: "tool" },
      { kind: "user", id: "u1" },
      { kind: "user", id: "u2" },
      { kind: "user", id: "u3" },
      { kind: "user", id: "u4" },
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
