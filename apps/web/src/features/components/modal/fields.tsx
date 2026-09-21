import type { Field } from "@dodok/shared";
import { type ChangeEvent, useId } from "react";
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

/**
 * number 칸의 값 — 비면 undefined, 브라우저가 못 읽는 입력(「1e」 등: value 는 "" 이고 badInput)이면 NaN.
 * NaN 을 빈 칸과 가르지 않으면 선택 칸에서 사용자가 친 값이 소리 없이 빠진다
 */
function numberOf(e: ChangeEvent<HTMLInputElement>): number | undefined {
  const el = e.currentTarget;
  if (el.value === "") return el.validity.badInput ? Number.NaN : undefined;
  return Number(el.value);
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
          {/* 못 읽는 입력(NaN)은 "" 로 그린다 — 브라우저가 쥔 원문을 React 가 덮지 않는다.
              step 이 없으면 소수도 받는다(서버가 step 을 안 본다) */}
          <Input
            {...control}
            type="number"
            value={typeof value === "number" && !Number.isNaN(value) ? value : ""}
            min={field.min}
            max={field.max}
            step={field.step ?? "any"}
            onChange={(e) => onChange(numberOf(e))}
          />
        </>
      );
      break;
    case "date":
      widget = (
        <>
          <Label htmlFor={id}>{field.label}</Label>
          <Input {...control} type="date" value={text(value)} onChange={(e) => onChange(e.target.value)} />
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
