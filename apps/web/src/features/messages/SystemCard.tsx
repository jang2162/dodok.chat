import type { Message, SystemKind } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { CircleXIcon, InfoIcon, type LucideIcon, TriangleAlertIcon } from "lucide-react";
import { useCanManage } from "@/api/queries";
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

const LIMIT_LINK = "mt-1 inline-block text-xs font-medium text-foreground underline underline-offset-4";

/**
 * 서버 `runErrorBody` 의 기본 갈래(`…실행이 실패했습니다: <코드>`) — 친절 문구가 없는 코드는 본문 끝에 그대로 붙어 온다.
 * 코드 꼴(`[A-Za-z0-9_:.-]+`)일 때만 떼어 「자세히」로 접는다. 친절 문구(한글·공백이 든 사유)는 꼴이 달라 그대로다.
 * 서버는 바꾸지 않는다 — 에이전트는 본문 그대로(코드까지) 받고, 옛 메시지에도 같은 규칙이 든다
 */
const RUN_ERROR_CODE = /^([\s\S]*실행이 실패했습니다): ([A-Za-z0-9_:.-]+)\s*$/;

/** run_error 본문을 사람에게 보일 글과 접어 둘 코드로 가른다 — 꼴이 다르면 코드 없이 본문 그대로 */
export function splitRunErrorBody(bodyMd: string): { body: string; code?: string } {
  const m = RUN_ERROR_CODE.exec(bodyMd);
  return m?.[1] && m[2] ? { body: m[1], code: m[2] } : { body: bodyMd };
}

/**
 * 시스템 메시지(스펙 5.3·7.2): 가운데 정렬 얇은 카드, `systemMeta.kind` 별 아이콘·색 + 본문.
 * components 가 있으면 그 카드(relay_limit 의 「이어가기」, run_error 의 「다시 실행」 버튼 등).
 * run_limit 은 이어갈 버튼이 없고, 막은 한도(`systemMeta.limit`)가 실려 있으면 admin 이상에게만 한도를 바꾸는 곳의 링크를 붙인다
 * (운영 보강 스펙 3.2 — 둘 다 admin 이상이 바꾼다, 팀 스펙 2장). 워크스페이스 상한은 운영 화면, 채널 한도는 그 채널 설정의 「릴레이 정책」에서 바꾼다
 */
export function SystemCard({ message }: { message: Message }) {
  // 이 웹보다 새 서버가 늘린 kind 는 표에 없다 — 정보 모양으로 그린다
  const { Icon, label, tone } = LOOK[message.systemMeta?.kind ?? "info"] ?? LOOK.info;
  const canManage = useCanManage();
  const limitScope =
    canManage && message.systemMeta?.kind === "run_limit" ? message.systemMeta.limit?.scope : undefined;
  const { body, code } =
    message.systemMeta?.kind === "run_error" ? splitRunErrorBody(message.bodyMd) : { body: message.bodyMd };
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
          <MessageBody bodyMd={body} />
          {code && (
            <details data-slot="run-error-code" className="mt-1 text-xs">
              <summary className="cursor-pointer select-none">자세히</summary>
              <code className="font-mono break-all">{code}</code>
            </details>
          )}
          <Components message={message} />
          {limitScope === "workspace" && (
            <Link to="/settings/operations" className={LIMIT_LINK}>
              운영에서 한도 바꾸기
            </Link>
          )}
          {limitScope === "channel" && (
            <Link
              to="/c/$channelId/s/$conversationId/settings"
              params={{ channelId: message.channelId, conversationId: message.conversationId }}
              className={LIMIT_LINK}
            >
              채널 설정에서 한도 바꾸기
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
