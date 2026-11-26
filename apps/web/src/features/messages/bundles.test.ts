import type { Message } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { AGENT, msg, uid } from "../../../test/fixtures";
import { type BundleRun, bundleIndex, bundlePath, bundlesUnder, computeBundles } from "./bundles";

const FIN = uid(12);
const [RA, RB, RA2] = [uid(301), uid(302), uid(303)];
const root = msg(1);
const R = root.id;

/** 에이전트 답 — runRoot 를 실은 지난 기록(REST) 꼴 */
const reply = (seq: number, agentId: string, runId: string, over: Partial<Message> = {}) =>
  msg(seq, {
    authorType: "agent",
    authorId: agentId,
    runId,
    runRoot: { runId, agentId, rootMessageId: R, triggerMessageId: R },
    ...over,
  });
const runError = (seq: number, agentId: string, runId: string) =>
  msg(seq, {
    kind: "system",
    authorType: "system",
    authorId: undefined,
    systemMeta: { kind: "run_error", runId },
    runRoot: { runId, agentId, rootMessageId: R, triggerMessageId: R },
  });
const run = (over: Partial<BundleRun> & Pick<BundleRun, "runId" | "agentId">): BundleRun => ({
  rootMessageId: R,
  triggerMessageId: R,
  status: "streaming",
  ...over,
});

