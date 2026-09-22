import { Field } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { initialValues, issueFieldIds, submitValues, validateFields } from "./validate";

/** 계약 기본값(required: false, multi: false)을 채운 필드 — 서버가 받는 모양 그대로 */
const f = (raw: Record<string, unknown>): Field => Field.parse({ id: "x", label: "칸", ...raw });
const OPTS = [
  { value: "a", label: "가" },
  { value: "b", label: "나" },
];

describe("validateFields — 서버 fieldSchema 와 같은 빡빡함", () => {
  it("required 인데 비면 오류", () => {
    expect(validateFields([{ type: "text", id: "t", label: "제목", required: true }], { t: "" })).toEqual({
      t: "필수 항목입니다",
    });
  });

  it("오류가 없으면 {}", () => {
    expect(validateFields([f({ type: "text" })], { x: "" })).toEqual({});
  });

  it("number 의 min·max — 경계는 포함", () => {
    const n = [{ type: "number", id: "n", label: "수", required: false, min: 1, max: 5 }] as Field[];
    expect(validateFields(n, { n: 0 })).toEqual({ n: "1 이상이어야 합니다" });
    expect(validateFields(n, { n: 6 })).toEqual({ n: "5 이하여야 합니다" });
    expect(validateFields(n, { n: 3 })).toEqual({});
    expect(validateFields(n, { n: 1 })).toEqual({});
    expect(validateFields(n, { n: 5 })).toEqual({});
  });

  it("number — 숫자가 아니면(NaN) 오류, 비면 required 에서만 오류", () => {
    expect(validateFields([f({ type: "number" })], { x: Number.NaN })).toEqual({ x: "숫자를 입력하세요" });
    expect(validateFields([f({ type: "number" })], { x: undefined })).toEqual({});
    expect(validateFields([f({ type: "number", required: true })], { x: undefined })).toEqual({
      x: "필수 항목입니다",
    });
  });

  it("number — step 은 보지 않는다(서버도 안 본다)", () => {
    expect(validateFields([f({ type: "number", step: 2 })], { x: 3 })).toEqual({});
  });

  it("text 의 minLength·maxLength — 경계는 포함", () => {
    const t = [f({ type: "text", minLength: 3, maxLength: 5 })];
    expect(validateFields(t, { x: "ab" })).toEqual({ x: "3자 이상이어야 합니다" });
    expect(validateFields(t, { x: "abcdef" })).toEqual({ x: "5자 이하여야 합니다" });
    expect(validateFields(t, { x: "abc" })).toEqual({});
    expect(validateFields(t, { x: "abcde" })).toEqual({});
  });

  it("text·textarea 는 maxLength 가 없어도 4000자까지", () => {
    for (const type of ["text", "textarea"]) {
      expect(validateFields([f({ type })], { x: "a".repeat(4000) })).toEqual({});
      expect(validateFields([f({ type })], { x: "a".repeat(4001) })).toEqual({ x: "4000자 이하여야 합니다" });
    }
  });

  it("required 가 아닌 text 는 비우면 minLength 가 있어도 통과한다 — 보낼 때 빼므로", () => {
    const t = [f({ type: "text", minLength: 3 })];
    expect(validateFields(t, { x: "" })).toEqual({});
    expect(submitValues(t, { x: "" })).toEqual({});
  });

  it("required text 에 minLength: 0 이면 빈 문자열도 통과한다 — 서버가 minLength 를 먼저 본다", () => {
    const t = [f({ type: "text", required: true, minLength: 0 })];
    expect(validateFields(t, { x: "" })).toEqual({});
    expect(submitValues(t, { x: "" })).toEqual({ x: "" });
  });

  it("글자 수는 코드 포인트로 센다 — 이모지 하나는 한 글자(서버 zod 와 같다)", () => {
    expect(validateFields([f({ type: "text", maxLength: 2 })], { x: "😀😀" })).toEqual({});
    expect(validateFields([f({ type: "text", maxLength: 2 })], { x: "😀😀😀" })).toEqual({
      x: "2자 이하여야 합니다",
    });
    expect(validateFields([f({ type: "text", minLength: 3 })], { x: "😀😀" })).toEqual({
      x: "3자 이상이어야 합니다",
    });
    expect(validateFields([f({ type: "textarea", maxLength: 1 })], { x: "😀" })).toEqual({});
    // 결합 문자도 한 글자 — 정규화(NFC)하지 않는다(zod 도 안 한다): 「e + ◌́」는 두 글자
    expect(validateFields([f({ type: "text", maxLength: 1 })], { x: "e\u0301" })).toEqual({
      x: "1자 이하여야 합니다",
    });
  });

  it("공백도 글자다 — 다듬지 않는다(서버가 길이만 본다)", () => {
    expect(validateFields([f({ type: "text", required: true })], { x: "  " })).toEqual({});
    expect(submitValues([f({ type: "text", required: true })], { x: "  " })).toEqual({ x: "  " });
    // 선택 칸도 — 공백뿐인 입력을 빈 칸으로 보고 소리 없이 빼지 않는다
    expect(submitValues([f({ type: "text" })], { x: "  " })).toEqual({ x: "  " });
    expect(submitValues([f({ type: "textarea" })], { x: " \n" })).toEqual({ x: " \n" });
  });

  it("textarea 는 required 면 비울 수 없고 minLength 는 없다", () => {
    expect(validateFields([f({ type: "textarea", required: true })], { x: "" })).toEqual({
      x: "필수 항목입니다",
    });
    expect(validateFields([f({ type: "textarea", required: true })], { x: "a" })).toEqual({});
  });

  it("date 는 실제 달력 날짜(YYYY-MM-DD)만", () => {
    const d = [f({ type: "date" })];
    expect(validateFields(d, { x: "2026-09-21" })).toEqual({});
    expect(validateFields(d, { x: "2024-02-29" })).toEqual({});
    expect(validateFields(d, { x: "2000-02-29" })).toEqual({});
    for (const bad of ["2026-02-30", "2100-02-29", "2026-13-01", "275760-09-13", "2026-9-21"]) {
      expect(validateFields(d, { x: bad }), bad).toEqual({ x: "날짜 형식이 올바르지 않습니다" });
    }
  });

  it("date 는 required 면 비울 수 없고, 아니면 비워도 된다", () => {
    expect(validateFields([f({ type: "date", required: true })], { x: "" })).toEqual({
      x: "필수 항목입니다",
    });
    expect(validateFields([f({ type: "date" })], { x: "" })).toEqual({});
  });

  it("select 는 required 면 하나 이상", () => {
    expect(
      validateFields([f({ type: "select", required: true, multi: true, options: OPTS })], { x: [] }),
    ).toEqual({ x: "하나 이상 고르세요" });
    expect(validateFields([f({ type: "select", required: true, options: OPTS })], { x: [] })).toEqual({
      x: "하나를 고르세요",
    });
    expect(validateFields([f({ type: "select", options: OPTS })], { x: [] })).toEqual({});
  });

  it("select — 단일은 하나까지, 다중은 상한이 없다", () => {
    expect(validateFields([f({ type: "select", options: OPTS })], { x: ["a", "b"] })).toEqual({
      x: "하나만 고를 수 있습니다",
    });
    expect(validateFields([f({ type: "select", multi: true, options: OPTS })], { x: ["a", "b"] })).toEqual(
      {},
    );
  });

  it("select·radio — 옵션에 없는 값은 오류", () => {
    expect(validateFields([f({ type: "select", options: OPTS })], { x: ["z"] })).toEqual({
      x: "목록에 없는 값입니다",
    });
    expect(validateFields([f({ type: "radio", options: OPTS })], { x: "z" })).toEqual({
      x: "목록에 없는 값입니다",
    });
  });

  it("radio 는 required 면 골라야 한다", () => {
    expect(validateFields([f({ type: "radio", required: true, options: OPTS })], { x: undefined })).toEqual({
      x: "하나를 고르세요",
    });
    expect(validateFields([f({ type: "radio", required: true, options: OPTS })], { x: "b" })).toEqual({});
    expect(validateFields([f({ type: "radio", options: OPTS })], { x: undefined })).toEqual({});
  });

  it("checkbox 는 required 여도 꺼진 채(false) 낼 수 있다 — 서버는 boolean 인지만 본다", () => {
    const c = [f({ type: "checkbox", required: true })];
    expect(validateFields(c, { x: false })).toEqual({});
    expect(submitValues(c, { x: false })).toEqual({ x: false });
    expect(validateFields(c, { x: undefined })).toEqual({ x: "필수 항목입니다" });
  });

  it("값의 형이 어긋나면 오류 — 서버가 거절할 모양을 보내지 않는다", () => {
    expect(validateFields([f({ type: "text" })], { x: 3 })).toEqual({ x: "값이 올바르지 않습니다" });
    expect(validateFields([f({ type: "checkbox" })], { x: "on" })).toEqual({ x: "값이 올바르지 않습니다" });
    expect(validateFields([f({ type: "select", options: OPTS })], { x: "a" })).toEqual({
      x: "값이 올바르지 않습니다",
    });
  });

  it("못 읽는 입력을 쥔 칸(unreadable)은 값이 비어도 형식 오류다 — 필수든 아니든, 「필수 항목입니다」보다 먼저", () => {
    const fields = [
      f({ type: "number", id: "n" }),
      f({ type: "date", id: "d", required: true }),
      f({ type: "text", id: "t" }),
    ];
    const values = { n: undefined, d: "", t: "" };
    expect(validateFields(fields, values, ["n", "d"])).toEqual({
      n: "숫자를 입력하세요",
      d: "날짜 형식이 올바르지 않습니다",
    });
    expect(validateFields(fields, values)).toEqual({ d: "필수 항목입니다" });
  });

  it("칸마다 따로 — 여러 칸의 오류를 한꺼번에 돌려준다", () => {
    const fields = [
      f({ type: "text", id: "a", required: true }),
      f({ type: "number", id: "b", min: 10 }),
      f({ type: "checkbox", id: "c" }),
    ];
    expect(validateFields(fields, { a: "", b: 1, c: true })).toEqual({
      a: "필수 항목입니다",
      b: "10 이상이어야 합니다",
    });
  });
});

