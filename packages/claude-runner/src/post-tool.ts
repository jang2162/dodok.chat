import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  ComponentsV1,
  type InboundDeliver,
  type RunnerOutboundAck,
  type RunnerOutboundPost,
} from "@dodok/shared";
import { z } from "zod";
import type { AttachmentsHttp } from "./attachments-http";
import {
  checkPostFiles,
  describePostFileRejections,
  type FilesFs,
  nodeFilesFs,
  openCheckedFile,
  readCheckedFile,
} from "./files";
import type { PathMasker } from "./mask";
import { defineSdkTool, type SdkMcpServer, type SdkPort } from "./sdk";

// dodok 도구 `mcp__dodok__post`(러너 스펙 4.4) — 런의 채널(스레드 런이면 그 스레드)에 카드·파일을 보낸다. 거절은 던지지 않고
// 도구 결과로 돌려준다(런은 계속된다). 모델에게 가는 글이라 호스트 경로를 싣지 않는다

export const POST_TOOL_NAME = "post";
/** 모델이 보는 이름 — allowedTools 에 늘 싣는다(승인 콜백은 입력 검증보다 먼저 와서, 묻게 두면 틀린 입력도 카드가 뜬다) */
export const POST_TOOL_FULL_NAME = `mcp__dodok__${POST_TOOL_NAME}`;
const TEXT_MAX = 4000;

const DESCRIPTION =
  "Post a message to this dodok channel (or thread) now: interactive UI (components v1), files from your " +
  "working directory, and optional text. Your final answer is posted to the channel automatically — use this " +
  "tool for cards and files, not to repeat the answer. files are paths inside the working directory (at most " +
  "10, 20 MiB each). In components, point at a file sent in the same call with artifact://<file name> " +
  "(percent-encode spaces).";

// components 는 shared 스키마 그대로 — 모델이 보는 스키마와 서버가 받는 스키마가 갈라지지 않게
export const PostInputSchema = z
  .object({
    text: z.string().max(TEXT_MAX).optional(),
    components: ComponentsV1.optional(),
    files: z.array(z.string()).max(10).optional(),
  })
  .refine((v) => v.text || v.components || v.files?.length, "text·components·files 중 하나는 있어야 합니다");
export type PostInput = z.infer<typeof PostInputSchema>;
export type PostResult = { messageId: string } | { error: string };

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

export function createDodokMcpServer(deps: {
  sdk: SdkPort;
  post: (input: PostInput) => Promise<PostResult>;
}): SdkMcpServer {
  // SDK MCP 층은 모양(shape)만 검사한다 — 「셋 중 하나」 refine 은 여기서 한 번 더 본다
  const post = defineSdkTool(POST_TOOL_NAME, DESCRIPTION, PostInputSchema.shape, async (args) => {
    const parsed = PostInputSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(입력)"}: ${i.message}`);
      return textResult(`입력이 틀렸습니다 — ${issues.join("; ")}`, true);
    }
    const result = await deps.post(parsed.data);
    if ("error" in result) return textResult(result.error, true);
    return textResult(`보냈습니다(메시지 ${result.messageId})`);
  });
  return deps.sdk.createMcpServer([post]);
}

// 서버는 매직 바이트로 이미지·PDF 를 가르고, 그 밖은 이 힌트가 글 종류일 때만 받는다(apps/server attachments/sniff.ts)
const MIME_HINTS: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

export type PosterDeps = {
  workdir: string;
  /** 그 런의 run.start 값 — 어댑터가 열린 런과 채널·에이전트·세션·스레드를 대조한다 */
  deliver: InboundDeliver;
  http: AttachmentsHttp;
  send: (message: RunnerOutboundPost) => Promise<RunnerOutboundAck>;
  mask: PathMasker;
  /** 런의 signal — 멈춘 런은 올리지 않는다(올린 뒤 서버가 FORBIDDEN 이면 블롭만 24시간 남는다) */
  signal?: AbortSignal;
  fs?: FilesFs;
  now?: () => number;
  newId?: () => string;
};

