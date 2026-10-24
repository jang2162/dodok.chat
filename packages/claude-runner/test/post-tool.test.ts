import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Attachment, ComponentsV1, RunnerOutboundPost, type RunnerOutboundAck } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AttachmentsHttpError, type AttachmentsHttp } from "../src/attachments-http";
import { createNodeFilesFs, type FilesFs, nodeFilesFs, POST_FILES_UNSUPPORTED } from "../src/files";
import { createPathMasker, OUTSIDE_WORKDIR, workdirRoots } from "../src/mask";
import {
  createDodokMcpServer,
  createPoster,
  POST_COMPONENTS_TOO_LONG,
  POST_STOPPED_MESSAGE,
  POST_TOOL_FULL_NAME,
  POST_TOOL_NAME,
  PostInputSchema,
  type PostInput,
  type PostResult,
} from "../src/post-tool";
import type { SdkMcpTool } from "../src/sdk";
import { createFakeSdk } from "./helpers/fake-query";
import { RUN_ID, runStart } from "./helpers/fixtures";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function postToolOf(post: (input: PostInput) => Promise<PostResult>): SdkMcpTool {
  const fake = createFakeSdk();
  createDodokMcpServer({ sdk: fake, post });
  expect(fake.servers).toHaveLength(1);
  expect(fake.servers[0]).toHaveLength(1);
  return fake.servers[0]![0]!;
}

const call = (t: SdkMcpTool, args: unknown) =>
  (t.handler as (a: unknown, extra: unknown) => Promise<ToolResult>)(args, {});

describe("dodok MCP 서버의 post 도구", () => {
  it("이름 post(모델에게는 mcp__dodok__post) — 입력 스키마의 components 는 shared ComponentsV1 그대로", () => {
    const t = postToolOf(async () => ({ messageId: "m" }));
    expect(t.name).toBe(POST_TOOL_NAME);
    expect(POST_TOOL_FULL_NAME).toBe("mcp__dodok__post");
    const shape = t.inputSchema as unknown as typeof PostInputSchema.shape;
    expect(shape).toBe(PostInputSchema.shape);
    expect(shape.components.unwrap()).toBe(ComponentsV1);
    // MCP 서버가 tools/list 때 도구 스키마를 JSON Schema 로 바꾼다 — 바꿀 수 없는 조각이 없어야 한다
    expect(() => z.toJSONSchema(PostInputSchema, { io: "input" })).not.toThrow();
  });

  it("보내면 「보냈습니다(메시지 id)」", async () => {
    const seen: PostInput[] = [];
    const t = postToolOf(async (input) => {
      seen.push(input);
      return { messageId: "0192f000-0000-7000-8000-0000000000aa" };
    });
    const out = await call(t, { text: "빌드 끝" });
    expect(out).toEqual({
      content: [{ type: "text", text: "보냈습니다(메시지 0192f000-0000-7000-8000-0000000000aa)" }],
    });
    expect(seen).toEqual([{ text: "빌드 끝" }]);
  });

  it("text·components·files 가 모두 없으면 거절 — post 를 부르지 않는다", async () => {
    let calls = 0;
    const t = postToolOf(async () => {
      calls += 1;
      return { messageId: "m" };
    });
    for (const args of [{}, { files: [] }, { text: "" }]) {
      const out = await call(t, args);
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain("text·components·files 중 하나는 있어야 합니다");
    }
    expect(calls).toBe(0);
  });

  it("components 가 ComponentsV1 위반(버튼 6개·겹친 id)이면 post 전에 거절 — 공유 스키마의 제약이 걸린다", async () => {
    let calls = 0;
    const t = postToolOf(async () => {
      calls += 1;
      return { messageId: "m" };
    });
    const button = (id: string) => ({ type: "button", id, label: id });
    const six = { blocks: [{ type: "actions", items: ["a", "b", "c", "d", "e", "f"].map(button) }] };
    const dup = { blocks: [{ type: "actions", items: [button("a"), button("a")] }] };
    for (const components of [six, dup]) {
      const out = await call(t, { components });
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(/^입력이 틀렸습니다/);
    }
    expect(calls).toBe(0);
    expect(ComponentsV1.safeParse(six).success).toBe(false);
  });

  it("post 가 오류를 돌려주면 도구 결과 오류로 — 런은 계속된다(던지지 않는다)", async () => {
    const t = postToolOf(async () => ({ error: "파일을 보내지 않았습니다 — …" }));
    expect(await call(t, { text: "x" })).toEqual({
      content: [{ type: "text", text: "파일을 보내지 않았습니다 — …" }],
      isError: true,
    });
  });
});

