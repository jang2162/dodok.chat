import type { Message, SystemKind } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { CircleXIcon, InfoIcon, type LucideIcon, TriangleAlertIcon } from "lucide-react";
import { useIsOwner } from "@/api/queries";
import { Components } from "@/features/components/Components";
import { cn } from "@/lib/utils";
import { MessageBody } from "./MessageBody";

const LOOK: Record<SystemKind, { Icon: LucideIcon; label: string; tone: string }> = {
  relay_limit: { Icon: TriangleAlertIcon, label: "주의", tone: "text-warning" },
  relay_denied: { Icon: TriangleAlertIcon, label: "주의", tone: "text-warning" },
  run_limit: { Icon: TriangleAlertIcon, label: "주의", tone: "text-warning" },
  run_error: { Icon: CircleXIcon, label: "오류", tone: "text-destructive" },
  info: { Icon: InfoIcon, label: "정보", tone: "text-muted-foreground" },
};

/**
 * 시스템 메시지(스펙 5.3·7.2): 가운데 정렬 얇은 카드, `systemMeta.kind` 별 아이콘·색 + 본문.
 * components 가 있으면 그 카드(relay_limit 의 「이어가기」, run_error 의 「다시 실행」 버튼 등).
 * run_limit 은 이어갈 버튼이 없고, 막은 한도(`systemMeta.limit`)가 실려 있으면 owner 에게만 운영 화면 링크를 붙인다(운영 보강 스펙 3.2)
 */
export function SystemCard({ message }: { message: Message }) {
  const { Icon, label, tone } = LOOK[message.systemMeta?.kind ?? "info"];
  const owner = useIsOwner();
  const limitLink =
    owner && message.systemMeta?.kind === "run_limit" && message.systemMeta.limit !== undefined;
  return (
    <div className="flex justify-center px-4 py-1.5">
      <div
        role="note"
        data-system-kind={message.systemMeta?.kind ?? "info"}
        className="flex max-w-[min(100%,40rem)] items-start gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"
      >
        <Icon
          role="img"
          aria-label={label}
          aria-hidden={false}
          className={cn("mt-0.5 size-4 shrink-0", tone)}
        />
        <div className="min-w-0 [&_p]:text-sm">
          <MessageBody bodyMd={message.bodyMd} />
          <Components message={message} />
          {limitLink && (
            <Link
              to="/settings/operations"
              className="mt-1 inline-block text-xs font-medium text-foreground underline underline-offset-4"
            >
              운영에서 한도 바꾸기
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