export const POST_STOPPED_MESSAGE = "런이 멈춰 보내지 않았습니다";
export const POST_COMPONENTS_TOO_LONG =
  "보내지 않았습니다 — components 안의 호스트 경로를 가리면 길이 제한을 넘습니다. 경로를 작업 디렉터리 상대 경로로 줄여 다시 보내세요";

/** post 도구의 실제 일 — 파일을 모두 검사하고, 하나라도 거절이면 아무것도 올리지 않는다 */
export function createPoster(deps: PosterDeps): (input: PostInput) => Promise<PostResult> {
  const fs = deps.fs ?? nodeFilesFs;
  const stopped = () => deps.signal?.aborted === true;
  return async (input) => {
    // 답 글과 같은 규칙으로 가린다(최종 답 run.final.text 도 가린다). 카드 안 글도 가리고 스키마로 다시 본다 — 가린 표지가
    // 원문보다 길 수 있다
    let components: PostInput["components"];
    if (input.components !== undefined) {
      const masked = ComponentsV1.safeParse(deps.mask.value(input.components));
      if (!masked.success) return { error: POST_COMPONENTS_TOO_LONG };
      components = masked.data;
    }
    const attachmentIds: string[] = [];
    const files = input.files ?? [];
    if (files.length > 0) {
      const { checks, tooMany } = checkPostFiles(deps.workdir, files, fs);
      if (tooMany || checks.some((c) => !c.ok)) return { error: describePostFileRejections(checks, tooMany) };
      const passed = checks.flatMap((c) => (c.ok ? [c] : []));
      // 올리기 전에 모두 연다 — 이 뒤로는 경로가 아니라 연 fd 에서 읽는다
      const opened: Array<{ check: (typeof passed)[number]; fd: number }> = [];
      try {
        for (const check of passed) {
          const o = openCheckedFile(check, fs);
          if (!o.ok) return { error: describePostFileRejections([o], false) };
          opened.push({ check, fd: o.fd });
        }
        for (const { check, fd } of opened) {
          if (stopped()) return { error: POST_STOPPED_MESSAGE };
          const bytes = readCheckedFile(fd, check, fs);
          if (bytes === undefined) {
            return {
              error: describePostFileRejections([{ ok: false, rel: check.rel, reason: "changed" }], false),
            };
          }
          const name = basename(check.rel);
          try {
            const mime = MIME_HINTS[extname(name).toLowerCase()];
            const att = await deps.http.upload({
              channelId: deps.deliver.channelId,
              bytes,
              name,
              ...(mime ? { mime } : {}),
              ...(deps.signal ? { signal: deps.signal } : {}),
            });
            attachmentIds.push(att.id);
          } catch (error) {
            // 앞서 올린 파일은 메시지에 묶이지 않아 서버 정리(24시간)가 치운다
            if (stopped()) return { error: POST_STOPPED_MESSAGE };
            const why = error instanceof Error ? deps.mask(error.message) : "알 수 없는 오류";
            return { error: `파일을 올리지 못했습니다(${check.rel}: ${why}) — 보내지 않았습니다` };
          }
        }
      } finally {
        for (const { fd } of opened) fs.close(fd);
      }
    }
    if (stopped()) return { error: POST_STOPPED_MESSAGE };
    const d = deps.deliver;
    const ack = await deps.send({
      outboundId: `runner-post:${(deps.newId ?? randomUUID)()}`,
      channelId: d.channelId,
      agentId: d.agentId,
      sessionKey: d.sessionKey,
      ...(d.threadId === undefined ? {} : { threadId: d.threadId }),
      runId: d.runId,
      replyToInboundId: d.message.id,
      text: deps.mask(input.text ?? ""),
      ...(components === undefined ? {} : { components }),
      attachmentIds,
      ts: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    if (ack.ok) return { messageId: ack.messageId };
    return { error: `보내지 못했습니다(${ack.code}): ${deps.mask(ack.message)}` };
  };
}
