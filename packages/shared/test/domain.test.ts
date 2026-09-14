import { describe, expect, it } from "vitest";
import {
  Approval,
  Channel,
  Handle,
  Message,
  RelayPolicy,
  Run,
  RunState,
  RunStatus,
  RunTriggerKind,
} from "../src/domain";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T09:12:00+09:00";

describe("Handle", () => {
  it("소문자·숫자·_·- 2~32자만", () => {
    expect(Handle.safeParse("researcher").success).toBe(true);
    expect(Handle.safeParse("a").success).toBe(false);
    expect(Handle.safeParse("Bob").success).toBe(false);
    expect(Handle.safeParse("x".repeat(33)).success).toBe(false);
  });
});

describe("RelayPolicy", () => {
  it("기본값 maxRelayTurns=4, allowPairs=all", () => {
    expect(RelayPolicy.parse({})).toEqual({ maxRelayTurns: 4, allowPairs: "all" });
  });
  it("허용 쌍 목록", () => {
    const p = RelayPolicy.parse({ allowPairs: [{ from: ID(1), to: ID(2) }], dailyRunLimit: 100 });
    expect(p.allowPairs).toEqual([{ from: ID(1), to: ID(2) }]);
    expect(p.dailyRunLimit).toBe(100);
  });
});

describe("Channel", () => {
  it("relayPolicy가 없으면 실패한다 (서버가 기본값을 채워 저장)", () => {
    expect(
      Channel.safeParse({
        id: ID(1),
        workspaceId: ID(2),
        name: "general",
        visibility: "public",
        createdBy: ID(3),
        createdAt: NOW,
      }).success,
    ).toBe(false);
    expect(
      Channel.safeParse({
        id: ID(1),
        workspaceId: ID(2),
        name: "general",
        relayPolicy: {},
        visibility: "public",
        createdBy: ID(3),
        createdAt: NOW,
      }).success,
    ).toBe(true);
  });
});

describe("Message", () => {
  const base = {
    id: ID(1),
    channelId: ID(2),
    seq: 1,
    kind: "normal",
    authorType: "user",
    authorId: ID(3),
    bodyMd: `<@a:${ID(4)}> 조사해줘`,
    mentions: { agents: [ID(4)], users: [] },
    createdAt: NOW,
  };
  it("사용자 메시지를 파싱하고 attachments 기본값을 채운다", () => {
    const m = Message.parse(base);
    expect(m.attachments).toEqual([]);
    expect(m.components).toBeUndefined();
  });
  it("components가 있으면 스키마로 검증한다", () => {
    expect(
      Message.safeParse({ ...base, components: { blocks: [{ type: "actions", items: [] }] } }).success,
    ).toBe(false);
    expect(Message.safeParse({ ...base, components: { blocks: [{ type: "separator" }] } }).success).toBe(
      true,
    );
  });
  it("componentState는 만료 시각과 소비 목록을 담는다", () => {
    const m = Message.parse({
      ...base,
      components: { blocks: [{ type: "separator" }] },
      componentState: { expiresAt: NOW, consumed: [] },
    });
    expect(m.componentState?.consumed).toEqual([]);
  });
  it("시스템 메시지는 systemMeta를 가진다", () => {
    const m = Message.parse({
      ...base,
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: "릴레이 한도 도달",
      mentions: { agents: [], users: [] },
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: ID(4), toAgentId: ID(5), sourceRunId: ID(6), rootMessageId: ID(7) },
      },
    });
    expect(m.systemMeta?.kind).toBe("relay_limit");
  });
});

describe("Run", () => {
  it("상태 8종, 트리거 5종", () => {
    expect(RunStatus.options).toEqual([
      "queued",
      "streaming",
      "tool",
      "awaiting_approval",
      "finalizing",
      "done",
      "error",
      "aborted",
    ]);
    expect(RunTriggerKind.options).toEqual(["mention", "auto_respond", "relay", "interaction", "continue"]);
  });
  it("hasCanonical 기본값 false", () => {
    const r = Run.parse({
      id: ID(1),
      channelId: ID(2),
      agentId: ID(3),
      triggerKind: "mention",
      triggerMessageId: ID(4),
      rootMessageId: ID(4),
      relayDepth: 0,
      sessionKey: `agent:researcher:dodok:channel:${ID(2)}`,
      status: "queued",
      createdAt: NOW,
    });
    expect(r.hasCanonical).toBe(false);
  });
  it("RunState는 요약 키만 가진다", () => {
    expect(Object.keys(RunState.shape).sort()).toEqual(
      [
        "agentId",
        "channelId",
        "endedAt",
        "error",
        "finalSource",
        "hasCanonical",
        "id",
        "parentRunId",
        "relayDepth",
        "startedAt",
        "status",
      ].sort(),
    );
  });
});

describe("Approval", () => {
  it("pending 승인을 파싱한다", () => {
    const a = Approval.parse({
      id: ID(1),
      runId: ID(2),
      providerApprovalId: "ap_1",
      kind: "exec",
      summary: "rm -rf build",
      status: "pending",
      createdAt: NOW,
    });
    expect(a.status).toBe("pending");
  });
});
