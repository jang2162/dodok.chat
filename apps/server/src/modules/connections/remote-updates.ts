/**
 * 원격 업데이트 진행(원격 업데이트 스펙 U9) — 서버 메모리에만 쥔다(재시작하면 잊는다). 연결 하나(러너 토큰·Gateway)에 하나. 진행 중이면
 * 두 번째 요청은 409(Review Focus 4). 끝은 다시 붙은 연결의 hello 로 가른다 — 러너는 새 판으로 붙으면 끝, 플러그인은 hello 의
 * lastUpdate(요청 때 본 것과 다른 결과)나 같은 빌드로 붙으면 끝. 상한(러너 3분·플러그인 5분) 안에 다시 붙지 않으면 timeout
 */
import type {
  RemoteUpdateAck,
  RemoteUpdateOutcome,
  RemoteUpdateProgress,
  RemoteUpdateSupport,
  RunnerCapability,
} from "@dodok/shared";
import { apiError } from "../../http/errors";

type Updating = {
  state: "updating";
  targetVersion: string | null;
  startedAt: number;
  deadline: number;
  /** 요청 때 그 플러그인 hello 의 lastUpdate.at — 다시 붙은 hello 의 결과가 이번 것인지 가른다(두 머신의 시계를 견주지 않는다) */
  prevLastUpdateAt: string | null;
};
type Entry = Updating | { state: "failed"; message: string; at: number } | { state: "timeout"; at: number };

export const ALREADY_UPDATING_MESSAGE = "이미 업데이트하는 중입니다";

export type RemoteUpdates = ReturnType<typeof createRemoteUpdates>;

export function createRemoteUpdates(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const iso = (ms: number) => new Date(ms).toISOString();

  function toView(entry: Entry): RemoteUpdateProgress {
    if (entry.state === "updating")
      return {
        state: "updating",
        targetVersion: entry.targetVersion,
        startedAt: iso(entry.startedAt),
        deadline: iso(entry.deadline),
      };
    if (entry.state === "failed") return { state: "failed", message: entry.message, at: iso(entry.at) };
    return { state: "timeout", at: iso(entry.at) };
  }

  /** 상한이 지났으면 timeout 으로 바꾼다 */
  function current(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry?.state === "updating" && now() > entry.deadline) {
      const timedOut: Entry = { state: "timeout", at: entry.deadline };
      entries.set(key, timedOut);
      return timedOut;
    }
    return entry;
  }

  return {
    /** 진행 시작 — 이미 진행 중이면 409 CONFLICT. 돌려준 startedAt 은 fail 의 짝 */
    begin(
      key: string,
      input: { targetVersion: string | null; deadlineMs: number; prevLastUpdateAt?: string | null },
    ): { view: RemoteUpdateProgress; startedAt: number } {
      if (current(key)?.state === "updating") throw apiError("CONFLICT", ALREADY_UPDATING_MESSAGE);
      const startedAt = now();
      const entry: Updating = {
        state: "updating",
        targetVersion: input.targetVersion,
        startedAt,
        deadline: startedAt + input.deadlineMs,
        prevLastUpdateAt: input.prevLastUpdateAt ?? null,
      };
      entries.set(key, entry);
      return { view: toView(entry), startedAt };
    },
    /** 그 시작의 진행을 실패로 — 그 사이 새로 시작했으면 건드리지 않는다 */
    fail(key: string, startedAt: number, message: string): void {
      const entry = entries.get(key);
      if (entry?.state === "updating" && entry.startedAt === startedAt)
        entries.set(key, { state: "failed", message, at: now() });
    },
    /** 그 시작을 없던 것으로(곧바로 거절된 요청) */
    cancel(key: string, startedAt: number): void {
      const entry = entries.get(key);
      if (entry?.state === "updating" && entry.startedAt === startedAt) entries.delete(key);
    },
    /** 러너 — 진행 중에 새 연결(시작 뒤 붙음)이 목표 판이면 끝, 다른 판이면 실패 */
    runnerView(
      tokenId: string,
      live: { runnerVersion: string; connectedAt: string } | null,
    ): RemoteUpdateProgress | null {
      const key = `runner:${tokenId}`;
      const entry = current(key);
      if (!entry) return null;
      if (entry.state === "updating" && live && Date.parse(live.connectedAt) > entry.startedAt) {
        if (live.runnerVersion === entry.targetVersion) {
          entries.delete(key);
          return null;
        }
        const failed: Entry = {
          state: "failed",
          message: `다시 붙었지만 판이 그대로입니다(${live.runnerVersion})`,
          at: now(),
        };
        entries.set(key, failed);
        return toView(failed);
      }
      return toView(entry);
    },
    /** 플러그인 — 진행 중에 새 연결이 이번 결과(lastUpdate)를 실었으면 그것으로, 결과 없이 서버와 같은 빌드면 끝 */
    gatewayView(
      gatewayId: string,
      plugin: {
        connectedAt: string;
        bundleSha256: string | null;
        lastUpdate?: RemoteUpdateOutcome | null;
      } | null,
      serverBundleSha256: string | null,
    ): RemoteUpdateProgress | null {
      const key = `gateway:${gatewayId}`;
      const entry = current(key);
      if (!entry) return null;
      if (entry.state === "updating" && plugin && Date.parse(plugin.connectedAt) > entry.startedAt) {
        const result = plugin.lastUpdate;
        if (result && result.at !== entry.prevLastUpdateAt) {
          if (result.ok) {
            entries.delete(key);
            return null;
          }
          const failed: Entry = {
            state: "failed",
            message: result.message ?? "업데이트에 실패했습니다",
            at: now(),
          };
          entries.set(key, failed);
          return toView(failed);
        }
        if (serverBundleSha256 !== null && plugin.bundleSha256 === serverBundleSha256) {
          entries.delete(key);
          return null;
        }
      }
      return toView(entry);
    },
  };
}

