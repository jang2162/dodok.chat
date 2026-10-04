import type { OpsGatewayStatus, OpsSeverity } from "@dodok/shared";
import { CircleXIcon, InfoIcon, type LucideIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useChannels } from "@/api/queries";
import { Section } from "@/features/setup/sections";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { SEVERITY_LABEL, eventText, eventTime } from "./copy";
import { useAckEvents } from "./mutations";
import { useOpsEvents } from "./queries";

const WHEN = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

const ICON: Record<OpsSeverity, { Icon: LucideIcon; tone: string }> = {
  info: { Icon: InfoIcon, tone: "text-muted-foreground" },
  warn: { Icon: TriangleAlertIcon, tone: "text-warning" },
  error: { Icon: CircleXIcon, tone: "text-destructive" },
};

/** 필터 버튼 — 「모두」와 심각도 셋 */
const FILTERS: Array<{ value: OpsSeverity | undefined; label: string }> = [
  { value: undefined, label: "모두" },
  { value: "error", label: SEVERITY_LABEL.error },
  { value: "warn", label: SEVERITY_LABEL.warn },
  { value: "info", label: SEVERITY_LABEL.info },
];

/**
 * 최근 사건(스펙 7장): 심각도 필터, 「모두 확인」, 한 줄 = 고정 문구 + ×n + 시각(끊김은 끊긴 때), 「더 보기」로 다음 페이지.
 * 확인 안 한 줄은 굵게, 확인한 줄은 흐리게. 좁은 화면에서는 문구와 시각이 줄을 바꿔 흐른다.
 * 런 한도 줄의 채널 이름은 채널 목록 캐시에서(사이드바가 이미 받은 것), Gateway 사건의 이름은 운영 상태의 Gateway 목록에서 찾는다
 * (화면이 이미 받아 주기로 다시 받는 것 — 아직 없으면 사건이 남긴 이름)
 */
export function EventList({ gateways }: { gateways?: readonly Pick<OpsGatewayStatus, "id" | "name">[] }) {
  const [severity, setSeverity] = useState<OpsSeverity>();
  const events = useOpsEvents(severity);
  const ack = useAckEvents();
  const list = events.data?.pages.flatMap((p) => p.events);
  const channels = useChannels().data;
  const nameOf = useCallback((id: string) => channels?.find((c) => c.id === id)?.name, [channels]);
  const gatewayOf = useCallback((id: string) => gateways?.find((g) => g.id === id)?.name, [gateways]);
  return (
    <Section title="최근 사건">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="심각도" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.label}
              type="button"
              size="xs"
              variant={severity === f.value ? "secondary" : "ghost"}
              aria-pressed={severity === f.value}
              onClick={() => setSeverity(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={ack.isPending}
          onClick={() => ack.mutate()}
        >
          모두 확인
        </Button>
      </div>
      {list === undefined ? (
        events.isError ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">사건을 불러오지 못했습니다</p>
            <Button variant="outline" size="sm" onClick={() => void events.refetch()}>
              다시 시도
            </Button>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            불러오는 중…
          </p>
        )
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">사건이 없습니다</p>
      ) : (
        <ul aria-label="사건" className="flex flex-col divide-y">
          {list.map((e) => {
            // 모르는 severity(새 서버)면 정보 모양에 원문 라벨
            const { Icon, tone } = ICON[e.severity] ?? ICON.info;
            const at = new Date(eventTime(e));
            return (
              <li
                key={e.id}
                data-acked={e.ackedAt !== undefined || undefined}
                className="flex items-start gap-2 py-1.5 text-sm"
              >
                <Icon
                  role="img"
                  aria-label={SEVERITY_LABEL[e.severity] ?? e.severity}
                  aria-hidden={false}
                  className={cn("mt-0.5 size-4 shrink-0", tone)}
                />
                <div className="flex min-w-0 flex-1 flex-wrap gap-x-2">
                  <span
                    className={cn(
                      "min-w-0 break-words",
                      e.ackedAt === undefined ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {eventText(e, nameOf, gatewayOf)}
                  </span>
                  <time dateTime={at.toISOString()} className="text-xs text-muted-foreground">
                    {WHEN.format(at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {events.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          더 보기
        </Button>
      )}
    </Section>
  );
}
