import type { OpenClawGatewayStatus } from "@dodok/shared";
import { useAdapterStatus } from "@/api/queries";
import { cn } from "@/lib/utils";
import { useWireStatus } from "@/realtime/wire";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

type Tone = "ok" | "warn" | "down" | "unknown";
type DotState = { label: string; tone: Tone; hint: string; lines?: string[] };

const TONE: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

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
 * 사이드바 하단 연결 상태 점 두 개(스펙 6.5) — OpenClaw Gateway, 그 안의 dodok 채널 플러그인. 둘 다 Gateway 들을 모은 값이고
 * 마우스를 올리거나 초점을 주면 Gateway 별 상태를 보인다. 값은 `["adapter"]` 캐시(REST 로 불러오고 wire `adapter.status` 가 고친다).
 * wire 가 끊기면 `adapter.status` 가 더는 오지 않아 마지막 값이 남는다 — 초록으로 두면 틀린 정보라
 * 「알 수 없음」(회색)으로 바꾼다(브라우저 검증 결함 6). 살아 있는 값의 유일한 출처가 wire 이므로 기준도 wire 다
 */
export function ConnectionDots() {
  const { data: adapter } = useAdapterStatus();
  // 점 두 개는 OpenClaw 어댑터의 것 — 캐시에는 그 상태만 담긴다(handlers.ts)
  const data = adapter?.provider === "openclaw" ? adapter : undefined;
  const live = useWireStatus((s) => s.status) === "connected";
  const unknown = (what: string): DotState => ({
    label: `${what} 상태 모름`,
    tone: "unknown",
    hint: UNKNOWN_HINT,
  });
  return (
    <div className="flex items-center gap-2">
      <Dot {...(data && live ? gatewayDot(data.gateways) : unknown("Gateway"))} />
      <Dot {...(data && live ? bridgeDot(data.gateways) : unknown("플러그인"))} />
    </div>
  );
}

function Dot({ label, tone, hint, lines = [] }: DotState) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          className={cn(
            "size-2.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
            TONE[tone],
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-medium">{label}</p>
        <p className="opacity-80">{hint}</p>
        {lines.length > 0 && (
          <ul className="mt-1">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