describe("createPoster — 파일 검사 → 올리기 → outbound.post", () => {
  let base: string;
  let workdir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "dodok-post-"));
    workdir = join(base, "repo");
    mkdirSync(join(workdir, "out"), { recursive: true });
    writeFileSync(join(workdir, "out", "report final.md"), "# 보고");
    writeFileSync(join(workdir, "chart.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(base, ".env"), "SECRET=1");
    symlinkSync(join(base, ".env"), join(workdir, "env-link"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function harness(
    opts: {
      ack?: RunnerOutboundAck;
      uploadFails?: boolean;
      signal?: AbortSignal;
      onUpload?: () => void;
    } = {},
  ) {
    const uploads: Array<{ conversationId: string; name: string; mime?: string; bytes: number }> = [];
    const uploadSignals: Array<AbortSignal | undefined> = [];
    const sent: RunnerOutboundPost[] = [];
    let n = 0;
    const http: AttachmentsHttp = {
      upload: async (o) => {
        if (opts.uploadFails) throw new AttachmentsHttpError("첨부 올리기 실패 507", 507);
        uploadSignals.push(o.signal);
        opts.onUpload?.();
        uploads.push({
          conversationId: o.conversationId,
          name: o.name,
          ...(o.mime ? { mime: o.mime } : {}),
          bytes: o.bytes.length,
        });
        n += 1;
        const id = `0192f000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
        return {
          id,
          kind: "file",
          url: `artifact://${id}`,
          name: o.name,
          mime: "text/plain",
          size: o.bytes.length,
        } satisfies Attachment;
      },
      download: async () => {
        throw new Error("not used");
      },
    };
    const start = runStart();
    const post = createPoster({
      workdir,
      deliver: start.deliver,
      http,
      mask: createPathMasker(workdirRoots(workdir)),
      send: async (m) => {
        sent.push(RunnerOutboundPost.parse(m));
        return opts.ack ?? { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" };
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: () => Date.parse("2026-09-27T02:00:00.000Z"),
      newId: () => "post-1",
    });
    return { post, uploads, uploadSignals, sent, start };
  }

  it("거절 파일이 하나라도 섞이면 올리기 0·보내기 0, 결과는 사유 목록(상대 경로만 — Review Focus 2)", async () => {
    const h = harness();
    const out = await h.post({
      text: "보고서",
      files: ["out/report final.md", "../.env", "/etc/passwd", "env-link", join(base, ".env")],
    });
    expect(h.uploads).toEqual([]);
    expect(h.sent).toEqual([]);
    expect("error" in out).toBe(true);
    const text = (out as { error: string }).error;
    expect(text).toContain(`- ${OUTSIDE_WORKDIR}: 작업 디렉터리 밖을 가리킵니다`);
    expect(text).toContain("- env-link: 작업 디렉터리 밖을 가리킵니다");
    expect(text).not.toContain("report final.md");
    for (const raw of [base, realpathSync(base), "/etc/passwd", ".env\n", tmpdir()]) {
      expect(text).not.toContain(raw);
    }
  });

  it("11개면 올리지 않는다", async () => {
    const h = harness();
    const out = await h.post({ files: Array(11).fill("chart.png") });
    expect(out).toEqual({ error: "파일을 보내지 않았습니다 — 파일은 한 번에 10개까지 보낼 수 있습니다" });
    expect(h.uploads).toEqual([]);
  });

  it("모두 통과하면 올려서 받은 첨부 id 를 outbound.post 에 — 런의 채널·에이전트·세션·런 id 그대로(조율자 인계)", async () => {
    const h = harness();
    const components = ComponentsV1.parse({
      blocks: [{ type: "file", name: "report final.md", url: "artifact://report%20final.md" }],
    });
    const out = await h.post({
      text: "보고서입니다",
      components,
      files: ["out/report final.md", "chart.png"],
    });
    expect(out).toEqual({ messageId: "0192f000-0000-7000-8000-0000000000aa" });
    expect(h.uploads).toEqual([
      {
        conversationId: h.start.deliver.conversationId,
        name: "report final.md",
        mime: "text/plain",
        bytes: 8,
      },
      { conversationId: h.start.deliver.conversationId, name: "chart.png", bytes: 2 },
    ]);
    const d = h.start.deliver;
    expect(h.sent).toEqual([
      {
        outboundId: "runner-post:post-1",
        conversationId: d.conversationId,
        agentId: d.agentId,
        sessionKey: d.sessionKey,
        runId: RUN_ID,
        replyToInboundId: d.message.id,
        text: "보고서입니다",
        components,
        attachmentIds: ["0192f000-0000-7000-8000-000000000001", "0192f000-0000-7000-8000-000000000002"],
        ts: "2026-09-27T02:00:00.000Z",
      },
    ]);
  });

  it("스레드 런이면 threadId 도 싣는다", async () => {
    const uploads: unknown[] = [];
    const sent: RunnerOutboundPost[] = [];
    const start = runStart();
    const threadId = "0192f000-0000-7000-8000-0000000000e9";
    const post = createPoster({
      workdir,
      deliver: { ...start.deliver, threadId },
      http: { upload: async () => uploads.push(1) as never, download: async () => ({}) as never },
      mask: createPathMasker(workdirRoots(workdir)),
      send: async (m) => {
        sent.push(m);
        return { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" };
      },
    });
    await post({ text: "스레드에" });
    expect(sent[0]).toMatchObject({ threadId, text: "스레드에", attachmentIds: [] });
    expect(sent[0]!.outboundId).toMatch(/^runner-post:[0-9a-f-]{36}$/);
  });

  it("글의 호스트 경로는 가린다 — 최종 답과 같은 규칙", async () => {
    const h = harness();
    await h.post({ text: `결과는 ${workdir}/out/report.md, 설정은 /Users/me/.ssh/config` });
    expect(h.sent[0]!.text).toBe(`결과는 out/report.md, 설정은 ${OUTSIDE_WORKDIR}`);
  });

  it("components 안 글의 호스트 경로도 가린다 — 가린 뒤에도 ComponentsV1", async () => {
    const h = harness();
    const components = ComponentsV1.parse({
      blocks: [
        { type: "section", text: `빌드 결과 ${workdir}/dist/app.js, 로그는 /Users/me/.cache/log` },
        { type: "actions", items: [{ type: "button", id: "open", label: `${workdir}/dist 열기` }] },
        { type: "file", name: "report final.md", url: "artifact://report%20final.md" },
      ],
    });
    const out = await h.post({ components });
    expect(out).toEqual({ messageId: "0192f000-0000-7000-8000-0000000000aa" });
    expect(h.sent[0]!.components).toEqual(
      ComponentsV1.parse({
        blocks: [
          { type: "section", text: `빌드 결과 dist/app.js, 로그는 ${OUTSIDE_WORKDIR}` },
          { type: "actions", items: [{ type: "button", id: "open", label: "dist 열기" }] },
          { type: "file", name: "report final.md", url: "artifact://report%20final.md" },
        ],
      }),
    );
    expect(JSON.stringify(h.sent[0])).not.toContain(workdir);
  });

  it("가린 표지 때문에 components 가 길이 제한을 넘으면 보내지 않고 도구 결과로 알린다", async () => {
    const h = harness();
    const label = `${"a".repeat(76)} /x`;
    const components = ComponentsV1.parse({
      blocks: [{ type: "actions", items: [{ type: "button", id: "b", label }] }],
    });
    const out = await h.post({ components, files: ["chart.png"] });
    expect(out).toEqual({ error: POST_COMPONENTS_TOO_LONG });
    expect(h.uploads).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("멈춘 런은 올리지도 보내지도 않는다 — 올리는 사이 멈춰도 다음 파일·보내기를 하지 않는다", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const h1 = harness({ signal: stopped.signal });
    expect(await h1.post({ text: "x", files: ["chart.png"] })).toEqual({ error: POST_STOPPED_MESSAGE });
    expect(h1.uploads).toEqual([]);
    expect(h1.sent).toEqual([]);

    const run = new AbortController();
    const h2 = harness({ signal: run.signal, onUpload: () => run.abort() });
    expect(await h2.post({ files: ["out/report final.md", "chart.png"] })).toEqual({
      error: POST_STOPPED_MESSAGE,
    });
    expect(h2.uploads).toHaveLength(1);
    expect(h2.uploadSignals[0]).toBe(run.signal);
    expect(h2.sent).toEqual([]);
  });

  it("올리기가 런 중지로 끊기면 올리기 실패가 아니라 중지 사유", async () => {
    const run = new AbortController();
    const h = harness({
      signal: run.signal,
      onUpload: () => {
        run.abort();
        throw new AttachmentsHttpError("첨부 올리기 실패(AbortError)");
      },
    });
    expect(await h.post({ files: ["chart.png"] })).toEqual({ error: POST_STOPPED_MESSAGE });
    expect(h.sent).toEqual([]);
  });

  it("서버가 거절하면(중지된 런 FORBIDDEN 등) 도구 결과로 사유", async () => {
    const h = harness({
      ack: { ok: false, code: "FORBIDDEN", message: "post must belong to an open run of this runner" },
    });
    expect(await h.post({ text: "x" })).toEqual({
      error: "보내지 못했습니다(FORBIDDEN): post must belong to an open run of this runner",
    });
  });

  function swapPoster(opts: { onUpload?: (n: number) => void; fs?: FilesFs }) {
    const uploaded: string[] = [];
    const sent: RunnerOutboundPost[] = [];
    const post = createPoster({
      workdir,
      deliver: runStart().deliver,
      mask: createPathMasker(workdirRoots(workdir)),
      ...(opts.fs ? { fs: opts.fs } : {}),
      http: {
        upload: async (o) => {
          uploaded.push(Buffer.from(o.bytes).toString());
          opts.onUpload?.(uploaded.length);
          const id = `0192f000-0000-7000-8000-0000000000${String(uploaded.length).padStart(2, "0")}`;
          return { id, kind: "file", url: `artifact://${id}`, name: o.name, mime: "text/plain", size: 1 };
        },
        download: async () => {
          throw new Error("not used");
        },
      },
      send: async (m) => {
        sent.push(m);
        return { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" };
      },
    });
    return { post, uploaded, sent };
  }

  function prepareSwap() {
    mkdirSync(join(workdir, "sub"));
    writeFileSync(join(workdir, "sub", "b.txt"), "bee");
    mkdirSync(join(base, "secret"));
    writeFileSync(join(base, "secret", "b.txt"), "PRIVATE-KEY");
    return () => {
      renameSync(join(workdir, "sub"), join(workdir, "sub-old"));
      symlinkSync(join(base, "secret"), join(workdir, "sub"));
    };
  }

  /** 검사와 열기 사이에 한 번 끼어드는 fs — 첫 open 직전에 swap */
  const swapBeforeOpen = (swap: () => void): FilesFs => {
    let done = false;
    return {
      ...nodeFilesFs,
      open: (p) => {
        if (!done) {
          done = true;
          swap();
        }
        return nodeFilesFs.open(p);
      },
    };
  };

  it("앞 파일을 올리는 사이 중간 디렉터리를 밖 링크로 바꿔도 밖 파일은 올라가지 않는다(리뷰 탐침, Review Focus 2)", async () => {
    const swap = prepareSwap();
    const h = swapPoster({ onUpload: (n) => n === 1 && swap() });
    const out = await h.post({ files: ["out/report final.md", "sub/b.txt"] });
    // 올리기 전에 모두 열어 둔다 — 두 번째도 검사한 그 파일(옮겨진 sub-old/b.txt)에서 읽는다
    expect(h.uploaded).toEqual(["# 보고", "bee"]);
    expect(h.uploaded).not.toContain("PRIVATE-KEY");
    expect(out).toEqual({ messageId: "0192f000-0000-7000-8000-0000000000aa" });
  });

  it("검사와 열기 사이에 중간 디렉터리를 밖 링크로 바꾸면 그 파일을 거절한다 — 올리기 0·보내기 0, 사유는 상대 경로만", async () => {
    const swap = prepareSwap();
    const h = swapPoster({ fs: swapBeforeOpen(swap) });
    const out = await h.post({ files: ["out/report final.md", "sub/b.txt"] });
    expect(h.uploaded).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(out).toEqual({
      error:
        "파일을 보내지 않았습니다 — 아래 파일을 보낼 수 없습니다(작업 디렉터리 안의 파일만, 하나에 20 MiB 까지):\n- sub/b.txt: 검사한 뒤 바뀌었습니다",
    });
  });

  it("검사와 열기 사이에 파일 자리를 링크로 바꾸면(O_NOFOLLOW) 거절한다", async () => {
    const h = swapPoster({
      fs: swapBeforeOpen(() => {
        rmSync(join(workdir, "chart.png"));
        symlinkSync(join(base, ".env"), join(workdir, "chart.png"));
      }),
    });
    const out = await h.post({ files: ["chart.png"] });
    expect(h.uploaded).toEqual([]);
    expect(out).toEqual({ error: expect.stringContaining("- chart.png: 검사한 뒤 바뀌었습니다") });
  });

  it("검사와 열기 사이에 파일 자리를 FIFO 로 바꿔도 막히지 않고 거절한다(O_NONBLOCK)", async () => {
    const h = swapPoster({
      fs: swapBeforeOpen(() => {
        rmSync(join(workdir, "chart.png"));
        execFileSync("mkfifo", [join(workdir, "chart.png")]);
      }),
    });
    const out = await h.post({ files: ["chart.png"] });
    expect(h.uploaded).toEqual([]);
    expect(out).toEqual({ error: expect.stringContaining("- chart.png: 검사한 뒤 바뀌었습니다") });
  });

  it("검사 안의 realpath 와 stat 사이에 중간 디렉터리를 밖 링크로 바꿔도 밖 파일은 올라가지 않는다(재리뷰 P1)", async () => {
    const swap = prepareSwap();
    let done = false;
    const h = swapPoster({
      fs: {
        ...nodeFilesFs,
        // stat 기준값(dev·ino)부터 밖 파일의 것이 된다 — 경로로 하는 대조는 여기서 통과한다
        stat: (p) => {
          if (!done) {
            done = true;
            swap();
          }
          return nodeFilesFs.stat(p);
        },
      },
    });
    const out = await h.post({ files: ["sub/b.txt"] });
    expect(h.uploaded).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(out).toEqual({ error: expect.stringContaining("- sub/b.txt: 검사한 뒤 바뀌었습니다") });
  });

  it("연 fd 를 확인할 수 없는 플랫폼이면 files 를 거절한다 — 글만은 보낸다", async () => {
    const h = swapPoster({ fs: createNodeFilesFs("win32") });
    expect(await h.post({ files: ["chart.png"] })).toEqual({ error: POST_FILES_UNSUPPORTED });
    expect(POST_FILES_UNSUPPORTED).toContain("이 플랫폼에서는 파일 보내기를 지원하지 않습니다");
    expect(h.uploaded).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(await h.post({ text: "x" })).toEqual({ messageId: "0192f000-0000-7000-8000-0000000000aa" });
  });

  const PYTHON = (() => {
    try {
      execFileSync("python3", ["-c", "import ctypes"], { stdio: "ignore" });
      return "python3";
    } catch {
      return undefined;
    }
  })();

  // 다른 프로세스가 repo/sub(디렉터리)와 밖 링크를 원자 교체(macOS renamex_np RENAME_SWAP · Linux renameat2
  // RENAME_EXCHANGE)로 계속 뒤집는다 — 비원자 rename 두 번으로는 경합이 안 난다(재리뷰 P2·P2b). 고치기 전 약 0.5% 가 새었다
  const RACER = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
a, b = os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2])
if sys.platform == "darwin":
    swap = lambda: libc.renamex_np(a, b, 2)
else:
    swap = lambda: libc.renameat2(-100, a, -100, b, 2)
n = 0
while True:
    if swap() != 0:
        sys.exit("swap failed: " + os.strerror(ctypes.get_errno()))
    n += 1
    if n == 1:
        print("ready", flush=True)
`;

  it.skipIf(PYTHON === undefined || !["darwin", "linux"].includes(process.platform))(
    "원자 교체 경합 수천 번에도 밖 파일은 한 번도 올라가지 않는다(재리뷰 P2b)",
    async () => {
      prepareSwap();
      symlinkSync(join(base, "secret"), join(workdir, "swap-link"));
      const racer = spawn(PYTHON!, ["-c", RACER, join(workdir, "sub"), join(workdir, "swap-link")], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      racer.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      try {
        await new Promise<void>((ok, fail) => {
          racer.stdout.once("data", () => ok());
          racer.once("exit", () => fail(new Error(`racer exited: ${stderr}`)));
        });
        const h = swapPoster({});
        let rejected = 0;
        for (let i = 0; i < 5000; i += 1) {
          const out = await h.post({ files: ["sub/b.txt"] });
          if ("error" in out) rejected += 1;
        }
        expect(racer.exitCode, stderr).toBeNull();
        expect(h.uploaded.filter((b) => b !== "bee")).toEqual([]);
        // 경합이 실제로 났고(거절) 정상 경로도 막히지 않았다(올라감)
        expect(rejected).toBeGreaterThan(0);
        expect(h.uploaded.length).toBeGreaterThan(0);
      } finally {
        // 끝난 것을 보고 나서 돌아간다 — 아직 교체 중인데 afterEach 가 base 를 지우면 ENOTEMPTY 로 실패한다
        const exited =
          racer.exitCode !== null || racer.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((done) => racer.once("exit", () => done()));
        racer.kill("SIGKILL");
        await exited;
      }
    },
    30_000,
  );

  it("거절로 끝나도 연 fd 는 모두 닫는다", async () => {
    const opened: number[] = [];
    const closed: number[] = [];
    let n = 0;
    const fs: FilesFs = {
      ...nodeFilesFs,
      open: (p) => {
        n += 1;
        // 두 번째 파일은 여는 순간 바뀐 것으로
        if (n === 2) writeFileSync(join(workdir, "chart.png"), Buffer.alloc(9));
        const fd = nodeFilesFs.open(p);
        opened.push(fd);
        return fd;
      },
      close: (fd) => {
        closed.push(fd);
        nodeFilesFs.close(fd);
      },
    };
    const h = swapPoster({ fs });
    const out = await h.post({ files: ["out/report final.md", "chart.png"] });
    expect("error" in out).toBe(true);
    expect(opened).toHaveLength(2);
    expect(closed.sort()).toEqual([...opened].sort());
  });

  it("검사한 뒤 크기가 바뀐 파일은 거절한다", async () => {
    const post = createPoster({
      workdir,
      deliver: runStart().deliver,
      mask: createPathMasker(workdirRoots(workdir)),
      http: {
        upload: async (o) => {
          writeFileSync(join(workdir, "chart.png"), Buffer.alloc(4096));
          return {
            id: "0192f000-0000-7000-8000-000000000001",
            kind: "file",
            url: "artifact://0192f000-0000-7000-8000-000000000001",
            name: o.name,
            mime: "text/plain",
            size: 1,
          };
        },
        download: async () => {
          throw new Error("not used");
        },
      },
      send: async () => ({ ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" }),
    });
    const out = await post({ files: ["out/report final.md", "chart.png"] });
    expect(out).toEqual({ error: expect.stringContaining("- chart.png: 검사한 뒤 바뀌었습니다") });
  });

  it("올리기가 실패하면 보내지 않는다 — 사유에 상대 경로만", async () => {
    const h = harness({ uploadFails: true });
    const out = await h.post({ files: ["out/report final.md"] });
    expect(h.sent).toEqual([]);
    expect(out).toEqual({
      error: "파일을 올리지 못했습니다(out/report final.md: 첨부 올리기 실패 507) — 보내지 않았습니다",
    });
  });
});
