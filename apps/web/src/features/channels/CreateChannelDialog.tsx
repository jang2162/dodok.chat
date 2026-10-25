import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { formError as serverFormError, validationField } from "@/api/formErrors";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useCreateChannel } from "./mutations";
import { NEW_CONVERSATION } from "@/features/messages/timeline";

const FIELDS = ["name", "topic"] as const;
type Field = (typeof FIELDS)[number];

/**
 * 「채널 만들기」(스펙 6.2): 이름(필수)·주제 → `POST /channels` → `/c/<id>/s/new/settings`(곧바로 에이전트를 넣을 수 있게 — 새 채널에는 세션이 없다).
 * `children` 이 여는 버튼이다. `onCreated` 는 이동 뒤에 부른다(좁은 화면 시트 닫기)
 */
export function CreateChannelDialog({
  children,
  onCreated,
}: {
  children: ReactNode;
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [formError, setFormError] = useState<{ message: string; field?: Field }>();
  const create = useCreateChannel();
  const navigate = useNavigate();
  const nameId = useId();
  const topicId = useId();
  const errorId = useId();
  const trimmedName = name.trim();

  function clear() {
    setName("");
    setTopic("");
    setFormError(undefined);
  }

  /** 칸을 고치면 지난 서버 오류는 내린다 — 다음 제출까지 남아 고친 값에 대한 오류처럼 보이지 않게 */
  function edit(set: (value: string) => void, value: string) {
    set(value);
    setFormError(undefined);
  }

  function onOpenChange(next: boolean) {
    // 만드는 중에는 닫지 않는다 — 결과(폼 오류·이동)를 잃지 않게
    if (!next && create.isPending) return;
    setOpen(next);
    if (!next) clear();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!trimmedName || create.isPending) return;
    setFormError(undefined);
    const trimmedTopic = topic.trim();
    create.mutate(
      { name: trimmedName, ...(trimmedTopic ? { topic: trimmedTopic } : {}) },
      {
        onSuccess: (channel) => {
          setOpen(false);
          clear();
          // 새 채널에는 세션이 없다 — 새 세션 창의 설정 패널로(첫 보내기가 세션을 만든다)
          void navigate({
            to: "/c/$channelId/s/$conversationId/settings",
            params: { channelId: channel.id, conversationId: NEW_CONVERSATION },
          });
          onCreated?.();
        },
        onError: (err) => {
          const message = serverFormError(err);
          if (message !== undefined) setFormError({ message, field: validationField(message, FIELDS) });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>채널 만들기</DialogTitle>
            <DialogDescription>만든 뒤 설정 패널에서 에이전트를 넣을 수 있습니다.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={nameId}>이름</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={80}
              autoComplete="off"
              aria-invalid={formError?.field === "name" || undefined}
              aria-describedby={formError?.field === "name" ? errorId : undefined}
              onChange={(e) => edit(setName, e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={topicId}>주제</Label>
            <Input
              id={topicId}
              value={topic}
              maxLength={500}
              autoComplete="off"
              placeholder="선택"
              aria-invalid={formError?.field === "topic" || undefined}
              aria-describedby={formError?.field === "topic" ? errorId : undefined}
              onChange={(e) => edit(setTopic, e.target.value)}
            />
          </div>
          {formError && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {formError.message}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!trimmedName || create.isPending}>
              {create.isPending ? "만드는 중…" : "만들기"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
