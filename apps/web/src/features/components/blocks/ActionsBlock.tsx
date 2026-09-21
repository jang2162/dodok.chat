import type { Block, Message } from "@dodok/shared";
import { Fragment, useId } from "react";
import { useMe } from "@/api/queries";
import { Button } from "@/ui/button";
import { DisabledHint, reasonProps } from "../DisabledHint";
import { itemState } from "../state";
import type { Interact } from "../useInteract";
import { SelectItem } from "./SelectItem";

const STYLE = {
  primary: "default",
  secondary: "secondary",
  success: "default",
  danger: "destructive",
} as const;

/** `https://` 가 아닌 링크 버튼의 사유 — title·aria-describedby 로 싣는다 */
export const LINK_BLOCKED = "열 수 없는 링크입니다";

type Props = { block: Extract<Block, { type: "actions" }>; message: Message; io: Interact; expired: boolean };

/**
 * actions 블록 — 「버튼 1~5개」 또는 「셀렉트 정확히 1개」(shared 스키마가 강제).
 * 링크 버튼은 새 탭, 그 밖의 버튼은 누르면 `component.interact`. 비활성 규칙은 `itemState` 한 곳.
 *
 * 링크 버튼도 media·file 처럼 **`https://` 만** 링크로 만든다. 계약 `SafeUrl` 이 앞에서 막지만 옛 행·느슨해진 계약이면
 * 렌더러가 마지막 방어다. 그 밖(`artifact://` 포함)은 링크 없는 비활성 버튼으로 떨어뜨린다
 */
export function ActionsBlock({ block, message, io, expired }: Props) {
  const meId = useMe().data?.user.id;
  const hintBase = useId();

  // 셀렉트는 블록에 홀로 있다(shared 스키마)
  const select = block.items.find((i) => i.type === "select");
  if (select)
    return <SelectItem item={select} blockId={block.id} message={message} io={io} expired={expired} />;

  const buttons = block.items.flatMap((i) => (i.type === "button" ? [i] : []));
  return (
    <div className="flex flex-wrap gap-2" data-slot="actions">
      {buttons.map((item) => {
        const label = `${item.emoji ? `${item.emoji} ` : ""}${item.label}`;
        const hintId = `${hintBase}-${item.id}`;
        if (item.url && !item.url.startsWith("https://")) {
          return (
            <Fragment key={item.id}>
              <Button variant="outline" size="sm" disabled title={LINK_BLOCKED} aria-describedby={hintId}>
                {label}
              </Button>
              <span id={hintId} className="sr-only">
                {LINK_BLOCKED}
              </span>
            </Fragment>
          );
        }
        if (item.url) {
          return (
            <Button key={item.id} asChild variant="outline" size="sm">
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            </Button>
          );
        }
        const state = itemState({
          message,
          connected: io.connected,
          hasSocket: io.hasSocket,
          meId,
          expired,
          busy: io.busy,
          allowedUsers: item.allowedUsers,
          itemId: item.id,
        });
        return (
          <Fragment key={item.id}>
            <Button
              size="sm"
              variant={STYLE[item.style]}
              disabled={state.disabled}
              {...reasonProps(state, hintId)}
              onClick={() => void io.send(item.id, {}, block.id ? { blockId: block.id } : {})}
            >
              {label}
            </Button>
            <DisabledHint state={state} id={hintId} />
          </Fragment>
        );
      })}
    </div>
  );
}
