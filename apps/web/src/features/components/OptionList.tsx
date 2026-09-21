import type { SelectOption } from "@dodok/shared";
import { type ReactElement, useId } from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";

/** 옵션이 이보다 많으면 스크롤 상자에 담는다(스펙 5.3) */
const SCROLL_AFTER = 6;

/** 고른 개수가 [min, max] 안인가 — 셀렉트의 「보내기」와 모달 검사가 함께 쓴다(서버 valuesSchemaFor 와 같은 경계) */
export function withinBounds(count: number, min: number, max: number): boolean {
  return count >= min && count <= max;
}

type Props = {
  /** fieldset 의 legend. 비면 legend 없이 그린다(셀렉트에 placeholder 가 없을 때) */
  name: string;
  options: SelectOption[];
  /** false → 라디오(하나), true → 체크박스(여럿) */
  multi: boolean;
  value: readonly string[];
  onChange(next: string[]): void;
  /** 목록 전체를 잠근다 — 부르는 쪽의 itemState */
  disabled?: boolean;
  /** 무리(fieldset)를 설명하는 요소 id — 비활성 사유·필드 오류 */
  describedBy?: string;
  /** 다중에서 고를 수 있는 최대 개수 — 다다르면 안 고른 항목을 잠그고 까닭을 보인다. 없으면 제한 없음, 단일에서는 무시 */
  max?: number;
};

/**
 * 옵션 목록 한 렌더러(스펙 결정 7) — 셀렉트 블록과 모달의 select·radio 필드가 함께 쓴다.
 * 단일은 라디오, 다중은 체크박스. 무리의 이름은 fieldset + legend 로 말한다(스펙 5.7)
 */
export function OptionList({
  name,
  options,
  multi,
  value,
  onChange,
  disabled = false,
  describedBy,
  max,
}: Props): ReactElement {
  const base = useId();
  const listClass = cn(
    "flex flex-col gap-2",
    options.length > SCROLL_AFTER && "max-h-56 overflow-y-auto p-1",
  );
  // 옵션 수 이상이면 잠길 일이 없다 — 그때는 「최대」 줄도 내지 않는다
  const capped = multi && max !== undefined && max < options.length;
  const full = capped && value.length >= max;
  const maxId = `${base}-max`;

  const text = (o: SelectOption, i: number) => ({
    id: `${base}-${i}`,
    descId: o.description ? `${base}-${i}-desc` : undefined,
  });

  return (
    <fieldset data-slot="option-list" className="min-w-0" disabled={disabled} aria-describedby={describedBy}>
      {name && <legend className="mb-2 text-sm leading-none font-medium">{name}</legend>}
      {capped && (
        <p id={maxId} className="mb-2 text-xs text-muted-foreground">
          {`최대 ${max}개까지 고를 수 있습니다`}
        </p>
      )}
      {multi ? (
        <div className={listClass}>
          {options.map((o, i) => {
            const { id, descId } = text(o, i);
            const checked = value.includes(o.value);
            // 고른 항목은 끌 수 있어야 한다 — 잠그는 것은 안 고른 항목뿐
            const locked = full && !checked;
            const described = [descId, locked ? maxId : undefined].filter(Boolean).join(" ");
            return (
              <OptionRow key={o.value} option={o} id={id} descId={descId} disabled={disabled || locked}>
                <Checkbox
                  id={id}
                  className="mt-px"
                  checked={checked}
                  disabled={disabled || locked}
                  aria-describedby={described || undefined}
                  onCheckedChange={(next) =>
                    onChange(next === true ? [...value, o.value] : value.filter((v) => v !== o.value))
                  }
                />
              </OptionRow>
            );
          })}
        </div>
      ) : (
        <RadioGroup
          className={listClass}
          value={value[0] ?? ""}
          onValueChange={(next) => onChange([next])}
          disabled={disabled}
        >
          {options.map((o, i) => {
            const { id, descId } = text(o, i);
            return (
              <OptionRow key={o.value} option={o} id={id} descId={descId} disabled={disabled}>
                <RadioGroupItem id={id} className="mt-px" value={o.value} aria-describedby={descId} />
              </OptionRow>
            );
          })}
        </RadioGroup>
      )}
    </fieldset>
  );
}

/** 컨트롤 하나 + 라벨(이모지는 앞) + 설명. value 는 화면에 내지 않는다 */
function OptionRow({
  option,
  id,
  descId,
  disabled,
  children,
}: {
  option: SelectOption;
  id: string;
  descId: string | undefined;
  disabled: boolean;
  children: ReactElement;
}) {
  return (
    <div className="group flex items-start gap-2" data-disabled={disabled ? "true" : undefined}>
      {children}
      <div className="grid gap-1">
        <Label htmlFor={id} className="font-normal">
          {option.emoji ? `${option.emoji} ${option.label}` : option.label}
        </Label>
        {option.description && (
          <span id={descId} className="text-xs text-muted-foreground group-data-[disabled=true]:opacity-50">
            {option.description}
          </span>
        )}
      </div>
    </div>
  );
}
