import { describe, expect, it } from "vitest";
import { createScheduler } from "../src/scheduler";

/** 끝을 테스트가 쥐는 일 — 받은 signal 도 남긴다 */
function deferredJob() {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const job = {
    started: false,
    signal: undefined as AbortSignal | undefined,
    run: (signal: AbortSignal) => {
      job.started = true;
      job.signal = signal;
      return done;
    },
    finish: () => finish(),
  };
  return job;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createScheduler", () => {
  it("상한 3 — 넷째는 queuedPosition 1, 하나가 끝나면 시작한다", async () => {
    const s = createScheduler(3);
    const jobs = [0, 1, 2, 3, 4].map(() => deferredJob());
    expect(s.submit("r0", "s0", jobs[0]!.run)).toEqual({});
    expect(s.submit("r1", "s1", jobs[1]!.run)).toEqual({});
    expect(s.submit("r2", "s2", jobs[2]!.run)).toEqual({});
    expect(s.submit("r3", "s3", jobs[3]!.run)).toEqual({ queuedPosition: 1 });
    expect(s.submit("r4", "s4", jobs[4]!.run)).toEqual({ queuedPosition: 2 });
    expect(jobs[3]!.started).toBe(false);
    jobs[1]!.finish();
    await tick();
    expect(jobs[3]!.started).toBe(true);
    expect(jobs[4]!.started).toBe(false);
  });

  it("일이 던져도 자리를 돌려준다", async () => {
    const s = createScheduler(1);
    const next = deferredJob();
    s.submit("r0", "s0", () => Promise.reject(new Error("boom")));
    expect(s.submit("r1", "s1", next.run)).toEqual({ queuedPosition: 1 });
    await tick();
    expect(next.started).toBe(true);
  });

  it("같은 세션이 돌거나 기다리는 중이면 busy", () => {
    const s = createScheduler(1);
    s.submit("r0", "s0", deferredJob().run);
    expect(s.submit("r1", "s0", deferredJob().run)).toEqual({ busy: true });
    s.submit("r2", "s2", deferredJob().run);
    expect(s.submit("r3", "s2", deferredJob().run)).toEqual({ busy: true });
  });

  it("같은 세션이라도 앞 런이 끝났으면 받는다", async () => {
    const s = createScheduler(2);
    const a = deferredJob();
    s.submit("r0", "s0", a.run);
    a.finish();
    await tick();
    expect(s.submit("r1", "s0", deferredJob().run)).toEqual({});
  });

  it("abort — 도는 런은 signal 을 끊고, 기다리는 런은 시작하지 않고 뺀다", async () => {
    const s = createScheduler(1);
    const a = deferredJob();
    const b = deferredJob();
    const c = deferredJob();
    s.submit("r0", "s0", a.run);
    s.submit("r1", "s1", b.run);
    s.submit("r2", "s2", c.run);
    s.abort("r1");
    s.abort("r0");
    expect(a.signal?.aborted).toBe(true);
    a.finish();
    await tick();
    expect(b.started).toBe(false);
    expect(c.started).toBe(true);
    s.abort("모르는 런"); // 조용히 무시
  });

  it("abortAll — 도는 것은 모두 끊고 대기열은 비운다(뒤에 자리가 나도 시작하지 않는다)", async () => {
    const s = createScheduler(2);
    const jobs = [0, 1, 2, 3].map(() => deferredJob());
    jobs.forEach((j, i) => s.submit(`r${i}`, `s${i}`, j.run));
    s.abortAll();
    expect(jobs[0]!.signal?.aborted).toBe(true);
    expect(jobs[1]!.signal?.aborted).toBe(true);
    jobs[0]!.finish();
    jobs[1]!.finish();
    await tick();
    expect(jobs[2]!.started).toBe(false);
    expect(jobs[3]!.started).toBe(false);
    // 비운 뒤에는 새 일을 곧바로 받는다
    expect(s.submit("r9", "s0", deferredJob().run)).toEqual({});
  });
});