export const runnerUpdateKey = (tokenId: string) => `runner:${tokenId}`;
export const gatewayUpdateKey = (gatewayId: string) => `gateway:${gatewayId}`;

/** 붙은 러너의 원격 업데이트 — 능력 remoteUpdate 가 없으면 옛 판, remoteUpdateOff 면 그 머신이 껐다(shared RunnerCapability 주석) */
export function runnerSupport(has: (capability: RunnerCapability) => boolean): RemoteUpdateSupport {
  if (!has("remoteUpdate")) return "unsupported";
  return has("remoteUpdateOff") ? "off" : "on";
}

/** 받아들여지지 않은 요청의 답이 곧바로 왔는지 기다리는 시간 — 거절(꺼짐·런 중·판)은 즉시 온다. 넘으면 202 로 답하고 상한이 가른다 */
export const QUICK_ACK_MS = 3_000;

/** 곧바로 거절된 업데이트 — 409, details.reason 은 그 머신의 사유 */
export function rejectedUpdate(result: Extract<RemoteUpdateAck, { ok: false }>) {
  return apiError("CONFLICT", result.message ?? `업데이트하지 않았습니다(${result.reason})`, {
    reason: result.reason,
  });
}

/**
 * 업데이트 요청을 보내고 QUICK_ACK_MS 만큼 답을 기다린다. 그 안에 거절이 오면 진행을 지우고 409, 보내기 자체가 실패하면 그 오류를 던진다.
 * 답이 늦으면 그 뒤 온 거절은 진행을 실패로 바꾸고 onLate 를 부른다(웹이 다시 받게)
 */
export async function sendUpdate(input: {
  updates: RemoteUpdates;
  key: string;
  startedAt: number;
  send: () => Promise<RemoteUpdateAck>;
  onLate: () => void;
  quickMs?: number;
}): Promise<void> {
  const sent = input.send();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    sent.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), input.quickMs ?? QUICK_ACK_MS))),
  ]);
  clearTimeout(timer);
  if (early && "error" in early) {
    input.updates.cancel(input.key, input.startedAt);
    throw early.error;
  }
  if (early) {
    if (!early.result.ok) {
      input.updates.cancel(input.key, input.startedAt);
      throw rejectedUpdate(early.result);
    }
    return;
  }
  void sent.then(
    (result) => {
      if (result.ok) return;
      input.updates.fail(
        input.key,
        input.startedAt,
        result.message ?? `업데이트하지 않았습니다(${result.reason})`,
      );
      input.onLate();
    },
    // 늦은 끊김·시간 초과 — 러너가 ok 를 답하기 전에 끊고 다시 떴을 수 있다. 상한(deadline)이 가른다
    () => {},
  );
}
