import { describe, expect, it } from "vitest";
import { attachmentHref } from "./url";

const ID = "01a0cc16-22ee-7018-826c-e4783d25fa14";

describe("attachmentHref — 자기 서버 경로는 artifact://<uuid> 에서만", () => {
  it("artifact://<uuid> 는 같은 출처 경로, download 면 ?download=1", () => {
    expect(attachmentHref({ url: `artifact://${ID}` })).toBe(`/api/v1/attachments/${ID}`);
    expect(attachmentHref({ url: `artifact://${ID}` }, { download: true })).toBe(
      `/api/v1/attachments/${ID}?download=1`,
    );
  });
  it("uuid 가 아닌 값은 경로를 만들지 않는다 — 경로 밖으로 새는 값·https·뒤에 붙은 경로", () => {
    for (const url of ["artifact://../../api/me", "https://e.com/x.png", `artifact://${ID}/x`, "artifact://"])
      expect(attachmentHref({ url })).toBeUndefined();
  });
});
