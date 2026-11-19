import type { OpenClawGatewayStatus } from "@dodok/shared";
import { TriangleAlertIcon } from "lucide-react";
import { useAdapterStatus } from "@/api/queries";
import { cn } from "@/lib/utils";
import { useWireStatus } from "@/realtime/wire";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

type Tone = "ok" | "warn" | "down" | "unknown";
export type DotState = { label: string; tone: Tone; hint: string; lines?: string[] };

/** 초록·회색은 점, 노랑·빨강은 경고 삼각형 — 색만으로 구분하지 않게 모양도 다르다(UI 점검 스펙 U1) */
const DOT_TONE = { ok: "bg-success", unknown: "bg-muted-foreground/40" } as const;
const ICON_TONE = { warn: "text-warning", down: "text-destructive" } as const;

const GATEWAY_HINT = "에이전트를 실행하는 OpenClaw Gateway";
const BRIDGE_HINT = "Gateway 안에서 에이전트 답을 서버로 보내는 dodok 플러그인";
const NONE_HINT = "켜진 OpenClaw Gateway 가 없습니다";
const UNKNOWN_HINT = "서버에 연결되지 않아 지금 상태를 알 수 없습니다";

const GATEWAY_TEXT: Record<OpenClawGatewayStatus["gateway"], string> = {
  connected: "연결됨",
  reconnecting: "다시 연결 중",
  down: "끊김",
  disabled: "꺼짐",
};
const BRIDGE_TEXT: Record<OpenClawGatewayStatus["bridge"], string> = { connected: "연결됨", down: "끊김" };

/**
 * Gateway 점 — 켜진 Gateway 를 하나로 모은다(멀티 Gateway 스펙 「웹」 절): 모두 연결됨 초록, 일부 끊김 노랑, 모두 끊김 빨강, 없음 회색.
 * 붙은 것이 없어도 다시 붙는 중인 것이 있으면 노랑이다 — Gateway 가 하나일 때의 「다시 연결 중」을 지킨다
 */
function gatewayDot(gateways: readonly OpenClawGatewayStatus[]): DotState {
  const lines = gateways.map((g) => `${g.name} — ${GATEWAY_TEXT[g.gateway]}`);
  const on = gateways.filter((g) => g.enabled);
  const connected = on.filter((g) => g.gateway === "connected").length;
  const base = { hint: GATEWAY_HINT, lines };
  if (on.length === 0) return { label: "Gateway 없음", tone: "unknown", hint: NONE_HINT, lines };
  if (connected === on.length) return { ...base, label: "Gateway 연결됨", tone: "ok" };
  if (connected > 0) return { ...base, label: "Gateway 일부 끊김", tone: "warn" };
  if (on.some((g) => g.gateway === "reconnecting"))
    return { ...base, label: "Gateway 다시 연결 중", tone: "warn" };
  return { ...base, label: "Gateway 끊김", tone: "down" };
}

/** 플러그인 점 — 켜진 Gateway 마다의 플러그인을 Gateway 점과 같은 규칙으로 모은다 */
function bridgeDot(gateways: readonly OpenClawGatewayStatus[]): DotState {
  const lines = gateways.map((g) => `${g.name} — ${g.enabled ? BRIDGE_TEXT[g.bridge] : "꺼짐"}`);
  const on = gateways.filter((g) => g.enabled);
  const connected = on.filter((g) => g.bridge === "connected").length;
  const base = { hint: BRIDGE_HINT, lines };
  if (on.length === 0) return { label: "플러그인 없음", tone: "unknown", hint: NONE_HINT, lines };
  if (connected === on.length) return { ...base, label: "플러그인 연결됨", tone: "ok" };
  if (connected > 0) return { ...base, label: "플러그인 일부 끊김", tone: "warn" };
  return { ...base, label: "플러그인 끊김", tone: "down" };
}

/**
 * 사이드바에 보이는 한 줄(UI 점검 스펙 U1). 모두 연결이면 「연결됨」, 문제가 있으면 Gateway 문제를 플러그인 문제보다 먼저 —
 * 켜진 것 중 하나만 문제면 그 이름(「<이름> 끊김」·「<이름> 다시 연결 중」·「<이름> 플러그인 끊김」), 여럿이면 모은 점 라벨.
 * 상태 모름·Gateway 없음은 회색이다. 색(tone)은 보이는 글을 낸 쪽의 점을 따른다
 */
