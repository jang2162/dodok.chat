import { describe, expect, it } from "vitest";
import { ComponentState, ComponentsV1, collectIds, componentsToolJsonSchema } from "../src/components";

const U1 = "01a09fc9-d204-7551-89d6-38544d07a13c";

const sample = {
  text: "어떤 방식으로 진행할까요?",
  blocks: [
    { type: "section", text: "**옵션을 선택하세요**" },
    { type: "separator" },
    {
      type: "actions",
      items: [
        { type: "button", id: "go_fast", label: "빠르게", style: "primary", emoji: "⚡" },
        { type: "button", id: "go_safe", label: "안전하게", style: "success" },
        { type: "button", id: "cancel", label: "취소", style: "danger", allowedUsers: [U1] },
      ],
    },
    {
      type: "actions",
      items: [
        {
          type: "select",
          id: "target",
          placeholder: "대상 선택",
          options: [
            { value: "web", label: "웹" },
            { value: "api", label: "API" },
          ],
        },
      ],
    },
    { type: "media", items: [{ url: "artifact://img_1", alt: "미리보기" }] },
    { type: "file", url: "artifact://report.pdf", name: "report.pdf" },
  ],
  modal: {
    id: "details",
    title: "세부 정보",
    triggerLabel: "입력하기",
    fields: [
      { type: "text", id: "title", label: "제목", required: true },
      { type: "textarea", id: "desc", label: "설명" },
      {
        type: "select",
        id: "priority",
        label: "우선순위",
        options: [
          { value: "p1", label: "높음" },
          { value: "p2", label: "보통" },
        ],
      },
      { type: "checkbox", id: "notify", label: "완료 시 알림" },
    ],
  },
};

const buttons = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: "button", id: `b${i}`, label: `B${i}` }));

describe("ComponentsV1", () => {
  it("스펙 5.4 예시를 파싱하고 기본값을 채운다", () => {
    const c = ComponentsV1.parse(sample);
    expect(c.reusable).toBe(false);
    expect(c.ttlMs).toBe(1_800_000);
    const actions = c.blocks[2];
    if (actions?.type !== "actions") throw new Error("expected actions");
    expect(actions.items[0]).toMatchObject({ style: "primary" });
    expect(actions.items[1]).toMatchObject({ style: "success" });
    const sel = c.blocks[3];
    if (sel?.type !== "actions" || sel.items[0]?.type !== "select") throw new Error("expected select");
    expect(sel.items[0].multi).toBe(false);
  });

  it("액션 로우: 버튼 6개 거부", () => {
    expect(ComponentsV1.safeParse({ blocks: [{ type: "actions", items: buttons(6) }] }).success).toBe(false);
  });
  it("액션 로우: 버튼 5개 허용", () => {
    expect(ComponentsV1.safeParse({ blocks: [{ type: "actions", items: buttons(5) }] }).success).toBe(true);
  });
  it("액션 로우: 셀렉트 + 버튼 혼합 거부", () => {
    const r = ComponentsV1.safeParse({
      blocks: [
        {
          type: "actions",
          items: [{ type: "select", id: "s", options: [{ value: "a", label: "A" }] }, ...buttons(1)],
        },
      ],
    });
    expect(r.success).toBe(false);
  });
  it("셀렉트 옵션 26개 거부, 25개 허용", () => {
    const options26 = Array.from({ length: 26 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    expect(
      ComponentsV1.safeParse({
        blocks: [{ type: "actions", items: [{ type: "select", id: "s", options: options26 }] }],
      }).success,
    ).toBe(false);
    const options25 = Array.from({ length: 25 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    expect(
      ComponentsV1.safeParse({
        blocks: [{ type: "actions", items: [{ type: "select", id: "s", options: options25 }] }],
      }).success,
    ).toBe(true);
  });
  it("모달 필드 6개 거부, 5개 허용", () => {
    const fields = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ type: "text", id: `f${i}`, label: `F${i}` }));
    const modal = (n: number) => ({
      modal: { id: "m", title: "t", triggerLabel: "open", fields: fields(n) },
    });
    expect(ComponentsV1.safeParse(modal(6)).success).toBe(false);
    expect(ComponentsV1.safeParse(modal(5)).success).toBe(true);
  });
  it("TTL 범위 밖 거부, 경계값 허용", () => {
    expect(ComponentsV1.safeParse({ ttlMs: 500 }).success).toBe(false);
    expect(ComponentsV1.safeParse({ ttlMs: 86_400_001 }).success).toBe(false);
    expect(ComponentsV1.safeParse({ ttlMs: 1_000 }).success).toBe(true);
    expect(ComponentsV1.safeParse({ ttlMs: 86_400_000 }).success).toBe(true);
  });
  it("id 중복 거부 (블록·아이템·모달·필드 통틀어)", () => {
    const r = ComponentsV1.safeParse({
      blocks: [{ type: "actions", items: buttons(1) }],
      modal: { id: "b0", title: "t", triggerLabel: "o", fields: [{ type: "text", id: "x", label: "X" }] },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["blocks"]);
  });
  it("http:// URL 거부, https://와 artifact:// 허용", () => {
    expect(ComponentsV1.safeParse({ blocks: [{ type: "file", url: "http://x/y", name: "f" }] }).success).toBe(
      false,
    );
    expect(
      ComponentsV1.safeParse({ blocks: [{ type: "file", url: "https://x/y", name: "f" }] }).success,
    ).toBe(true);
    expect(
      ComponentsV1.safeParse({ blocks: [{ type: "file", url: "artifact://abc", name: "f" }] }).success,
    ).toBe(true);
  });
  it("블록 11개 거부, 10개 허용", () => {
    const blocks11 = Array.from({ length: 11 }, () => ({ type: "separator" }));
    expect(ComponentsV1.safeParse({ blocks: blocks11 }).success).toBe(false);
    const blocks10 = Array.from({ length: 10 }, () => ({ type: "separator" }));
    expect(ComponentsV1.safeParse({ blocks: blocks10 }).success).toBe(true);
  });
});

describe("collectIds", () => {
  it("모든 id를 모은다", () => {
    expect(collectIds(ComponentsV1.parse(sample))).toEqual([
      "go_fast",
      "go_safe",
      "cancel",
      "target",
      "details",
      "title",
      "desc",
      "priority",
      "notify",
    ]);
  });
});

describe("ComponentState", () => {
  it("만료 시각과 소비 목록", () => {
    expect(
      ComponentState.parse({ expiresAt: "2026-09-14T00:00:00Z", consumed: ["go_fast"] }).consumed,
    ).toEqual(["go_fast"]);
  });
});

describe("componentsToolJsonSchema", () => {
  it("에이전트용 JSON Schema에는 blocks/modal이 있고 서버 부여 id는 없다", () => {
    const js = componentsToolJsonSchema() as { properties: Record<string, unknown> };
    expect(js.properties.blocks).toBeDefined();
    expect(js.properties.modal).toBeDefined();
    expect(js.properties.id).toBeUndefined();
  });
});
