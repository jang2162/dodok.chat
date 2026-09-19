import type { Block, Button as ButtonItem, Message } from "@dodok/shared";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMe } from "@/api/queries";
import { emitAck, useWireStatus, WireAckError } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";

const STYLE = {
  primary: "default",
  secondary: "secondary",
  success: "default",
  danger: "destructive",
} as const;
/** component.interact ack 오류(스펙 5.4). wire 오류는 REST 전역 토스트 밖이라 여기서 알린다 */
const ERR: Partial<Record<string, string>> = {
  EXPIRED: "만료된 버튼입니다",
  CONSUMED: "이미 처리된 버튼입니다",
  FORBIDDEN: "이 버튼을 누를 권한이 없습니다",
  VALIDATION: "처리할 수 없는 요청입니다",
  TIMEOUT: "서버 응답이 없습니다",
};
const UNSUPPORTED = "이 메시지의 입력 요소는 Phase 2 에서 지원합니다";
/** 만료 시각에 다시 그리는 타이머의 상한(setTimeout 최대 지연 약 24.8일) */
const MAX_TIMER_MS = 2_147_483_647;

type ButtonBlock = { id?: string | undefined; items: ButtonItem[] };
/** 버튼만 든 actions 블록(Phase 1 이 그리는 것) */
function buttonBlock(b: Block): ButtonBlock | undefined {
  if (b.type !== "actions") return undefined;
  const items = b.items.flatMap((i) => (i.type === "button" ? [i] : []));
  return items.length === b.items.length ? { id: b.id, items } : undefined;
}

/** 만료 시각이 지나면 한 번 다시 그린다 */
function useExpired(expiresAt: string | undefined): boolean {
  const at = expiresAt ? Date.parse(expiresAt) : Number.POSITIVE_INFINITY;
  const [expired, setExpired] = useState(() => at <= Date.now());
  useEffect(() => {
    const left = at - Date.now();
    setExpired(left <= 0);
    if (left <= 0 || left > MAX_TIMER_MS) return;
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [at]);
  return expired;
}

/**
 * components v1 중 actions 블록의 버튼만 그린다(스펙 5.4) — 그 밖의 블록·모달은 자리표시 한 줄.
 * 누르면 `component.interact`, 소비 상태는 서버의 `message.updated` 로 바뀐다.
 * 소비된 아이템·만료·allowedUsers 밖·wire 미연결·응답 대기 중이면 비활성
 */
export function ActionButtons({ message }: { message: Message }) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const me = useMe().data?.user.id;
  const expired = useExpired(message.componentState?.expiresAt);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const c = message.components;
  if (!c) return null;

  const componentId = c.id;
  const consumed = new Set(message.componentState?.consumed ?? []);
  const buttonBlocks = c.blocks.flatMap((b) => buttonBlock(b) ?? []);
  const unsupported = c.modal !== undefined || buttonBlocks.length < c.blocks.length;

  function interact(block: ButtonBlock, item: ButtonItem) {
    if (!socket || !componentId) return;
    setBusy((s) => new Set(s).add(item.id));
    emitAck(socket, "component.interact", {
      messageId: message.id,
      componentId,
      ...(block.id ? { blockId: block.id } : {}),
      itemId: item.id,
      values: {},
    })
      .catch((e: unknown) => {
        if (e instanceof WireAckError) toast.error(ERR[e.code] ?? e.message);
      })
      .finally(() =>
        setBusy((s) => {
          const next = new Set(s);
          next.delete(item.id);
          return next;
        }),
      );
  }

  const blocked = (item: ButtonItem) =>
    !socket ||
    !connected ||
    !componentId ||
    expired ||
    consumed.has(item.id) ||
    busy.has(item.id) ||
    (item.allowedUsers !== undefined && (me === undefined || !item.allowedUsers.includes(me)));

  return (
    <div className="mt-2 flex flex-col gap-2">
      {buttonBlocks.map((block, bi) => (
        <div key={block.id ?? bi} className="flex flex-wrap gap-2">
          {block.items.map((item) => {
            const label = `${item.emoji ? `${item.emoji} ` : ""}${item.label}`;
            return item.url ? (
              <Button key={item.id} asChild variant="outline" size="sm">
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              </Button>
            ) : (
              <Button
                key={item.id}
                size="sm"
                variant={STYLE[item.style]}
                disabled={blocked(item)}
                onClick={() => interact(block, item)}
              >
                {label}
              </Button>
            );
          })}
        </div>
      ))}
      {unsupported && <p className="text-sm text-muted-foreground">{UNSUPPORTED}</p>}
    </div>
  );
}