export function connectionSummary(
  gateway: DotState,
  bridge: DotState,
  gateways: readonly OpenClawGatewayStatus[],
): { text: string; tone: Tone } {
  if (gateway.tone === "unknown")
    return { text: gateway.label === "Gateway 없음" ? "Gateway 없음" : "상태 모름", tone: "unknown" };
  const on = gateways.filter((g) => g.enabled);
  if (gateway.tone !== "ok") {
    const bad = on.filter((g) => g.gateway !== "connected");
    const one = bad.length === 1 ? bad[0] : undefined;
    return {
      text: one ? `${one.name} ${one.gateway === "reconnecting" ? "다시 연결 중" : "끊김"}` : gateway.label,
      tone: gateway.tone,
    };
  }
  if (bridge.tone !== "ok") {
    const bad = on.filter((g) => g.bridge !== "connected");
    const one = bad.length === 1 ? bad[0] : undefined;
    return { text: one ? `${one.name} 플러그인 끊김` : bridge.label, tone: bridge.tone };
  }
  return { text: "연결됨", tone: "ok" };
}

/**
 * 사이드바 하단 연결 상태 단추 하나(UI 점검 스펙 U1, 옛 점 두 개 — 스펙 6.5) — OpenClaw Gateway 와 그 안의 dodok 채널 플러그인을
 * 각각 Gateway 들로 모은 값을 한 줄로 보이고, 마우스를 올리거나 초점을 주면 둘의 Gateway 별 상태를 한 툴팁에 위아래로 보인다.
 * 접근 이름은 보이는 글로 시작하고 두 라벨을 잇는다(`<보이는 글> — Gateway: <라벨>, 플러그인: <라벨>` — 말로 부르는 이름이 화면 글과 맞게, WCAG 2.5.3). 값은 `["adapter"]` 캐시(REST 로 불러오고 wire `adapter.status` 가 고친다).
 * wire 가 끊기면 `adapter.status` 가 더는 오지 않아 마지막 값이 남는다 — 초록으로 두면 틀린 정보라
 * 「알 수 없음」(회색)으로 바꾼다(브라우저 검증 결함 6). 살아 있는 값의 유일한 출처가 wire 이므로 기준도 wire 다
 */
export function ConnectionDots() {
  const { data: adapter } = useAdapterStatus();
  // 연결 상태는 OpenClaw 어댑터의 것 — 캐시에는 그 상태만 담긴다(handlers.ts)
  const data = adapter?.provider === "openclaw" ? adapter : undefined;
  const live = useWireStatus((s) => s.status) === "connected";
  const unknown = (what: string): DotState => ({
    label: `${what} 상태 모름`,
    tone: "unknown",
    hint: UNKNOWN_HINT,
  });
  const gateways = data && live ? data.gateways : [];
  const gateway = data && live ? gatewayDot(gateways) : unknown("Gateway");
  const bridge = data && live ? bridgeDot(gateways) : unknown("플러그인");
  const { text, tone } = connectionSummary(gateway, bridge, gateways);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${text} — Gateway: ${gateway.label}, 플러그인: ${bridge.label}`}
          className="flex min-w-0 max-w-40 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          {tone === "ok" || tone === "unknown" ? (
            <span
              data-slot="status-dot"
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", DOT_TONE[tone])}
            />
          ) : (
            <TriangleAlertIcon aria-hidden className={cn("size-3.5 shrink-0", ICON_TONE[tone])} />
          )}
          <span className="truncate">{text}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex flex-col gap-2">
        <DotDetail {...gateway} />
        <DotDetail {...bridge} />
      </TooltipContent>
    </Tooltip>
  );
}

function DotDetail({ label, hint, lines = [] }: DotState) {
  return (
    <div>
      <p className="font-medium">{label}</p>
      <p className="opacity-80">{hint}</p>
      {lines.length > 0 && (
        <ul className="mt-1">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
