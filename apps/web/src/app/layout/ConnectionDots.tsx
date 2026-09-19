import type { AdapterStatus } from "@dodok/shared";
import { useAdapterStatus } from "@/api/queries";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

type Tone = "ok" | "warn" | "down" | "unknown";
type DotState = { label: string; tone: Tone };

const TONE: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

const GATEWAY: Record<AdapterStatus["gateway"], DotState> = {
  connected: { label: "Gateway 연결됨", tone: "ok" },
  reconnecting: { label: "Gateway 다시 연결 중", tone: "warn" },
  down: { label: "Gateway 끊김", tone: "down" },
};
const BRIDGE: Record<AdapterStatus["bridge"], DotState> = {
  connected: { label: "플러그인 연결됨", tone: "ok" },
  down: { label: "플러그인 끊김", tone: "down" },
};

/**
 * 사이드바 하단 연결 상태 점 두 개(스펙 6.5) — OpenClaw Gateway, 그 안의 dodok 채널 플러그인.
 * 값은 `["adapter"]` 캐시(REST 로 불러오고 wire `adapter.status` 가 고친다). 마우스를 올리거나 초점을 주면 설명
 */
export function ConnectionDots() {
  const { data } = useAdapterStatus();
  return (
    <div className="flex items-center gap-2">
      <Dot
        {...(data ? GATEWAY[data.gateway] : { label: "Gateway 상태 모름", tone: "unknown" })}
        hint="에이전트를 실행하는 OpenClaw Gateway"
      />
      <Dot
        {...(data ? BRIDGE[data.bridge] : { label: "플러그인 상태 모름", tone: "unknown" })}
        hint="Gateway 안에서 에이전트 답을 서버로 보내는 dodok 플러그인"
      />
    </div>
  );
}

function Dot({ label, tone, hint }: DotState & { hint: string }) {
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
      </TooltipContent>
    </Tooltip>
  );
}
