import { describe, expect, it } from "vitest";
import { referencedAttachmentIds, resolveRef } from "./resolve";

const ID1 = "01a0cc16-22ee-7018-826c-e4783d25fa14";
const ID2 = "01a0cc16-22ee-7018-826c-e4783d25fa15";
const a1 = {
  id: ID1,
  kind: "image" as const,
  url: `artifact://${ID1}`,
  name: "chart.png",
  mime: "image/png",
  size: 10,
  width: 4,
  height: 3,
};
const ID3 = "01a0cc16-22ee-7018-826c-e4783d25fa16";
const a3 = {
  id: ID3,
  kind: "file" as const,
  url: `artifact://${ID3}`,
  name: "notes.txt",
  mime: "text/plain",
  size: 5,
};
const a2 = {
  id: ID2,
  kind: "file" as const,
  url: `artifact://${ID2}`,
  name: "report.pdf",
  mime: "application/pdf",
  size: 20,
};

describe("resolveRef — 같은 메시지 첨부만(스펙 6.3)", () => {
  it("이름으로 찾는다, 없으면 id 로", () => {
    expect(resolveRef("artifact://report.pdf", [a1, a2])).toEqual({ kind: "attachment", attachment: a2 });
    expect(resolveRef(`artifact://${ID1}`, [a1, a2])).toEqual({ kind: "attachment", attachment: a1 });
  });
  it("이름이 같은 첨부가 둘이면 첫 것", () => {
    const dup = { ...a2, id: ID1, name: "report.pdf" };
    expect(resolveRef("artifact://report.pdf", [dup, a2])).toEqual({ kind: "attachment", attachment: dup });
  });
  it("이름이 다른 첨부의 id 와 같으면 이름 쪽 — 이름이 먼저다", () => {
    const named = { ...a2, name: ID1 };
    expect(resolveRef(`artifact://${ID1}`, [a1, named])).toEqual({ kind: "attachment", attachment: named });
  });
  it("공백·한국어 이름은 퍼센트 인코딩돼 와도 찾는다", () => {
    const k = { ...a2, name: "월간 보고서.pdf" };
    expect(resolveRef("artifact://월간 보고서.pdf", [k]).kind).toBe("attachment");
    expect(resolveRef("artifact://%EC%9B%94%EA%B0%84%20%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf", [k]).kind).toBe(
      "attachment",
    );
  });
  it("못 찾으면 missing, https 는 그대로, 그 밖은 blocked", () => {
    expect(resolveRef("artifact://nope.png", [a1])).toEqual({ kind: "missing" });
    expect(resolveRef("https://e.com/x.png", [a1])).toEqual({ kind: "https", url: "https://e.com/x.png" });
    for (const u of [
      "javascript:alert(1)",
      " https://e.com",
      "HTTPS://e.com",
      "/api/v1/attachments/x",
      "artifact:/x",
    ])
      expect(resolveRef(u, [a1])).toEqual({ kind: "blocked" });
  });
  it("referencedAttachmentIds: media·file·링크 버튼이 가리킨 것", () => {
    const components = {
      id: "c",
      ttlMs: 60_000,
      reusable: false,
      blocks: [
        { type: "media", items: [{ url: "artifact://chart.png" }, { url: "https://e.com/y.png" }] },
        { type: "file", url: "artifact://notes.txt", name: "메모" },
        {
          type: "actions",
          items: [{ type: "button", id: "b", label: "열기", style: "secondary", url: `artifact://${ID2}` }],
        },
      ],
    };
    expect(referencedAttachmentIds(components as never, [a1, a2, a3])).toEqual(new Set([ID1, ID2, ID3]));
    expect(referencedAttachmentIds(undefined, [a1])).toEqual(new Set());
  });
});
