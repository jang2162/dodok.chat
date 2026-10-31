/**
 * 브리지 인증 실패 카운터(운영 보강 스펙 4.1). 핸드셰이크와 서버의 `/bridge/attachments` 가 같은 인스턴스를 쓰고,
 * 러너의 `/runner` 핸드셰이크·`/runner/attachments` 도 같은 인스턴스를 쓴다(러너 스펙 5장 — 그래서 어댑터 공용 자리에 둔다).
 * 실패만 센다 — 한 주소가 windowMs 안에 maxFailures 번 틀리면 blockMs 동안 토큰을 보지 않고 거절한다.
 * 성공은 카운터를 건드리지 않는다(그런 메서드가 없다): 막힌 주소의 정상 토큰도 blockMs 동안은 거절되고, 그 뒤에는 저절로 풀린다
 * — 브리지·러너 쓰임새의 규칙이다. 웹훅(`/hooks/<token>`)은 따로 둔 인스턴스를 쓰고 막힘을 받지 못할 토큰에만 건다: 켜진 웹훅의
 * 토큰은 막힌 주소에서도 지나간다(발신 주소를 나눠 쓰는 GitHub 같은 서비스에서 남의 틀린 토큰이 정상 웹훅을 막지 않게 —
 * 서버 automations/webhook.ts)
 */
type Entry = { windowStart: number; failures: number; blockedUntil?: number };

export class BridgeAuthGuard {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #blockMs: number;
  readonly #maxAddresses: number;
  // 실패할 때마다 다시 넣는다 — 삽입 순서가 곧 마지막 실패 시각 순서다
  readonly #entries = new Map<string, Entry>();

  constructor(
    opts: { maxFailures?: number; windowMs?: number; blockMs?: number; maxAddresses?: number } = {},
  ) {
    this.#maxFailures = opts.maxFailures ?? 10;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#blockMs = opts.blockMs ?? 60_000;
    this.#maxAddresses = opts.maxAddresses ?? 1024;
  }

  isBlocked(address: string, nowMs: number): boolean {
    const blockedUntil = this.#entries.get(address)?.blockedUntil;
    return blockedUntil !== undefined && nowMs < blockedUntil;
  }

  /** 실패 하나를 센다. 이번 실패로 막히기 시작했으면 true */
  fail(address: string, nowMs: number): boolean {
    let entry = this.#entries.get(address);
    if (entry?.blockedUntil !== undefined && nowMs < entry.blockedUntil) return false;
    // 막힘이 끝났거나 창이 지났으면 처음부터 센다
    if (!entry || entry.blockedUntil !== undefined || nowMs - entry.windowStart >= this.#windowMs)
      entry = { windowStart: nowMs, failures: 0 };
    entry.failures += 1;
    const blocked = entry.failures >= this.#maxFailures;
    if (blocked) entry.blockedUntil = nowMs + this.#blockMs;
    this.#entries.delete(address);
    this.#entries.set(address, entry);
    while (this.#entries.size > this.#maxAddresses) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return blocked;
  }
}