describe("initialValues", () => {
  // 프로토타입 없는 객체다(byFieldId) — toStrictEqual 은 프로토타입까지 보므로 제 키만 평범한 객체로 옮겨 잰다
  const own = (fields: Field[]) => ({ ...initialValues(fields) });

  it("initialValues 는 default 를 채우고 없는 칸은 비운다", () => {
    expect(
      initialValues([{ type: "checkbox", id: "c", label: "동의", required: false, default: true }]),
    ).toEqual({
      c: true,
    });
  });

  it("필드 7종의 default", () => {
    const fields = [
      f({ type: "text", id: "t", default: "제목" }),
      f({ type: "textarea", id: "ta", default: "본문" }),
      f({ type: "number", id: "n", default: 0 }),
      f({ type: "date", id: "d", default: "2026-09-21" }),
      f({ type: "select", id: "s", multi: true, options: OPTS, default: ["b", "a"] }),
      f({ type: "checkbox", id: "c", default: false }),
      f({ type: "radio", id: "r", options: OPTS, default: "b" }),
    ];
    expect(own(fields)).toStrictEqual({
      t: "제목",
      ta: "본문",
      n: 0,
      d: "2026-09-21",
      s: ["b", "a"],
      c: false,
      r: "b",
    });
  });

  it("default 가 없으면 칸마다 빈 값", () => {
    const fields = [
      f({ type: "text", id: "t" }),
      f({ type: "textarea", id: "ta" }),
      f({ type: "number", id: "n" }),
      f({ type: "date", id: "d" }),
      f({ type: "select", id: "s", options: OPTS }),
      f({ type: "checkbox", id: "c" }),
      f({ type: "radio", id: "r", options: OPTS }),
    ];
    expect(own(fields)).toStrictEqual({
      t: "",
      ta: "",
      n: undefined,
      d: "",
      s: [],
      c: false,
      r: undefined,
    });
  });

  it("옵션에 없는 default 는 버린다 — 화면에 안 보이는 값을 보내지 않게", () => {
    const fields = [
      f({ type: "select", id: "s", multi: true, options: OPTS, default: ["z", "a"] }),
      f({ type: "radio", id: "r", options: OPTS, default: "z" }),
    ];
    expect(own(fields)).toStrictEqual({ s: ["a"], r: undefined });
  });

  it("단일 select 의 default 가 여럿이면 첫 하나만", () => {
    expect(own([f({ type: "select", options: OPTS, default: ["b", "a"] })])).toStrictEqual({
      x: ["b"],
    });
  });
});

