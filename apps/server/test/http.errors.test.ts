import { describe, expect, it } from "vitest";
import { apiError, httpStatusToErrorCode } from "../src/http/errors";

describe("httpStatusToErrorCode", () => {
  it("507 은 INSUFFICIENT_STORAGE 이고 apiError 와 같은 상태로 돌아온다", () => {
    expect(httpStatusToErrorCode(507)).toBe("INSUFFICIENT_STORAGE");
    expect(apiError("INSUFFICIENT_STORAGE", "x").status).toBe(507);
  });
});
