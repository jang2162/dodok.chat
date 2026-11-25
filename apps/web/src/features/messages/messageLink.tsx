import { type Message, messageLinkPath } from "@dodok/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { LinkIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, ApiRequestError } from "@/api/http";
import { cn } from "@/lib/utils";
import { requestJump } from "./jumpTarget";

export const LINK_COPIED = "링크를 복사했습니다";
export const LINK_UNREADABLE = "볼 수 없는 메시지입니다";

/** `GET /api/v1/messages/:id` 의 응답(메시지 링크 스펙 「주소」) */
export type LinkedMessageView = {
  message: Message;
  channelKind: "channel" | "dm" | "direct";
  channelName: string;
  conversationTitle: string;
};

/**
 * 링크한 메시지 하나 — 키 `["message", id]`, 못 읽거나 없으면(404) null. 카드·주소 진입이 같은 캐시를 쓴다. 오류는 부르는 자리가 그린다
 * (카드는 그리지 않고, 진입은 토스트) — 전역 토스트를 끈다
 */
export const linkedMessageQuery = (id: string) =>
  queryOptions({
    queryKey: ["message", id] as const,
    queryFn: async (): Promise<LinkedMessageView | null> => {
      try {
        return await api<LinkedMessageView>("GET", `/messages/${id}`);
      } catch (e) {
        if (e instanceof ApiRequestError && (e.status === 404 || e.status === 400)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
    meta: { silent: true },
  });

export const useLinkedMessage = (id: string) => useQuery(linkedMessageQuery(id));

/** 그 메시지를 여는 주소 — 지금 웹 오리진 + `messageLinkPath` */
export function messageLinkUrl(
  m: Pick<Message, "id" | "channelId" | "conversationId" | "threadRootId">,
): string {
  return `${window.location.origin}${messageLinkPath({
    channelId: m.channelId,
    conversationId: m.conversationId,
    messageId: m.id,
    ...(m.threadRootId === undefined ? {} : { threadRootId: m.threadRootId }),
  })}`;
}

/** 복사에 실패하면 띄우는 읽기 전용 칸 — 뜨자마자 주소 전체가 선택돼 사람이 바로 복사한다 */
function SelectedUrl({ url }: { url: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      readOnly
      aria-label="메시지 링크"
      value={url}
      onFocus={(e) => e.currentTarget.select()}
      className="mt-1 w-full rounded border bg-background px-2 py-1 font-mono text-xs"
    />
  );
}

/**
 * 「링크 복사」(메시지 링크 스펙 「복사 자리」) — 누른 핸들러 안에서 클립보드에 쓴다. 권한·비보안 출처로 실패하면 주소를 선택된 읽기
 * 전용 칸으로 띄운다
 */
export async function copyMessageLink(
  m: Pick<Message, "id" | "channelId" | "conversationId" | "threadRootId">,
): Promise<void> {
  const url = messageLinkUrl(m);
  try {
    await navigator.clipboard.writeText(url);
    toast.success(LINK_COPIED, { id: "message-link-copy" });
  } catch {
    toast("링크를 복사하지 못했습니다 — 아래 주소를 복사하세요", {
      id: "message-link-copy",
      description: <SelectedUrl url={url} />,
      duration: 15_000,
    });
  }
}

/**
 * `?m=<메시지>` 주소로 들어오면(메시지 링크 스펙 「주소」) 그 메시지를 받아 결과로 가기와 같은 길(`requestJump`)로 그 자리에 가서
 * 강조하고, 주소에서 `m` 을 지운다(기록을 바꿔 쓴다 — 뒤로 가기·새로고침이 다시 뛰지 않게). 주소의 채널·대화와 응답이 다르면 응답을
 * 따른다. 못 읽으면 「볼 수 없는 메시지입니다」 뒤 그 주소의 대화만 연다
 */
export function useMessageLinkEntry(): void {
  const m = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown>).m,
  });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  useEffect(() => {
    if (typeof m !== "string" || m === "") return;
    let live = true;
    const stripM = () => {
      const { pathname, search } = router.state.location;
      const { m: _, ...rest } = search as Record<string, unknown>;
      void navigate({ to: pathname, search: rest as never, replace: true });
    };
    void qc
      .fetchQuery(linkedMessageQuery(m))
      .catch(() => null)
      .then((found) => {
        if (!live) return;
        if (!found?.message) {
          toast.error(LINK_UNREADABLE, { id: "message-link-open" });
          stripM();
          return;
        }
        const msg = found.message;
        requestJump({
          conversationId: msg.conversationId,
          messageId: msg.id,
          seq: msg.seq,
          ...(msg.threadRootId === undefined ? {} : { threadRootId: msg.threadRootId }),
        });
        const params = { channelId: msg.channelId, conversationId: msg.conversationId };
        const { view } = router.state.location.search as { view?: unknown };
        if (msg.threadRootId === undefined)
          void navigate({ to: "/c/$channelId/s/$conversationId", params, replace: true });
        else
          void navigate({
            to: "/c/$channelId/s/$conversationId/t/$rootId",
            params: { ...params, rootId: msg.threadRootId },
            search: view === "main" ? { view: "main" } : {},
            replace: true,
          });
      });
    return () => {
      live = false;
    };
  }, [m, qc, navigate, router]);
}

/**
 * 메시지 동작 줄의 🔗 「링크 복사」 — 반응 추가·스레드 답하기와 같은 꼴로, 마우스를 올리거나 행 안에 초점이 있을 때 나타나고 마우스가 없는
 * 기기에서는 늘 보인다. 자리(`right-*`)는 부르는 쪽이 준다
 */
export function CopyLinkButton({
  message,
  className,
}: {
  message: Pick<Message, "id" | "channelId" | "conversationId" | "threadRootId">;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="링크 복사"
      title="링크 복사"
      data-slot="copy-message-link"
      onClick={() => void copyMessageLink(message)}
      className={cn(
        "absolute top-1 inline-flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground opacity-0 shadow-xs group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [@media(hover:none)]:opacity-100",
        className,
      )}
    >
      <LinkIcon className="size-4" aria-hidden />
    </button>
  );
}
