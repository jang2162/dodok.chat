import type { Message } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { AGENT, msg, uid } from "../../../test/fixtures";
import { type BundleRun, bundleIndex, computeBundles } from "./bundles";

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

  it("1명만 불렀어도 릴레이로 둘째가 답하면 묶는다", () => {
    const m = reply(2, AGENT, RA);
    const relayed = reply(3, FIN, RB, {
      runRoot: { runId: RB, agentId: FIN, rootMessageId: R, triggerMessageId: m.id },
    });
    const lanes = computeBundles([root, m, relayed], []).get(R)?.lanes ?? [];
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.fromAgentId).toBeUndefined();
    expect(lanes[1]?.fromAgentId).toBe(AGENT);
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

  it("relay_limit 은 tailSystemIds", () => {
    const limit = msg(4, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: AGENT, toAgentId: FIN, sourceRunId: RA, rootMessageId: R },
      },
    });
    const bundle = computeBundles([root, reply(2, AGENT, RA), reply(3, FIN, RB), limit], []).get(R);
    expect(bundle?.tailSystemIds).toEqual([limit.id]);
    expect(bundleIndex(new Map([[R, bundle!]])).byMessage.get(limit.id)).toBe(R);
  });

  it("루트가 items 에 없으면 묶지 않는다", () => {
    expect(computeBundles([reply(2, AGENT, RA), reply(3, FIN, RB)], []).size).toBe(0);
  });

  it("에이전트 글이 루트면 묶지 않는다", () => {
    const agentRoot = msg(1, { authorType: "agent", authorId: AGENT });
    expect(computeBundles([agentRoot, reply(2, AGENT, RA), reply(3, FIN, RB)], []).size).toBe(0);
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
