import { z } from "zod";
import { Id, IsoDateTime } from "../common";

export const ItemId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
export const SafeUrl = z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/);
const AllowedUsers = z.array(Id).max(50).optional();

export const Button = z.object({
  type: z.literal("button"),
  id: ItemId,
  label: z.string().min(1).max(80),
  style: z.enum(["primary", "secondary", "success", "danger"]).default("secondary"),
  emoji: z.string().max(8).optional(),
  url: SafeUrl.optional(), // 링크 버튼: 상호작용 없음
  allowedUsers: AllowedUsers,
});
export type Button = z.infer<typeof Button>;

export const SelectOption = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  description: z.string().max(100).optional(),
  emoji: z.string().max(8).optional(),
});
export type SelectOption = z.infer<typeof SelectOption>;

export const Select = z.object({
  type: z.literal("select"),
  id: ItemId,
  placeholder: z.string().max(150).optional(),
  multi: z.boolean().default(false),
  minValues: z.int().min(0).max(25).optional(),
  maxValues: z.int().min(1).max(25).optional(),
  options: z.array(SelectOption).min(1).max(25),
  allowedUsers: AllowedUsers,
});
export type Select = z.infer<typeof Select>;

export const SectionBlock = z.object({ type: z.literal("section"), text: z.string().min(1).max(2000) });
export const SeparatorBlock = z.object({ type: z.literal("separator") });
export const ActionsBlock = z
  .object({
    type: z.literal("actions"),
    id: ItemId.optional(),
    items: z
      .array(z.union([Button, Select]))
      .min(1)
      .max(5),
  })
  .refine(
    (b) =>
      b.items.every((i) => i.type === "button") || (b.items.length === 1 && b.items[0]?.type === "select"),
    { message: "actions: 버튼 1~5개 또는 셀렉트 정확히 1개", path: ["items"] },
  );
export const MediaBlock = z.object({
  type: z.literal("media"),
  items: z
    .array(z.object({ url: SafeUrl, alt: z.string().max(200).optional() }))
    .min(1)
    .max(10),
});
export const FileBlock = z.object({
  type: z.literal("file"),
  url: SafeUrl,
  name: z.string().min(1).max(255),
  size: z.int().optional(),
});

export const Block = z.discriminatedUnion("type", [
  SectionBlock,
  SeparatorBlock,
  ActionsBlock,
  MediaBlock,
  FileBlock,
]);
export type Block = z.infer<typeof Block>;

const FieldBase = { id: ItemId, label: z.string().min(1).max(45), required: z.boolean().default(false) };
export const Field = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    ...FieldBase,
    placeholder: z.string().max(100).optional(),
    minLength: z.int().optional(),
    maxLength: z.int().max(4000).optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("textarea"),
    ...FieldBase,
    placeholder: z.string().max(100).optional(),
    maxLength: z.int().max(4000).optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("number"),
    ...FieldBase,
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({ type: z.literal("date"), ...FieldBase, default: z.iso.date().optional() }),
  z.object({
    type: z.literal("select"),
    ...FieldBase,
    multi: z.boolean().default(false),
    options: z.array(SelectOption).min(1).max(25),
    default: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("checkbox"), ...FieldBase, default: z.boolean().optional() }),
  z.object({
    type: z.literal("radio"),
    ...FieldBase,
    options: z.array(SelectOption).min(2).max(10),
    default: z.string().optional(),
  }),
]);
export type Field = z.infer<typeof Field>;

export const Modal = z.object({
  id: ItemId,
  title: z.string().min(1).max(45),
  triggerLabel: z.string().min(1).max(80),
  fields: z.array(Field).min(1).max(5),
  allowedUsers: AllowedUsers,
});
export type Modal = z.infer<typeof Modal>;

/** refine 없는 객체. JSON Schema 변환과 파생(omit/pick)에 쓴다. */
export const ComponentsV1Base = z.object({
  id: z.string().optional(), // 서버가 저장 시 부여 (cmp_<uuid>)
  reusable: z.boolean().default(false),
  ttlMs: z.int().min(1_000).max(86_400_000).default(1_800_000),
  text: z.string().max(2000).optional(), // 컴포넌트를 못 그리는 곳의 대체 텍스트
  blocks: z.array(Block).max(10).default([]),
  modal: Modal.optional(),
});

export function collectIds(c: z.infer<typeof ComponentsV1Base>): string[] {
  const ids: string[] = [];
  for (const b of c.blocks) {
    if (b.type !== "actions") continue;
    if (b.id) ids.push(b.id);
    for (const item of b.items) ids.push(item.id);
  }
  if (c.modal) {
    ids.push(c.modal.id);
    for (const f of c.modal.fields) ids.push(f.id);
  }
  return ids;
}

export const ComponentsV1 = ComponentsV1Base.refine(
  (c) => {
    const ids = collectIds(c);
    return new Set(ids).size === ids.length;
  },
  { message: "components: 모든 id는 유일해야 함", path: ["blocks"] },
);
export type ComponentsV1 = z.infer<typeof ComponentsV1>;

export const ComponentState = z.object({ expiresAt: IsoDateTime, consumed: z.array(ItemId) });
export type ComponentState = z.infer<typeof ComponentState>;

/** 에이전트에게 노출하는 message 툴 스키마 조각 (서버 부여 id 제외) */
export function componentsToolJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ComponentsV1Base.omit({ id: true })) as Record<string, unknown>;
}
