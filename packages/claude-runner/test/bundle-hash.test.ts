import { describe, expect, it } from "vitest";
import { computeBundleSha256 } from "../src/bundle-hash";

describe("computeBundleSha256", () => {
  it("파일 URL 이면 내용의 sha256 hex", () => {
    expect(computeBundleSha256("file:///x/main.js", () => Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("파일 URL 이 아니거나 못 읽으면 null", () => {
    expect(computeBundleSha256("http://x/main.js")).toBeNull();
    expect(
      computeBundleSha256("file:///x/main.js", () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });
});
