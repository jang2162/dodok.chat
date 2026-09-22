import type { Block } from "@dodok/shared";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ArtifactPending } from "./artifact";

type Item = Extract<Block, { type: "media" }>["items"][number];

/** 항목 수 → 열 수(1~3) */
const COLS = ["grid-cols-1", "grid-cols-1", "grid-cols-2", "grid-cols-3"] as const;

/**
 * https 이미지 한 장. 불러오기에 실패하면 깨진 그림 대신 새 탭 링크 「이미지: <alt 또는 주소>」로 물러난다
 * (스펙 6장 — 메시지 본문의 마크다운 이미지와 같은 문구)
 */
function MediaImage({ item, single }: { item: Item; single: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm break-all text-primary underline"
      >
        이미지: {item.alt || item.url}
      </a>
    );
  }
  return (
    <img
      src={item.url}
      // alt 가 없으면 빈 문자열 — 보조 기술이 장식으로 건너뛴다(주소를 읽어 주지 않게)
      alt={item.alt ?? ""}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(
        "rounded-md bg-muted",
        single ? "max-h-80 max-w-full object-contain" : "aspect-square w-full object-contain",
      )}
    />
  );
}

/**
 * media 블록 — 이미지 격자(≤10, 항목 수에 따라 1~3열). **항목별로** 갈린다: `https://` 는 그리고, 그 밖의 값은 모두 자리표시다
 * (계약 `SafeUrl` 안에서는 `artifact://` 뿐이다 — 링크 버튼처럼 `isArtifactUrl` 로 한 번 더 가르지 않는 것은 docs/plan.md 8장 「이월」).
 *
 * https 이미지는 **불러온다** — 무엇이 드러나는지의 정본은 스펙 결정 8(docs/superpowers/specs/2026-09-21-components-v1-design.md 0장)이다.
 * 메시지 본문의 마크다운 이미지는 추적 픽셀 때문에 불러오지 않고 링크로만 두지만, 「이미지를 보여 주는 블록」이 링크만 내면 블록의 뜻이 사라진다.
 * `referrerPolicy="no-referrer"` 가 실제로 가리는 것은 **출처**(보는 사람이 어느 dodok 서버를 쓰는가)다 — 이 속성이 없어도 브라우저 기본
 * 정책 `strict-origin-when-cross-origin` 이 교차 출처 HTTPS 요청에는 출처만 보내므로 채널 경로는 원래 안 샌다. `loading="lazy"` 는 화면에
 * 가까워지면(들어오기 조금 전) 부른다. **남는 대가는 IP 하나가 아니다** — `crossOrigin` 없는 `<img>` 라 이미지 호스트는 보는 사람의
 * ① IP ② 본 시각(사실상 읽음 확인) ③ User-Agent 같은 요청 헤더 ④ 그 호스트가 심어 둔 `SameSite=None` 쿠키를 받는다.
 * `crossOrigin="anonymous"` 는 쿠키를 빼 주지만 CORS 헤더를 안 주는 호스트의 이미지가 실패하므로 쓰지 않았다.
 * Phase 2 ③ 에서 이미지가 `artifact://`(자기 서버 경유)로 오게 되면 그 이미지에 대해서는 임시 상태다
 */
export function MediaBlock({ block }: { block: Extract<Block, { type: "media" }> }) {
  const single = block.items.length === 1;
  return (
    <div data-slot="media" className={cn("grid gap-2", COLS[Math.min(block.items.length, 3)])}>
      {block.items.map((item, i) =>
        item.url.startsWith("https://") ? (
          <MediaImage key={i} item={item} single={single} />
        ) : (
          <div
            key={i}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-md border border-dashed p-3 text-center",
              !single && "aspect-square",
            )}
          >
            <ArtifactPending />
            {item.alt && <span className="text-xs break-all text-muted-foreground">{item.alt}</span>}
          </div>
        ),
      )}
    </div>
  );
}
