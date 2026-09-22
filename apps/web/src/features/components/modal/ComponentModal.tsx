import type { Message, Modal } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { useMe } from "@/api/queries";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { FieldError } from "@/ui/field-error";
import { DisabledHint, reasonProps } from "../DisabledHint";
import { itemState } from "../state";
import type { Interact } from "../useInteract";
import { ModalField, unreadableFieldIds } from "./fields";
import {
  byFieldId,
  type FieldValues,
  initialValues,
  issueFieldIds,
  submitValues,
  validateFields,
} from "./validate";

/** 서버가 VALIDATION 으로 가리킨 칸의 문구 — 서버의 zod 문구(영문)를 그대로 내지 않는다(스펙 6장) */
const SERVER_REJECTED = "받아들일 수 없는 값입니다";

type Props = { modal: Modal; message: Message; io: Interact; expired: boolean };

/**
 * 모달(스펙 5.4) — `triggerLabel` 버튼이 `ui/dialog` 를 연다. 초점 가둠·Esc·트리거 복귀는 Radix Dialog 가 한다.
 * 제출은 화면 검사(validate.ts) → `values: { fields }`. 성공하면 닫고, ack 오류는 **토스트가 아니라 대화상자 안**에 보인다
 * (대화상자가 토스트를 가린다, 스펙 6장): `details.issues` 가 가리키는 칸 아래, 못 가리키면 하단 한 줄
 */
export function ComponentModal({ modal, message, io, expired }: Props) {
  const meId = useMe().data?.user.id;
  const hintId = useId();
  const submitHintId = `${hintId}-submit`;
  const formErrorId = `${hintId}-form`;
  const [open, setOpen] = useState(false);
  // 칸 id 로 찾는 둘은 늘 byFieldId — 칸 id 가 「__proto__」「constructor」여도 상속된 것을 읽지 않게
  const [values, setValues] = useState<FieldValues>(() => byFieldId());
  const [errors, setErrors] = useState<Record<string, string>>(() => byFieldId());
  const [formError, setFormError] = useState<string>();

  const state = itemState({
    message,
    connected: io.connected,
    hasSocket: io.hasSocket,
    meId,
    expired,
    busy: io.busy,
    allowedUsers: modal.allowedUsers,
    itemId: modal.id,
  });
  const busy = io.busy.has(modal.id);

  function onOpenChange(next: boolean) {
    // 보내는 중에는 닫지 않는다 — ack 오류를 보일 자리를 잃지 않게
    if (!next && busy) return;
    // 열 때마다 처음 값 — 지난번에 쓰다 만 값·오류를 남기지 않는다
    if (next) {
      setValues(initialValues(modal.fields));
      setErrors(byFieldId());
      setFormError(undefined);
    }
    setOpen(next);
  }

  /** 칸을 고치면 그 칸의 오류와 하단 줄은 내린다 — 다음 제출까지 남아 고친 값에 대한 오류처럼 보이지 않게 */
  function edit(fieldId: string, value: unknown) {
    setValues((v) => byFieldId([...Object.entries(v), [fieldId, value]]));
    setErrors((e) => byFieldId(Object.entries(e).filter(([id]) => id !== fieldId)));
    setFormError(undefined);
  }

  async function submit(unreadable: string[]) {
    if (state.disabled) return;
    const found = validateFields(modal.fields, values, unreadable);
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;
    const r = await io.send(modal.id, { fields: submitValues(modal.fields, values) }, { toast: false });
    if (r.ok) {
      setOpen(false);
      return;
    }
    const ids = r.code === "VALIDATION" ? issueFieldIds(modal.fields, r.details) : [];
    if (ids.length > 0) setErrors(byFieldId(ids.map((id) => [id, SERVER_REJECTED])));
    else setFormError(r.text);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 못 읽는 입력은 화면 값에 남지 않는다 — 제출하는 순간 칸에서 읽는다
    void submit(unreadableFieldIds(e.currentTarget));
  }

  // 「제출」의 설명: 잠긴 사유 + 하단 오류 줄
  const submitDescribedBy =
    [state.reason ? submitHintId : undefined, formError ? formErrorId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="modal-trigger">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button size="sm" variant="secondary" disabled={state.disabled} {...reasonProps(state, hintId)}>
            {modal.triggerLabel}
          </Button>
        </DialogTrigger>
        {/* 계약에 모달 설명이 없다 — Radix 의 Description 경고를 끈다 */}
        <DialogContent closeDisabled={busy} aria-describedby={undefined}>
          {/* 검사는 validate.ts 가 한다 — 브라우저 기본 검사(min·max 등)가 제출을 가로채지 않게 */}
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{modal.title}</DialogTitle>
            </DialogHeader>
            {modal.fields.map((f) => (
              <ModalField
                key={f.id}
                field={f}
                value={values[f.id]}
                error={errors[f.id]}
                onChange={(v) => edit(f.id, v)}
              />
            ))}
            <FieldError id={formErrorId} className="empty:-mt-4">
              {formError}
            </FieldError>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  취소
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={state.disabled}
                {...reasonProps(state, submitHintId)}
                aria-describedby={submitDescribedBy}
              >
                제출
              </Button>
              <DisabledHint state={state} id={submitHintId} />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DisabledHint state={state} id={hintId} />
    </div>
  );
}
