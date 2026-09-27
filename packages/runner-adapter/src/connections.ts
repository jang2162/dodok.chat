import {
  RunnerCapability,
  type RunnerAgent,
  type RunnerClientToServerEvents,
  type RunnerConnection,
  type RunnerHello,
  type RunnerServerToClientEvents,
  Sha256Hex,
} from "@dodok/shared";
import type { Socket } from "socket.io";

export type RunnerSocket = Socket<RunnerClientToServerEvents, RunnerServerToClientEvents>;

/** hello 를 마친 러너 연결 하나 — 토큰 하나에 하나만 산다(러너 스펙 5장) */
export type Runner = {
  readonly socket: RunnerSocket;
  readonly tokenId: string;
  readonly label: string;
  readonly hello: RunnerHello;
  /** 모르는 값은 버렸다 — 새 러너가 옛 서버에 붙을 수 있게(스레드 스펙 R1) */
  readonly capabilities: RunnerCapability[];
  /** 같은 id 를 두 번 알렸으면 앞의 것만 */
  readonly agents: RunnerAgent[];
  readonly connectedAt: string;
};

export function createRunner(input: {
  socket: RunnerSocket;
  tokenId: string;
  label: string;
  hello: RunnerHello;
  connectedAt: string;
}): Runner {
  const seen = new Set<string>();
  const agents = input.hello.agents.filter((a) => !seen.has(a.id) && seen.add(a.id));
  const capabilities = input.hello.capabilities.flatMap((c) => RunnerCapability.safeParse(c).data ?? []);
  return { ...input, agents, capabilities };
}

/**
 * 붙은 러너들과 에이전트 배정. 에이전트는 그 id 를 **먼저 hello 한** 러너가 맡는다 — 뒤 러너의 같은 id 는 「충돌」이다.
 * 배정을 따로 저장하지 않고 hello 순서에서 매번 계산하므로, 앞 러너가 빠지면 뒤 러너가 저절로 이어받는다(Review Focus 3)
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

  /**
   * 같은 토큰의 새 연결이 옛 연결의 자리(hello 순서)를 잇는다 — 순간 재접속 한 번에 충돌해 있던 뒤 러너가 에이전트를 가져가면
   * 세션 전사가 없는 머신으로 대화가 넘어간다
   */
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

  owner(agentId: string): Runner | undefined {
    for (const runner of this.#runners.values()) {
      if (runner.agents.some((a) => a.id === agentId)) return runner;
    }
    return undefined;
  }

  conflicts(runner: Runner): string[] {
    return runner.agents.filter((a) => this.owner(a.id) !== runner).map((a) => a.id);
  }

  connections(): RunnerConnection[] {
    return this.all().map((runner) => ({
      tokenId: runner.tokenId,
      label: runner.label,
      runnerVersion: runner.hello.runnerVersion,
      sdkVersion: runner.hello.sdkVersion,
      claudeCodeVersion: runner.hello.claudeCodeVersion,
      // 모양이 틀린 값은 「같은 빌드」를 가를 수 없다 — 없는 것으로 본다
      bundleSha256: Sha256Hex.safeParse(runner.hello.bundleSha256).data ?? null,
      capabilities: [...runner.capabilities],
      connectedAt: runner.connectedAt,
      agents: runner.agents.map((a) => ({ ...a, conflict: this.owner(a.id) !== runner })),
    }));
  }
}
