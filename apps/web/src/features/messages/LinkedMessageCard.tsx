import { messageLinkPath } from "@dodok/shared";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { useLinkedMessage } from "./messageLink";
import { previewOf } from "./bundles";
import { useAuthors } from "./useAuthors";

const TIME = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * 링크한 메시지의 인용 카드(메시지 링크 스펙 「사람에게 보이는 카드」) — 작성자 아바타·이름, 「# 채널 · 세션 제목(· 스레드) · 시각」, 본문 첫
 * 2줄(멘션은 @핸들, 마크다운 걷음). 보는 사람 권한으로 받아 못 읽으면(null) 그리지 않는다. 누르면 그 메시지로 간다(`?m=` 주소 — 진입 길이
 * 강조한다). `onDismiss` 가 있으면 ✕ — 작성 중 미리보기만 닫는다
 */
export function LinkedMessageCard({ messageId, onDismiss }: { messageId: string; onDismiss?: () => void }) {
  const linked = useLinkedMessage(messageId);
  const { author, mention } = useAuthors();
  const navigate = useNavigate();
  const view = linked.data;
  if (!view) return null;
  const { message, channelKind, channelName, conversationTitle } = view;
  const who = author(message);
  const where = [
    channelKind === "channel" ? `# ${channelName}` : channelName,
    conversationTitle === "" ? "새 세션" : conversationTitle,
    ...(message.threadRootId === undefined ? [] : ["스레드"]),
    TIME.format(new Date(message.createdAt)),
  ].join(" · ");
  const preview = previewOf(message.bodyMd, mention, 2);
  const open = () => {
    void navigate({
      href: messageLinkPath({
        channelId: message.channelId,
        conversationId: message.conversationId,
        messageId: message.id,
        ...(message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId }),
      }),
    });
  };
  return (
    <div
      data-slot="linked-message-card"
      className="relative flex max-w-md min-w-0 rounded-md border border-l-4 border-input bg-background"
    >
      <button
        type="button"
        onClick={open}
        aria-label={`링크한 메시지 — ${who.name}: ${preview}`}
        className="flex min-w-0 flex-1 gap-2 p-2 pr-8 text-left hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <IdentityAvatar
          kind={who.isAgent ? "agent" : "person"}
          id={who.ref?.id ?? who.name}
          name={who.name}
          handle={who.handle}
          avatarUrl={who.avatarUrl}
          size={24}
          className="shrink-0"
        />
        <span className="min-w-0 flex-1 text-xs">
          <span className="block truncate">
            <span className="font-medium">{who.name}</span>{" "}
            <span className="text-muted-foreground">{where}</span>
          </span>
          {preview !== "" && (
            <span className="line-clamp-2 whitespace-pre-line text-muted-foreground">{preview}</span>
          )}
        </span>
      </button>
      {onDismiss && (
        <button
          type="button"
          aria-label="인용 미리보기 닫기"
          onClick={onDismiss}
          className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** 본문의 링크 카드 묶음 — 없으면 아무것도 그리지 않는다 */
export function LinkedMessageCards({
  ids,
  onDismiss,
  className,
}: {
  ids: readonly string[];
  onDismiss?: (id: string) => void;
  className?: string;
}) {
  if (ids.length === 0) return null;
  return (
    <div className={className ?? "flex flex-col gap-1.5"}>
      {ids.map((id) => (
        <LinkedMessageCard
          key={id}
          messageId={id}
          {...(onDismiss ? { onDismiss: () => onDismiss(id) } : {})}
        />
      ))}
    </div>
  );
}
