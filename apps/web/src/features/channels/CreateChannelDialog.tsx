import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
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

/** 폼 안에 그리는 오류(스펙 8장) — 이 둘은 전역 토스트에서 저절로 빠진다. 그 밖은 토스트가 알린다 */
const isFormError = (e: unknown): e is ApiRequestError =>
  e instanceof ApiRequestError && (e.code === "VALIDATION" || e.code === "CONFLICT");

/**
 * 「채널 만들기」(스펙 6.2): 이름(필수)·주제 → `POST /channels` → `/c/<id>/settings`(곧바로 에이전트를 넣을 수 있게).
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
  const [formError, setFormError] = useState<string>();
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
          void navigate({ to: "/c/$channelId/settings", params: { channelId: channel.id } });
          onCreated?.();
        },
        onError: (err) => {
          if (isFormError(err)) setFormError(err.message);
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
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? errorId : undefined}
              onChange={(e) => setName(e.target.value)}
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
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
          {formError && (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {formError}
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
