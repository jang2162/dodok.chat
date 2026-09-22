import { ComponentsV1, type MessageInteraction } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { uid, USER } from "../../../test/fixtures";
import { oldestFirst, summarize } from "./interactions";

const OPTS = [
  { value: "pdf", label: "PDF" },
  { value: "md", label: "마크다운" },
];

const CMP = ComponentsV1.parse({
  id: "cmp_1",
  blocks: [
    { type: "actions", items: [{ type: "button", id: "ok", label: "확인", emoji: "👍" }] },
    {
      type: "actions",
      items: [{ type: "select", id: "fmt", placeholder: "보고서 형식", multi: true, options: OPTS }],
    },
    { type: "actions", items: [{ type: "select", id: "pick", options: OPTS }] },
  ],
  modal: {
    id: "form",
    title: "새 작업",
    triggerLabel: "작업 만들기",
    fields: [
      { type: "text", id: "title", label: "제목" },
      { type: "checkbox", id: "agree", label: "동의" },
    ],
  },
});

const IX: MessageInteraction = {
  id: uid(600),
  componentId: "cmp_1",
  userId: USER,
  itemId: "ok",
  values: {},
  createdAt: "2030-01-01T00:00:00.000Z",
};

/** 필드 7종 — 모달 칸은 5개까지라 두 모달로 나눈다. 값 푸는 규칙(서버 renderFieldValue)을 종류별로 잰다 */
const modalOf = (id: string, fields: unknown[]) =>
  ComponentsV1.parse({ id: "cmp_2", modal: { id, title: "모든 칸", triggerLabel: "열기", fields } });
const FIVE = modalOf("five", [
  { type: "text", id: "t", label: "제목" },
  { type: "textarea", id: "ta", label: "본문" },
  { type: "number", id: "n", label: "개수" },
  { type: "date", id: "d", label: "마감" },
  { type: "select", id: "s", label: "형식", multi: true, options: OPTS },
]);
const TWO = modalOf("two", [
  { type: "checkbox", id: "c", label: "동의" },
  { type: "radio", id: "r", label: "우선", options: OPTS },
]);
const fieldsOf = (card: ComponentsV1, fields: unknown) =>
  summarize(card, { ...IX, componentId: "cmp_2", itemId: card.modal?.id ?? "", values: { fields } });

