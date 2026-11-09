import { ATTACHMENT_LIMITS, type Attachment } from "@dodok/shared";
import { describe, expect, it, vi } from "vitest";
import { appendNotes, inboundSaveArgs, prepareInboundMedia } from "../src/inbound-media";
import { MediaHttpError } from "../src/media-http";

let seq = 0;
function att(kind: Attachment["kind"], name: string, mime: string): Attachment {
  seq++;
  const id = `01a0cc16-22ee-7018-826c-${String(seq).padStart(12, "0")}`;
  return { id, kind, url: `artifact://${id}`, name, mime, size: 1 };
}
const img = (name: string, mime = "image/png") => att("image", name, mime);
const file = (name: string) => att("file", name, "application/pdf");

describe("prepareInboundMedia", () => {
  it("이미지만 받아 저장하고 facts 에 path·contentType·fileName, url 은 없다", async () => {
    const save = vi.fn(async () => ({ path: "/m/inbound/a---1.png", contentType: "image/png" }));
    const a = img("a.png");
    const download = vi.fn(async () => ({ bytes: Buffer.from([1]), mime: "image/png" }));
    const r = await prepareInboundMedia([a, file("b.pdf")], { download, save });
    expect(r.facts).toEqual([
      { path: "/m/inbound/a---1.png", contentType: "image/png", fileName: "a.png", kind: "image" },
    ]);
    expect(r.facts[0]).not.toHaveProperty("url");
    expect(r.notes).toEqual(["[첨부 파일: b.pdf]"]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(a.id);
    expect(save).toHaveBeenCalledWith(Buffer.from([1]), "image/png", "a.png");
  });

  it("사람이 올린 PDF(파일함 스펙 4.2) — 받지 않고 이름 한 줄만, facts 없음", async () => {
    const download = vi.fn();
    const save = vi.fn();
    const r = await prepareInboundMedia([file("사람 보고서.pdf")], { download, save });
    expect(r).toEqual({ facts: [], notes: ["[첨부 파일: 사람 보고서.pdf]"], reasons: [] });
    expect(download).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("MIME 은 서버 기록(a.mime)이 정본 — 받은 content-type 이 달라도 기록을 저장에 넘기고, 저장이 contentType 을 안 주면 기록을 fact 에", async () => {
    const save = vi.fn(async () => ({ path: "/m/inbound/x.webp" }));
    const r = await prepareInboundMedia([img("x.webp", "image/webp")], {
      download: async () => ({ bytes: Buffer.from([2]), mime: "application/octet-stream" }),
      save,
    });
    expect(save).toHaveBeenCalledWith(Buffer.from([2]), "image/webp", "x.webp");
    expect(r.facts).toEqual([
      { path: "/m/inbound/x.webp", contentType: "image/webp", fileName: "x.webp", kind: "image" },
    ]);
  });

  it("받기나 저장이 실패한 장은 빼고 알림 줄, 나머지는 계속", async () => {
    const [a, b, c] = [img("a.png"), img("b.png"), img("c.png")];
    const download = vi.fn(async (id: string) => {
      if (id === a.id) throw new Error("404");
      return { bytes: Buffer.from([1]), mime: "image/png" };
    });
    const save = vi.fn(async (_bytes: Buffer, _mime: string, name: string) => {
      if (name === "b.png") throw new Error("too big");
      return { path: `/m/inbound/${name}`, contentType: "image/png" };
    });
    const r = await prepareInboundMedia([a, b, c], { download, save });
    expect(r.facts.map((f) => f.fileName)).toEqual(["c.png"]);
    expect(r.notes).toEqual([
      "[이미지를 불러오지 못했습니다: a.png]",
      "[이미지를 불러오지 못했습니다: b.png]",
    ]);
  });

  it("artifact:// 가 id 가 아니면(계약상 오지 않지만) 받지 않고 실패 줄", async () => {
    const odd: Attachment = { ...img("w.png"), url: "https://example.com/w.png" };
    const download = vi.fn();
    const r = await prepareInboundMedia([odd], { download, save: vi.fn() });
    expect(download).not.toHaveBeenCalled();
    expect(r).toEqual({
      facts: [],
      notes: ["[이미지를 불러오지 못했습니다: w.png]"],
      reasons: ["url:not-attachment-id"],
    });
  });

  it("알림 줄과 facts 는 첨부 순서를 따른다, 첨부가 없으면 둘 다 비어 있다", async () => {
    const r = await prepareInboundMedia([file("1.pdf"), img("2.png"), file("3.zip")], {
      download: async () => ({ bytes: Buffer.from([1]), mime: "image/png" }),
      save: async (_b, _m, name) => ({ path: `/m/${name}` }),
    });
    expect(r.notes).toEqual(["[첨부 파일: 1.pdf]", "[첨부 파일: 3.zip]"]);
    expect(r.facts.map((f) => f.fileName)).toEqual(["2.png"]);
    await expect(prepareInboundMedia([], { download: vi.fn(), save: vi.fn() })).resolves.toEqual({
      facts: [],
      notes: [],
      reasons: [],
    });
  });
});

describe("prepareInboundMedia — 병렬 받기·사유", () => {
  it("받기는 한꺼번에 시작하고, 늦게 끝난 장이 있어도 facts·notes 는 첨부 순서 그대로", async () => {
    const [a, b, c, d] = [img("a.png"), file("b.pdf"), img("c.png"), img("d.png")];
    const pending = new Map<string, (v: { bytes: Buffer; mime: string }) => void>();
    const download = vi.fn(
      (id: string) =>
        new Promise<{ bytes: Buffer; mime: string }>((resolve, reject) => {
          if (id === d.id) reject(new MediaHttpError("첨부 받기 실패 404", 404));
          else pending.set(id, resolve);
        }),
    );
    const run = prepareInboundMedia([a, b, c, d], {
      download,
      save: async (_b, _m, name) => ({ path: `/m/${name}`, contentType: "image/png" }),
    });
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(3));
    // 뒤 장부터 끝낸다
    pending.get(c.id)!({ bytes: Buffer.from([1]), mime: "image/png" });
    await Promise.resolve();
    pending.get(a.id)!({ bytes: Buffer.from([1]), mime: "image/png" });
    const r = await run;
    expect(r.facts.map((f) => f.fileName)).toEqual(["a.png", "c.png"]);
    expect(r.notes).toEqual(["[첨부 파일: b.pdf]", "[이미지를 불러오지 못했습니다: d.png]"]);
  });

  it("실패 사유(reasons)는 단계와 경로 없는 종류 — HTTP 상태·오류 코드·오류 이름", async () => {
    const [a, b, c, d] = [img("a.png"), img("b.png"), img("c.png"), img("d.png")];
    const r = await prepareInboundMedia([a, b, c, d], {
      download: async (id) => {
        if (id === a.id) throw new MediaHttpError("첨부 받기 실패 404", 404);
        if (id === b.id)
          throw new DOMException("The operation was aborted due to timeout /Users/x", "TimeoutError");
        return { bytes: Buffer.from([1]), mime: "image/png" };
      },
      save: async (_b, _m, name) => {
        if (name === "c.png") throw Object.assign(new Error("too big /Users/x/c.png"), { code: "too-large" });
        if (name === "d.png") throw new Error("disk full at /Users/x/media");
        return { path: "/m/x" };
      },
    });
    expect(r.facts).toEqual([]);
    expect(r.reasons).toEqual(["download:http-404", "download:TimeoutError", "save:too-large", "save:Error"]);
    expect(r.reasons.join(" ")).not.toContain("/Users");
  });
});

describe("inboundSaveArgs", () => {
  it("saveMediaBuffer 인자 — inbound 하위 폴더·에이전트 상한 maxBytes·원래 이름", () => {
    const bytes = Buffer.from([1]);
    expect(inboundSaveArgs(bytes, "image/png", "a.png")).toEqual([
      bytes,
      "image/png",
      "inbound",
      ATTACHMENT_LIMITS.agentFileMaxBytes,
      "a.png",
    ]);
  });
});

describe("appendNotes", () => {
  it("본문이 비면 알림 줄만, 있으면 빈 줄 하나 뒤에", () => {
    expect(appendNotes("", ["[첨부 파일: b.pdf]"])).toBe("[첨부 파일: b.pdf]");
    expect(appendNotes("안녕", ["x", "y"])).toBe("안녕\n\nx\ny");
    expect(appendNotes("안녕", [])).toBe("안녕");
    expect(appendNotes("", [])).toBe("");
  });
});
