// 백업 CLI(스펙 3.2) — 번들 dist/backup.js. 사용: docker compose exec app node dist/backup.js [--keep N]
// DATA_DIR(기본 /data — 이미지의 볼륨 자리)·DB_PATH(기본 <DATA_DIR>/dodok.sqlite). 출력은 한 줄, 실패는 exit 1
import { rmSync } from "node:fs";
import { runBackup } from "./backup";

const i = process.argv.indexOf("--keep");
const keep = i >= 0 ? Number(process.argv[i + 1]) : undefined;
if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
  console.error("백업 실패: --keep 은 1 이상의 정수");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || "/data";
// Ctrl-C·docker compose down 이면 자기 .partial-* 를 지우고 128+신호 번호로 끝낸다.
// 복사 단계는 동기라 그 도중의 신호는 여기 오지 못한다 — 복사가 끝나면 완료 줄을 찍고 exit 0 으로 끝난다
// (600 MB DB 복사 중 SIGINT·SIGTERM 으로 잼). SIGKILL 로 남은 것은 다음 실행이 지운다(backup.ts STALE_PARTIAL_MS)
let partial: string | undefined;
for (const [sig, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(sig, () => {
    if (partial) rmSync(partial, { recursive: true, force: true });
    console.error(`백업 중단: ${sig}`);
    process.exit(code);
  });
}
try {
  const r = await runBackup({
    dataDir,
    ...(process.env.DB_PATH ? { dbPath: process.env.DB_PATH } : {}),
    ...(keep !== undefined ? { keep } : {}),
    onPartial: (p) => (partial = p),
  });
  const partials = r.removedPartials.length ? `, 중단된 것 지움 ${r.removedPartials.length}` : "";
  console.log(`백업 완료: ${r.dir} (${r.dbBytes} bytes, ${r.ms} ms, 지움 ${r.removed.length}${partials})`);
} catch (err) {
  console.error(`백업 실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
