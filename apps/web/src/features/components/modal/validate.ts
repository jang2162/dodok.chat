import type { Field, SelectOption } from "@dodok/shared";

/**
 * 필드 id → 화면이 든 값. text·textarea·date 는 문자열, number 는 수(비면 undefined), select 는 배열.
 * 브라우저가 못 읽는 입력은 값으로는 빈 칸이다 — 그 칸은 `validateFields` 의 `unreadable` 로 따로 받는다
 */
export type FieldValues = Record<string, unknown>;

/**
 * 칸 id 로 찾는 객체(화면 값·오류) — 프로토타입 없이 만든다. 계약 ItemId 는 「__proto__」「constructor」를 거절하지만 옛 행에는 있을 수 있다(Message 의 StoredItemId 가 받는다):
 * `{}` 면 없는 칸을 읽을 때 Object.prototype 의 것이 나오고(오류 자리에 객체가 그려져 렌더가 던진다),
 * `__proto__` 에 쓰면 칸이 아니라 프로토타입 세터를 탄다. 서버로 나가는 값만은 평범한 객체다(`submitValues`)
 */
export function byFieldId<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const [id, v] of entries) out[id] = v;
  return out;
}

const REQUIRED = "필수 항목입니다";
const BAD_VALUE = "값이 올바르지 않습니다";
const NOT_OPTION = "목록에 없는 값입니다";
const PICK_ONE = "하나를 고르세요";
const NOT_NUMBER = "숫자를 입력하세요";
const BAD_DATE = "날짜 형식이 올바르지 않습니다";

/** text·textarea 의 기본 상한 — 서버 fieldSchema 의 `maxLength ?? 4000` */
const TEXT_MAX = 4000;

const hasOption = (options: SelectOption[], v: unknown) => options.some((o) => o.value === v);

/**
 * 글자 수 — 서버 zod(4.6.5)처럼 유니코드 코드 포인트로 센다(서로게이트 쌍은 하나, 짝 없는 서로게이트도 하나).
 * UTF-16 단위(`.length`)로 세면 이모지에서 서버와 어긋난다. 같은 까닭으로 입력에 HTML maxLength 를 달지 않는다
 */
const codePoints = (v: string) => [...v].length;

/**
 * 실제 달력 날짜인 `YYYY-MM-DD` — 서버의 `z.iso.date()`(윤년까지 따지는 정규식, 연도 네 자리)와 같은 집합.
 * 웹은 zod 에 기대지 않으므로(의존성 없음) UTC 자정으로 읽어 되돌렸을 때 같은지로 잰다
 */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** 폼을 열 때의 값 — default 를 채우고 없는 칸은 비운다. 옵션에 없는 default 는 버린다(화면에 안 보이는 값을 보내지 않게) */
export function initialValues(fields: Field[]): FieldValues {
  const out = byFieldId<unknown>();
  for (const f of fields) {
    switch (f.type) {
      case "text":
      case "textarea":
      case "date":
        out[f.id] = f.default ?? "";
        break;
      case "number":
        out[f.id] = f.default;
        break;
      case "select": {
        const known = (f.default ?? []).filter((v) => hasOption(f.options, v));
        out[f.id] = f.multi ? known : known.slice(0, 1);
        break;
      }
      case "checkbox":
        out[f.id] = f.default ?? false;
        break;
      case "radio":
        out[f.id] = hasOption(f.options, f.default) ? f.default : undefined;
        break;
    }
  }
  return out;
}

/** 빈 칸 — required 가 아니면 보내지 않는다. 체크박스의 false 는 빈 칸이 아니다 */
const isEmpty = (v: unknown) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** 칸 하나가 서버로 나가는 값 — required 가 아닌 빈 칸은 undefined(키를 뺀다) */
const outgoing = (f: Field, v: unknown) => (!f.required && isEmpty(v) ? undefined : v);

/**
 * 서버로 나가는 `values.fields` — required 가 아닌 빈 칸은 뺀다(서버 스키마가 optional 이라 빠진 키는 받는다).
 * wire(JSON)로 나가니 평범한 객체로 — `Object.fromEntries` 는 `__proto__` 도 세터를 타지 않고 제 키로 싣는다
 */
export function submitValues(fields: Field[], values: FieldValues): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const v = outgoing(f, values[f.id]);
      return v === undefined ? [] : [[f.id, v] as const];
    }),
  );
}

