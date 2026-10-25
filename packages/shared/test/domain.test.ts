import { describe, expect, it } from "vitest";
import {
  Agent,
  Approval,
  ApprovalDecision,
  ApprovalKind,
  ApprovalReason,
  ApprovalStatus,
  Channel,
  ChannelMember,
  Conversation,
  ConversationList,
  ConversationPatch,
  Handle,
  INTERACTIONS_MAX,
  Message,
  RelayPolicy,
  Run,
  RunState,
  RunStatus,
  RunTriggerKind,
} from "../src/domain";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T09:12:00+09:00";

describe("Agent.archivedAt", () => {
  const agent = {
    id: ID(1),
    workspaceId: ID(2),
    provider: "openclaw",
    providerAgentId: "dev",
    handle: "dev",
    name: "Dev",
    enabled: true,
    createdAt: NOW,
  };
  it("null 이면 살아 있고, 시각이면 보관한 것이다 — 키는 빠질 수 없다", () => {
    expect(Agent.safeParse({ ...agent, archivedAt: null }).success).toBe(true);
    expect(Agent.safeParse({ ...agent, archivedAt: NOW }).success).toBe(true);
    expect(Agent.safeParse(agent).success).toBe(false);
    expect(Agent.safeParse({ ...agent, archivedAt: "어제" }).success).toBe(false);
  });
});

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
        archivedAt: null,
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
        archivedAt: null,
      }).success,
    ).toBe(true);
  });
  it("archivedAt — null 이면 살아 있고, 시각이면 보관한 것이다. 키는 빠질 수 없다", () => {
    const channel = {
      id: ID(1),
      workspaceId: ID(2),
      name: "general",
      relayPolicy: {},
      visibility: "public",
      createdBy: ID(3),
      createdAt: NOW,
    };
    expect(Channel.safeParse({ ...channel, archivedAt: null }).success).toBe(true);
    expect(Channel.safeParse({ ...channel, archivedAt: NOW }).success).toBe(true);
    expect(Channel.safeParse(channel).success).toBe(false);
    expect(Channel.safeParse({ ...channel, archivedAt: "어제" }).success).toBe(false);
  });
});

describe("Conversation", () => {
  const base = {
    id: ID(2),
    channelId: ID(2),
    title: "이전 대화",
    titleSource: "user",
    createdBy: { type: "user", id: ID(3) },
    createdAt: NOW,
    lastSeq: 0,
  };
  it("제목은 1~80자 — 빈 제목·81자를 거절한다", () => {
    expect(Conversation.safeParse(base).success).toBe(true);
    expect(Conversation.safeParse({ ...base, title: "가".repeat(80) }).success).toBe(true);
    expect(Conversation.safeParse({ ...base, title: "가".repeat(81) }).success).toBe(false);
    expect(Conversation.safeParse({ ...base, title: "" }).success).toBe(false);
    expect(Conversation.safeParse({ ...base, title: "   " }).success).toBe(false);
  });
  it("titleSource 는 user·auto 뿐", () => {
    expect(Conversation.safeParse({ ...base, titleSource: "auto" }).success).toBe(true);
    expect(Conversation.safeParse({ ...base, titleSource: "x" }).success).toBe(false);
  });
});

describe("세션 계약(채널 세션 스펙 「데이터」·「권한」·「wire·REST」 장)", () => {
  const channel = {
    id: ID(1),
    workspaceId: ID(2),
    name: "general",
    relayPolicy: {},
    visibility: "public",
    createdBy: ID(3),
    createdAt: NOW,
    archivedAt: null,
  };
  it("Channel.sessionPolicy — 없으면 members, managers·members 밖은 거절", () => {
    expect(Channel.parse(channel).sessionPolicy).toEqual({ create: "members" });
    expect(Channel.parse({ ...channel, sessionPolicy: { create: "managers" } }).sessionPolicy).toEqual({
      create: "managers",
    });
    expect(Channel.safeParse({ ...channel, sessionPolicy: { create: "all" } }).success).toBe(false);
  });
  it("ChannelMember.role — member·manager 만, 없어도 된다(에이전트 행)", () => {
    const member = { id: ID(4), channelId: ID(1), memberType: "user", memberId: ID(3), joinedAt: NOW };
    expect(ChannelMember.parse(member).role).toBeUndefined();
    expect(ChannelMember.parse({ ...member, role: "manager" }).role).toBe("manager");
    expect(ChannelMember.safeParse({ ...member, role: "owner" }).success).toBe(false);
  });
  it("ConversationPatch — title·closed 가운데 하나는 있어야 하고 제목은 1~80자", () => {
    expect(ConversationPatch.safeParse({}).success).toBe(false);
    expect(ConversationPatch.safeParse({ closed: true }).success).toBe(true);
    expect(ConversationPatch.safeParse({ title: "배포 회고" }).success).toBe(true);
    expect(ConversationPatch.safeParse({ title: "가".repeat(81) }).success).toBe(false);
    expect(ConversationPatch.safeParse({ title: "  " }).success).toBe(false);
  });
  it("ConversationList — nextCursor 는 선택", () => {
    expect(ConversationList.safeParse({ conversations: [] }).success).toBe(true);
    expect(ConversationList.safeParse({ conversations: [], nextCursor: "1_x" }).success).toBe(true);
  });
});

