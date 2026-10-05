import type { Agent, Channel, ChannelMember, Message, Run } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  computeRelayHash,
  decideRuns,
  normalizeForHash,
  type RoutingInput,
} from "../src/modules/router/decide";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T09:00:00+09:00";
const WS = ID(0);
const CH = ID(1);
const USER = ID(2);
const A = ID(10);
const B = ID(11);
const C = ID(12);

const agent = (id: string, handle: string, enabled = true): Agent => ({
  id,
  workspaceId: WS,
  provider: "openclaw",
  providerAgentId: handle,
  handle,
  name: handle,
  enabled,
  createdAt: NOW,
  archivedAt: null,
});
const member = (memberId: string, extra: Partial<ChannelMember> = {}): ChannelMember => ({
  id: ID(20),
  channelId: CH,
  memberType: "agent",
  memberId,
  autoRespond: false,
  aliases: [],
  joinedAt: NOW,
  ...extra,
});
const channel = (relayPolicy: Partial<Channel["relayPolicy"]> = {}): Channel => ({
  id: CH,
  workspaceId: WS,
  name: "g",
  relayPolicy: { maxRelayTurns: 4, allowPairs: "all", ...relayPolicy },
  visibility: "public",
  createdBy: USER,
  createdAt: NOW,
});
const userMsg = (agents: string[], bodyMd = "hi"): Message => ({
  id: ID(30),
  channelId: CH,
  seq: 1,
  kind: "normal",
  authorType: "user",
  authorId: USER,
  bodyMd,
  mentions: { agents, users: [] },
  attachments: [],
  interactions: [],
  createdAt: NOW,
});
const agentMsg = (author: string, agents: string[], bodyMd = "reply"): Message => ({
  id: ID(31),
  channelId: CH,
  seq: 2,
  kind: "normal",
  authorType: "agent",
  authorId: author,
  bodyMd,
  mentions: { agents, users: [] },
  attachments: [],
  interactions: [],
  runId: ID(40),
  createdAt: NOW,
});
const run = (agentId: string, relayDepth: number): Run => ({
  id: ID(40),
  channelId: CH,
  agentId,
  triggerKind: "mention",
  triggerMessageId: ID(30),
  rootMessageId: ID(30),
  relayDepth,
  sessionKey: "k",
  status: "done",
  hasCanonical: true,
  createdAt: NOW,
});
const input = (partial: Partial<RoutingInput>): RoutingInput => ({
  message: userMsg([]),
  channel: channel(),
  members: [member(A), member(B)],
  agents: [agent(A, "a"), agent(B, "b")],
  chainHashes: new Set(),
  now: new Date(NOW),
  ...partial,
});

describe("decideRuns — 사람 메시지", () => {
  it("멘션된 활성 에이전트마다 mention 런, depth 0, root = 메시지", () => {
    const r = decideRuns(input({ message: userMsg([A, B]) }));
    expect(r.blocked).toEqual([]);
    expect(r.runs).toEqual([
      { agentId: A, triggerKind: "mention", rootMessageId: ID(30), relayDepth: 0 },
      { agentId: B, triggerKind: "mention", rootMessageId: ID(30), relayDepth: 0 },
    ]);
  });
  it("보관한 에이전트는 켜져 있어도 멘션·자동 응답 대상이 아니다(계획 판정 PS2)", () => {
    const archived = { ...agent(A, "a"), archivedAt: NOW };
    const mention = decideRuns(input({ message: userMsg([A]), agents: [archived, agent(B, "b")] }));
    expect(mention.runs).toEqual([]);
    const auto = decideRuns(
      input({
        message: userMsg([]),
        members: [member(A, { autoRespond: true })],
        agents: [archived],
      }),
    );
    expect(auto.runs).toEqual([]);
  });
  it("비활성·비소속 에이전트는 조용히 제외", () => {
    const r = decideRuns(
      input({ message: userMsg([A, B, C]), agents: [agent(A, "a", false), agent(B, "b"), agent(C, "c")] }),
    );
    expect(r.runs.map((x) => x.agentId)).toEqual([B]);
  });
  it("중복 멘션은 한 번만", () => {
    expect(decideRuns(input({ message: userMsg([A, A]) })).runs).toHaveLength(1);
  });
  it("멘션 없음 → autoRespond 에이전트 1개 (joinedAt 가장 이른 것)", () => {
    const r = decideRuns(
      input({
        members: [
          member(A, { autoRespond: true, joinedAt: "2026-09-14T10:00:00+09:00" }),
          member(B, { autoRespond: true, joinedAt: "2026-09-14T09:00:00+09:00" }),
        ],
      }),
    );
    expect(r.runs).toEqual([
      { agentId: B, triggerKind: "auto_respond", rootMessageId: ID(30), relayDepth: 0 },
    ]);
  });
  it("멘션 없음 + autoRespond 없음 → 런 없음", () => {
    expect(decideRuns(input({})).runs).toEqual([]);
  });
  it("joinedAt은 시각(오프셋 포함)으로 비교한다, 문자열 비교가 아니라", () => {
    const r = decideRuns(
      input({
        members: [
          member(A, { autoRespond: true, joinedAt: "2026-09-14T10:00:00+09:00" }), // 01:00Z
          member(B, { autoRespond: true, joinedAt: "2026-09-14T02:00:00Z" }), // 02:00Z
        ],
      }),
    );
    expect(r.runs).toEqual([
      { agentId: A, triggerKind: "auto_respond", rootMessageId: ID(30), relayDepth: 0 },
    ]);
  });
  it("멘션이 전부 비활성이면 autoRespond로 폴백하지 않는다", () => {
    const r = decideRuns(
      input({
        message: userMsg([A]),
        agents: [agent(A, "a", false), agent(B, "b")],
        members: [member(A), member(B, { autoRespond: true })],
      }),
    );
    expect(r.runs).toEqual([]);
  });
});