describe("computeBundles", () => {
  it("두 에이전트가 답한 사람 글은 묶음", () => {
    const items = [root, reply(2, FIN, RB), reply(3, AGENT, RA)];
    const bundles = computeBundles(items, []);
    expect([...bundles.keys()]).toEqual([R]);
    const lanes = bundles.get(R)?.lanes ?? [];
    // 런 id(생성) 순
    expect(lanes.map((l) => l.runId)).toEqual([RA, RB]);
    expect(lanes.map((l) => l.messageIds)).toEqual([[reply(3, AGENT, RA).id], [reply(2, FIN, RB).id]]);
    expect(lanes.every((l) => l.status === "done")).toBe(true);
  });

  it("한 에이전트만이면 묶지 않는다", () => {
    const items = [root, reply(2, AGENT, RA), reply(3, AGENT, RA)];
    expect(computeBundles(items, []).size).toBe(0);
  });

  it("1명만 불렀고 릴레이로 둘째가 답해도 묶지 않는다 — 앵커가 각각 1명(2026-11-26 부른 글 기준)", () => {
    const m = reply(2, AGENT, RA);
    const relayed = reply(3, FIN, RB, {
      runRoot: { runId: RB, agentId: FIN, rootMessageId: R, triggerMessageId: m.id },
    });
    expect(computeBundles([root, m, relayed], []).size).toBe(0);
  });

  it("진행 중 런도 센다 — 메시지 없는 줄", () => {
    const bundles = computeBundles([root, reply(2, AGENT, RA)], [run({ runId: RB, agentId: FIN })]);
    const lane = bundles.get(R)?.lanes.find((l) => l.runId === RB);
    expect(lane).toMatchObject({ agentId: FIN, messageIds: [], status: "streaming" });
  });

  it("저장소의 런 상태가 메시지로 짐작한 것을 이긴다", () => {
    const bundles = computeBundles(
      [root, reply(2, AGENT, RA), reply(3, FIN, RB)],
      [run({ runId: RA, agentId: AGENT, status: "finalizing" })],
    );
    expect(bundles.get(R)?.lanes.find((l) => l.runId === RA)?.status).toBe("finalizing");
  });

  it("runRoot 가 없는 실시간 메시지는 저장소 런의 루트로 묶는다", () => {
    const live = msg(3, { authorType: "agent", authorId: FIN, runId: RB });
    const bundles = computeBundles(
      [root, reply(2, AGENT, RA), live],
      [run({ runId: RB, agentId: FIN, status: "done" })],
    );
    expect(bundles.get(R)?.lanes.find((l) => l.runId === RB)?.messageIds).toEqual([live.id]);
  });

  it("같은 에이전트의 두 런은 줄 둘 — 런 id 순", () => {
    const items = [root, reply(2, AGENT, RA), reply(3, FIN, RB), reply(4, AGENT, RA2)];
    const lanes = computeBundles(items, []).get(R)?.lanes ?? [];
    expect(lanes.map((l) => [l.runId, l.agentId])).toEqual([
      [RA, AGENT],
      [RB, FIN],
      [RA2, AGENT],
    ]);
  });

  it("저장소에 없고 메시지도 없는 aborted 런은 루트 글의 rootRuns 로 줄이 되어 묶음을 지킨다", () => {
    const withRuns = msg(1, {
      rootRuns: [
        { runId: RA, agentId: AGENT, status: "done", triggerMessageId: R },
        { runId: RB, agentId: FIN, status: "aborted", triggerMessageId: R },
      ],
    });
    const lanes = computeBundles([withRuns, reply(2, AGENT, RA)], []).get(R)?.lanes ?? [];
    expect(lanes.map((l) => [l.runId, l.status, l.messageIds.length])).toEqual([
      [RA, "done", 1],
      [RB, "aborted", 0],
    ]);
    // 저장소 상태가 rootRuns 를 이긴다
    const live = computeBundles([withRuns, reply(2, AGENT, RA)], [run({ runId: RB, agentId: FIN })]);
    expect(live.get(R)?.lanes.find((l) => l.runId === RB)?.status).toBe("streaming");
  });

  it("run_error 만 남은 런은 error 줄", () => {
    const err = runError(3, FIN, RB);
    const lane = computeBundles([root, reply(2, AGENT, RA), err], []).get(R)?.lanes[1];
    expect(lane).toMatchObject({ runId: RB, messageIds: [], systemIds: [err.id], status: "error" });
  });

  it("루트가 items 에 없으면 묶지 않는다", () => {
    expect(computeBundles([reply(2, AGENT, RA), reply(3, FIN, RB)], []).size).toBe(0);
  });

  it("에이전트 글도 여럿을 부르면 루트 — 작성자는 묻지 않는다(2026-11-26)", () => {
    const agentRoot = msg(1, { authorType: "agent", authorId: AGENT });
    expect([...computeBundles([agentRoot, reply(2, AGENT, RA), reply(3, FIN, RB)], []).keys()]).toEqual([R]);
  });

  it("스레드 답글이 루트면 묶지 않는다", () => {
    const threadReply = msg(1, { threadRootId: uid(9999) });
    expect(computeBundles([threadReply, reply(2, AGENT, RA), reply(3, FIN, RB)], []).size).toBe(0);
  });

  it("bundleIndex 는 메시지·런 id 를 루트로 잇는다", () => {
    const a = reply(2, AGENT, RA);
    const b = reply(3, FIN, RB);
    const { byMessage, byRun } = bundleIndex(computeBundles([root, a, b], []));
    expect(byMessage.get(a.id)).toBe(R);
    expect(byMessage.get(b.id)).toBe(R);
    expect(byMessage.has(R)).toBe(false);
    expect(byRun.get(RB)).toBe(R);
  });
});

