import {
  type ApiError,
  type Button,
  type ComponentState,
  type ComponentsV1,
  type Field,
  isReservedItemId,
  type Modal,
  type Select,
  type SelectOption,
} from "@dodok/shared";
import { z } from "zod";

export type FoundItem =
  | { kind: "button"; item: Button; blockId?: string }
  | { kind: "select"; item: Select; blockId?: string }
  | { kind: "modal"; item: Modal };

export function findItem(components: ComponentsV1, itemId: string): FoundItem | undefined {
  for (const b of components.blocks) {
    if (b.type !== "actions") continue;
    for (const item of b.items) {
      if (item.id !== itemId) continue;
      if (item.type === "button") return { kind: "button", item, blockId: b.id };
      return { kind: "select", item, blockId: b.id };
    }
  }
  if (components.modal?.id === itemId) return { kind: "modal", item: components.modal };
  return undefined;
}

const enumOf = (options: SelectOption[]) => z.enum(options.map((o) => o.value) as [string, ...string[]]);

function fieldSchema(f: Field): z.ZodType {
  let s: z.ZodType;
  switch (f.type) {
    case "text":
      s = z
        .string()
        .min(f.minLength ?? (f.required ? 1 : 0))
        .max(f.maxLength ?? 4000);
      break;
    case "textarea":
      s = z
        .string()
        .min(f.required ? 1 : 0)
        .max(f.maxLength ?? 4000);
      break;
    case "number": {
      let n = z.number();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      s = n;
      break;
    }
    case "date":
      s = z.iso.date();
      break;
    case "select": {
      const arr = z.array(enumOf(f.options));
      s = f.multi ? arr.min(f.required ? 1 : 0) : arr.min(f.required ? 1 : 0).max(1);
      break;
    }
    case "checkbox":
      s = z.boolean();
      break;
    case "radio":
      s = enumOf(f.options);
      break;
  }
  return f.required ? s : s.optional();
}

/** 아이템 종류별 values 스키마 (스펙 9.2) */
export function valuesSchemaFor(found: FoundItem): z.ZodType {
  switch (found.kind) {
    case "button":
      return z.strictObject({});
    case "select": {
      const { item } = found;
      const min = item.minValues ?? (item.multi ? 0 : 1);
      const max = item.multi ? (item.maxValues ?? 25) : 1;
      return z.strictObject({ values: z.array(enumOf(item.options)).min(min).max(max) });
    }
    case "modal": {
      const shape: Record<string, z.ZodType> = {};
      for (const f of found.item.fields) shape[f.id] = fieldSchema(f);
      return z.strictObject({ fields: z.strictObject(shape) });
    }
  }
}

export type InteractionInput = {
  message: { id: string; components?: ComponentsV1; componentState?: ComponentState };
  componentId: string;
  itemId: string;
  userId: string;
  values: Record<string, unknown>;
  now: Date;
};
export type InteractionResult =
  | { ok: true; found: FoundItem; values: Record<string, unknown> }
  | { ok: false; error: ApiError };

const fail = (
  code: ApiError["code"],
  message: string,
  details?: Record<string, unknown>,
): InteractionResult => ({
  ok: false,
  error: details ? { code, message, details } : { code, message },
});

/** 스펙 9.3의 1~5단계. 저장·브로드캐스트·전달은 호출자가 한다. */
export function validateInteraction(input: InteractionInput): InteractionResult {
  const c = input.message.components;
  if (!c || c.id !== input.componentId) return fail("NOT_FOUND", "component not found");
  const found = findItem(c, input.itemId);
  if (!found) return fail("NOT_FOUND", "item not found");
  if (found.kind === "button" && found.item.url) return fail("VALIDATION", "link button has no interaction");
  const state = input.message.componentState;
  if (!state) return fail("NOT_FOUND", "component state missing");
  if (new Date(state.expiresAt).getTime() <= input.now.getTime()) return fail("EXPIRED", "component expired");
  const allowed = found.item.allowedUsers;
  if (allowed && allowed.length > 0 && !allowed.includes(input.userId))
    return fail("FORBIDDEN", "user not allowed");
  if (!c.reusable && state.consumed.includes(input.itemId)) return fail("CONSUMED", "item already used");
  // 계약이 거절하기 전에 저장된 옛 카드 — 이 id 들은 아래 values 스키마(칸 id 를 객체 키로)와 소비 기록에 쓰지 않는다
  if (usesReservedId(found)) return fail("VALIDATION", "item uses a reserved id");
  const parsed = valuesSchemaFor(found).safeParse(input.values);
  if (!parsed.success) return fail("VALIDATION", "invalid values", { issues: parsed.error.issues });
  return { ok: true, found, values: parsed.data as Record<string, unknown> };
}

function usesReservedId(found: FoundItem): boolean {
  const ids =
    found.kind === "modal" ? [found.item.id, ...found.item.fields.map((f) => f.id)] : [found.item.id];
  return ids.some(isReservedItemId);
}

const labelOf = (options: SelectOption[], value: string) =>
  options.find((o) => o.value === value)?.label ?? value;

function renderFieldValue(f: Field, v: unknown): string {
  if (f.type === "checkbox") return v ? "예" : "아니요";
  if (f.type === "select" && Array.isArray(v)) return v.map((x) => labelOf(f.options, String(x))).join(", ");
  if (f.type === "radio") return labelOf(f.options, String(v));
  return String(v);
}

/** 스펙 9.4: 기계가 읽는 한 줄 + 사람이 읽는 본문 */
export function formatInteractionText(args: {
  userHandle: string;
  components: ComponentsV1;
  found: FoundItem;
  values: Record<string, unknown>;
}): string {
  const { userHandle, components, found, values } = args;
  const cid = components.id ?? "?";
  const head = `[dodok interaction] user=@${userHandle} kind=${found.kind} component=${cid} item=${found.item.id}`;
  switch (found.kind) {
    case "button":
      return `${head}\n@${userHandle} 님이 "${found.item.label}" 버튼을 눌렀습니다.`;
    case "select": {
      const vals = Array.isArray(values.values) ? values.values.map(String) : [];
      const labels = vals.map((v) => labelOf(found.item.options, v)).join(", ");
      const name = found.item.placeholder ?? found.item.id;
      return `${head} values=${JSON.stringify(vals)}\n@${userHandle} 님이 "${name}"에서 ${labels}을 골랐습니다.`;
    }
    case "modal": {
      const fields = (values.fields ?? {}) as Record<string, unknown>;
      const lines = [`${head}`, `@${userHandle} 님이 "${found.item.title}" 양식을 제출했습니다.`];
      for (const f of found.item.fields) {
        if (fields[f.id] === undefined) continue;
        lines.push(`- ${f.label}: ${renderFieldValue(f, fields[f.id])}`);
      }
      return lines.join("\n");
    }
  }
}