describe("submitValues — 보내는 모양", () => {
  it("required 가 아닌 빈 칸은 뺀다 — 체크박스의 false 는 남긴다", () => {
    const fields = [
      f({ type: "text", id: "t" }),
      f({ type: "textarea", id: "ta" }),
      f({ type: "number", id: "n" }),
      f({ type: "date", id: "d" }),
      f({ type: "select", id: "s", options: OPTS }),
      f({ type: "checkbox", id: "c" }),
      f({ type: "radio", id: "r", options: OPTS }),
    ];
    expect(submitValues(fields, initialValues(fields))).toStrictEqual({ c: false });
  });

  it("값이 있는 칸은 그대로 싣는다", () => {
    const fields = [
      f({ type: "text", id: "t", required: true }),
      f({ type: "number", id: "n" }),
      f({ type: "select", id: "s", multi: true, options: OPTS }),
      f({ type: "radio", id: "r", options: OPTS }),
    ];
    expect(submitValues(fields, { t: "제목", n: 0, s: ["a", "b"], r: "a" })).toStrictEqual({
      t: "제목",
      n: 0,
      s: ["a", "b"],
      r: "a",
    });
  });
});

describe("칸 id 가 Object.prototype 의 이름이어도(계약 ItemId 가 받는다)", () => {
  const fields = [
    f({ type: "text", id: "__proto__", required: true }),
    f({ type: "select", id: "constructor", multi: true, options: OPTS }),
  ];

  it("initialValues 가 그 칸을 제 키로 든다 — `__proto__` 에 써도 프로토타입 세터를 타지 않는다", () => {
    expect(Object.entries(initialValues(fields))).toEqual([
      ["__proto__", ""],
      ["constructor", []],
    ]);
  });

  it("validateFields 의 오류도 그 키로 — 없는 칸은 상속된 것을 읽지 않는다", () => {
    const errors = validateFields(fields, initialValues(fields));
    expect(Object.entries(errors)).toEqual([["__proto__", "필수 항목입니다"]]);
    // 화면은 errors[f.id] 로 읽는다 — 오류 없는 칸에서 Object 함수가 나오면 그 칸이 aria-invalid 가 된다
    expect(errors.constructor).toBeUndefined();
  });

  it("못 읽는 입력의 칸이 `__proto__` 여도 형식 오류로 막는다", () => {
    const d = [f({ type: "date", id: "__proto__" })];
    expect(Object.entries(validateFields(d, initialValues(d), ["__proto__"]))).toEqual([
      ["__proto__", "날짜 형식이 올바르지 않습니다"],
    ]);
  });

  it("submitValues 는 그 키를 싣는 평범한 객체 — wire(JSON)로 나간다", () => {
    // 계산된 키로 — `{ __proto__: "a" }` 는 제 키가 아니라 프로토타입을 정하는 문법이다
    const out = submitValues(fields, { ...initialValues(fields), ["__proto__"]: "a", constructor: ["b"] });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":"a","constructor":["b"]}');
  });
});

