import { ATTACHMENT_LIMITS, type InboundDeliver, isImageMime, parseArtifactUrl } from "@dodok/shared";
import type { AttachmentsHttp } from "./attachments-http";

// 인바운드 이미지 → 사용자 메시지의 이미지 블록(러너 스펙 4.2). 받기 실패는 그 이미지만 빼고 런은 막지 않는다 —
// 몇 장을 못 불러왔는지는 프롬프트 끝 한 줄로 알린다(이름·주소는 프롬프트 머리의 「첨부 이미지」 줄에 이미 있다)

export type SdkImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
};

// 사람이 올리는 이미지 상한과 같다(서버가 이미 막는다). 릴레이된 에이전트 이미지는 20 MiB 까지 올 수 있는데, Messages API 의
// 이미지 한 장 상한(5 MB)을 넘으면 요청 전체가 거절되므로 그 이미지만 뺀다
const IMAGE_MAX_BYTES = ATTACHMENT_LIMITS.userImageMaxBytes;

export const imageFailureNote = (n: number): string => `첨부 이미지 ${n}장을 불러오지 못했습니다`;

export async function loadImageBlocks(
  deliver: InboundDeliver,
  http: AttachmentsHttp,
  /** 런의 signal — 멈추면 받기를 끊는다(제한 시간까지 기다리지 않는다) */
  signal?: AbortSignal,
): Promise<{ blocks: SdkImageBlock[]; failed: number }> {
  const images = deliver.message.attachments.filter((a) => a.kind === "image");
  const taken = images.slice(0, ATTACHMENT_LIMITS.perMessage);
  const settled = await Promise.allSettled(
    taken.map(async (a): Promise<SdkImageBlock> => {
      const id = parseArtifactUrl(a.url);
      // MIME 은 서버 기록이 정본이다 — 매직 바이트로 정해졌다. SVG 는 그리지 않는다(첨부 스펙 결정 8)
      if (!id || !isImageMime(a.mime)) throw new Error("not a drawable server image");
      const { bytes } = await http.download(id, signal ? { signal } : undefined);
      if (bytes.length > IMAGE_MAX_BYTES) throw new Error("image too large");
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: a.mime as SdkImageBlock["source"]["media_type"],
          data: bytes.toString("base64"),
        },
      };
    }),
  );
  const blocks = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  return { blocks, failed: images.length - blocks.length };
}
