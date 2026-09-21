import type { Block, Message } from "@dodok/shared";
import { useEffect, useState } from "react";
import { ActionsBlock } from "./blocks/ActionsBlock";
import { FileBlock } from "./blocks/FileBlock";
import { MediaBlock } from "./blocks/MediaBlock";
import { SectionBlock } from "./blocks/SectionBlock";
import { SeparatorBlock } from "./blocks/SeparatorBlock";
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

      {/* 태스크 6: 결과 줄 — 모달 트리거 뒤, 오래된 것부터 */}
    </div>
  );
}
