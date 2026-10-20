import proxyaddr from "@fastify/proxy-addr";
import ipaddr from "ipaddr.js";

/**
 * 믿는 리버스 프록시(TRUST_PROXY). 비었거나 false 면 아무도 믿지 않아 클라이언트 주소는 연결 주소, IP·CIDR 쉼표 목록이면 그 주소에서
 * 온 연결만 X-Forwarded-For 를 읽는다 — 오른쪽부터 믿는 주소를 건너뛴 첫 값(Fastify trustProxy 와 같은 @fastify/proxy-addr 판정).
 * 레이트리밋·브리지 실패 카운터가 이 주소로 걸리므로 XFF 첫 값을 그대로 믿으면 클라이언트가 꾸민 값으로 상한을 피한다
 */
export type TrustProxy = { kind: "none" } | { kind: "list"; entries: string[] };

/** proxy-addr 이 받아 주는 이름 붙은 범위 — 사설망 전체를 믿게 되므로(같은 네트워크의 아무 컨테이너가 XFF 를 꾸민다) 받지 않는다 */
const NAMED_RANGES = new Set(["loopback", "linklocal", "uniquelocal"]);

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "false") return { kind: "none" };
  if (value === "true") {
    throw new Error(
      "TRUST_PROXY=true 는 받지 않는다 — 프록시 주소를 IP·CIDR 로(예: 172.18.0.5/32). 모두 믿으면 아무나 X-Forwarded-For 를 꾸민다",
    );
  }
  const entries = value.split(",").map((e) => e.trim());
  for (const entry of entries) {
    if (entry === "" || NAMED_RANGES.has(entry))
      throw new Error(`TRUST_PROXY 의 「${entry}」 는 IP·CIDR 가 아니다`);
    try {
      // /0 은 여기서 「invalid range」 로 던진다
      proxyaddr.compile([entry]);
    } catch {
      throw new Error(`TRUST_PROXY 의 「${entry}」 는 IP·CIDR 가 아니다`);
    }
  }
  if (trustsEveryone(entries)) {
    throw new Error(
      `TRUST_PROXY 가 모든 주소를 믿는다(${entries.join(",")}) — 아무나 X-Forwarded-For 를 꾸민다. 프록시 주소를 /32 로`,
    );
  }
  return { kind: "list", entries };
}

type Span = [start: bigint, end: bigint];

const V4_BITS = 32;
const V6_BITS = 128;
const V4_END = (1n << 32n) - 1n;
const V6_END = (1n << 128n) - 1n;
/** ::ffff:0:0/96 — proxy-addr 은 IPv6 범위에 IPv4 연결을 이 꼴로 바꿔 견준다 */
const MAPPED_BASE = 0xffffn << 32n;

const toBig = (ip: ipaddr.IPv4 | ipaddr.IPv6): bigint =>
  ip.toByteArray().reduce((n, b) => (n << 8n) | BigInt(b), 0n);

function spanOf(base: bigint, prefix: number, bits: number): Span {
  const size = 1n << BigInt(bits - prefix);
  const start = (base >> BigInt(bits - prefix)) << BigInt(bits - prefix);
  return [start, start + size - 1n];
}

/** 겹치거나 맞닿은 구간을 이어 [0, end] 한 구간이 되는가 */
function covers(spans: Span[], end: bigint): boolean {
  let reach = -1n;
  for (const [s, e] of [...spans].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (s > reach + 1n) return false;
    if (e > reach) reach = e;
  }
  return reach >= end;
}

/**
 * 「모든 주소」 판정 — /0 만 막으면 같은 뜻의 다른 표기(::ffff:0:0/96, ::/1, 0.0.0.0/1 + 128.0.0.0/1 …)가 지나간다.
 * 그래서 표기가 아니라 proxy-addr 이 실제로 믿게 되는 주소 집합을 본다: 항목마다 proxy-addr parseipNotation 과 같은 규칙(같은
 * ipaddr.js — 슬래시 없는 ::ffff:a.b.c.d 는 IPv4, IPv4 넷마스크 표기 허용)으로 범위를 구하고, IPv6 범위는 IPv4 연결이
 * ::ffff:a.b.c.d 로 바뀌어 견줘지므로 ::ffff:0:0/96 과 겹치는 만큼 IPv4 범위로도 센다. 거절은 둘 중 하나:
 * IPv4 범위의 합이 IPv4 공간 전체를 덮거나, IPv6 범위의 합이 ::ffff:0:0/96 을 뺀 IPv6 공간 전체를 덮는다(그 구간의 연결은
 * IPv4 로 오므로 IPv6 클라이언트는 그 밖에만 있다). 전체에 못 미치는 넓은 범위(예: 0.0.0.0/1 하나)는 막지 않는다 —
 * 「모든 주소」가 아니라 잘못 넓힌 신뢰이고, 문서가 /32 를 요구한다
 */
function trustsEveryone(entries: string[]): boolean {
  const v4: Span[] = [];
  // IPv4-mapped 구간은 IPv6 클라이언트가 쓰지 않으니 덮인 것으로 둔다
  const v6: Span[] = [[MAPPED_BASE, MAPPED_BASE + V4_END]];
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    let ip = ipaddr.parse(slash === -1 ? entry : entry.slice(0, slash));
    if (slash === -1 && ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    const bits = ip.kind() === "ipv4" ? V4_BITS : V6_BITS;
    const raw = slash === -1 ? String(bits) : entry.slice(slash + 1);
    const prefix = /^[0-9]+$/.test(raw)
      ? Number.parseInt(raw, 10)
      : (ipaddr.IPv4.parse(raw).prefixLengthFromSubnetMask() ?? 0);
    const span = spanOf(toBig(ip), prefix, bits);
    if (bits === V4_BITS) {
      v4.push(span);
      continue;
    }
    v6.push(span);
    // ::ffff:0:0/96 과의 교집합 → IPv4 구간
    const lo = span[0] > MAPPED_BASE ? span[0] : MAPPED_BASE;
    const hi = span[1] < MAPPED_BASE + V4_END ? span[1] : MAPPED_BASE + V4_END;
    if (lo <= hi) v4.push([lo - MAPPED_BASE, hi - MAPPED_BASE]);
  }
  return covers(v4, V4_END) || covers(v6, V6_END);
}

/** Fastify({ trustProxy }) 값 — 문자열이면 Fastify 가 쉼표로 나눠 같은 proxy-addr compile 에 넘긴다 */
export function fastifyTrustProxy(t: TrustProxy): boolean | string {
  return t.kind === "none" ? false : t.entries.join(",");
}

/** 소켓 핸드셰이크(브리지·러너·wire)의 클라이언트 주소 — REST request.ip 와 같은 판정 */
export function clientAddressOf(
  t: TrustProxy,
): (h: { address: string; headers: Record<string, string | string[] | undefined> }) => string {
  if (t.kind === "none") return (h) => h.address;
  const trust = proxyaddr.compile(t.entries);
  return (h) =>
    proxyaddr(
      { socket: { remoteAddress: h.address }, headers: h.headers } as unknown as Parameters<
        typeof proxyaddr
      >[0],
      trust,
    );
}
