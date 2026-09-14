import { describe, expect, it } from "vitest";
import { COMPONENTS_DESCRIPTION, componentsJsonSchema } from "../src/components-schema";

describe("componentsJsonSchema", () => {
  it("shared components v1 의 입력 JSON Schema 에 설명을 붙인다 ($schema 제거)", () => {
    expect(componentsJsonSchema["$schema"]).toBeUndefined();
    expect(componentsJsonSchema["type"]).toBe("object");
    expect(componentsJsonSchema["description"]).toBe(COMPONENTS_DESCRIPTION);
    const properties = componentsJsonSchema["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["blocks", "modal", "reusable", "ttlMs"]));
  });

  it("v1 제약 일부가 스키마에 드러난다 (액션 로우 ≤5, 블록 ≤10)", () => {
    const text = JSON.stringify(componentsJsonSchema);
    expect(text).toContain('"maxItems":5');
    expect(
      (componentsJsonSchema["properties"] as Record<string, { maxItems?: number }>)["blocks"]?.maxItems,
    ).toBe(10);
  });
});
