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

/** a3-c1 리뷰 2절 표 — 플러그인이 만든 url(공백류 퍼센트 인코딩)을 저장 이름(`sanitizeAttachmentName`)으로 푼다 */
describe("resolveRef — 플러그인 인코딩 왕복(a3-c1 리뷰 2절)", () => {
  const named = (name: string, id = ID2) => ({ ...a2, id, name });
  const cases: [string, string, string][] = [
    ["공백", "월간 보고서.pdf", "artifact://월간%20보고서.pdf"],
    ["탭(모델이 원래 이름을 씀)", "탭이름.pdf", "artifact://탭%09이름.pdf"],
    ["탭(모델이 저장 이름을 씀)", "탭이름.pdf", "artifact://탭이름.pdf"],
    ["줄바꿈", "줄바꿈.txt", "artifact://줄%0A바꿈.txt"],
    ["원래 % 가 든 이름", "50% 할인.pdf", "artifact://50%%20할인.pdf"],
    ["이름 자체에 %20", "a%20b.pdf", "artifact://a%20b.pdf"],
    ["모델이 이미 %20 으로 적음", "월간 보고서.pdf", "artifact://월간%20보고서.pdf"],
    ["전각 공백 U+3000", "월간　보고서.pdf", "artifact://월간%E3%80%80보고서.pdf"],
    ["NBSP U+00A0", "월간 보고서.pdf", "artifact://월간%C2%A0보고서.pdf"],
    ["% + 전각 공백", "50%　할인.pdf", "artifact://50%%E3%80%80할인.pdf"],
    ["끝 공백(저장 이름은 trim)", "월간 보고서.pdf", "artifact://월간%20보고서.pdf%20"],
    ["% 뒤 16진이 아닌 글자 + 공백", "100%go od.pdf", "artifact://100%go%20od.pdf"],
  ];
  for (const [label, name, url] of cases)
    it(`풀린다 — ${label}`, () => {
      const k = named(name);
      expect(resolveRef(url, [a1, k])).toEqual({ kind: "attachment", attachment: k });
    });

  it("남는 것 — %20 문자열과 공백이 함께 든 이름은 missing(본질적 모호: 어느 %20 이 원래 글자인지 url 로 모른다)", () => {
    expect(resolveRef("artifact://a%20b%20c.pdf", [a1, named("a%20b c.pdf")])).toEqual({ kind: "missing" });
  });

  it("모호 ① — 정확 일치가 첨부 순서보다 먼저다: 뒤 첨부 a%20b.pdf 로 풀린다", () => {
    const front = named("a b.pdf", ID1);
    const back = named("a%20b.pdf", ID2);
    expect(resolveRef("artifact://a%20b.pdf", [front, back])).toEqual({
      kind: "attachment",
      attachment: back,
    });
  });

  it("남는 것 — 모호 ②: 뜻이 뒤 첨부 a b.pdf 여도 정확 일치인 앞 첨부로 풀린다(본질적 모호: 인코딩이 구분을 지웠다)", () => {
    const front = named("a%20b.pdf", ID1);
    const back = named("a b.pdf", ID2);
    expect(resolveRef("artifact://a%20b.pdf", [front, back])).toEqual({
      kind: "attachment",
      attachment: front,
    });
  });

  it("모호 ③ — 뜻이 뒤 첨부여도 관대한 디코드로 앞 첨부에 풀린다(본질적 모호, 리뷰 3절)", () => {
    const front = named("50% a b.pdf", ID1);
    const back = named("50% a%20b.pdf", ID2);
    expect(resolveRef("artifact://50%%20a%20b.pdf", [front, back])).toEqual({
      kind: "attachment",
      attachment: front,
    });
  });

  it("이름 정보가 없는 ref 는 폴백 이름 file 인 첨부로 풀지 않는다(a3-c2 리뷰 3절)", () => {
    const f = named("file");
    for (const ref of ["%00", "%09", "%20", "%0A%0D", ".", "...", "%2F"])
      expect(resolveRef(`artifact://${ref}`, [a1, f])).toEqual({ kind: "missing" });
  });

  it("이름이 file 인 첨부는 다듬어 file 이 되는 이름으로도 풀린다 — 끝 공백·탭·앞 점", () => {
    const f = named("file");
    for (const ref of ["file", "file%20", "fi%09le", ".file"])
      expect(resolveRef(`artifact://${ref}`, [a1, f])).toEqual({ kind: "attachment", attachment: f });
  });

  it("referencedAttachmentIds 도 같은 해석을 쓴다 — 탭·% 든 이름", () => {
    const tab = named("탭이름.pdf", ID2);
    const pct = named("50% 할인.pdf", ID3);
    const components = {
      id: "c",
      ttlMs: 60_000,
      reusable: false,
      blocks: [
        { type: "file", url: "artifact://탭%09이름.pdf", name: "탭" },
        { type: "file", url: "artifact://50%%20할인.pdf", name: "할인" },
      ],
    };
    expect(referencedAttachmentIds(components as never, [a1, tab, pct])).toEqual(new Set([ID2, ID3]));
  });
});