describe("computeBundles — 채널에도 보낸 답글(스레드 글 채널에도 보이기 설계)", () => {
  const threadRoot = msg(1);
  const also = msg(5, { threadRootId: threadRoot.id, alsoInChannel: true });
  const plain = msg(6, { threadRootId: threadRoot.id });
  const runOn = (rootMessageId: string, runId: string, agentId: string): BundleRun => ({
    runId,
    agentId,
    rootMessageId,
    triggerMessageId: rootMessageId,
    status: "streaming",
  });

  it("사람의 채널에도 보낸 답글 + 서로 다른 에이전트 런 둘 → 묶음(줄은 런으로, 스레드 루트를 싣는다)", () => {
    const bundles = computeBundles([threadRoot, also], [runOn(also.id, RA, AGENT), runOn(also.id, RB, FIN)]);
    const b = bundles.get(also.id);
    expect(b?.lanes.map((l) => [l.runId, l.status, l.messageIds])).toEqual([
      [RA, "streaming", []],
      [RB, "streaming", []],
    ]);
    expect(b?.threadRootId).toBe(threadRoot.id);
    // 최상위 글의 묶음은 스레드 루트가 없다
    expect(
      computeBundles([root, reply(2, AGENT, RA), reply(3, FIN, RB)], []).get(R)?.threadRootId,
    ).toBeUndefined();
  });

  it("보통 스레드 답글은 묶지 않는다", () => {
    const bundles = computeBundles(
      [threadRoot, plain],
      [runOn(plain.id, RA, AGENT), runOn(plain.id, RB, FIN)],
    );
    expect(bundles.size).toBe(0);
  });

  it("런 저장소가 없으면 글의 rootRuns 로 줄이 선다", () => {
    const withRuns = {
      ...also,
      rootRuns: [
        { runId: RA, agentId: AGENT, status: "done" as const },
        { runId: RB, agentId: FIN, status: "error" as const },
      ],
    };
    const b = computeBundles([threadRoot, withRuns], []).get(also.id);
    expect(b?.lanes.map((l) => l.status)).toEqual(["done", "error"]);
  });

  it("스레드 패널(threadReplies)에서는 보통 스레드 답글도 루트 — 답이 그 답글 아래 줄에 든다(부른 글 기준 설계 덧붙임)", () => {
    const a = reply(7, AGENT, RA, {
      threadRootId: threadRoot.id,
      runRoot: { runId: RA, agentId: AGENT, rootMessageId: plain.id, triggerMessageId: plain.id },
    });
    const b = reply(8, FIN, RB, {
      threadRootId: threadRoot.id,
      runRoot: { runId: RB, agentId: FIN, rootMessageId: plain.id, triggerMessageId: plain.id },
    });
    const bundles = computeBundles([threadRoot, plain, a, b], [], { threadReplies: true });
    expect([...bundles.keys()]).toEqual([plain.id]);
    expect(bundles.get(plain.id)?.lanes.map((l) => l.messageIds)).toEqual([[a.id], [b.id]]);
    expect(bundles.get(plain.id)?.threadRootId).toBe(threadRoot.id);
    // 메인(옵션 없음)에서는 그대로 묶지 않는다
    expect(computeBundles([threadRoot, plain, a, b], []).size).toBe(0);
  });

  it("bundlesUnder 는 여러 루트를 받아 그 묶음과 하위 묶음만 — 다른 최상위 묶음은 뺀다", () => {
    const other = msg(20);
    const bundles = computeBundles(
      [threadRoot, plain, other],
      [
        runOn(plain.id, RA, AGENT),
        runOn(plain.id, RB, FIN),
        runOn(other.id, uid(311), AGENT),
        runOn(other.id, uid(312), FIN),
      ],
      { threadReplies: true },
    );
    expect([...bundles.keys()].sort()).toEqual([plain.id, other.id].sort());
    expect([...bundlesUnder(bundles, new Set([threadRoot.id, plain.id])).keys()]).toEqual([plain.id]);
    expect([...bundlesUnder(bundles, other.id).keys()]).toEqual([other.id]);
  });
});

