import type { ComponentsV1, Field, MessageInteraction, SelectOption } from "@dodok/shared";

/** 결과 줄 하나의 문구 — 화면은 `@<핸들> — <itemLabel>: <valueText>` */
export type InteractionSummary = { itemLabel: string; valueText?: string };

/** 옵션 값 → 라벨. 못 찾으면 값 그대로(카드가 바뀌어 옵션이 사라져도 줄은 남는다) */
const labelOf = (options: readonly SelectOption[], value: string) =>
  options.find((o) => o.value === value)?.label ?? value;

/** 모달 칸 하나의 값 → 사람이 읽는 문구 */
function fieldText(f: Field, v: unknown): string {
  if (f.type === "checkbox") return v ? "예" : "아니요";
  if (f.type === "select" && Array.isArray(v)) return v.map((x) => labelOf(f.options, String(x))).join(", ");
  if (f.type === "radio") return labelOf(f.options, String(v));
  return String(v);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 값 문구가 비면 이름만 — 「보고서 형식: 」처럼 빈 값을 달지 않는다 */
const summary = (itemLabel: string, valueText: string): InteractionSummary =>
  valueText ? { itemLabel, valueText } : { itemLabel };

/**
 * 상호작용 하나 → 결과 줄 문구(스펙 5.6, 순수). 버튼은 라벨, 셀렉트는 `placeholder ?? id` 와 고른 옵션 라벨들,
 * 모달은 제목과 칸별 「라벨: 값」(모달에 적힌 순서, 실려 오지 않은 칸은 건너뜀).
 *
 * 라벨 해석은 서버 `formatInteractionText`(`apps/server/src/modules/components/interact.ts`)의 사람이 읽는 부분과 같다 —
 * 아이템 찾는 순서(actions 블록들 → 모달), `labelOf`, `renderFieldValue`(checkbox 예/아니요 · select·radio 옵션 라벨 · 그 밖 `String`).
 * 그쪽은 에이전트용이라 기계가 읽는 머리줄이 붙어 일부러 따로 둔다.
 * 카드에서 그 `itemId` 를 못 찾으면(카드가 편집됐거나 계약이 바뀜) `undefined` — 부르는 쪽은 그 줄을 그리지 않는다
 */
export function summarize(
  components: ComponentsV1,
  interaction: MessageInteraction,
): InteractionSummary | undefined {
  const { itemId, values } = interaction;
  for (const b of components.blocks) {
    if (b.type !== "actions") continue;
    for (const item of b.items) {
      if (item.id !== itemId) continue;
      if (item.type === "button") return { itemLabel: item.label };
      const picked = Array.isArray(values.values) ? values.values.map(String) : [];
      return summary(item.placeholder ?? item.id, picked.map((v) => labelOf(item.options, v)).join(", "));
    }
  }
  const modal = components.modal;
  if (modal?.id !== itemId) return undefined;
  const fields = isRecord(values.fields) ? values.fields : {};
  // 자기 키만 — 칸 id 가 「constructor」「__proto__」여도(계약은 쓰기에서 거절하지만 옛 행에는 있고 Message 가 받는다) 상속된 것을 값으로 읽지 않게
  const parts = modal.fields.flatMap((f) =>
    Object.hasOwn(fields, f.id) && fields[f.id] !== undefined
      ? [`${f.label}: ${fieldText(f, fields[f.id])}`]
      : [],
  );
  return summary(modal.title, parts.join(" · "));
}

/**
 * 결과 줄 순서 — 오래된 것부터, 같은 시각이면 id 순(서버 `withInteractions` 가 싣는 순서와 같다).
 * 서버가 이미 그 순서로 싣지만 화면 순서를 그것에 기대지 않는다. 받은 배열(메시지 캐시)은 건드리지 않는다
 */
export function oldestFirst(list: readonly MessageInteraction[]): MessageInteraction[] {
  return [...list].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