describe("decideRuns — 에이전트 메시지(릴레이)", () => {
  it("sourceRun이 없으면 릴레이하지 않는다", () => {
    expect(decideRuns(input({ message: agentMsg(A, [B]) })).runs).toEqual([]);
  });
  it("자기 멘션 제외, depth+1, root는 sourceRun의 root, relayHash 포함", () => {
    const r = decideRuns(input({ message: agentMsg(A, [A, B], "B야 봐줘"), sourceRun: run(A, 0) }));
    expect(r.runs).toEqual([
      {
        agentId: B,
        triggerKind: "relay",
        rootMessageId: ID(30),
        relayDepth: 1,
        relayHash: computeRelayHash(A, B, "B야 봐줘"),
      },
    ]);
  });
  it("autoRespond는 에이전트 메시지에 적용되지 않는다", () => {
    const r = decideRuns(
      input({
        message: agentMsg(A, []),
        sourceRun: run(A, 0),
        members: [member(A), member(B, { autoRespond: true })],
      }),
    );
    expect(r.runs).toEqual([]);
  });
  it("pair_not_allowed", () => {
    const r = decideRuns(
      input({
        message: agentMsg(A, [B]),
        sourceRun: run(A, 0),
        channel: channel({ allowPairs: [{ from: B, to: A }] }),
      }),
    );
    expect(r.runs).toEqual([]);
    expect(r.blocked).toEqual([{ agentId: B, reason: "pair_not_allowed" }]);
  });
  it("max_turns: depth 4에서 5로 넘어가면 차단, 3→4는 허용", () => {
    expect(decideRuns(input({ message: agentMsg(A, [B]), sourceRun: run(A, 4) })).blocked).toEqual([
      { agentId: B, reason: "max_turns" },
    ]);
    expect(decideRuns(input({ message: agentMsg(A, [B]), sourceRun: run(A, 3) })).runs[0]?.relayDepth).toBe(
      4,
    );
  });
  it("repeat: 체인에 같은 해시가 있으면 차단", () => {
    const h = computeRelayHash(A, B, "reply");
    const r = decideRuns(
      input({ message: agentMsg(A, [B], "reply"), sourceRun: run(A, 0), chainHashes: new Set([h]) }),
    );
    expect(r.blocked).toEqual([{ agentId: B, reason: "repeat" }]);
  });
  it("disabled: 비활성 대상은 blocked로 알린다", () => {
    const r = decideRuns(
      input({
        message: agentMsg(A, [B]),
        sourceRun: run(A, 0),
        agents: [agent(A, "a"), agent(B, "b", false)],
      }),
    );
    expect(r.blocked).toEqual([{ agentId: B, reason: "disabled" }]);
  });
});

const ROOT = ID(50);
/** 스레드 루트 — 작성자 종류만 바꿔 쓴다 */
const rootMsg = (authorType: "user" | "agent", authorId: string): Message => ({
  id: ROOT,
  channelId: CH,
  seq: 1,
  kind: "normal",
  authorType,
  authorId,
  bodyMd: "root",
  mentions: { agents: [], users: [] },
  attachments: [],
  interactions: [],
  createdAt: NOW,
});
const inThread = (m: Message): Message => ({ ...m, threadRootId: ROOT });

