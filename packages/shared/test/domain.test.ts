import { describe, expect, it } from "vitest";
import {
  Approval,
  ApprovalDecision,
  ApprovalKind,
  ApprovalReason,
  ApprovalStatus,
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
  // 승인 스파이크 3.2 의 plugin.approval.requested 원본 프레임(런 1, Write 툴)에서 그대로 옮긴 값.
  const REQUESTED = {
    id: ID(1),
    providerApprovalId: "plugin:533fe246-fa79-4f86-bcd0-3c08b549cb20",
    kind: "plugin",
    channelId: ID(2),
    agentId: ID(3),
    toolCallId: "toolu_018ohZoiNMZwidAe7fWsWSam",
    toolName: "Write",
    pluginId: "claude-cli",
    title: "claude-cli native tool: Write",
    description: '{"file_path":"/tmp/spike-approval.txt","content":"hello\\n"}',
    detail: '{"file_path":"/tmp/spike-approval.txt","content":"hello\\n"}',
    severity: "warning",
    allowedDecisions: ["allow-once", "deny"],
    urlPath: "/approve/plugin%3A533fe246-fa79-4f86-bcd0-3c08b549cb20",
    status: "pending",
    createdAt: "2026-09-20T09:49:47.988Z",
    expiresAt: "2026-09-20T09:51:47.988Z", // createdAt + 120초 — Gateway plugin 승인 기본 TTL
  };

  it("실물 승인 프레임의 값을 받고, runId 는 없다(sessionKey+toolCallId 로 런에 붙인다)", () => {
    const a = Approval.parse(REQUESTED);
    expect(a.runId).toBeUndefined();
    expect(a.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(a.toolCallId).toBe("toolu_018ohZoiNMZwidAe7fWsWSam");
    expect(a.severity).toBe("warning");
  });

  it("expiresAt 은 필수(카운트다운의 근거), allowedDecisions 는 1개 이상", () => {
    expect(Approval.safeParse({ ...REQUESTED, expiresAt: undefined }).success).toBe(false);
    expect(Approval.safeParse({ ...REQUESTED, allowedDecisions: [] }).success).toBe(false);
  });

  it("확정된 승인은 decision·reason·decidedBy·decidedAt 을 싣는다", () => {
    const a = Approval.parse({
      ...REQUESTED,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedBy: ID(4),
      decidedAt: "2026-09-20T09:49:50.009Z",
    });
    expect(a.status).toBe("allowed");
    expect(a.decision).toBe("allow-once");
    expect(a.reason).toBe("user");
  });

  it("만료는 expired+timeout, 런 중단은 cancelled+run-aborted", () => {
    const expired = Approval.parse({ ...REQUESTED, status: "expired", decision: "deny", reason: "timeout" });
    expect(expired.reason).toBe("timeout");
    const cancelled = Approval.parse({ ...REQUESTED, status: "cancelled", reason: "run-aborted" });
    expect(cancelled.status).toBe("cancelled");
  });

  it("Gateway 에 없는 옛 값은 거부한다", () => {
    expect(ApprovalStatus.safeParse("approved").success).toBe(false); // → allowed
    expect(ApprovalKind.safeParse("generic").success).toBe(false); // → system-agent
    expect(ApprovalDecision.safeParse("approve").success).toBe(false); // → allow-once
    expect(Approval.safeParse({ ...REQUESTED, status: "approved" }).success).toBe(false);
  });

  /**
   * 보여 주는 문자열의 길이 상한은 **어댑터가 잘라 맞추는 과녁**이다(`gateway/approvals.ts` 의 `MAX`).
   * 상한 초과 입력을 버리지 않고 잘라서 통과시키는 fail-open 판정(p2-t2)이 성립하려면 자른 길이(=상한)가
   * 여기서 통과해야 하고 한 자만 더 길면 막혀야 한다. 이 숫자를 바꾸면 어댑터 `MAX` 도 같이 바꾼다
   */
  it("보여 주는 문자열의 길이 상한 — 상한까지는 통과, 한 자 더는 거부", () => {
    const CAPS = [
      ["title", 200],
      ["description", 512],
      ["detail", 16_384],
      ["toolName", 100],
      ["pluginId", 100],
      ["urlPath", 500],
      ["toolCallId", 200],
    ] as const;

    for (const [field, max] of CAPS) {
      const at = (length: number) =>
        Approval.safeParse({ ...REQUESTED, [field]: "가".repeat(length) }).success;
      expect(at(max), `${field} 는 ${max} 자까지 받아야 한다`).toBe(true);
      expect(at(max + 1), `${field} 는 ${max + 1} 자를 막아야 한다`).toBe(false);
    }
  });

  it("열거값 목록은 Gateway 실물 그대로", () => {
    expect(ApprovalKind.options).toEqual(["exec", "plugin", "system-agent"]);
    expect(ApprovalStatus.options).toEqual(["pending", "allowed", "denied", "expired", "cancelled"]);
    expect(ApprovalDecision.options).toEqual(["allow-once", "allow-always", "deny"]);
    expect(ApprovalReason.options).toEqual([
      "user",
      "timeout",
      "malformed-verdict",
      "no-route",
      "run-aborted",
      "gateway-restart",
      "storage-corrupt",
    ]);
  });
});
