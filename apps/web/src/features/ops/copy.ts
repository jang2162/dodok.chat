import type { OpsEvent, OpsEventKind, OpsSeverity } from "@dodok/shared";

/** 끊김 사건 — 줄이 열려 있는 동안이 끊긴 동안이다(스펙 3.1) */
const DOWN: ReadonlySet<OpsEventKind> = new Set(["gateway_down", "plugin_down", "runner_down"]);

type Detail = OpsEvent["detail"];
const str = (v: Detail[string] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: Detail[string] | undefined): number | undefined => (typeof v === "number" ? v : undefined);

/** 채널 id → 이름. 못 찾으면 undefined(캐시에 없거나 지운 채널) */
export type ChannelNameOf = (channelId: string) => string | undefined;
/** Gateway id → 지금 이름. 못 찾으면 undefined(지운 Gateway·목록을 아직 못 받음) */
export type GatewayNameOf = (gatewayId: string) => string | undefined;

/**
 * Gateway 사건(key `gateway:<id>`·`gateway:<id>:<version>`, 멀티 Gateway 스펙 「운영」 절)의 Gateway 이름. 지금 이름을 key 의 id 로 먼저 찾는다 —
 * 사건 detail 의 `gatewayName` 은 줄을 연 때의 이름이라 그 뒤 이름을 바꾸면 옛 이름이다. 못 찾으면(지운 Gateway) detail 의 이름
 */
function gatewayNameOf(e: OpsEvent, nameOf: GatewayNameOf | undefined): string | undefined {
  const id = /^gateway:([^:]+)/.exec(e.key)?.[1];
  return (id === undefined ? undefined : nameOf?.(id)) ?? str(e.detail.gatewayName);
}

/** Gateway 이름이 있을 때의 문구 — key 로도 detail 로도 이름을 못 찾는 줄은 TITLE 의 문구 그대로 */
const NAMED: Partial<Record<OpsEventKind, (e: OpsEvent, name: string) => string>> = {
  gateway_down: (_, n) => `Gateway 「${n}」 연결 끊김`,
  plugin_down: (_, n) => `Gateway 「${n}」 플러그인 연결 끊김`,
  gateway_version_changed: (e, n) =>
    `Gateway 「${n}」 버전이 바뀜 (${str(e.detail.from) ?? "?"} → ${str(e.detail.to) ?? "?"})`,
  gateway_version_untested: (e, n) => `Gateway 「${n}」 검증 안 된 버전 (${str(e.detail.version) ?? "?"})`,
};

/**
 * 런 한도 사건의 범위 — key 가 `workspace` 면 워크스페이스, `channel:<id>` 면 그 채널(이름을 찾으면 「#이름」).
 * 모르는 key 면 붙이지 않는다
 */
function limitScope(key: string, nameOf: ChannelNameOf | undefined): string {
  if (key === "workspace") return " (워크스페이스)";
  const channel = /^channel:(.+)$/.exec(key)?.[1];
  if (channel === undefined) return "";
  const name = nameOf?.(channel);
  return name === undefined ? " (채널)" : ` (#${name})`;
}

/** kind → 고정 문구(계획 태스크 6). detail 에는 id·코드·수치와 Gateway 이름만 있다 — 본문·경로는 애초에 없다(스펙 8장) */
const TITLE: Record<OpsEventKind, (e: OpsEvent, nameOf: ChannelNameOf | undefined) => string> = {
  gateway_down: () => "Gateway 연결 끊김",
  plugin_down: () => "플러그인 연결 끊김",
  runner_down: () => "러너 연결 끊김",
  gateway_version_changed: (e) =>
    `Gateway 버전이 바뀜 (${str(e.detail.from) ?? "?"} → ${str(e.detail.to) ?? "?"})`,
  gateway_version_untested: (e) => `검증 안 된 Gateway 버전 (${str(e.detail.version) ?? "?"})`,
  run_limit: (e, nameOf) => `런 한도 도달${limitScope(e.key, nameOf)}`,
  run_failed: (e) => {
    const code = str(e.detail.code);
    return code ? `런 실패 (${code})` : "런 실패";
  },
  ratelimit: () => "요청 제한 발동",
  bridge_auth_blocked: () => "브리지 인증 실패가 반복돼 주소를 막음",
  crash_rejection: () => "처리 안 된 오류",
  crash_exception: () => "서버가 오류로 종료됨",
  unclean_shutdown: () => "직전 종료가 비정상",
  disk_low: () => "디스크 여유 부족",
  invite_accept_failed: () => "초대 수락 실패",
  member_deactivate_failed: () => "멤버 비활성화 실패",
};

export const SEVERITY_LABEL: Record<OpsSeverity, string> = { info: "정보", warn: "주의", error: "오류" };

/** 끊긴 시간 — 분 단위 반올림(최소 1분, 끊김 사건은 임계 60초를 넘겨야 열린다), 한 시간부터는 「h시간 m분」 */
export function formatDowntime(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/**
 * 사건 한 줄 = 고정 문구 + 끊긴 시간 + 「×n」. 끊김이 닫혔으면 실제 끊긴 시간(`detail.downMs`), 열려 있으면 「(지금도)」.
 * `nameOf` 는 런 한도 줄의 채널 이름을, `gatewayOf` 는 Gateway 사건의 지금 Gateway 이름을 찾는다
 */
export function eventText(e: OpsEvent, nameOf?: ChannelNameOf, gatewayOf?: GatewayNameOf): string {
  // 응답은 파싱하지 않으므로 이 웹보다 새 서버가 늘린 kind 가 온다(PWA 는 새 버전을 토스트로만 받는다) — 그 줄만 일반 문구
  const title = TITLE[e.kind] as ((e: OpsEvent, nameOf: ChannelNameOf | undefined) => string) | undefined;
  const named = NAMED[e.kind];
  const gateway = named ? gatewayNameOf(e, gatewayOf) : undefined;
  let text =
    named && gateway !== undefined
      ? named(e, gateway)
      : title
        ? title(e, nameOf)
        : `알 수 없는 사건 (${e.kind})`;
  if (DOWN.has(e.kind)) {
    const downMs = num(e.detail.downMs);
    text +=
      e.resolvedAt === undefined
        ? " (지금도)"
        : downMs === undefined
          ? ""
          : ` (${formatDowntime(downMs)} 동안)`;
  }
  return e.count > 1 ? `${text} ×${e.count}` : text;
}

/**
 * 줄에 보일 시각(epoch ms). 끊김은 끊긴 때 — 줄은 임계(`detail.thresholdMs`)를 넘긴 뒤에 열리므로 `firstAt` 에서 그만큼 뺀다.
 * 그 밖은 마지막으로 일어난 때(`lastAt`)
 */
export function eventTime(e: OpsEvent): number {
  if (DOWN.has(e.kind)) return Date.parse(e.firstAt) - (num(e.detail.thresholdMs) ?? 0);
  return Date.parse(e.lastAt);
}
