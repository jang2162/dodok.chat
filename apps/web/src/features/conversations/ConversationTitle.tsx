import { type Conversation, ConversationTitle as TitleSchema } from "@dodok/shared";
import { CircleSlashIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { formError } from "@/api/formErrors";
import { useChannelArchived } from "@/features/channels/archived";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
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
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { usePatchConversation } from "./mutations";
import { useConversationPermissions } from "./permissions";
import { useConversationView } from "./queries";

/** 새 세션 창의 머리 — 첫 보내기가 세션을 만들기 전이다(채널 세션 스펙 결정 7) */
export const NEW_SESSION_TITLE = "새 세션";

/**
 * 세션 머리의 지금 세션 제목(채널 세션 스펙 「웹」 장). 바꿀 권한이 있으면(만든 사람·세션 관리자·admin 이상) 제목이 「이름 바꾸기」
 * 대화상자를 여는 버튼이고, 없으면 글자일 뿐이다(보관한 채널도 — 서버가 409). 닫힌 세션은 「닫힘」 표를 단다. 아직 못 받았으면 아무것도
 * 그리지 않는다
 */
export function ConversationTitle({
  channelId,
  conversationId,
}: {
  channelId: string;
  conversationId: string;
}) {
  const conversation = useConversationView(conversationId).data;
  const { canManage } = useConversationPermissions(channelId);
  const archived = useChannelArchived();
  if (conversationId === NEW_CONVERSATION)
    return <span className="truncate text-muted-foreground">{NEW_SESSION_TITLE}</span>;
  if (!conversation) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {canManage(conversation) && !archived ? (
        <RenameDialog conversation={conversation} />
      ) : (
        <span data-testid="conversation-title" className="truncate">
          {conversation.title}
        </span>
      )}
      {conversation.closedAt !== undefined && (
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
          닫힘
        </span>
      )}
    </span>
  );
}

/** 제목 버튼 + 「이름 바꾸기」 대화상자. 트리거라 닫으면 Radix 가 초점을 제목 버튼으로 돌려준다 */
function RenameDialog({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [error, setError] = useState<string>();
  const patch = usePatchConversation(conversation.id);
  const id = useId();

  function change(next: boolean) {
    if (!next && patch.isPending) return;
    if (next) {
      setDraft(conversation.title);
      setError(undefined);
    }
    setOpen(next);
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (patch.isPending) return;
    const parsed = TitleSchema.safeParse(draft);
    if (!parsed.success) {
      setError("제목은 1~80자로 씁니다");
      return;
    }
    if (parsed.data === conversation.title) {
      setOpen(false);
      return;
    }
    patch.mutate(
      { title: parsed.data },
      { onSuccess: () => setOpen(false), onError: (err) => setError(formError(err)) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="conversation-title"
          title="세션 이름 바꾸기"
          className="min-w-0 truncate rounded-sm text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {conversation.title}
        </button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>세션 이름 바꾸기</DialogTitle>
            <DialogDescription>이 채널의 모든 사람에게 바뀐 이름이 보입니다.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Input
              aria-label="세션 제목"
              value={draft}
              maxLength={80}
              autoFocus
              aria-invalid={error !== undefined || undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(undefined);
              }}
            />
            <FieldError id={`${id}-error`}>{error}</FieldError>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={patch.isPending} onClick={() => change(false)}>
              취소
            </Button>
            <Button type="submit" disabled={patch.isPending}>
              {patch.isPending ? "저장하는 중…" : "저장"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 머리의 「세션 닫기」 — 바꿀 권한이 있고 열린 세션일 때만(보관한 채널은 아니다). 닫으면 그 세션의 진행 중인 실행이 멈추므로 한 번 묻는다. 닫히면 이 단추와
 * 대화상자가 함께 사라진다 — 초점은 작성기 자리의 안내(`ClosedNotice`)가 받는다
 */
export function CloseConversationButton({
  channelId,
  conversationId,
}: {
  channelId: string;
  conversationId: string;
}) {
  const conversation = useConversationView(conversationId).data;
  const { canManage } = useConversationPermissions(channelId);
  const patch = usePatchConversation(conversationId);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const archived = useChannelArchived();
  if (!conversation || conversation.closedAt !== undefined || archived || !canManage(conversation))
    return null;
  return (
    <>
      <Button
        ref={opener}
        variant="ghost"
        size="icon-sm"
        aria-label="세션 닫기"
        title="세션 닫기"
        onClick={() => setOpen(true)}
      >
        <CircleSlashIcon />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="세션 닫기"
        description={`「${conversation.title}」 세션을 닫습니다. 진행 중인 실행은 멈추고, 닫힌 세션은 읽기만 됩니다. 다시 열 수 있습니다.`}
        confirmLabel="세션 닫기"
        pendingLabel="닫는 중…"
        pending={patch.isPending}
        returnFocus={opener}
        onConfirm={() => patch.mutate({ closed: true }, { onSuccess: () => setOpen(false) })}
      />
    </>
  );
}
