// 백업 CLI(스펙 3.2) — 번들 dist/backup.js. 사용: docker compose exec app node dist/backup.js [--keep N]
// DATA_DIR(기본 /data — 이미지의 볼륨 자리)·DB_PATH(기본 <DATA_DIR>/dodok.sqlite). 출력은 한 줄, 실패는 exit 1
import { runBackup } from "./backup";

const i = process.argv.indexOf("--keep");
const keep = i >= 0 ? Number(process.argv[i + 1]) : undefined;
if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
  console.error("백업 실패: --keep 은 1 이상의 정수");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || "/data";
try {
  const r = await runBackup({
    dataDir,
    ...(process.env.DB_PATH ? { dbPath: process.env.DB_PATH } : {}),
    ...(keep !== undefined ? { keep } : {}),
  });
  console.log(`백업 완료: ${r.dir} (${r.dbBytes} bytes, ${r.ms} ms, 지움 ${r.removed.length})`);
} catch (err) {
  console.error(`백업 실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
