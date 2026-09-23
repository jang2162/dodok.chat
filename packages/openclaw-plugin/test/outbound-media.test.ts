import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { describe, expect, it, vi } from "vitest";
import { MediaHttpError } from "../src/media-http";
import {
  collectDeliverMediaSources,
  collectToolMediaSources,
  deliverFailureLine,
  loaderOptions,
  maskHostPaths,
  shouldDeliverFinal,
  toolFailureMessage,
  uniqueNames,
  uploadOutboundMedia,
} from "../src/outbound-media";

const MAX = ATTACHMENT_LIMITS.agentFileMaxBytes;
const loaded = (bytes = 1, extra: { contentType?: string; fileName?: string } = {}) => ({
  bytes: Buffer.alloc(bytes),
  ...extra,
});

describe("원천 모으기", () => {
  it("툴 인자: mediaUrls 가 있으면 그것, 없으면 media. 빈 값·중복 제외, filename 은 첫 파일 이름", () => {
    expect(
      collectToolMediaSources({ media: "/a.png", mediaUrls: ["/a.png", "/b.pdf", "", "/a.png"] }),
    ).toEqual([{ src: "/a.png" }, { src: "/b.pdf" }]);
    expect(collectToolMediaSources({ media: "/a.png", filename: "보고서.png" })).toEqual([
      { src: "/a.png", name: "보고서.png" },
    ]);
    expect(collectToolMediaSources({ message: "hi" })).toEqual([]);
    expect(collectToolMediaSources({ media: 3 })).toEqual([]);
    expect(collectToolMediaSources({ media: "/a.png", mediaUrls: [] })).toEqual([{ src: "/a.png" }]);
    expect(collectToolMediaSources({ media: "   " })).toEqual([]);
  });

  it("deliver payload: mediaUrls·mediaUrl, 이름은 attachments[i].name", () => {
    expect(
      collectDeliverMediaSources({
        mediaUrls: ["/o/a---1.png", "https://x/y.png"],
        attachments: [{ name: "a.png" }, {}],
      }),
    ).toEqual([{ src: "/o/a---1.png", name: "a.png" }, { src: "https://x/y.png" }]);
    expect(collectDeliverMediaSources({ mediaUrl: "/o/b.pdf" })).toEqual([{ src: "/o/b.pdf" }]);
    expect(collectDeliverMediaSources({ mediaUrls: ["/o/a.png", "/o/a.png"] })).toEqual([
      { src: "/o/a.png" },
    ]);
    expect(collectDeliverMediaSources({})).toEqual([]);
    expect(collectDeliverMediaSources({ mediaUrls: "nope", attachments: "nope" })).toEqual([]);
  });

  it("uniqueNames: 겹치면 확장자 앞에 (2)·(3)", () => {
    expect(uniqueNames(["a.png", "a.png", "b", "a.png", "b"])).toEqual([
      "a.png",
      "a (2).png",
      "b",
      "a (3).png",
      "b (2)",
    ]);
  });
});

