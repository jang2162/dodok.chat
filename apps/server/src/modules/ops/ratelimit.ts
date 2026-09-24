const MINUTE_MS = 60_000;

/** 분당 perMin 속도로 차고 burst 까지 쌓이는 토큰 버킷 — wire 소켓마다 하나씩 */
export class TokenBucket {
  readonly #perMs: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #at: number;

  constructor(opts: { perMin: number; burst: number; now?: () => number }) {
    this.#perMs = opts.perMin / MINUTE_MS;
    this.#burst = opts.burst;
    this.#now = opts.now ?? Date.now;
    this.#tokens = opts.burst;
    this.#at = this.#now();
  }

  take(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#at) * this.#perMs);
    this.#at = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** 키별 고정 창(분당 perMin) — REST. 기억하는 키가 maxKeys 를 넘으면 창을 가장 먼저 연 키부터 버린다 */
export class KeyedLimiter {
  readonly #perMin: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  // 새 창을 열 때만 다시 넣는다 — 삽입 순서가 곧 창을 연 순서다
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(opts: { perMin: number; maxKeys?: number; now?: () => number }) {
    this.#perMin = opts.perMin;
    this.#maxKeys = opts.maxKeys ?? 10_000;
    this.#now = opts.now ?? Date.now;
  }

  take(key: string): boolean {
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window && now - window.start < MINUTE_MS) {
      if (window.count >= this.#perMin) return false;
      window.count += 1;
      return true;
    }
    this.#windows.delete(key);
    this.#windows.set(key, { start: now, count: 1 });
    while (this.#windows.size > this.#maxKeys) {
      const oldest = this.#windows.keys().next().value as string;
      this.#windows.delete(oldest);
    }
    return true;
  }
}
