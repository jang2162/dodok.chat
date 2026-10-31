import { type ComponentState, ComponentsV1, StoredComponentsV1 } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { findItem, formatInteractionText, validateInteraction } from "../src/modules/components/interact";

const U1 = "01a09fc9-d204-7551-89d6-38544d07a1c1";
const U2 = "01a09fc9-d204-7551-89d6-38544d07a1c2";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a1d1";
const NOW = new Date("2026-09-14T00:10:00Z");

const components = ComponentsV1.parse({
  id: "cmp_1",
  blocks: [
    {
      type: "actions",
      id: "row1",
      items: [
        { type: "button", id: "go_fast", label: "빠르게", style: "primary" },
        { type: "button", id: "cancel", label: "취소", style: "danger", allowedUsers: [U1] },
        { type: "button", id: "docs", label: "문서", url: "https://example.com" },
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
  ],
  modal: {
    id: "details",
    title: "세부 정보",
    triggerLabel: "입력하기",
    fields: [
      { type: "text", id: "title", label: "제목", required: true, maxLength: 20 },
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
      { type: "number", id: "hours", label: "예상 시간", min: 0, max: 100 },
    ],
  },
});
const state = (over: Partial<ComponentState> = {}): ComponentState => ({
  expiresAt: "2026-09-14T00:30:00Z",
  consumed: [],
  ...over,
});
const message = (over: { componentState?: ComponentState; reusable?: boolean } = {}) => ({
  id: MSG,
  components: over.reusable === undefined ? components : { ...components, reusable: over.reusable },
  componentState: over.componentState ?? state(),
});
const call = (
  itemId: string,
  values: Record<string, unknown>,
  over: Parameters<typeof message>[0] & { userId?: string; componentId?: string; now?: Date } = {},
) =>
  validateInteraction({
    message: message(over),
    componentId: over.componentId ?? "cmp_1",
    itemId,
    userId: over.userId ?? U1,
    values,
    now: over.now ?? NOW,
  });

describe("findItem", () => {
  it("버튼·셀렉트는 블록 id와 함께, 모달은 단독으로 찾는다", () => {
    expect(findItem(components, "go_fast")).toMatchObject({ kind: "button", blockId: "row1" });
    expect(findItem(components, "target")).toMatchObject({ kind: "select", blockId: undefined });
    expect(findItem(components, "details")).toMatchObject({ kind: "modal" });
    expect(findItem(components, "nope")).toBeUndefined();
  });
});

describe("validateInteraction — 실패 순서", () => {
  it("componentId 불일치 → NOT_FOUND", () => {
    expect(call("go_fast", {}, { componentId: "cmp_9" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
  it("없는 아이템 → NOT_FOUND", () => {
    expect(call("nope", {})).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
  it("링크 버튼 → VALIDATION", () => {
    expect(call("docs", {})).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
  it("만료 → EXPIRED", () => {
    expect(call("go_fast", {}, { now: new Date("2026-09-14T00:30:00Z") })).toMatchObject({
      ok: false,
      error: { code: "EXPIRED" },
    });
  });
  it("allowedUsers 밖 → FORBIDDEN", () => {
    expect(call("cancel", {}, { userId: U2 })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(call("cancel", {}, { userId: U1 })).toMatchObject({ ok: true });
  });
  it("1회용 소비됨 → CONSUMED, reusable이면 허용", () => {
    expect(call("go_fast", {}, { componentState: state({ consumed: ["go_fast"] }) })).toMatchObject({
      ok: false,
      error: { code: "CONSUMED" },
    });
    expect(
      call("go_fast", {}, { componentState: state({ consumed: ["go_fast"] }), reusable: true }),
    ).toMatchObject({
      ok: true,
    });
  });
  it("값 검증 → VALIDATION", () => {
    expect(call("go_fast", { junk: 1 })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(call("target", { values: ["nope"] })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(call("target", { values: ["web", "api"] })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(call("details", { fields: { desc: "설명만" } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(call("details", { fields: { title: "x".repeat(21) } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(call("details", { fields: { title: "t", hours: 101 } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(call("details", { fields: { title: "" } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });
});

describe("validateInteraction — 성공", () => {
  it("버튼", () => {
    expect(call("go_fast", {})).toMatchObject({ ok: true, found: { kind: "button" }, values: {} });
  });
  it("셀렉트", () => {
    expect(call("target", { values: ["web"] })).toMatchObject({ ok: true, values: { values: ["web"] } });
  });
  it("모달: 필수만 있어도 통과, 선택 필드는 생략 가능", () => {
    expect(call("details", { fields: { title: "로그인 버그" } })).toMatchObject({ ok: true });
    expect(
      call("details", { fields: { title: "t", priority: ["p1"], notify: true, hours: 3 } }),
    ).toMatchObject({ ok: true });
  });
  it("checkbox: required 면 켜져야(true) 제출된다, 아니면 false 도 받는다", () => {
    const card = ComponentsV1.parse({
      id: "cmp_1",
      modal: {
        id: "agree_form",
        title: "동의",
        triggerLabel: "열기",
        fields: [
          { type: "checkbox", id: "agree", label: "약관 동의", required: true },
          { type: "checkbox", id: "news", label: "소식 받기" },
        ],
      },
    });
    const run = (fields: Record<string, unknown>) =>
      validateInteraction({
        message: { id: MSG, components: card, componentState: state() },
        componentId: "cmp_1",
        itemId: "agree_form",
        userId: U1,
        values: { fields },
        now: NOW,
      });
    expect(run({ agree: true, news: false })).toMatchObject({ ok: true });
    expect(run({ agree: false, news: true })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(run({ news: true })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
  it("선택 textarea는 빈 문자열을 허용한다", () => {
    expect(call("details", { fields: { title: "t", desc: "" } })).toMatchObject({ ok: true });
  });
});

describe("formatInteractionText", () => {
  const base = { userHandle: "jang", components };
  it("버튼", () => {
    const found = findItem(components, "go_fast");
    if (!found) throw new Error("x");
    expect(formatInteractionText({ ...base, found, values: {} })).toBe(
      '[dodok interaction] user=@jang kind=button component=cmp_1 item=go_fast\n@jang 님이 "빠르게" 버튼을 눌렀습니다.',
    );
  });
  it("셀렉트", () => {
    const found = findItem(components, "target");
    if (!found) throw new Error("x");
    expect(formatInteractionText({ ...base, found, values: { values: ["web"] } })).toBe(
      '[dodok interaction] user=@jang kind=select component=cmp_1 item=target values=["web"]\n@jang 님이 "대상 선택"에서 웹을 골랐습니다.',
    );
  });
  it("셀렉트에서 고른 것이 0개면 「아무것도 고르지 않았습니다」", () => {
    const found = findItem(components, "target");
    if (!found) throw new Error("x");
    expect(formatInteractionText({ ...base, found, values: { values: [] } })).toBe(
      '[dodok interaction] user=@jang kind=select component=cmp_1 item=target values=[]\n@jang 님이 "대상 선택"에서 아무것도 고르지 않았습니다.',
    );
  });
  it("빈 placeholder 인 옛 카드(읽기 스키마만 받는다)는 id 를 이름으로 쓴다", () => {
    const old = StoredComponentsV1.parse({
      id: "cmp_old",
      blocks: [
        {
          type: "actions",
          items: [{ type: "select", id: "fmt", placeholder: "", options: [{ value: "pdf", label: "PDF" }] }],
        },
      ],
    });
    const found = findItem(old, "fmt");
    if (!found) throw new Error("x");
    expect(
      formatInteractionText({ userHandle: "jang", components: old, found, values: { values: ["pdf"] } }),
    ).toBe(
      '[dodok interaction] user=@jang kind=select component=cmp_old item=fmt values=["pdf"]\n@jang 님이 "fmt"에서 PDF을 골랐습니다.',
    );
  });
  it("모달", () => {
    const found = findItem(components, "details");
    if (!found) throw new Error("x");
    expect(
      formatInteractionText({
        ...base,
        found,
        values: {
          fields: {
            title: "로그인 버그",
            desc: "재현됨",
            priority: ["p1"],
            notify: true,
            hours: 2,
          },
        },
      }),
    ).toBe(
      [
        "[dodok interaction] user=@jang kind=modal component=cmp_1 item=details",
        '@jang 님이 "세부 정보" 양식을 제출했습니다.',
        "- 제목: 로그인 버그",
        "- 설명: 재현됨",
        "- 우선순위: 높음",
        "- 완료 시 알림: 예",
        "- 예상 시간: 2",
      ].join("\n"),
    );
  });
});
