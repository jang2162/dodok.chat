import type { Block } from "@dodok/shared";
import { MessageBody } from "@/features/messages/MessageBody";

/**
 * section 블록 — 메시지 본문과 **같은 렌더러**(`MessageBody`)로 그린다(스펙 5.2).
 * 마크다운 규칙(원시 HTML 끔, 마크다운 이미지는 링크, 링크는 새 탭)이 두 벌 되지 않게 여기서 따로 파싱하지 않는다
 */
export function SectionBlock({ block }: { block: Extract<Block, { type: "section" }> }) {
  return (
    <div data-slot="section">
      <MessageBody bodyMd={block.text} />
    </div>
  );
}
