const MINUTE_MS = 60_000;

/**
 * 레이트리밋 기본 시계(ms) — 단조 시계. Date.now 는 NTP 스텝·VM 재개로 뒤로 갈 수 있고, 그만큼 창·버킷·막힘이 늘어난다.
 * 값의 기준점은 프로세스 시작 무렵의 벽시계라 절대 시각으로 쓰지 않는다(간격만 잰다)
 */
export const monotonicNow = (): number => performance.timeOrigin + performance.now();

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
    this.#now = opts.now ?? monotonicNow;
    this.#tokens = opts.burst;
    this.#at = this.#now();
  }

  take(): boolean {
    const now = this.#now();
    // 주입한 시계가 뒤로 가면 보충을 0 으로 — 음수 보충은 토큰 빚이 되어 역행한 만큼 막힌다
    this.#tokens = Math.min(this.#burst, this.#tokens + Math.max(0, now - this.#at) * this.#perMs);
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
    this.#now = opts.now ?? monotonicNow;
  }

  /** perMin 0 은 「모두 거절」이다 — 새 창도 상한을 지나므로 창마다 1개씩 새지 않는다. 테스트가 0 을 「상한 없음」으로 오해하지 않게 */
  take(key: string): boolean {
    const now = this.#now();
    let window = this.#windows.get(key);
    // 창이 지났거나, 주입한 시계가 창 시작보다 뒤로 갔으면 새 창 — 역행한 만큼 창이 늘지 않게
    if (!window || now - window.start >= MINUTE_MS || now < window.start) {
      window = { start: now, count: 0 };
      this.#windows.delete(key);
      this.#windows.set(key, window);
      while (this.#windows.size > this.#maxKeys) {
        const oldest = this.#windows.keys().next().value as string;
        this.#windows.delete(oldest);
      }
    }
    if (window.count >= this.#perMin) return false;
    window.count += 1;
    return true;
  }
}
