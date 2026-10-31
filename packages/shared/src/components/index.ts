import { z } from "zod";
import { Id, IsoDateTime } from "../common";

const ITEM_ID_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * 쓰기 경계가 거절하는 id — 서버가 id 를 객체 키로 써서 상속 값을 읽거나 프로토타입 세터를 탄다
 * (Object.prototype 의 다른 이름은 대문자가 섞여 정규식에 안 걸린다).
 */
export function isReservedItemId(id: string): boolean {
  return id === "constructor" || id === "__proto__";
}

// 에이전트 출력·서버 저장이 쓰는 id. refine 이라 JSON Schema 의 pattern 은 그대로다.
export const ItemId = z
  .string()
  .regex(ITEM_ID_RE)
  .refine((id) => !isReservedItemId(id), {
    message: "id 로 constructor·__proto__ 는 쓸 수 없다",
  });
/**
 * 저장된 행을 읽을 때의 id — 두 이름도 받는다. 거절 전에 저장된 카드가 있을 수 있고,
 * 그 행 하나가 그 메시지가 든 페이지 전체를 500 으로 만들면 안 된다. 쓰는 자리에는 쓰지 않는다.
 */
export const StoredItemId = z.string().regex(ITEM_ID_RE);
export const SafeUrl = z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/);
const AllowedUsers = z.array(Id).max(50).optional();

export const SelectOption = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  description: z.string().max(100).optional(),
  emoji: z.string().max(8).optional(),
});
export type SelectOption = z.infer<typeof SelectOption>;

export const SectionBlock = z.object({ type: z.literal("section"), text: z.string().min(1).max(2000) });
export const SeparatorBlock = z.object({ type: z.literal("separator") });
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

/**
 * id 를 품는 스키마 묶음 — 쓰기(ItemId, strict)와 읽기(StoredItemId)가 다르다.
 * strict 는 쓰기에만 거는 제약(셀렉트의 빈 placeholder·채울 수 없는 min/max)이다. 읽기에 걸면
 * 그 제약 전에 저장된 카드 하나가 그 메시지가 든 페이지 전체를 500 으로 만든다(StoredItemId 와 같은 까닭).
 */
function withItemId(itemId: typeof StoredItemId, { strict }: { strict: boolean }) {
  const Button = z.object({
    type: z.literal("button"),
    id: itemId,
    label: z.string().min(1).max(80),
    style: z.enum(["primary", "secondary", "success", "danger"]).default("secondary"),
    emoji: z.string().max(8).optional(),
    url: SafeUrl.optional(), // 링크 버튼: 상호작용 없음
    allowedUsers: AllowedUsers,
  });

  const SelectBase = z.object({
    type: z.literal("select"),
    id: itemId,
    // 빈 placeholder 는 결과 문구의 이름 자리를 비운다 — 읽는 쪽은 placeholder || id 로 버틴다
    placeholder: (strict ? z.string().min(1).max(150) : z.string().max(150)).optional(),
    multi: z.boolean().default(false),
    minValues: z.int().min(0).max(25).optional(),
    maxValues: z.int().min(1).max(25).optional(),
    options: z.array(SelectOption).min(1).max(25),
    allowedUsers: AllowedUsers,
  });
  // 채울 수 없는 셀렉트(「보내기」가 영영 안 켜진다)를 쓰는 자리에서 곧바로 거절한다.
  // z.toJSONSchema 는 refine 을 싣지 않으므로 에이전트에게는 도구 설명 문장이 이 규칙을 알린다.
  const Select = strict
    ? SelectBase.refine(
        (s) =>
          (s.minValues === undefined || s.minValues <= (s.maxValues ?? s.options.length)) &&
          (s.maxValues === undefined || s.maxValues <= s.options.length) &&
          (s.multi || s.minValues === undefined || s.minValues <= 1),
        {
          message: "select: minValues ≤ maxValues ≤ options 수, 단일 선택이면 minValues ≤ 1",
          path: ["minValues"],
        },
      )
    : SelectBase;

  const ActionsBlock = z
    .object({
      type: z.literal("actions"),
      id: itemId.optional(),
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

  const Block = z.discriminatedUnion("type", [
    SectionBlock,
    SeparatorBlock,
    ActionsBlock,
    MediaBlock,
    FileBlock,
  ]);

  const FieldBase = { id: itemId, label: z.string().min(1).max(45), required: z.boolean().default(false) };
  const Field = z.discriminatedUnion("type", [
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

  const Modal = z.object({
    id: itemId,
    title: z.string().min(1).max(45),
    triggerLabel: z.string().min(1).max(80),
    fields: z.array(Field).min(1).max(5),
    allowedUsers: AllowedUsers,
  });

  /** refine 없는 객체. JSON Schema 변환과 파생(omit/pick)에 쓴다. */
  const ComponentsV1Base = z.object({
    id: z.string().optional(), // 서버가 저장 시 부여 (cmp_<uuid>)
    reusable: z.boolean().default(false),
    ttlMs: z.int().min(1_000).max(86_400_000).default(1_800_000),
    text: z.string().max(2000).optional(), // 컴포넌트를 못 그리는 곳의 대체 텍스트
    blocks: z.array(Block).max(10).default([]),
    modal: Modal.optional(),
  });

  const ComponentsV1 = ComponentsV1Base.refine(
    (c) => {
      const ids = collectIds(c);
      return new Set(ids).size === ids.length;
    },
    { message: "components: 모든 id는 유일해야 함", path: ["blocks"] },
  );

  const ComponentState = z.object({ expiresAt: IsoDateTime, consumed: z.array(itemId) });

  return {
    Button,
    Select,
    ActionsBlock,
    Block,
    Field,
    Modal,
    ComponentsV1Base,
    ComponentsV1,
    ComponentState,
  };
}

const write = withItemId(ItemId, { strict: true });
const stored = withItemId(StoredItemId, { strict: false });

export const Button = write.Button;
export type Button = z.infer<typeof Button>;
export const Select = write.Select;
export type Select = z.infer<typeof Select>;
export const ActionsBlock = write.ActionsBlock;
export const Block = write.Block;
export type Block = z.infer<typeof Block>;
export const Field = write.Field;
export type Field = z.infer<typeof Field>;
export const Modal = write.Modal;
export type Modal = z.infer<typeof Modal>;
export const ComponentsV1Base = write.ComponentsV1Base;
export const ComponentsV1 = write.ComponentsV1;
export type ComponentsV1 = z.infer<typeof ComponentsV1>;
export const ComponentState = write.ComponentState;
export type ComponentState = z.infer<typeof ComponentState>;
/** 저장된 행 읽기 전용(StoredItemId) — 타입은 ComponentsV1·ComponentState 와 같다 */
export const StoredComponentsV1 = stored.ComponentsV1;
export const StoredComponentState = stored.ComponentState;

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

/** 에이전트에게 노출하는 message 툴 스키마 조각 (서버 부여 id 제외) */
export function componentsToolJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ComponentsV1Base.omit({ id: true }), { io: "input" }) as Record<string, unknown>;
}
