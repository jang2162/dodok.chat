import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDirErrorMessage, isBundled, migrationsFolder, unwritableDataPath } from "../src/runtime";

describe("runtime", () => {
  it("테스트(소스 실행)에서는 번들이 아니다", () => {
    expect(isBundled()).toBe(false);
  });
  it("DODOK_MIGRATIONS_DIR 가 있으면 그것을 쓴다", () => {
    expect(migrationsFolder({ DODOK_MIGRATIONS_DIR: "/app/drizzle" })).toBe("/app/drizzle");
  });
  it("없거나 비었으면 소스 기준 apps/server/drizzle", () => {
    const dir = migrationsFolder({});
    expect(dir.endsWith(join("apps", "server", "drizzle"))).toBe(true);
    expect(migrationsFolder({ DODOK_MIGRATIONS_DIR: "" })).toBe(dir);
  });
});

// root 로 돌면 권한 비트와 무관하게 쓸 수 있어 「못 쓴다」를 재현할 수 없다
describe.skipIf(process.getuid?.() === 0)("unwritableDataPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-datadir-"));
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const paths = (dataDir: string) => ({
    dataDir,
    dbPath: join(dataDir, "dodok.sqlite"),
    attachmentsDir: join(dataDir, "attachments"),
  });

  it("쓸 수 있으면 null — 없는 DATA_DIR 은 만든다", () => {
    const data = join(dir, "data");
    expect(unwritableDataPath(paths(data))).toBeNull();
    expect(statSync(data).isDirectory()).toBe(true);
  });

  it("DATA_DIR 에 쓸 수 없으면 그 경로(root 소유 볼륨 — 디렉터리만 있고 비트가 없다)", () => {
    chmodSync(dir, 0o555);
    expect(unwritableDataPath(paths(dir))).toEqual({ path: dir, code: "EACCES" });
  });

  it("DATA_DIR 을 만들 수 없어도 그 경로", () => {
    chmodSync(dir, 0o555);
    const data = join(dir, "data");
    expect(unwritableDataPath(paths(data))).toEqual({ path: data, code: "EACCES" });
  });

  it("디렉터리는 되는데 이미 있는 DB·WAL·첨부 디렉터리가 못 쓰는 것이면 그 경로(옛 root 이미지가 만든 파일)", () => {
    const p = paths(dir);
    writeFileSync(p.dbPath, "");
    writeFileSync(`${p.dbPath}-wal`, "");
    chmodSync(`${p.dbPath}-wal`, 0o444);
    expect(unwritableDataPath(p)).toEqual({ path: `${p.dbPath}-wal`, code: "EACCES" });
    chmodSync(`${p.dbPath}-wal`, 0o644);
    mkdirSync(p.attachmentsDir, { mode: 0o555 });
    expect(unwritableDataPath(p)).toEqual({ path: p.attachmentsDir, code: "EACCES" });
  });

  it("메시지는 한 줄 — 경로·사유·고치는 명령", () => {
    expect(dataDirErrorMessage({ path: "/data", code: "EACCES" })).toBe(
      "설정 오류: DATA_DIR 에 쓸 수 없다: /data (EACCES) — 컨테이너면 볼륨 소유자를 1000:1000 으로: " +
        "docker compose run --rm -u 0 app chown -R 1000:1000 /data",
    );
  });
});