describe("issueFieldIds — VALIDATION details 가 가리키는 칸", () => {
  const fields = [f({ type: "text", id: "title" }), f({ type: "number", id: "n" })];

  it("path 가 [fields, <id>, …] 인 이슈의 칸 id 들", () => {
    const details = {
      issues: [
        { path: ["fields", "title"], message: "Too small" },
        { path: ["fields", "n"], message: "Too big" },
        { path: ["fields", "title"], message: "again" },
      ],
    };
    expect(issueFieldIds(fields, details)).toEqual(["title", "n"]);
  });

  it("칸을 못 가리키는 이슈는 뺀다 — 모르는 id·fields 자체·다른 뿌리", () => {
    const details = {
      issues: [
        { path: ["fields", "ghost"], message: "x" },
        { path: ["fields"], message: "Unrecognized key" },
        { path: [], message: "x" },
        { path: ["values", "title"], message: "x" },
        { path: ["fields", 0], message: "x" },
      ],
    };
    expect(issueFieldIds(fields, details)).toEqual([]);
  });

  it("details 가 없거나 모양이 어긋나면 빈 배열", () => {
    expect(issueFieldIds(fields, undefined)).toEqual([]);
    expect(issueFieldIds(fields, {})).toEqual([]);
    expect(issueFieldIds(fields, { issues: "nope" })).toEqual([]);
    expect(issueFieldIds(fields, { issues: [null, 3, { path: "fields.title" }] })).toEqual([]);
  });
});
