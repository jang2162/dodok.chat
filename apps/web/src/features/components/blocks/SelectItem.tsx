import type { Message, Select } from "@dodok/shared";
import { useId, useState } from "react";
import { useMe } from "@/api/queries";
import { Button } from "@/ui/button";
import { DisabledHint, reasonProps } from "../DisabledHint";
import { OptionList, withinBounds } from "../OptionList";
import { itemState } from "../state";
import type { Interact } from "../useInteract";

type Props = {
  item: Select;
  /** actions 블록의 id — 있으면 component.interact 에 싣는다 */
  blockId: string | undefined;
  message: Message;
  io: Interact;
  expired: boolean;
};

/** 「보내기」가 꺼진 까닭 — 아직 덜 골랐다(더 고른 것은 OptionList 가 잠가 막는다) */
const pickMore = (min: number) => (min === 1 ? "하나를 고르세요" : `${min}개 이상 고르세요`);

/**
 * 셀렉트 하나(스펙 5.3) — 옵션을 고르고 「보내기」로 확정한다(스펙 결정 6).
 * 개수 경계는 서버 valuesSchemaFor 와 같다. 비활성이면 목록과 「보내기」가 함께 잠긴다
 */
export function SelectItem({ item, blockId, message, io, expired }: Props) {
  const meId = useMe().data?.user.id;
  const hintId = useId();
  const pickId = `${hintId}-pick`;
  const [picked, setPicked] = useState<string[]>([]);

  const min = item.minValues ?? (item.multi ? 0 : 1);
  const max = item.multi ? (item.maxValues ?? 25) : 1;
  const state = itemState({
    message,
    connected: io.connected,
    hasSocket: io.hasSocket,
    archived: io.archived,
    closed: io.closed,
    dmReadOnly: io.dmReadOnly,
    meId,
    expired,
    busy: io.busy,
    allowedUsers: item.allowedUsers,
    itemId: item.id,
  });
  const ready = withinBounds(picked.length, min, max);
  // 잠긴 사유가 먼저다 — 잠긴 카드에 「고르세요」를 내지 않는다
  const pickHint = !state.reason && !ready;

  return (
    <div className="flex flex-col gap-2" data-slot="select">
      <OptionList
        name={item.placeholder ?? ""}
        options={item.options}
        multi={item.multi}
        value={picked}
        onChange={setPicked}
        disabled={state.disabled}
        describedBy={state.reason ? hintId : undefined}
        max={max}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={state.disabled || !ready}
          {...reasonProps(state, hintId)}
          {...(pickHint ? { "aria-describedby": pickId } : {})}
          onClick={() => void io.send(item.id, { values: picked }, blockId ? { blockId } : {})}
        >
          보내기
        </Button>
        <DisabledHint state={state} id={hintId} />
        {/* 덜 고른 것은 보이게 말한다 — 더 고른 것은 OptionList 가 잠가 막고 「최대」 줄로 말한다 */}
        {pickHint && (
          <span id={pickId} className="text-xs text-muted-foreground">
            {pickMore(min)}
          </span>
        )}
      </div>
    </div>
  );
}
