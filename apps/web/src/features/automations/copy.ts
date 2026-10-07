import type { AutomationSchedule, AutomationStatus, AutomationWarning } from "@dodok/shared";
import { josa } from "@/lib/josa";

/** weekday 0 은 일요일(shared AutomationSchedule) */
export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

export const REPEAT_LABEL: Record<AutomationSchedule["repeat"], string> = {
  daily: "매일",
  weekdays: "평일(월~금)",
  weekly: "매주",
  hourly: "매시간",
};

/** 「매일 09:00」·「평일(월~금) 09:00」·「매주 월요일 09:00」·「매시간 15분」 */
export function describeSchedule(s: AutomationSchedule): string {
  switch (s.repeat) {
    case "hourly":
      return `매시간 ${s.minute}분`;
    case "weekly":
      return `매주 ${WEEKDAYS[s.weekday]}요일 ${s.time}`;
    default:
      return `${REPEAT_LABEL[s.repeat]} ${s.time}`;
  }
}

export const STATUS_LABEL: Record<AutomationStatus, string> = {
  ok: "성공",
  skipped: "건너뜀",
  error: "실패",
};

/**
 * 목록의 경고 한 줄(자동화 스펙 「웹」 장). 핸들 뒤 조사는 받침대로 고른다(`josa` — 「@fin 이」·「@dev 가」).
 * 에이전트 경고는 게시는 되지만 그 에이전트가 불리지 않는다는 뜻이고, 보관된 채널에는 게시하지 못한다
 */
export function warningText(w: AutomationWarning): string {
  const h = w.handle ?? "";
  switch (w.kind) {
    case "agent_not_in_channel":
      return `문구의 @${h} ${josa(h, "이", "가")} 이 채널에 없습니다`;
    case "agent_disabled":
      return `문구의 @${h} ${josa(h, "이", "가")} 꺼져 있거나 삭제되었습니다`;
    case "unknown_handle":
      return `문구의 @${h} ${josa(h, "을", "를")} 찾을 수 없습니다`;
    case "channel_archived":
      return "채널이 보관되었습니다";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * 워크스페이스 시간대의 「10월 8일 (목) 오전 9:00」. 예약은 그 시간대의 벽시계로 돌므로 브라우저 시간대로 그리면 다른 시각으로
 * 읽힌다. 서버의 Intl 이 받은 이름을 이 브라우저가 모르면(ICU 판본 차이) 브라우저 시간대로 그린다
 */
export function formatAt(iso: string, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = {
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    };
    try {
      f = new Intl.DateTimeFormat("ko-KR", { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat("ko-KR", options);
    }
    formatters.set(timeZone, f);
  }
  return f.format(new Date(iso));
}
