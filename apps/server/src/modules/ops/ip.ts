import { isIPv4, isIPv6 } from "node:net";

/**
 * 사건·로그에 남길 주소 조각(스펙 8장 — IP 전체는 남기지 않는다). IPv4 는 /24, IPv6 는 /48,
 * IPv4 사상 주소(::ffff:a.b.c.d·::ffff:hhhh:hhhh)는 IPv4 규칙. 알아볼 수 없으면 "unknown"
 */
export function ipPrefix(ip: string): string {
  const address = ip.trim().replace(/%.*$/, ""); // IPv6 zone id(fe80::1%en0)
  if (isIPv4(address)) return v4Prefix(address.split(".").map(Number));
  if (!isIPv6(address)) return "unknown";
  const groups = expandV6(address);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return v4Prefix([hi >> 8, hi & 0xff, lo >> 8]);
  }
  return `${compressV6([...groups.slice(0, 3), 0, 0, 0, 0, 0])}/48`;
}

function v4Prefix(octets: number[]): string {
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/** isIPv6 를 통과한 주소를 16비트 여덟 칸으로 — 끝의 점 표기 IPv4 는 두 칸으로 바꾼다 */
function expandV6(address: string): number[] {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}

/** RFC 5952 표기 — 가장 긴(같으면 앞의) 두 칸 이상 0 연속을 :: 로 줄인다 */
function compressV6(groups: number[]): string {
  let best = { start: -1, len: 0 };
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(":");
  return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.len).join(":")}`;
}
