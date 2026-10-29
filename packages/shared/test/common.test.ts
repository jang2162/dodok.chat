import { describe, expect, it } from "vitest";
import { ApiError, BRIDGE_PROTOCOL, ErrorCode, Id, IsoDateTime, WIRE_PROTOCOL } from "../src/common";

describe("common", () => {
  it("Id는 UUID만 허용한다", () => {
    expect(Id.safeParse("01a09fc9-d204-7551-89d6-38544d07a13a").success).toBe(true);
    expect(Id.safeParse("not-a-uuid").success).toBe(false);
  });

  it("IsoDateTime은 오프셋과 Z를 모두 받는다", () => {
    expect(IsoDateTime.safeParse("2026-09-14T09:12:00+09:00").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-09-14T00:12:00Z").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-09-14 09:12").success).toBe(false);
  });

  it("ErrorCode는 닫힌 enum이다", () => {
    expect(ErrorCode.options).toEqual([
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "VALIDATION",
      "CONFLICT",
      "RATE_LIMITED",
      "RELAY_LIMIT",
      "RUN_LIMIT",
      "ADAPTER_UNAVAILABLE",
      "PROTOCOL_MISMATCH",
      "EXPIRED",
      "CONSUMED",
      "TIMEOUT",
      "INSUFFICIENT_STORAGE",
      "PROVIDER_AUTH",
      "AGENT_ARCHIVED",
      "MEMBER_DEACTIVATED",
      "CHANNEL_ARCHIVED",
      "PUSH_UNAVAILABLE",
      "CONVERSATION_CLOSED",
      "DM_READ_ONLY",
      "RUNNER_CEILING",
      "INTERNAL",
    ]);
    expect(ErrorCode.safeParse("NOPE").success).toBe(false);
  });

  it("ApiError는 details를 선택으로 받는다", () => {
    expect(ApiError.parse({ code: "VALIDATION", message: "bad" })).toEqual({
      code: "VALIDATION",
      message: "bad",
    });
    expect(ApiError.safeParse({ code: "VALIDATION" }).success).toBe(false);
  });

  it("프로토콜 상수는 1이다", () => {
    expect(WIRE_PROTOCOL).toBe(1);
    expect(BRIDGE_PROTOCOL).toBe(1);
  });
});
