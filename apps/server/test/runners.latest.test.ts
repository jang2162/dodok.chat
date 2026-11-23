import { describe, expect, it } from "vitest";
import {
  createLatestRunnerVersion,
  LATEST_FAILURE_TTL_MS,
  LATEST_TTL_MS,
  RUNNER_LATEST_URL,
} from "../src/modules/runners/latest";

// npm @dodok/runner latest 캐시(원격 업데이트 스펙 U2) — 레지스트리는 가짜 fetch

function fakeFetch(answers: Array<() => Response | Promise<Response>>) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(String(url));
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, urls };
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

describe("createLatestRunnerVersion", () => {
  it("레지스트리의 latest 를 1시간 쥐고, 같은 때의 두 질문은 한 번만 묻는다", async () => {
    let now = 0;
    const f = fakeFetch([ok({ version: "0.9.0" }), ok({ version: "0.10.0" })]);
    const latest = createLatestRunnerVersion({ fetch: f.fetch, now: () => now });
    const [a, b] = await Promise.all([latest.get(), latest.get()]);
    expect([a, b]).toEqual(["0.9.0", "0.9.0"]);
    expect(f.urls).toEqual([RUNNER_LATEST_URL]);
    now = LATEST_TTL_MS - 1;
    expect(await latest.get()).toBe("0.9.0");
    now = LATEST_TTL_MS + 1;
    expect(await latest.get()).toBe("0.10.0");
    expect(f.urls).toHaveLength(2);
  });

  it("닿지 않음·HTTP 오류·semver 가 아닌 답이면 null — 실패는 5분만 쥔다", async () => {
    let now = 0;
    const f = fakeFetch([
      () => Promise.reject(new Error("ENOTFOUND")),
      () => new Response("", { status: 503 }),
      ok({ version: "latest" }),
      ok({ version: "1.0.0" }),
    ]);
    const latest = createLatestRunnerVersion({ fetch: f.fetch, now: () => now });
    expect(await latest.get()).toBeNull();
    expect(await latest.get()).toBeNull();
    expect(f.urls).toHaveLength(1);
    for (const expected of [null, null, "1.0.0"]) {
      now += LATEST_FAILURE_TTL_MS + 1;
      expect(await latest.get()).toBe(expected);
    }
  });

  it("peek 은 기다리지 않는다 — 묻기 전 undefined, 쥔 동안 fresh, 지나면 낡은 값 그대로 fresh false", async () => {
    let now = 0;
    const f = fakeFetch([ok({ version: "0.9.0" })]);
    const latest = createLatestRunnerVersion({ fetch: f.fetch, now: () => now });
    expect(latest.peek()).toEqual({ value: undefined, fresh: false });
    expect(f.urls).toEqual([]);
    await latest.get();
    expect(latest.peek()).toEqual({ value: "0.9.0", fresh: true });
    now = LATEST_TTL_MS + 1;
    expect(latest.peek()).toEqual({ value: "0.9.0", fresh: false });
    expect(createLatestRunnerVersion({ fixed: null }).peek()).toEqual({ value: null, fresh: true });
  });

  it("fixed 면 레지스트리에 묻지 않는다", async () => {
    const f = fakeFetch([]);
    expect(await createLatestRunnerVersion({ fetch: f.fetch, fixed: null }).get()).toBeNull();
    expect(await createLatestRunnerVersion({ fetch: f.fetch, fixed: "0.9.0" }).get()).toBe("0.9.0");
    expect(f.urls).toEqual([]);
  });
});