/**
 * 서버 `fieldSchema`(apps/server/src/modules/components/interact.ts)를 한 줄씩 옮긴 것 — 나가는 값(`outgoing`)을 잰다.
 * 서버가 정본이다: 더 느슨하면 사용자가 거절당하고, 더 빡빡하면 보낼 수 있는 것을 막는다
 */
function fieldError(f: Field, v: unknown): string | undefined {
  if (v === undefined) return f.required ? (f.type === "radio" ? PICK_ONE : REQUIRED) : undefined;
  switch (f.type) {
    case "text":
    case "textarea": {
      if (typeof v !== "string") return BAD_VALUE;
      // textarea 에는 minLength 가 없다
      const min = (f.type === "text" ? f.minLength : undefined) ?? (f.required ? 1 : 0);
      const max = f.maxLength ?? TEXT_MAX;
      const n = codePoints(v);
      if (n < min) return n === 0 ? REQUIRED : `${min}자 이상이어야 합니다`;
      if (n > max) return `${max}자 이하여야 합니다`;
      return undefined;
    }
    case "number":
      // step 은 서버도 안 본다
      if (typeof v !== "number" || !Number.isFinite(v)) return NOT_NUMBER;
      if (f.min !== undefined && v < f.min) return `${f.min} 이상이어야 합니다`;
      if (f.max !== undefined && v > f.max) return `${f.max} 이하여야 합니다`;
      return undefined;
    case "date":
      if (typeof v !== "string") return BAD_VALUE;
      if (v === "") return REQUIRED;
      return isIsoDate(v) ? undefined : BAD_DATE;
    case "select":
      if (!Array.isArray(v)) return BAD_VALUE;
      if (!v.every((x) => hasOption(f.options, x))) return NOT_OPTION;
      // 계약의 select 필드에는 min/max 가 없다 — required 면 하나 이상, 단일이면 하나까지
      if (f.required && v.length === 0) return f.multi ? "하나 이상 고르세요" : PICK_ONE;
      if (!f.multi && v.length > 1) return "하나만 고를 수 있습니다";
      return undefined;
    case "checkbox":
      // required 면 켜져야 제출된다 — 서버는 required 면 true 만, 아니면 boolean 이면 받는다
      if (typeof v !== "boolean") return BAD_VALUE;
      return f.required && v !== true ? REQUIRED : undefined;
    case "radio":
      if (v === "") return PICK_ONE;
      return hasOption(f.options, v) ? undefined : NOT_OPTION;
  }
}

/** 못 읽는 입력을 쥔 칸의 문구 — 그런 입력을 쥐는 것은 number·date 뿐이다 */
const unreadableError = (f: Field) => (f.type === "date" ? BAD_DATE : NOT_NUMBER);

/**
 * 제출 전 화면 검사(스펙 5.4, 순수) — 필드 id → 오류 문구. 없으면 {}.
 * `unreadable` 은 브라우저가 못 읽는 입력을 쥔 칸(number·date)의 id — 값은 비었어도 사용자는 친 것이 있으니
 * 통과시키거나(선택 칸이 소리 없이 빠진다) 「필수 항목입니다」로 말하지 않고 형식 오류로 막는다
 */
export function validateFields(
  fields: Field[],
  values: FieldValues,
  unreadable: readonly string[] = [],
): Record<string, string> {
  const errors = byFieldId<string>();
  for (const f of fields) {
    const e = unreadable.includes(f.id) ? unreadableError(f) : fieldError(f, outgoing(f, values[f.id]));
    if (e !== undefined) errors[f.id] = e;
  }
  return errors;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * `VALIDATION` ack 의 `details.issues` 가 가리키는 칸 id 들(중복 없이, 처음 나온 순서). 서버는 `{ issues: zodError.issues }` 를
 * 싣고 path 는 values 기준이다(`["fields", "<id>", …]`). wire 에서 온 외부 입력이라 모양을 하나씩 확인하고, 못 가리키면 뺀다
 */
export function issueFieldIds(fields: Field[], details: Record<string, unknown> | undefined): string[] {
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  const ids = new Set<string>();
  for (const issue of issues) {
    if (!isRecord(issue) || !Array.isArray(issue.path)) continue;
    const [root, id] = issue.path;
    if (root === "fields" && typeof id === "string" && fields.some((f) => f.id === id)) ids.add(id);
  }
  return [...ids];
}
