import type { Block, Message } from "@dodok/shared";
import { Fragment, useId } from "react";
import { useMe } from "@/api/queries";
import { Button } from "@/ui/button";
import { DisabledHint, reasonProps } from "../DisabledHint";
import { itemState } from "../state";
import type { Interact } from "../useInteract";

const STYLE = {
  primary: "default",
  secondary: "secondary",
  success: "default",
  danger: "destructive",
} as const;

type Props = { block: Extract<Block, { type: "actions" }>; message: Message; io: Interact; expired: boolean };

/**
 * actions 블록 — 「버튼 1~5개」 또는 「셀렉트 정확히 1개」(shared 스키마가 강제).
 * 링크 버튼은 새 탭, 그 밖의 버튼은 누르면 `component.interact`. 비활성 규칙은 `itemState` 한 곳
 */
export function ActionsBlock({ block, message, io, expired }: Props) {
  const meId = useMe().data?.user.id;
  const hintBase = useId();

  // 태스크 3: 셀렉트 — 셀렉트는 블록에 홀로 있다. 여기서 <SelectItem> 을 그린다
  if (block.items.some((i) => i.type === "select")) return null;

  const buttons = block.items.flatMap((i) => (i.type === "button" ? [i] : []));
  return (
    <div className="flex flex-wrap gap-2" data-slot="actions">
      {buttons.map((item) => {
        const label = `${item.emoji ? `${item.emoji} ` : ""}${item.label}`;
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
        const hintId = `${hintBase}-${item.id}`;
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
