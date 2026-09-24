import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { OPENCLAW_PINNED_VERSION } from "../src";

describe("OPENCLAW_PINNED_VERSION", () => {
  it("package.json 의 @openclaw/gateway-client 정확 핀과 같다", () => {
    expect(OPENCLAW_PINNED_VERSION).toBe(packageJson.dependencies["@openclaw/gateway-client"]);
  });
});
