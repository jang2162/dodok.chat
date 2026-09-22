import {
  type Block,
  type ComponentsV1,
  INTERACTIONS_MAX,
  type Message,
  type MessageInteraction,
} from "@dodok/shared";
import { useEffect, useRef, useState } from "react";
import { useAuthors } from "@/features/messages/useAuthors";
import { ActionsBlock } from "./blocks/ActionsBlock";
import { FileBlock } from "./blocks/FileBlock";
import { MediaBlock } from "./blocks/MediaBlock";
import { SectionBlock } from "./blocks/SectionBlock";
import { SeparatorBlock } from "./blocks/SeparatorBlock";
import { oldestFirst, summarize } from "./interactions";
import { type Interact, useInteract } from "./useInteract";
import { ComponentModal } from "./modal/ComponentModal";

/** 만료 시각에 다시 그리는 타이머의 상한(setTimeout 최대 지연 약 24.8일) */
const MAX_TIMER_MS = 2_147_483_647;

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

type BlockProps = { block: Block; message: Message; io: Interact; expired: boolean };

/** 블록 하나 — 다섯 종류를 모두 그린다(스펙 5.2) */
function BlockView({ block, message, io, expired }: BlockProps) {
  switch (block.type) {
    case "actions":
      return <ActionsBlock block={block} message={message} io={io} expired={expired} />;
    case "section":
      return <SectionBlock block={block} />;
    case "separator":
      return <SeparatorBlock />;
    case "media":
      return <MediaBlock block={block} />;
    case "file":
      return <FileBlock block={block} />;
  }
}

/** 결과 줄의 사람을 못 풀 때(다른 사람·지워진 사용자) */
export const UNKNOWN_USER = "알 수 없는 사용자";

type LogProps = {
  components: ComponentsV1;
  interactions: readonly MessageInteraction[];
  /** 초점을 옮길 줄의 상호작용 id — `Interact.focusId` */
  focusId: string | undefined;
  onFocused(): void;
};

/**
 * 결과 줄(스펙 5.6) — 누가 무엇을 보냈는지, 오래된 것부터 `@<핸들> — <itemLabel>: <valueText>`.
 * `summarize` 가 못 푸는 줄(카드가 편집됨)은 건너뛴다. 서버가 싣는 상한에 닿으면 「최근 20건」 — 정확히 20건일 때도 나온다(알고 받는 비용, 스펙 3장).
 *
 * 결정 뒤 초점(Phase 2 ① D13): 누른 버튼·셀렉트는 잠기거나 모달이 닫히며 초점이 `<body>` 로 떨어진다 — **내가 보낸** 상호작용의
 * 줄이 그려지면 그리로 옮긴다. 표식은 ack 이 돌려준 그 상호작용의 id 라 다른 사람이 보낸 줄·만료는 초점을 뺏지 않는다.
 * 줄이 ack 보다 먼저 와도(서버는 message.updated 를 먼저 낸다) 뒤에 와도 옮긴다
 */
function InteractionLog({ components, interactions, focusId, onFocused }: LogProps) {
  const { mention } = useAuthors();
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!focusId) return;
    const line = Array.from(listRef.current?.children ?? []).find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.interactionId === focusId,
    );
    if (!line) return;
    line.focus();
    onFocused();
  }, [focusId, onFocused, interactions]);

  const rows = oldestFirst(interactions).flatMap((ix) => {
    const s = summarize(components, ix);
    return s ? [{ ix, s }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <div data-slot="interaction-log" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <ul ref={listRef} aria-label="상호작용 기록" className="flex flex-col gap-0.5">
        {rows.map(({ ix, s }) => {
          const handle = mention("u", ix.userId);
          return (
            // 결정 뒤 초점이 오는 자리라 tabIndex={-1}(탭 차례에는 안 든다) — 테두리는 :focus-visible 에서만(승인 카드와 같다)
            <li
              key={ix.id}
              data-interaction-id={ix.id}
              tabIndex={-1}
              className="rounded-xs break-words focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {handle ? `@${handle}` : UNKNOWN_USER} — {s.itemLabel}
              {s.valueText ? `: ${s.valueText}` : ""}
            </li>
          );
        })}
      </ul>
      {/* 목록 밖에 둔다 — 목록 안이면 스크린 리더가 줄 수에 이 안내까지 센다 */}
      {interactions.length === INTERACTIONS_MAX && <p>최근 {INTERACTIONS_MAX}건</p>}
    </div>
  );
}

/**
 * 메시지의 components v1 카드 전체(스펙 5.1): 블록을 배열 순서대로 → 모달 트리거 → 결과 줄.
 * 사람·에이전트 메시지와 시스템 카드(relay_limit 의 「이어가기」)가 함께 쓴다. components 가 없으면 null
 */
export function Components({ message }: { message: Message }) {
  const c = message.components;
  const expired = useExpired(message.componentState?.expiresAt);
  const io = useInteract(message);
  if (!c) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" data-slot="components">
      {c.blocks.map((b, i) => (
        <BlockView key={i} block={b} message={message} io={io} expired={expired} />
      ))}

      {c.modal && <ComponentModal modal={c.modal} message={message} io={io} expired={expired} />}

      <InteractionLog
        components={c}
        interactions={message.interactions}
        focusId={io.focusId}
        onFocused={io.focusDone}
      />
    </div>
  );
}
