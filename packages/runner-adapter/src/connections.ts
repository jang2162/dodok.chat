import {
  RunnerCapability,
  type RunnerClientToServerEvents,
  type RunnerConnection,
  type RunnerHello,
  type RunnerProgram,
  type RunnerProgramStatus,
  type RunnerServerToClientEvents,
  Sha256Hex,
} from "@dodok/shared";
import type { Socket } from "socket.io";

export type RunnerSocket = Socket<RunnerClientToServerEvents, RunnerServerToClientEvents>;

/**
 * 붙은 러너가 hello 로 알린 것 — 메모리에만 있다(러너 일반화 스펙 5장). 끊기면 없어지고, 화면은 「마지막으로 알린」 내용 없이
 * 「끊김」만 보인다. 루트는 id·라벨뿐이다 — 호스트 경로는 서버로 오지 않는다
 */
export type RunnerLive = {
  tokenId: string;
  label: string;
  runnerVersion: string;
  sdkVersion: string;
  bundleSha256: string | null;
  browse: boolean;
  roots: Array<{ id: string; label: string }>;
  programs: RunnerProgramStatus[];
  connectedAt: string;
};

/** hello 를 마친 러너 연결 하나 — 토큰 하나에 하나만 산다(러너 스펙 5장) */
export type Runner = {
  readonly socket: RunnerSocket;
  readonly tokenId: string;
  readonly label: string;
  readonly hello: RunnerHello;
  /** 모르는 값은 버렸다 — 새 러너가 옛 서버에 붙을 수 있게(스레드 스펙 R1) */
  readonly capabilities: RunnerCapability[];
  /** 같은 프로그램을 두 번 알렸으면 앞의 것만 */
  readonly programs: RunnerProgramStatus[];
  readonly connectedAt: string;
};

export function createRunner(input: {
  socket: RunnerSocket;
  tokenId: string;
  label: string;
  hello: RunnerHello;
  connectedAt: string;
}): Runner {
  const seen = new Set<RunnerProgram>();
  const programs = input.hello.programs.filter((p) => !seen.has(p.program) && seen.add(p.program));
  const capabilities = input.hello.capabilities.flatMap((c) => RunnerCapability.safeParse(c).data ?? []);
  return { ...input, programs, capabilities };
}

export function runnerLive(runner: Runner): RunnerLive {
  return {
    tokenId: runner.tokenId,
    label: runner.label,
    runnerVersion: runner.hello.runnerVersion,
    sdkVersion: runner.hello.sdkVersion,
    // 모양이 틀린 값은 「같은 빌드」를 가를 수 없다 — 없는 것으로 본다
    bundleSha256: Sha256Hex.safeParse(runner.hello.bundleSha256).data ?? null,
    browse: runner.hello.browse,
    roots: runner.hello.roots.map((r) => ({ id: r.id, label: r.label })),
    programs: runner.programs.map((p) => structuredClone(p)),
    connectedAt: runner.connectedAt,
  };
}

/**
 * 붙은 러너들. 러너 에이전트는 만들 때부터 러너 토큰에 묶이므로(러너 일반화 계획 판정 PR9) 런은 그 토큰의 러너로만 간다 —
 * 에이전트를 러너 사이에 배정하는 일이 없다
 */
export class RunnerRegistry {
  // 삽입 순서 = hello 순서
  readonly #runners = new Map<string, Runner>();

  get size(): number {
    return this.#runners.size;
  }

  add(runner: Runner): void {
    this.#runners.set(runner.socket.id, runner);
  }

  /** 같은 토큰의 새 연결이 옛 연결의 자리(hello 순서)를 잇는다 — 목록 순서가 재접속 한 번에 흔들리지 않게 */
  replace(previous: Runner, runner: Runner): void {
    const entries = [...this.#runners].map(([id, r]): [string, Runner] =>
      r === previous ? [runner.socket.id, runner] : [id, r],
    );
    this.#runners.clear();
    for (const [id, r] of entries) this.#runners.set(id, r);
  }

  /** 빠진 러너. 이미 없으면 undefined — 교체와 disconnect 가 같은 러너를 두 번 뺄 수 있다 */
  remove(socketId: string): Runner | undefined {
    const runner = this.#runners.get(socketId);
    this.#runners.delete(socketId);
    return runner;
  }

  get(socketId: string): Runner | undefined {
    return this.#runners.get(socketId);
  }

  byToken(tokenId: string): Runner | undefined {
    for (const runner of this.#runners.values()) if (runner.tokenId === tokenId) return runner;
    return undefined;
  }

  all(): Runner[] {
    return [...this.#runners.values()];
  }

  connections(): RunnerConnection[] {
    return this.all().map((runner) => {
      const live = runnerLive(runner);
      return {
        tokenId: live.tokenId,
        label: live.label,
        runnerVersion: live.runnerVersion,
        sdkVersion: live.sdkVersion,
        claudeCodeVersion: runner.programs.find((p) => p.program === "claude")?.version ?? "",
        bundleSha256: live.bundleSha256,
        capabilities: [...runner.capabilities],
        connectedAt: live.connectedAt,
      };
    });
  }
}
