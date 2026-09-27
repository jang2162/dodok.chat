import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Attachment, ComponentsV1, RunnerOutboundPost, type RunnerOutboundAck } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AttachmentsHttpError, type AttachmentsHttp } from "../src/attachments-http";
import { createPathMasker, OUTSIDE_WORKDIR, workdirRoots } from "../src/mask";
import {
  createDodokMcpServer,
  createPoster,
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

  function harness(opts: { ack?: RunnerOutboundAck; uploadFails?: boolean } = {}) {
    const uploads: Array<{ channelId: string; name: string; mime?: string; bytes: number }> = [];
    const sent: RunnerOutboundPost[] = [];
    let n = 0;
    const http: AttachmentsHttp = {
      upload: async (o) => {
        if (opts.uploadFails) throw new AttachmentsHttpError("첨부 올리기 실패 507", 507);
        uploads.push({
          channelId: o.channelId,
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
      now: () => Date.parse("2026-09-27T02:00:00.000Z"),
      newId: () => "post-1",
    });
    return { post, uploads, sent, start };
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
      { channelId: h.start.deliver.channelId, name: "report final.md", mime: "text/plain", bytes: 8 },
      { channelId: h.start.deliver.channelId, name: "chart.png", bytes: 2 },
    ]);
    const d = h.start.deliver;
    expect(h.sent).toEqual([
      {
        outboundId: "runner-post:post-1",
        channelId: d.channelId,
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

  it("서버가 거절하면(중지된 런 FORBIDDEN 등) 도구 결과로 사유", async () => {
    const h = harness({
      ack: { ok: false, code: "FORBIDDEN", message: "post must belong to an open run of this runner" },
    });
    expect(await h.post({ text: "x" })).toEqual({
      error: "보내지 못했습니다(FORBIDDEN): post must belong to an open run of this runner",
    });
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
