import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeBundleSha256 } from "../src/bundle-hash";

describe("computeBundleSha256", () => {
  it("파일 내용의 sha256(hex)", () => {
    const bytes = Buffer.from("bundle");
    expect(computeBundleSha256("file:///x/index.js", () => bytes)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
  it("file URL 을 경로로 바꿔 읽는다", () => {
    const seen: string[] = [];
    computeBundleSha256("file:///x/a%20b/index.js", (p) => {
      seen.push(p);
      return Buffer.alloc(0);
    });
    expect(seen).toEqual(["/x/a b/index.js"]);
  });
  it("읽기 실패면 undefined(hello 에서 필드를 뺀다)", () => {
    expect(
      computeBundleSha256("file:///x/index.js", () => {
        throw new Error("ENOENT");
      }),
    ).toBeUndefined();
  });
  it("file: 이 아닌 URL 이면 undefined", () => {
    expect(computeBundleSha256("https://x/index.js", () => Buffer.alloc(0))).toBeUndefined();
  });
});
