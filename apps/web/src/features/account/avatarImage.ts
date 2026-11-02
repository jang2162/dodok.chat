import { AVATAR_TARGET_PX } from "@dodok/shared";

// 아바타 만들기(프로필 스펙 3.6)와 상태 만료 고르기(3.2) — 서버는 형식·크기·가로세로만 본다. 자르기·줄이기는 브라우저가 한다

/** 가운데 정사각형 — 원본의 어디를 잘라 낼지 */
export function squareCrop(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
}

/**
 * 고른 그림(png·jpeg·webp·gif 첫 장면)을 가운데 정사각형으로 잘라 size×size 로 줄인다 — webp, 안 되는 브라우저면 png. 투명 배경은
 * 그대로 둔다(webp·png 둘 다 알파가 있다). 그림을 읽지 못하면 던진다
 */
export async function cropToSquare(file: Blob, size = AVATAR_TARGET_PX): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    const webp = await toBlob(canvas, "image/webp");
    // webp 를 못 만드는 브라우저는 png 를 돌려준다(toBlob 의 대체) — 형식을 보고 고른다
    if (webp && webp.type === "image/webp") return webp;
    const png = await toBlob(canvas, "image/png");
    if (!png) throw new Error("encode failed");
    return png;
  } finally {
    bitmap.close();
  }
}

export type ExpiryChoice = "never" | "30m" | "1h" | "4h" | "today" | { at: Date };

const MINUTE = 60_000;
const AFTER: Record<"30m" | "1h" | "4h", number> = {
  "30m": 30 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 240 * MINUTE,
};

/** 만료 시각(ISO) — 「오늘」의 경계는 브라우저 시간대의 자정이다. 서버에는 계산된 시각만 간다 */
export function expiryOf(choice: ExpiryChoice, now: Date): string | null {
  if (choice === "never") return null;
  if (choice === "today") {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.toISOString();
  }
  if (typeof choice === "object") return choice.at.toISOString();
  return new Date(now.getTime() + AFTER[choice]).toISOString();
}
