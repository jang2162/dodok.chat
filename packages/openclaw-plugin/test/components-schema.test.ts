import { ComponentsV1 } from "@dodok/shared/components";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ARTIFACT_URL_DESCRIPTION,
  COMPONENTS_DESCRIPTION,
  componentsJsonSchema,
} from "../src/components-schema";

describe("componentsJsonSchema", () => {
  it("shared components v1 의 입력 JSON Schema 에 설명을 붙인다 ($schema 제거)", () => {
    expect(componentsJsonSchema["$schema"]).toBeUndefined();
    expect(componentsJsonSchema["type"]).toBe("object");
    expect(componentsJsonSchema["description"]).toBe(COMPONENTS_DESCRIPTION);
    const properties = componentsJsonSchema["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["blocks", "modal", "reusable", "ttlMs"]));
  });

  it("스키마로 못 싣는 제약(refine·checkbox required 의 뜻)을 설명이 적는다 — placeholder 는 minLength 로도 보인다", () => {
    expect(COMPONENTS_DESCRIPTION).toContain("checkbox with required: true must be checked");
    expect(COMPONENTS_DESCRIPTION).toContain("minValues ≤ maxValues ≤ options");
    expect(COMPONENTS_DESCRIPTION).toContain("placeholder non-empty");
    expect(JSON.stringify(componentsJsonSchema)).toContain('"minLength":1,"maxLength":150');
  });

  it("v1 제약 일부가 스키마에 드러난다 (액션 로우 ≤5, 블록 ≤10)", () => {
    const text = JSON.stringify(componentsJsonSchema);
    expect(text).toContain('"maxItems":5');
    expect(
      (componentsJsonSchema["properties"] as Record<string, { maxItems?: number }>)["blocks"]?.maxItems,
    ).toBe(10);
  });

  it("media·file·링크 버튼 url 설명에 artifact://<파일 이름> 관례를 적는다 — 스키마 모양은 그대로", () => {
    const text = JSON.stringify(componentsJsonSchema);
    const hits = text.split("artifact://<파일 이름>").length - 1;
    expect(hits).toBe(3);
    const stripped = JSON.parse(text, (key, value) => (key === "description" ? undefined : value));
    const bare = JSON.parse(JSON.stringify(z.toJSONSchema(ComponentsV1, { io: "input" })), (key, value) =>
      key === "description" || key === "$schema" ? undefined : value,
    );
    expect(stripped).toEqual(bare);
  });

  it("url 설명이 이름에 공백이 있어도 그대로 쓰라고 적는다", () => {
    expect(ARTIFACT_URL_DESCRIPTION).toContain("공백이 있어도 그대로");
    const text = JSON.stringify(componentsJsonSchema);
    expect(text.split("공백이 있어도 그대로").length - 1).toBe(3);
  });
});
