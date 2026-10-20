import proxyaddr from "@fastify/proxy-addr";

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
  return { kind: "list", entries };
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