describe("Message", () => {
  const base = {
    id: ID(1),
    channelId: ID(2),
    conversationId: ID(2),
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
  it("interactions 는 없으면 빈 배열 — 옛 행도 그대로 파싱된다", () => {
    expect(Message.parse(base).interactions).toEqual([]);
  });

  it("interactions 는 INTERACTIONS_MAX 를 넘으면 거부", () => {
    const one = {
      id: ID(5),
      componentId: "cmp_1",
      userId: ID(3),
      itemId: "ok",
      values: {},
      createdAt: NOW,
    };
    const make = (n: number) =>
      Message.safeParse({ ...base, interactions: Array.from({ length: n }, () => one) });
    expect(make(INTERACTIONS_MAX).success).toBe(true);
    expect(make(INTERACTIONS_MAX + 1).success).toBe(false);
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
      conversationId: ID(2),
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
  it("스레드 런은 threadRootId 를 싣는다(UUID)", () => {
    const base = {
      id: ID(1),
      channelId: ID(2),
      conversationId: ID(2),
      agentId: ID(3),
      triggerKind: "mention",
      rootMessageId: ID(4),
      relayDepth: 0,
      sessionKey: `agent:dev:dodok:channel:${ID(2)}:thread:${ID(5)}`,
      status: "queued",
      createdAt: NOW,
    };
    expect(Run.parse({ ...base, threadRootId: ID(5) }).threadRootId).toBe(ID(5));
    expect(Run.safeParse({ ...base, threadRootId: "x" }).success).toBe(false);
  });
  it("RunState는 요약 키만 가진다", () => {
    expect(Object.keys(RunState.shape).sort()).toEqual(
      [
        "agentId",
        "channelId",
        "conversationId",
        "endedAt",
        "error",
        "finalSource",
        "hasCanonical",
        "id",
        "parentRunId",
        "relayDepth",
        "startedAt",
        "status",
        "threadRootId",
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
    conversationId: ID(2),
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
   * 이 상한들은 **어댑터가 맞추는 과녁**이다(`gateway/approvals.ts` 의 `MAX`). 상한 초과를 승인을 버리지 않고
   * 통과시키는 fail-open 판정(p2-t2)이 성립하려면 어댑터가 낸 값이 여기서 통과해야 하고 한 자만 더 길면 막혀야 한다.
   * 어댑터가 상한에 맞추는 법은 필드마다 다르다: 보여 주는 여섯(`title`·`description`·`detail`·`toolName`·
   * `pluginId`·`urlPath`)은 **잘라서** 끝에 `…` 를 붙이고(`clamp`), 상관 키 `toolCallId` 만
   * **자르지 않고 통째로 버린다**(`keyWithin`). 어느 쪽이든 과녁은 같은 숫자다 —
   * 이 숫자를 바꾸면 어댑터 `MAX` 도 같이 바꾼다
   */
  it("승인 문자열 필드의 길이 상한 — 상한까지는 통과, 한 자 더는 거부", () => {
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
    // tool·dodok_control 은 Gateway 값이 아니다 — 러너 도구 승인과 우리 서버의 제어 확인 카드
    expect(ApprovalKind.options).toEqual(["exec", "plugin", "system-agent", "tool", "dodok_control"]);
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
