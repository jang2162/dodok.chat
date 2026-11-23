/**
 * npm `@dodok/runner` 의 latest(원격 업데이트 스펙 U2) — 러너 상세의 「최신 Y」와 원격 업데이트가 올릴 판. 서버가 1시간 쥐고, 레지스트리에
 * 닿지 않거나 답이 틀리면 null(「최신을 알 수 없음」 — 단추가 잠긴다). 실패도 잠깐 쥐어 목록을 열 때마다 레지스트리를 두드리지 않는다
 */
import { RemoteUpdateVersion } from "@dodok/shared";
import { z } from "zod";

export const RUNNER_LATEST_URL = "https://registry.npmjs.org/@dodok%2frunner/latest";
export const LATEST_TTL_MS = 60 * 60_000;
/** 실패를 쥐는 시간 — 레지스트리가 돌아오면 이만큼 뒤 다시 묻는다 */
export const LATEST_FAILURE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

const LatestBody = z.object({ version: RemoteUpdateVersion });

export type LatestRunnerVersion = {
  /** 쥔 값이 살아 있으면 그것, 아니면 레지스트리에 묻는다(같은 때 두 번 묻지 않는다) */
  get(): Promise<string | null>;
};

export function createLatestRunnerVersion(opts: {
  fetch?: typeof fetch;
  now?: () => number;
  url?: string;
  /** 고정 값 — dev:fake·시험. 있으면 레지스트리에 묻지 않는다 */
  fixed?: string | null;
}): LatestRunnerVersion {
  if (opts.fixed !== undefined) {
    const fixed = opts.fixed;
    return { get: async () => fixed };
  }
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const url = opts.url ?? RUNNER_LATEST_URL;
  let cached: { value: string | null; until: number } | undefined;
  let inflight: Promise<string | null> | undefined;

  async function ask(): Promise<string | null> {
    try {
      const res = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const parsed = LatestBody.safeParse(await res.json());
      return parsed.success ? parsed.data.version : null;
    } catch {
      return null;
    }
  }

  return {
    get() {
      if (cached && now() < cached.until) return Promise.resolve(cached.value);
      inflight ??= ask().then((value) => {
        cached = { value, until: now() + (value === null ? LATEST_FAILURE_TTL_MS : LATEST_TTL_MS) };
        inflight = undefined;
        return value;
      });
      return inflight;
    },
  };
}
