const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 만료 시각 — 오늘이면 「15:00 까지」, 아니면 날짜와 함께(브라우저 시간대) */
export function untilLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  return `${(sameDay ? TIME : DATE_TIME).format(at)} 까지`;
}