describe("decideRuns — 스레드 답글(스펙 2.2)", () => {
  it("사람 답글의 멘션 → 에이전트마다 그 스레드의 mention 런", () => {
    const r = decideRuns(input({ message: inThread(userMsg([A, B])), threadRoot: rootMsg("user", USER) }));
    expect(r.runs).toEqual([
      { agentId: A, triggerKind: "mention", rootMessageId: ID(30), relayDepth: 0, threadRootId: ROOT },
      { agentId: B, triggerKind: "mention", rootMessageId: ID(30), relayDepth: 0, threadRootId: ROOT },
    ]);
  });
  it("멘션 없음 + 루트가 에이전트 메시지 → 그 에이전트(자동 응답 에이전트보다 먼저)", () => {
    const r = decideRuns(
      input({
        message: inThread(userMsg([])),
        threadRoot: rootMsg("agent", B),
        members: [member(A, { autoRespond: true }), member(B)],
      }),
    );
    expect(r.runs).toEqual([
      { agentId: B, triggerKind: "auto_respond", rootMessageId: ID(30), relayDepth: 0, threadRootId: ROOT },
    ]);
  });
  it("멘션 없음 + 루트 에이전트가 비활성·비소속 → 채널 자동 응답 에이전트", () => {
    for (const setup of [
      {
        agents: [agent(A, "a"), agent(B, "b", false)],
        members: [member(A, { autoRespond: true }), member(B)],
      },
      { agents: [agent(A, "a"), agent(B, "b")], members: [member(A, { autoRespond: true })] },
    ]) {
      const r = decideRuns(
        input({ message: inThread(userMsg([])), threadRoot: rootMsg("agent", B), ...setup }),
      );
      expect(r.runs).toEqual([
        { agentId: A, triggerKind: "auto_respond", rootMessageId: ID(30), relayDepth: 0, threadRootId: ROOT },
      ]);
    }
  });
  it("멘션 없음 + 사람 루트 → 채널 자동 응답 에이전트, 없으면 런 없음", () => {
    const withAuto = decideRuns(
      input({
        message: inThread(userMsg([])),
        threadRoot: rootMsg("user", USER),
        members: [member(A), member(B, { autoRespond: true })],
      }),
    );
    expect(withAuto.runs).toEqual([
      { agentId: B, triggerKind: "auto_respond", rootMessageId: ID(30), relayDepth: 0, threadRootId: ROOT },
    ]);
    expect(
      decideRuns(input({ message: inThread(userMsg([])), threadRoot: rootMsg("user", USER) })).runs,
    ).toEqual([]);
  });
  it("멘션이 전부 비활성이면 루트 에이전트로도 폴백하지 않는다", () => {
    const r = decideRuns(
      input({
        message: inThread(userMsg([C])),
        threadRoot: rootMsg("agent", A),
      }),
    );
    expect(r.runs).toEqual([]);
  });
  it("에이전트 답글의 멘션은 같은 스레드의 릴레이", () => {
    const r = decideRuns(
      input({ message: inThread(agentMsg(A, [B], "B야")), sourceRun: { ...run(A, 0), threadRootId: ROOT } }),
    );
    expect(r.runs).toEqual([
      {
        agentId: B,
        triggerKind: "relay",
        rootMessageId: ID(30),
        relayDepth: 1,
        relayHash: computeRelayHash(A, B, "B야"),
        threadRootId: ROOT,
      },
    ]);
  });
  it("최상위 메시지의 런에는 threadRootId 가 없다", () => {
    const r = decideRuns(input({ message: userMsg([A]) }));
    expect(r.runs[0]).not.toHaveProperty("threadRootId");
  });
});

describe("해시", () => {
  it("normalizeForHash: 토큰 제거, 공백 축약, 소문자, 앞 300자", () => {
    expect(normalizeForHash(`  Hello   <@a:${A}>  World\n\n`)).toBe("hello world");
    expect(normalizeForHash("x".repeat(400))).toHaveLength(300);
  });
  it("computeRelayHash는 64자 hex이고 방향에 따라 다르다", () => {
    expect(computeRelayHash(A, B, "t")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRelayHash(A, B, "t")).not.toBe(computeRelayHash(B, A, "t"));
  });
});
