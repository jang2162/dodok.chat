/** 브리지 클라이언트의 순수 부분: 재연결 지연 계산과 연결 전 아웃바운드 큐. */

export type BackoffOptions = {
  baseMs: number;
  maxMs: number;
  /** 0~1. 지연에 ±jitter 비율을 곱해 흔든다 */
  jitter: number;
};

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, jitter: 0.2 };

export function backoffDelayMs(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  const spread = exponential * opts.jitter * (random() * 2 - 1);
  return Math.round(Math.min(opts.maxMs * (1 + opts.jitter), Math.max(0, exponential + spread)));
}

export class OutboundQueue<T> {
  readonly #items: T[] = [];
  readonly #max: number;

  constructor(opts: { max: number }) {
    this.#max = opts.max;
  }

  get depth(): number {
    return this.#items.length;
  }

  /** 넣고, 상한을 넘어 버린 가장 오래된 항목이 있으면 돌려준다 */
  push(item: T): T | undefined {
    this.#items.push(item);
    return this.#items.length > this.#max ? this.#items.shift() : undefined;
  }

  /** 앞에서부터 보낸다. 실패하면 그 항목을 남긴 채 에러를 던진다 */
  async flush(send: (item: T) => Promise<void>): Promise<void> {
    while (this.#items.length > 0) {
      const head = this.#items[0] as T;
      await send(head);
      this.#items.shift();
    }
  }

  drain(): T[] {
    return this.#items.splice(0, this.#items.length);
  }
}
