import { RunEvent, RunState } from "@dodok/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  reduceEvent,
  reduceReplay,
  reduceState,
  selectChannelRuns,
  selectScopeRuns,
  useRunStore,
} from "./runStore";

const id = (n: number) => `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;
// uuid v7 은 생성 순 = 문자열 순. R1 < R2 < R3
const [R1, R2, R3] = [id(101), id(102), id(103)];
const [C1, C2, A1] = [id(1), id(2), id(11)];
const TS = "2027-01-15T08:00:00.000Z";

/** 픽스처는 shared 스키마를 통과시켜 계약과 맞춘다 */
const state = (over: Partial<RunState> = {}): RunState =>
  RunState.parse({
    id: R1,
    channelId: C1,
    agentId: A1,
    status: "streaming",
    relayDepth: 0,
    hasCanonical: false,
    ...over,
  });
const ev = (e: Record<string, unknown>): RunEvent => RunEvent.parse({ runId: R1, ts: TS, ...e });
const text = (seq: number, delta: string): RunEvent =>
  ev({ type: "TEXT_MESSAGE_CONTENT", seq, messageId: "m", delta });

describe("run reducers", () => {
  it("reduceState 는 처음이면 빈 텍스트로 만들고, 종료 상태로 처음 바뀔 때 terminalAt 을 찍는다", () => {
    const v = reduceState(undefined, state(), 1);
    expect(v).toMatchObject({ text: "", lastEventSeq: 0 });
    expect(v.terminalAt).toBeUndefined();
    const done = reduceState(v, state({ status: "done" }), 50);
    expect(done.terminalAt).toBe(50);
    expect(reduceState(done, state({ status: "done" }), 99).terminalAt).toBe(50);
  });
  it("reduceEvent 는 seq 가 커질 때만 델타를 잇는다(재생과 실시간 중복 방지)", () => {
    let v = reduceState(undefined, state(), 0);
    v = reduceEvent(v, text(2, "안")) ?? v;
    v = reduceEvent(v, text(3, "녕")) ?? v;
    v = reduceEvent(v, text(3, "녕")) ?? v;
    expect(v).toMatchObject({ text: "안녕", lastEventSeq: 3 });
  });
  it("TEXT_MESSAGE_REPLACE 는 통째로 바꾸고, 다른 이벤트는 seq 만 올린다", () => {
    let v = reduceState(undefined, state(), 0);
    v = reduceEvent(v, text(2, "x")) ?? v;
    v = reduceEvent(v, ev({ type: "TEXT_MESSAGE_REPLACE", seq: 3, messageId: "m", text: "전체" })) ?? v;
    v = reduceEvent(v, ev({ type: "STATE_SNAPSHOT", seq: 4, snapshot: state() })) ?? v;
    expect(v).toMatchObject({ text: "전체", lastEventSeq: 4 });
  });
  it("모르는 런의 이벤트는 버린다(입장 때 activeRuns 재생이 채운다)", () => {
    expect(reduceEvent(undefined, text(2, "x"))).toBeUndefined();
  });
  it("reduceReplay 는 새로 쌓는다", () => {
    expect(reduceReplay(state(), [text(2, "a"), text(3, "b")], 0)).toMatchObject({
      text: "ab",
      lastEventSeq: 3,
    });
  });
});

describe("useRunStore", () => {
  beforeEach(() => useRunStore.getState().reset());
  it("applyState·applyEvent·remove, 채널별 선택", () => {
    const s = useRunStore.getState();
    s.applyState(state({ id: R2, channelId: C1 }));
    s.applyState(state({ id: R1, channelId: C1 }));
    s.applyState(state({ id: R3, channelId: C2 }));
    useRunStore.getState().applyEvent(text(2, "x"));
    expect(selectChannelRuns(C1)(useRunStore.getState()).map((v) => v.state.id)).toEqual([R1, R2]);
    expect(useRunStore.getState().runs[R1]?.text).toBe("x");
    useRunStore.getState().remove(R1);
    expect(useRunStore.getState().runs[R1]).toBeUndefined();
  });
  it("모르는 런의 이벤트·없는 런 remove 는 상태를 바꾸지 않는다", () => {
    const before = useRunStore.getState().runs;
    useRunStore.getState().applyEvent(text(2, "x"));
    useRunStore.getState().remove(R1);
    expect(useRunStore.getState().runs).toBe(before);
  });
  it("applyReplay 는 런을 재생 결과로 채우고, reset 은 모두 비운다", () => {
    useRunStore.getState().applyReplay(state(), [text(2, "a"), text(3, "b")]);
    expect(useRunStore.getState().runs[R1]).toMatchObject({ text: "ab", lastEventSeq: 3 });
    useRunStore.getState().reset();
    expect(useRunStore.getState().runs).toEqual({});
  });
});

describe("런의 스레드 소속(판정 R3′)", () => {
  const ROOT = id(500);
  const started = (sessionKey: string) =>
    ev({ type: "RUN_STARTED", seq: 1, threadId: C1, agentId: A1, sessionKey });
  beforeEach(() => useRunStore.getState().reset());

  it("run.state 의 threadRootId 가 1순위 — queued 로 RUN_STARTED 전이어도 스레드 런이다", () => {
    expect(reduceState(undefined, state({ status: "queued", threadRootId: ROOT }), 1).threadRootId).toBe(
      ROOT,
    );
    // 뒤따른 상태에 필드가 빠져도 잊지 않는다
    const v = reduceState(reduceState(undefined, state({ threadRootId: ROOT }), 1), state(), 2);
    expect(v.threadRootId).toBe(ROOT);
  });

  it("threadRootId 가 없으면 RUN_STARTED 의 세션 키를 shared 파서로 풀어 가른다 — 채널 키는 채널 런", () => {
    const base = reduceState(undefined, state({ status: "queued" }), 1);
    const thread = reduceEvent(base, started(`agent:dev:dodok:channel:${C1}:thread:${ROOT.toUpperCase()}`));
    expect(thread?.threadRootId).toBe(ROOT);
    const channel = reduceEvent(base, started(`agent:dev:dodok:channel:${C1}`));
    expect(channel?.threadRootId).toBeUndefined();
  });

  it("세션 키로 정한 스레드는 뒤의 run.state 에 threadRootId 가 없어도(옛 서버) 유지", () => {
    const s = useRunStore.getState();
    s.applyState(state({ id: R1, status: "queued" }));
    s.applyEvent(
      ev({
        type: "RUN_STARTED",
        runId: R1,
        seq: 1,
        threadId: C1,
        agentId: A1,
        sessionKey: `agent:dev:dodok:channel:${C1}:thread:${ROOT}`,
      }),
    );
    useRunStore.getState().applyState(state({ id: R1, status: "streaming" }));
    useRunStore.getState().applyState(state({ id: R1, status: "done" }));
    expect(useRunStore.getState().runs[R1]?.threadRootId).toBe(ROOT);
    expect(selectScopeRuns(C1)(useRunStore.getState())).toEqual([]);
  });

  it("selectScopeRuns: 채널 범위는 스레드 런을, 스레드 범위는 채널 런·다른 스레드 런을 뺀다", () => {
    const s = useRunStore.getState();
    s.applyState(state({ id: R1 }));
    s.applyState(state({ id: R2, threadRootId: ROOT }));
    s.applyState(state({ id: R3, threadRootId: id(501) }));
    const now = useRunStore.getState();
    expect(selectScopeRuns(C1)(now).map((v) => v.state.id)).toEqual([R1]);
    expect(selectScopeRuns(C1, ROOT)(now).map((v) => v.state.id)).toEqual([R2]);
    // 활동 탭·재동기화는 여전히 채널의 전부를 본다
    expect(selectChannelRuns(C1)(now)).toHaveLength(3);
  });

  it("런을 스토어에서 지워도 스레드 소속은 남는다 — 확정된 승인 카드가 채널로 새지 않게", () => {
    const s = useRunStore.getState();
    s.applyState(state({ id: R2, threadRootId: ROOT }));
    s.remove(R2);
    expect(useRunStore.getState().threads[R2]).toBe(ROOT);
    useRunStore.getState().reset();
    expect(useRunStore.getState().threads).toEqual({});
  });

  it("재생(applyReplay)의 RUN_STARTED 로도 소속을 기록한다", () => {
    useRunStore
      .getState()
      .applyReplay(state({ id: R1 }), [started(`agent:dev:dodok:channel:${C1}:thread:${ROOT}`)]);
    expect(useRunStore.getState().threads[R1]).toBe(ROOT);
  });
});
