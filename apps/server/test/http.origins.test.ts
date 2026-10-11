import { describe, expect, it } from "vitest";
import { allowedOrigins, isAllowedOrigin } from "../src/http/origins";

describe("allowedOrigins", () => {
  it("normalizes APP_ORIGIN to a URL origin", () => {
    expect(allowedOrigins({ APP_ORIGIN: "http://localhost:5173/" })).toEqual(["http://localhost:5173"]);
    expect(allowedOrigins({ APP_ORIGIN: "https://chat.example.com/app?x=1" })).toEqual([
      "https://chat.example.com",
    ]);
  });
});

describe("isAllowedOrigin", () => {
  const config = { APP_ORIGIN: "http://localhost:5173/" };

  it("accepts the same origin", () => {
    expect(isAllowedOrigin(config, "http://localhost:5173")).toBe(true);
  });

  it("rejects a different port, scheme or host", () => {
    expect(isAllowedOrigin(config, "http://localhost:5174")).toBe(false);
    expect(isAllowedOrigin(config, "https://localhost:5173")).toBe(false);
    expect(isAllowedOrigin(config, "http://127.0.0.1:5173")).toBe(false);
  });

  it("rejects a missing origin and an un-normalized one", () => {
    expect(isAllowedOrigin(config, undefined)).toBe(false);
    expect(isAllowedOrigin(config, "http://localhost:5173/")).toBe(false);
  });

  it("never accepts an opaque origin, even when APP_ORIGIN has one", () => {
    expect(allowedOrigins({ APP_ORIGIN: "capacitor://localhost" })).toEqual([]);
    expect(isAllowedOrigin({ APP_ORIGIN: "capacitor://localhost" }, "null")).toBe(false);
  });
});
