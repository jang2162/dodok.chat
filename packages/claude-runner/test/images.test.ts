import { ATTACHMENT_LIMITS, type Attachment, type InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { AttachmentsHttpError, type AttachmentsHttp } from "../src/attachments-http";
import { imageFailureNote, loadImageBlocks } from "../src/images";
import { runStart } from "./helpers/fixtures";

const id = (n: number) => `0192f000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const image = (n: number, mime = "image/png"): Attachment => ({
  id: id(n),
  kind: "image",
  url: `artifact://${id(n)}`,
  name: `img${n}.png`,
  mime,
  size: 3,
});

function deliverWith(attachments: Attachment[]): InboundDeliver {
  const d = runStart().deliver;
  return { ...d, message: { ...d.message, attachments } };
}

function fakeHttp(files: Record<string, Buffer | number>) {
  const asked: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const http: AttachmentsHttp = {
    upload: async () => {
      throw new Error("not used");
    },
    download: async (attId, o) => {
      asked.push(attId);
      signals.push(o?.signal);
      const f = files[attId];
      if (f === undefined) throw new AttachmentsHttpError("첨부 받기 실패 404", 404);
      if (typeof f === "number") throw new AttachmentsHttpError(`첨부 받기 실패 ${f}`, f);
      return { bytes: f, mime: "application/octet-stream" };
    },
  };
  return { http, asked, signals };
}

describe("loadImageBlocks", () => {
  it("두 장 중 한 장 404 → 블록 하나 + 못 불러온 수 1", async () => {
    const { http } = fakeHttp({ [id(1)]: Buffer.from([1, 2, 3]) });
    const out = await loadImageBlocks(deliverWith([image(1), image(2)]), http);
    expect(out).toEqual({
      blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }],
      failed: 1,
    });
    expect(imageFailureNote(out.failed)).toBe("첨부 이미지 1장을 불러오지 못했습니다");
  });

  it("MIME 은 서버 기록(첨부의 mime)이 정본 — 첨부 순서대로", async () => {
    const { http } = fakeHttp({ [id(1)]: Buffer.from([1]), [id(2)]: Buffer.from([2]) });
    const out = await loadImageBlocks(deliverWith([image(2, "image/webp"), image(1, "image/jpeg")]), http);
    expect(out.blocks.map((b) => b.source.media_type)).toEqual(["image/webp", "image/jpeg"]);
    expect(out.blocks.map((b) => b.source.data)).toEqual(["Ag==", "AQ=="]);
  });

  it("이미지가 아닌 첨부는 받지 않는다(프롬프트에 이름만 있다) — 이미지가 없으면 요청 0", async () => {
    const { http, asked } = fakeHttp({});
    const file: Attachment = { ...image(3), kind: "file", mime: "application/pdf", name: "a.pdf" };
    expect(await loadImageBlocks(deliverWith([file]), http)).toEqual({ blocks: [], failed: 0 });
    expect(asked).toEqual([]);
  });

  it("사람이 올린 PDF 가 실린 deliver(파일함 스펙 4.2) — 받기 0회, 블록 없음", async () => {
    const { http, asked } = fakeHttp({});
    const pdf: Attachment = { ...image(5), kind: "file", mime: "application/pdf", name: "사람 보고서.pdf" };
    const d = deliverWith([pdf]);
    expect(d.message.author.type).toBe("user");
    expect(await loadImageBlocks(d, http)).toEqual({ blocks: [], failed: 0 });
    expect(asked).toEqual([]);
  });

  it("5 MiB 를 넘는 이미지·그릴 수 없는 MIME·서버 첨부가 아닌 URL 은 못 불러온 것으로 센다", async () => {
    const big = Buffer.alloc(ATTACHMENT_LIMITS.userImageMaxBytes + 1);
    const { http, asked } = fakeHttp({ [id(1)]: big, [id(2)]: Buffer.from([1]), [id(4)]: Buffer.from([4]) });
    const external: Attachment = { ...image(3), url: "https://example.com/x.png" };
    const out = await loadImageBlocks(
      deliverWith([image(1), image(2, "image/svg+xml"), external, image(4)]),
      http,
    );
    expect(out.failed).toBe(3);
    expect(out.blocks).toHaveLength(1);
    expect(asked).not.toContain(id(3));
  });

  it("10장을 넘으면 앞 10장만 받고 나머지는 못 불러온 것으로", async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [id(i + 1), Buffer.from([i])]));
    const { http, asked } = fakeHttp(files);
    const atts = Array.from({ length: 12 }, (_, i) => image(i + 1));
    const d = runStart().deliver;
    // 계약은 10장까지라 파싱을 거치지 않은 값으로 — 러너가 스스로도 상한을 지키는지 본다
    const out = await loadImageBlocks({ ...d, message: { ...d.message, attachments: atts } }, http);
    expect(out.blocks).toHaveLength(10);
    expect(out.failed).toBe(2);
    expect(asked).toHaveLength(10);
  });

  it("런 signal 을 받기마다 넘긴다 — 멈추면 제한 시간까지 기다리지 않는다", async () => {
    const { http, signals } = fakeHttp({ [id(1)]: Buffer.from([1]), [id(2)]: Buffer.from([2]) });
    const run = new AbortController();
    await loadImageBlocks(deliverWith([image(1), image(2)]), http, run.signal);
    expect(signals).toEqual([run.signal, run.signal]);
  });
});