describe("uploadOutboundMedia", () => {
  it("올리기: 이름은 원천 이름(filename·attachments[i].name) → 로더 fileName → basename, 순서대로 id", async () => {
    const load = vi.fn(async (src: string) =>
      src === "/w/b" ? loaded(2, { fileName: "loader.txt", contentType: "text/plain" }) : loaded(3),
    );
    let n = 0;
    const upload = vi.fn(async () => ({ id: `id-${++n}` }));
    const r = await uploadOutboundMedia(
      [
        { src: "/w/a.png", name: "보고서.png" },
        { src: "/w/b" },
        { src: "https://x/dir/c.pdf?sig=1" },
        { src: "/w/d/" },
      ],
      { load, upload, maxBytes: MAX },
    );
    expect(r).toEqual({ ids: ["id-1", "id-2", "id-3", "id-4"], failures: [] });
    expect(upload.mock.calls.map((c) => (c as unknown[]).slice(1))).toEqual([
      ["보고서.png", undefined],
      ["loader.txt", "text/plain"],
      ["c.pdf", undefined],
      ["d", undefined],
    ]);
  });

  it("이름에서 경로 구분자·제어 문자를 빼고, 한 메시지 안에서 겹치면 (2)", async () => {
    const upload = vi.fn(async (_b: Buffer, name: string) => ({ id: name }));
    const r = await uploadOutboundMedia(
      [{ src: "/x/a.png" }, { src: "/y/a.png" }, { src: "/z", name: "e\u0000vil/..\\a.png" }],
      { load: async () => loaded(), upload, maxBytes: MAX },
    );
    expect(r.ids).toEqual(["a.png", "a (2).png", "evil..a.png"]);
  });

  it("크기 초과는 로드 뒤 검사해 실패로 — 사유 「20 MiB 초과」, 나머지는 올린다", async () => {
    const upload = vi.fn(async () => ({ id: "ok" }));
    const r = await uploadOutboundMedia([{ src: "/big.bin" }, { src: "/small.png" }], {
      load: async (src) => loaded(src === "/big.bin" ? MAX + 1 : 1),
      upload,
      maxBytes: MAX,
    });
    expect(r).toEqual({
      ids: ["ok"],
      failures: [{ name: "big.bin", reason: "20 MiB 초과", detail: "20 MiB 초과" }],
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("로드·올리기 실패는 이름과 고정 사유로 모으고 나머지는 계속 — 원문은 detail(가림·120자)에만", async () => {
    const r = await uploadOutboundMedia([{ src: "/a.png" }, { src: "/b.png" }, { src: "/c.png" }], {
      load: async (src) => {
        if (src === "/a.png") throw new Error("x".repeat(300));
        return loaded();
      },
      upload: async (_b, name) => {
        if (name === "b.png") throw new MediaHttpError("첨부 올리기 실패 413", 413);
        return { id: "c" };
      },
      maxBytes: MAX,
    });
    expect(r.ids).toEqual(["c"]);
    expect(r.failures).toEqual([
      { name: "a.png", reason: "파일을 읽지 못함", detail: "x".repeat(120) },
      { name: "b.png", reason: "서버 상한 초과", detail: "첨부 올리기 실패 413" },
    ]);
  });

  const loaderError = (message: string, code?: string, cause?: unknown) =>
    Object.assign(new Error(message, cause ? { cause } : undefined), code ? { code } : {});

  it("로드 사유는 로더 오류 코드로만 — not-found·허용 루트 밖·그 밖, 로더 크기 초과(cause too-large)는 상한 값", async () => {
    const cases: [unknown, string][] = [
      [loaderError("Local media file not found: /Users/x/a.png", "not-found"), "파일을 찾을 수 없음"],
      [
        loaderError("Local media path is not under an allowed directory: /Users/x/a.png", "path-not-allowed"),
        "허용되지 않은 경로",
      ],
      [
        loaderError("Local media path is a network path: \\\\h\\s", "network-path-not-allowed"),
        "허용되지 않은 경로",
      ],
      [
        loaderError("Local media path is not safe to read: /Users/x/a.png", "invalid-path"),
        "파일을 읽지 못함",
      ],
      [loaderError("Local media path is not a file: /Users/x", "not-file"), "파일을 읽지 못함"],
      [loaderError("Media exceeds 20 MB limit", undefined, { code: "too-large" }), "20 MiB 초과"],
      [new TypeError("fetch failed"), "파일을 읽지 못함"],
      ["문자열로 던짐 /Users/x/a.png", "파일을 읽지 못함"],
    ];
    for (const [err, reason] of cases) {
      const r = await uploadOutboundMedia([{ src: "/Users/x/a.png" }], {
        load: async () => {
          throw err;
        },
        upload: vi.fn(),
        maxBytes: MAX,
      });
      expect(r.failures.map((f) => f.reason)).toEqual([reason]);
    }
  });

  it("올리기 사유는 HTTP 상태로만 — 413 은 서버 상한, 그 밖 상태는 거절(상태), 상태 없음·네트워크는 올리지 못함", async () => {
    const cases: [unknown, string][] = [
      [new MediaHttpError("첨부 올리기 실패 413", 413), "서버 상한 초과"],
      [new MediaHttpError("첨부 올리기 실패 403", 403), "서버가 거절함 (403)"],
      [new MediaHttpError("첨부 올리기 응답이 계약과 다르다"), "서버에 올리지 못함"],
      [new TypeError("fetch failed /Users/x/a.png"), "서버에 올리지 못함"],
    ];
    for (const [err, reason] of cases) {
      const r = await uploadOutboundMedia([{ src: "/w/a.png" }], {
        load: async () => loaded(),
        upload: async () => {
          throw err;
        },
        maxBytes: MAX,
      });
      expect(r.failures.map((f) => f.reason)).toEqual([reason]);
    }
  });

  it("경로가 든 원문 오류는 어떤 꼴이든 채널 본문·툴 문구에 나타나지 않는다(가림이 못 잡는 꼴 포함)", async () => {
    const leaks = [
      "ENOENT: no such file or directory, open '/Users/x/secret/a.png'",
      "ENOENT:/Users/x/secret/a.png",
      "경로:/Users/x/secret/a.png",
      "not under an allowed directory:/Users/x/secret/a.png",
      "`/Users/x/secret/a.png`",
      "[/Users/x/secret/a.png]",
      "denied|/Users/x/secret/a.png",
      "open ‘/Users/x/secret/a.png’",
      "file:/Users/x/secret/a.png",
      "at <file:///Users/x/secret/a.png>",
      "../../secret/passwd",
      "./secret/a.png",
      "Invalid path /Users/x/it's-secret.png here",
    ];
    for (const message of leaks) {
      for (const code of [undefined, "path-not-allowed", "not-found"]) {
        const r = await uploadOutboundMedia([{ src: "/w/a.png" }, { src: "/w/b.png" }], {
          load: async (src) => {
            if (src === "/w/a.png") throw loaderError(message, code);
            return loaded();
          },
          upload: async () => {
            throw new MediaHttpError(message, 500);
          },
          maxBytes: MAX,
        });
        expect(r.failures).toHaveLength(2);
        for (const text of [deliverFailureLine(r.failures), toolFailureMessage(r.failures)]) {
          expect(text).not.toContain("secret");
          expect(text).not.toContain("Users");
        }
      }
    }
  });

  it("detail 은 로그용 — 원문을 가려(호스트 경로 → <경로>) 싣는다", async () => {
    const r = await uploadOutboundMedia([{ src: "/Users/x/secret/a.png" }], {
      load: async () => {
        throw new Error("ENOENT: no such file or directory, open '/Users/x/secret/a.png'");
      },
      upload: vi.fn(),
      maxBytes: MAX,
    });
    expect(r.failures).toEqual([
      {
        name: "a.png",
        reason: "파일을 읽지 못함",
        detail: "ENOENT: no such file or directory, open '<경로>'",
      },
    ]);
  });

  it("메시지당 상한(10)을 넘는 원천은 읽지 않고 실패로", async () => {
    const load = vi.fn(async () => loaded());
    const items = Array.from({ length: ATTACHMENT_LIMITS.perMessage + 2 }, (_, i) => ({ src: `/f${i}.png` }));
    const r = await uploadOutboundMedia(items, { load, upload: async () => ({ id: "i" }), maxBytes: MAX });
    expect(r.ids).toHaveLength(ATTACHMENT_LIMITS.perMessage);
    expect(load).toHaveBeenCalledTimes(ATTACHMENT_LIMITS.perMessage);
    expect(r.failures.map(({ name, reason }) => ({ name, reason }))).toEqual([
      { name: "f10.png", reason: "메시지당 10개 초과" },
      { name: "f11.png", reason: "메시지당 10개 초과" },
    ]);
  });
});

describe("maskHostPaths", () => {
  it("/·\\·~/·드라이브·file:// 로 시작하는 경로를 따옴표나 줄 끝까지 가린다, URL·일반 글은 둔다", () => {
    expect(maskHostPaths("ENOENT: /Users/x/a.png")).toBe("ENOENT: <경로>");
    expect(maskHostPaths("open '/Users/x/My Docs/a.png' failed")).toBe("open '<경로>' failed");
    expect(maskHostPaths("not allowed: ~/secret/a b.png")).toBe("not allowed: <경로>");
    expect(maskHostPaths("missing C:\\Users\\x\\a.png")).toBe("missing <경로>");
    expect(maskHostPaths("bad file:///etc/passwd")).toBe("bad <경로>");
    expect(maskHostPaths("\\\\host\\share\\a.png")).toBe("<경로>");
    expect(maskHostPaths("fetch https://example.com/a.png 404")).toBe("fetch https://example.com/a.png 404");
    expect(maskHostPaths("20 MiB 초과")).toBe("20 MiB 초과");
  });
});

describe("실패 문구", () => {
  it("툴 오류 문구·deliver 꼬리 줄", () => {
    const f = [{ name: "report.pdf", reason: "20 MiB 초과", detail: "20 MiB 초과" }];
    expect(toolFailureMessage(f)).toBe("dodok: 첨부를 보내지 못했습니다 — report.pdf: 20 MiB 초과");
    expect(deliverFailureLine(f)).toBe("_첨부 1개를 보내지 못했습니다: report.pdf (20 MiB 초과)_");
    const two = [...f, { name: "b.png", reason: "서버 상한 초과", detail: "첨부 올리기 실패 413" }];
    expect(toolFailureMessage(two)).toBe(
      "dodok: 첨부를 보내지 못했습니다 — report.pdf: 20 MiB 초과, b.png: 서버 상한 초과",
    );
    expect(deliverFailureLine(two)).toBe(
      "_첨부 2개를 보내지 못했습니다: report.pdf (20 MiB 초과), b.png (서버 상한 초과)_",
    );
  });
});

describe("channel.ts 배선", () => {
  it("shouldDeliverFinal: final 만, 텍스트나 미디어 중 하나라도 있으면 보낸다(미디어 전용 응답)", () => {
    expect(shouldDeliverFinal("final", "", 1)).toBe(true);
    expect(shouldDeliverFinal("final", "   ", 2)).toBe(true);
    expect(shouldDeliverFinal("final", "안녕", 0)).toBe(true);
    expect(shouldDeliverFinal("final", "  \n", 0)).toBe(false);
    expect(shouldDeliverFinal("block", "안녕", 1)).toBe(false);
    expect(shouldDeliverFinal("tool", "", 1)).toBe(false);
  });

  it("loaderOptions: 호스트 정책(localRoots·readFile·workspaceDir)을 있는 것만 그대로 넘긴다", () => {
    const readFile = async () => Buffer.alloc(0);
    expect(loaderOptions({ localRoots: ["/r"], readFile, workspaceDir: "/w" }, 7)).toEqual({
      maxBytes: 7,
      localRoots: ["/r"],
      readFile,
      workspaceDir: "/w",
    });
    expect(loaderOptions({ localRoots: ["/r"] }, 7)).toStrictEqual({ maxBytes: 7, localRoots: ["/r"] });
    expect(loaderOptions(undefined, 7)).toStrictEqual({ maxBytes: 7 });
    expect(loaderOptions({}, 7)).toStrictEqual({ maxBytes: 7 });
  });
});