describe("summarize — 결과 줄 문구(서버 formatInteractionText 의 사람이 읽는 부분과 같은 규칙)", () => {
  it("버튼 — 라벨만. 이모지는 싣지 않는다(서버도 label 만 쓴다)", () => {
    expect(summarize(CMP, { ...IX, itemId: "ok", values: {} })).toStrictEqual({ itemLabel: "확인" });
  });

  it("셀렉트 — placeholder 와 고른 옵션 라벨들(고른 순서대로)", () => {
    expect(summarize(CMP, { ...IX, itemId: "fmt", values: { values: ["pdf", "md"] } })).toStrictEqual({
      itemLabel: "보고서 형식",
      valueText: "PDF, 마크다운",
    });
    expect(summarize(CMP, { ...IX, itemId: "fmt", values: { values: ["md", "pdf"] } })).toStrictEqual({
      itemLabel: "보고서 형식",
      valueText: "마크다운, PDF",
    });
  });

  it("셀렉트에 placeholder 가 없으면 id 를 쓴다", () => {
    expect(summarize(CMP, { ...IX, itemId: "pick", values: { values: ["md"] } })).toStrictEqual({
      itemLabel: "pick",
      valueText: "마크다운",
    });
  });

  it("셀렉트의 모르는 값은 값 그대로 — 카드가 바뀌어 옵션이 사라져도 줄은 남는다", () => {
    expect(summarize(CMP, { ...IX, itemId: "fmt", values: { values: ["pdf", "gone"] } })).toStrictEqual({
      itemLabel: "보고서 형식",
      valueText: "PDF, gone",
    });
  });

  it("셀렉트에서 고른 것이 없으면(다중 0개·values 모양이 깨짐) 값 없이 이름만", () => {
    expect(summarize(CMP, { ...IX, itemId: "fmt", values: { values: [] } })).toStrictEqual({
      itemLabel: "보고서 형식",
    });
    expect(summarize(CMP, { ...IX, itemId: "fmt", values: { values: "pdf" } })).toStrictEqual({
      itemLabel: "보고서 형식",
    });
  });

  it("모달 — 제목과 필드별 「라벨: 값」", () => {
    expect(
      summarize(CMP, { ...IX, itemId: "form", values: { fields: { title: "보고서", agree: true } } }),
    ).toStrictEqual({ itemLabel: "새 작업", valueText: "제목: 보고서 · 동의: 예" });
  });

  it("모달 칸은 모달에 적힌 순서대로 — 값이 실려 온 순서가 아니라", () => {
    expect(
      summarize(CMP, { ...IX, itemId: "form", values: { fields: { agree: false, title: "보고서" } } }),
    ).toStrictEqual({ itemLabel: "새 작업", valueText: "제목: 보고서 · 동의: 아니요" });
  });

  it("checkbox 는 예/아니요, radio·select 는 옵션 라벨, 그 밖은 값 그대로", () => {
    expect(
      fieldsOf(FIVE, { t: "보고서", ta: "둘째 줄", n: 4, d: "2030-01-02", s: ["md", "pdf"] }),
    ).toStrictEqual({
      itemLabel: "모든 칸",
      valueText: "제목: 보고서 · 본문: 둘째 줄 · 개수: 4 · 마감: 2030-01-02 · 형식: 마크다운, PDF",
    });
    expect(fieldsOf(TWO, { c: false, r: "pdf" })).toStrictEqual({
      itemLabel: "모든 칸",
      valueText: "동의: 아니요 · 우선: PDF",
    });
    expect(fieldsOf(TWO, { c: true, r: "gone" })).toStrictEqual({
      itemLabel: "모든 칸",
      valueText: "동의: 예 · 우선: gone",
    });
  });

  it("실려 오지 않은 칸은 건너뛴다 — 칸 id 가 Object.prototype 의 이름이어도 상속된 것을 읽지 않는다", () => {
    const risky = ComponentsV1.parse({
      id: "cmp_3",
      modal: {
        id: "risky",
        title: "위험한 칸",
        triggerLabel: "열기",
        fields: [
          { type: "text", id: "constructor", label: "생성자" },
          { type: "text", id: "__proto__", label: "원형" },
          { type: "text", id: "ok", label: "보통" },
        ],
      },
    });
    const at = (fields: unknown) =>
      summarize(risky, { ...IX, componentId: "cmp_3", itemId: "risky", values: { fields } });
    expect(at({ ok: "값" })).toStrictEqual({ itemLabel: "위험한 칸", valueText: "보통: 값" });
    expect(at({ constructor: "만든 이", ok: "값" })).toStrictEqual({
      itemLabel: "위험한 칸",
      valueText: "생성자: 만든 이 · 보통: 값",
    });
  });

  it("모달에 실린 칸이 하나도 없거나 fields 모양이 깨졌으면 값 없이 제목만", () => {
    expect(summarize(CMP, { ...IX, itemId: "form", values: { fields: {} } })).toStrictEqual({
      itemLabel: "새 작업",
    });
    expect(summarize(CMP, { ...IX, itemId: "form", values: {} })).toStrictEqual({ itemLabel: "새 작업" });
    expect(summarize(CMP, { ...IX, itemId: "form", values: { fields: "보고서" } })).toStrictEqual({
      itemLabel: "새 작업",
    });
  });

  it("카드에서 못 찾는 itemId 면 undefined — 그 줄은 그리지 않는다", () => {
    expect(summarize(CMP, { ...IX, itemId: "gone" })).toBeUndefined();
    // 모달이 없는 카드
    expect(summarize({ ...CMP, modal: undefined }, { ...IX, itemId: "form" })).toBeUndefined();
  });
});

describe("oldestFirst — 결과 줄 순서", () => {
  const at = (n: number, createdAt: string): MessageInteraction => ({ ...IX, id: uid(n), createdAt });

  it("오래된 것부터 — 같은 시각이면 id 순(서버 하이드레이션과 같은 순서)", () => {
    const a = at(1, "2030-01-01T00:00:01.000Z");
    const b = at(2, "2030-01-01T00:00:02.000Z");
    const c = at(3, "2030-01-01T00:00:02.000Z");
    expect(oldestFirst([c, a, b]).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(oldestFirst([b, c, a]).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });

  it("받은 배열은 건드리지 않는다 — 메시지 캐시의 값이다", () => {
    const list = [at(2, "2030-01-01T00:00:02.000Z"), at(1, "2030-01-01T00:00:01.000Z")];
    const before = [...list];
    oldestFirst(list);
    expect(list).toEqual(before);
  });
});
