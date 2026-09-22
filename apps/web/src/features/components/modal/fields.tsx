import type { Field } from "@dodok/shared";
import { useId } from "react";
import { Checkbox } from "@/ui/checkbox";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";
import { OptionList } from "../OptionList";

type Props = {
  field: Field;
  /** 화면이 든 값 — 모양은 validate.ts 의 FieldValues */
  value: unknown;
  /** 칸 아래 오류 문구. 있을 때만 칸이 aria-describedby 로 가리킨다 */
  error: string | undefined;
  onChange(next: unknown): void;
};

const text = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** number 칸의 값 — 비면 undefined. 못 읽는 입력(「e」「-」「1e」)도 value 는 "" 라 여기서는 빈 칸과 같다(`unreadableFieldIds`) */
const numberOf = (el: HTMLInputElement) => (el.value === "" ? undefined : Number(el.value));

/**
 * date 칸을 고치는 키 — 조각에 숫자를 치거나(한 글자 키), 지우거나, 위아래로 올리고 내린다.
 * 그 밖의 키를 뗀 것은 고친 것이 아니다: Enter 는 암묵 제출이 방금 띄운 오류를, Tab·Shift 는 들어오기만 한 칸의 오류를 지워 버린다
 */
const DATE_EDIT_KEYS = new Set(["Backspace", "Delete", "ArrowUp", "ArrowDown"]);
const editsDate = (key: string) => key.length === 1 || DATE_EDIT_KEYS.has(key);

/**
 * 브라우저가 못 읽는 입력을 쥔 칸(number·date)의 id — 제출하는 순간 칸의 `validity.badInput` 을 읽는다.
 * 못 읽는 입력은 value 가 "" 라 화면 값(state)으로는 빈 칸과 같다: 빈 number 칸의 「e」「-」는 value 가 그대로여서
 * React onChange 가 안 불리고, date 의 부분 입력(「02/31」)은 input·change 이벤트조차 없다.
 * 칸은 name 이 아니라 `data-field-id` 로 찾는다 — 칸 id 가 「elements」「submit」 같으면 name 이 form 의 속성을 가린다
 */
export function unreadableFieldIds(form: HTMLFormElement): string[] {
  return [...form.querySelectorAll<HTMLInputElement>("input[data-field-id]")].flatMap((el) =>
    el.validity.badInput && el.dataset.fieldId ? [el.dataset.fieldId] : [],
  );
}

/**
 * 모달 필드 한 칸(스펙 5.4) — 필드 7종 → 위젯, 그 아래 늘 두는 오류 자리(`ui/field-error` 관습).
 * 이름: 입력 칸은 `ui/label`. select·radio 는 `OptionList` 의 legend 가 무리의 이름이라 label 을 겹쳐 달지 않는다
 * (fieldset 은 label 로 이을 수 없어 이름이 두 벌 보이기만 한다)
 */
export function ModalField({ field, value, error, onChange }: Props) {
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = error !== undefined;
  // 오류가 있을 때만 가리킨다 — 빈 오류 자리를 설명으로 읽지 않게
  const control = {
    id,
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? errorId : undefined,
    "aria-required": field.required || undefined,
  };

  let widget;
  switch (field.type) {
    case "text":
      widget = (
        <>
          <Label htmlFor={id}>{field.label}</Label>
          <Input
            {...control}
            value={text(value)}
            placeholder={field.placeholder}
            autoComplete="off"
            onChange={(e) => onChange(e.target.value)}
          />
        </>
      );
      break;
    case "textarea":
      widget = (
        <>
          <Label htmlFor={id}>{field.label}</Label>
          <Textarea
            {...control}
            value={text(value)}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </>
      );
      break;
    case "number":
      widget = (
        <>
          <Label htmlFor={id}>{field.label}</Label>
          {/* 빈 칸은 "" 로 그린다 — 못 읽는 입력도 value 가 "" 라 브라우저가 쥔 원문(「1e」)을 React 가 덮지 않는다.
              step 이 없으면 소수도 받는다(서버가 step 을 안 본다).
              onChange 가 아니라 onInput — 빈 칸에 「e」를 치거나 지워도 value 는 "" 그대로라 onChange 가 안 불린다.
              그래도 칸을 고친 것이니 그 칸의 오류를 내린다 */}
          <Input
            {...control}
            type="number"
            data-field-id={field.id}
            value={typeof value === "number" ? value : ""}
            min={field.min}
            max={field.max}
            step={field.step ?? "any"}
            onInput={(e) => onChange(numberOf(e.currentTarget))}
          />
        </>
      );
      break;
    case "date":
      widget = (
        <>
          <Label htmlFor={id}>{field.label}</Label>
          {/* 부분 입력(「2026」만)은 치거나 지워도 input·change 가 안 난다 — 고치는 키를 뗀 것으로 칸을 고친 것을 알고
              그 칸의 오류를 내린다(`editsDate`) */}
          <Input
            {...control}
            type="date"
            data-field-id={field.id}
            value={text(value)}
            onChange={(e) => onChange(e.target.value)}
            onKeyUp={(e) => {
              if (editsDate(e.key)) onChange(e.currentTarget.value);
            }}
          />
        </>
      );
      break;
    case "select":
      widget = (
        <OptionList
          name={field.label}
          options={field.options}
          multi={field.multi}
          value={strings(value)}
          onChange={onChange}
          describedBy={invalid ? errorId : undefined}
        />
      );
      break;
    case "checkbox":
      widget = (
        <div className="flex items-center gap-2">
          <Checkbox
            {...control}
            checked={value === true}
            onCheckedChange={(next) => onChange(next === true)}
          />
          <Label htmlFor={id}>{field.label}</Label>
        </div>
      );
      break;
    case "radio":
      widget = (
        <OptionList
          name={field.label}
          options={field.options}
          multi={false}
          value={typeof value === "string" && value !== "" ? [value] : []}
          onChange={(next) => onChange(next[0])}
          describedBy={invalid ? errorId : undefined}
        />
      );
      break;
  }

  return (
    <div className="flex flex-col gap-1.5" data-slot="modal-field">
      {widget}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
