const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const NUM = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

/** 바이트 → 사람이 읽는 단위(1024 배수, 소수 한 자리까지). 음수는 뜻이 없어 적지 않는다 */
export function formatSize(bytes: number): string | undefined {
  if (bytes < 0) return undefined;
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${NUM.format(n)} ${UNITS[unit]}`;
}