describe("computeBundles — 부른 글 기준(2026-11-26)", () => {
  const [C1, C2, C3, C4, C5, C6] = [uid(21), uid(22), uid(23), uid(24), uid(25), uid(26)];
  const [RC, RD] = [uid(304), uid(305)];
  /** triggerId 글이 부른 런의 답 — 체인 루트는 R */
  const called = (seq: number, agentId: string, runId: string, triggerId: string) =>
    reply(seq, agentId, runId, {
      runRoot: { runId, agentId, rootMessageId: R, triggerMessageId: triggerId },
    });
  const sys = (seq: number, kind: "relay_limit" | "relay_denied", sourceRunId: string) =>
    msg(seq, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      systemMeta: { kind, relay: { fromAgentId: AGENT, toAgentId: FIN, sourceRunId, rootMessageId: R } },
    });

  it("사람 → 1명, 그 답 → 6명: 묶음 루트는 에이전트 답", () => {
    const a = reply(2, AGENT, RA);
    const six = [C1, C2, C3, C4, C5, C6].map((agent, i) => called(3 + i, agent, uid(400 + i), a.id));
    const bundles = computeBundles([root, a, ...six], []);
    expect([...bundles.keys()]).toEqual([a.id]);
    expect(bundles.get(a.id)?.lanes).toHaveLength(6);
    expect(bundles.get(a.id)?.parent).toBeUndefined();
    expect(bundles.get(a.id)?.lanes.every((l) => l.fromAgentId === AGENT)).toBe(true);
    // 여럿을 부른 글은 메인에 남는다
    expect(bundleIndex(bundles).byMessage.has(a.id)).toBe(false);
    expect(bundleIndex(bundles).byMessage.get(six[0]!.id)).toBe(a.id);
  });

  it("사람이 2명을 부르면 지금처럼 사람 글이 루트", () => {
    const bundles = computeBundles([root, reply(2, AGENT, RA), reply(3, FIN, RB)], []);
    expect([...bundles.keys()]).toEqual([R]);
  });

  it("1명 릴레이는 앵커 자리를 따른다(메인)", () => {
    const a = reply(2, AGENT, RA);
    expect(computeBundles([root, a, called(3, FIN, RB, a.id)], []).size).toBe(0);
  });

  it("줄 안 글이 1명을 부르면 그 줄에 따라 들어간다", () => {
    const a = reply(2, AGENT, RA);
    const b = reply(3, FIN, RB);
    const c = called(4, C1, RC, a.id);
    const bundles = computeBundles([root, a, b, c], []);
    expect([...bundles.keys()]).toEqual([R]);
    const laneA = bundles.get(R)?.lanes.find((l) => l.runId === RA);
    expect(bundles.get(R)?.lanes).toHaveLength(2);
    expect(laneA?.messageIds).toEqual([a.id, c.id]);
    expect(laneA?.followRunIds).toEqual([RC]);
    expect(bundles.get(R)?.lanes.find((l) => l.runId === RB)?.followRunIds).toEqual([]);
    expect(bundleIndex(bundles).byRun.get(RC)).toBe(R);
  });

  it("줄 안 글이 2명을 부르면 하위 묶음", () => {
    const a = reply(2, AGENT, RA);
    const b = reply(3, FIN, RB);
    const c = called(4, C1, RC, a.id);
    const d = called(5, C2, RD, a.id);
    const bundles = computeBundles([root, a, b, c, d], []);
    expect(new Set(bundles.keys())).toEqual(new Set([R, a.id]));
    const sub = bundles.get(a.id);
    expect(sub?.parent).toEqual({ rootId: R, runId: RA });
    expect(sub?.lanes.map((l) => l.runId)).toEqual([RC, RD]);
    expect(bundles.get(R)?.parent).toBeUndefined();
    const laneA = bundles.get(R)?.lanes.find((l) => l.runId === RA);
    expect(laneA?.messageIds).toEqual([a.id]);
    expect(laneA?.followRunIds).toEqual([]);
    const { byMessage, byRun } = bundleIndex(bundles);
    // 가장 바깥 묶음을 가리킨다
    expect(byMessage.get(c.id)).toBe(R);
    expect(byMessage.get(a.id)).toBe(R);
    expect(byRun.get(RD)).toBe(R);
  });

  it("줄 안 글이 둘째 런을 얻으면 하위 묶음", () => {
    const a = reply(2, AGENT, RA);
    const b = reply(3, FIN, RB);
    const c = called(4, C1, RC, a.id);
    const items = [root, a, b, c];
    const before = computeBundles(items, []);
    expect([...before.keys()]).toEqual([R]);
    expect(before.get(R)?.lanes.find((l) => l.runId === RA)?.messageIds).toEqual([a.id, c.id]);
    const after = computeBundles(items, [
      { runId: RD, agentId: C2, rootMessageId: R, triggerMessageId: a.id, status: "streaming" },
    ]);
    expect(new Set(after.keys())).toEqual(new Set([R, a.id]));
    expect(after.get(R)?.lanes).toHaveLength(2);
    expect(after.get(R)?.lanes.find((l) => l.runId === RA)?.messageIds).toEqual([a.id]);
    expect(after.get(a.id)?.lanes.map((l) => [l.runId, l.messageIds])).toEqual([
      [RC, [c.id]],
      [RD, []],
    ]);
  });

  it("bundlePath 는 바깥부터", () => {
    const a = reply(2, AGENT, RA);
    const c = called(4, C1, RC, a.id);
    const bundles = computeBundles([root, a, reply(3, FIN, RB), c, called(5, C2, RD, a.id)], []);
    expect(bundlePath(bundles, c.id)).toEqual([
      { rootId: R, runId: RA },
      { rootId: a.id, runId: RC },
    ]);
    expect(bundlePath(bundles, a.id)).toEqual([{ rootId: R, runId: RA }]);
    expect(bundlePath(bundles, R)).toEqual([]);
  });

  it("앵커가 items 에 없으면 메인에 남는다", () => {
    const missing = uid(9998);
    const a = reply(2, AGENT, RA);
    const b = reply(3, FIN, RB);
    // 둘을 부른 글도, 하나를 부른 글도 아직 위로 안 불렸다
    const x = called(4, C1, RC, missing);
    const y = called(5, C2, RD, missing);
    const z = called(6, C3, uid(306), uid(9997));
    const bundles = computeBundles([root, a, b, x, y, z], []);
    expect([...bundles.keys()]).toEqual([R]);
    const { byMessage } = bundleIndex(bundles);
    expect([x, y, z].map((m) => byMessage.has(m.id))).toEqual([false, false, false]);
  });

  it("앵커 사슬 순환은 메인", () => {
    // 런 X 의 trigger 가 X 자신의 메시지(깨진 데이터) — 1명이면 따라감 순환, 2명이면 자기 줄 안에 자기 묶음
    const X = uid(310);
    const x = msg(2, {
      authorType: "agent",
      authorId: AGENT,
      runId: X,
      runRoot: { runId: X, agentId: AGENT, rootMessageId: R, triggerMessageId: uid(10_002) },
    });
    expect(x.id).toBe(uid(10_002));
    expect(computeBundles([root, x], []).size).toBe(0);
    const y = called(3, FIN, RB, x.id);
    const bundles = computeBundles([root, x, y], []);
    expect(bundles.size).toBe(0);
    expect(bundlePath(bundles, y.id)).toEqual([]);
  });

  it("trigger 없는 런은 rootMessageId 를 앵커로", () => {
    const bundles = computeBundles(
      [root],
      [
        { runId: RA, agentId: AGENT, rootMessageId: R, status: "streaming" },
        { runId: RB, agentId: FIN, rootMessageId: R, status: "streaming" },
      ],
    );
    expect(bundles.get(R)?.lanes.map((l) => [l.runId, l.fromAgentId])).toEqual([
      [RA, undefined],
      [RB, undefined],
    ]);
  });

  it("relay_limit 은 sourceRunId 런의 글 자리", () => {
    const a = reply(2, AGENT, RA);
    const b = reply(3, FIN, RB);
    // ① 막힌 멘션을 쓴 글이 묶음 루트 → 그 묶음 맨 아래
    const asRoot = computeBundles(
      [root, a, called(4, C1, RC, a.id), called(5, C2, RD, a.id), sys(6, "relay_limit", RA)],
      [],
    );
    expect(asRoot.get(a.id)?.tailSystemIds).toEqual([sys(6, "relay_limit", RA).id]);
    expect(bundleIndex(asRoot).byMessage.get(sys(6, "relay_limit", RA).id)).toBe(a.id);
    // ② 글이 줄 안 → 그 줄의 systemIds
    const inLane = computeBundles([root, a, b, sys(6, "relay_denied", RA)], []);
    expect(inLane.get(R)?.tailSystemIds).toEqual([]);
    expect(inLane.get(R)?.lanes.find((l) => l.runId === RA)?.systemIds).toEqual([
      sys(6, "relay_denied", RA).id,
    ]);
    expect(bundlePath(inLane, sys(6, "relay_denied", RA).id)).toEqual([{ rootId: R, runId: RA }]);
    // ③ 글이 메인 → 묶음 없음
    const main = computeBundles([root, a, sys(6, "relay_limit", RA)], []);
    expect(main.size).toBe(0);
  });
});
