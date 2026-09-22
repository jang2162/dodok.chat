import type { Block, Message } from "@dodok/shared";
import { useId } from "react";
import { useMe } from "@/api/queries";
import { Button } from "@/ui/button";
import { ReasonHint } from "../DisabledHint";
import { DISABLED_REASON_TEXT, itemState } from "../state";
import type { Interact } from "../useInteract";
import { ARTIFACT_PENDING, isArtifactUrl } from "./artifact";
import { SelectItem } from "./SelectItem";

const STYLE = {
  primary: "default",
  secondary: "secondary",
  success: "default",
  danger: "destructive",
} as const;

/** `https://`·`artifact://` 가 아닌 링크 버튼의 사유 — 다른 비활성 사유처럼 보이는 글로 싣는다(`ReasonHint`) */
export const LINK_BLOCKED = "열 수 없는 링크입니다";

type Props = { block: Extract<Block, { type: "actions" }>; message: Message; io: Interact; expired: boolean };

/**
 * actions 블록 — 「버튼 1~5개」 또는 「셀렉트 정확히 1개」(shared 스키마가 강제).
 * 링크 버튼은 새 탭, 그 밖의 버튼은 누르면 `component.interact`. 비활성 규칙은 `itemState` 한 곳.
 *
 * 링크 버튼도 media·file 처럼 **`https://` 만** 링크로 만든다. 계약 `SafeUrl` 이 앞에서 막지만 옛 행·느슨해진 계약이면
 * 렌더러가 마지막 방어다. 그 밖(`artifact://` 포함)은 링크 없는 비활성 버튼으로 떨어뜨린다.
 * 사유는 둘로 갈린다: `artifact://` 는 media·file 과 같은 「첨부는 곧 지원합니다」(해석은 Phase 2 ③),
 * 그 밖의 스킴·상대 주소는 「열 수 없는 링크입니다」. 같은 카드의 같은 값이 한 곳은 「곧 지원」, 다른 곳은 「열 수 없음」이면 거짓말이다
 */
export function ActionsBlock({ block, message, io, expired }: Props) {
  const meId = useMe().data?.user.id;
  const hintBase = useId();

  // 셀렉트는 블록에 홀로 있다(shared 스키마)
  const select = block.items.find((i) => i.type === "select");
  if (select)
    return <SelectItem item={select} blockId={block.id} message={message} io={io} expired={expired} />;

  const buttons = block.items.flatMap((i) => (i.type === "button" ? [i] : []));
  const rows = buttons.map((item) => {
    const label = `${item.emoji ? `${item.emoji} ` : ""}${item.label}`;
    if (item.url && !item.url.startsWith("https://")) {
      return {
        item,
        label,
        kind: "blocked" as const,
        why: isArtifactUrl(item.url) ? ARTIFACT_PENDING : LINK_BLOCKED,
      };
    }
    if (item.url) return { item, label, kind: "link" as const, why: undefined };
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
    const why = state.reason ? DISABLED_REASON_TEXT[state.reason] : undefined;
    return { item, label, kind: "button" as const, state, why };
  });

  // 사유가 같은 버튼은 줄 끝의 한 줄을 함께 가리킨다 — 만료·끊김이면 줄 전체가 같은 사유라 한 번만 보인다.
  // 사유가 둘 이상 섞이면 어느 버튼의 것인지 앞에 적는다(회색 버튼만으로는 짝을 못 짓는다)
  const hints: { id: string; text: string; labels: string[] }[] = [];
  for (const { label, why } of rows) {
    if (!why) continue;
    const found = hints.find((h) => h.text === why);
    if (found) found.labels.push(label);
    else hints.push({ id: `${hintBase}-why-${hints.length}`, text: why, labels: [label] });
  }
  const hintId = (why: string | undefined) => hints.find((h) => h.text === why)?.id;

  return (
    <div className="flex flex-wrap items-center gap-2" data-slot="actions">
      {rows.map((row) => {
        if (row.kind === "blocked") {
          return (
            <Button key={row.item.id} variant="outline" size="sm" disabled aria-describedby={hintId(row.why)}>
              {row.label}
            </Button>
          );
        }
        if (row.kind === "link") {
          return (
            <Button key={row.item.id} asChild variant="outline" size="sm">
              <a href={row.item.url} target="_blank" rel="noopener noreferrer">
                {row.label}
              </a>
            </Button>
          );
        }
        const { item, state } = row;
        return (
          <Button
            key={item.id}
            size="sm"
            variant={STYLE[item.style]}
            disabled={state.disabled}
            aria-describedby={hintId(row.why)}
            onClick={() => void io.send(item.id, {}, block.id ? { blockId: block.id } : {})}
          >
            {row.label}
          </Button>
        );
      })}
      {hints.map((h) => (
        <ReasonHint
          key={h.id}
          id={h.id}
          text={h.text}
          subject={hints.length > 1 ? h.labels.join(", ") : undefined}
        />
      ))}
    </div>
  );
}
