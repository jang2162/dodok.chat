import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBundled, migrationsFolder } from "../src/runtime";

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
