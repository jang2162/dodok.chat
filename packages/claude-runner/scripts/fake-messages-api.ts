/**
 * 로컬 가짜 Messages API — Claude 러너 런 0회 하네스(docs/guides/live-smoke.md 「Claude 러너 런 0회 하네스」 절, ADR 0007
 * 「다시 재는 법」 6). 번들 CLI 에 ANTHROPIC_BASE_URL=http://127.0.0.1:<포트>·가짜 API 키를 주면 CLI 가 모델 대신 여기에 묻는다 —
 * CLI 가 실제로 보내는 요청 본문(시스템 프롬프트·메시지 배열·도구 목록)을 파일로 남기고, 대본대로 SSE 를 돌려줘 CLI 의 권한 판단·
 * 도구 실행·interrupt 가 실제로 돈다. 모델을 부르지 않는다(바깥으로 나가는 연결이 없다).
 *
 *   node packages/claude-runner/scripts/fake-messages-api.ts --port 3197 --out <스크래치>/api
 *
 * 대본은 사용자 메시지 본문(러너 프롬프트의 `---` 뒤)의 키워드로 고른다. 도구 결과가 돌아오면 그 도구를 낸 대본이 결과를 요약한
 * 글로 턴을 끝낸다 — 요약은 채널에 남으므로 도구 결과 문구(거절 사유 등)가 가려진 채 보이는지 채널에서 볼 수 있다.
 *
 * | 키워드 | 응답 |
 * | --- | --- |
 * | HX-TEXT | 글 한 덩이(델타 5) |
 * | HX-SLOW | 글 40조각을 0.5초 간격(20초) — 중지·러너 죽이기용 |
 * | HX-BASH | 쓰기 Bash(`touch hx-note.txt`) tool_use → 결과를 받으면 `HX-BASH-DONE` |
 * | HX-POST-IN | `mcp__dodok__post` 로 작업 디렉터리 안 파일 `hx-out.txt` → `HX-POST-DONE` |
 * | HX-POST-OUT | `mcp__dodok__post` 로 작업 디렉터리 밖 `../hx-outside.txt` → `HX-POST-DONE` |
 * | (그 밖) | 글 한 줄 `ok` — CLI 의 보조 요청도 여기로 온다 |
 *
 * 남기는 것: `<out>/requests.jsonl`(요청마다 한 줄 — 번호·시각·경로·대본·요약)과 `<out>/NNN.json`(요청 본문 그대로). 헤더는
 * 남기지 않는다(가짜 키라도 적지 않는다).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type Json = Record<string, unknown>;
type Block = { type?: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
type ApiMessage = { role?: string; content?: string | Block[] };

type ToolStep = { name: string; input: Json };
type Script = {
  key: string;
  /** 첫 응답이 글이면 조각들, 도구면 그 도구 */
  text?: string[];
  tool?: ToolStep;
  intervalMs: number;
};

const SCRIPTS: Script[] = [
  {
    key: "HX-SLOW",
    text: Array.from({ length: 40 }, (_, i) => `느린 조각 ${i + 1}. `),
    intervalMs: 500,
  },
  {
    key: "HX-BASH",
    tool: {
      name: "Bash",
      input: { command: "touch hx-note.txt", description: "Create the harness note file" },
    },
    intervalMs: 20,
  },
  {
    key: "HX-POST-IN",
    tool: { name: "mcp__dodok__post", input: { text: "하네스가 파일을 보냅니다.", files: ["hx-out.txt"] } },
    intervalMs: 20,
  },
  {
    key: "HX-POST-OUT",
    tool: { name: "mcp__dodok__post", input: { text: "밖 파일", files: ["../hx-outside.txt"] } },
    intervalMs: 20,
  },
  {
    key: "HX-TEXT",
    text: ["하네스 ", "답입니다 ", "— 가짜 ", "Messages API 가 ", "보냈습니다."],
    intervalMs: 20,
  },
];

const { values: args } = parseArgs({
  options: { port: { type: "string", default: "3197" }, out: { type: "string" } },
});
if (!args.out) {
  console.error("사용법: node fake-messages-api.ts --port <포트> --out <디렉터리>");
  process.exit(1);
}
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });

// 도구 결과가 돌아올 때 어느 대본의 도구였는지 — tool_use id 로 찾는다
const toolScripts = new Map<string, string>();
let seq = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textBlocks(message: ApiMessage): Block[] {
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

/** 러너 프롬프트(`[dodok context] channel=…` 머리, `---` 뒤가 사람이 쓴 본문)를 뒤에서부터 찾아 본문만 */
function lastPromptBody(messages: ApiMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const blocks = textBlocks(m);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const text = blocks[j]?.type === "text" ? (blocks[j]?.text ?? "") : "";
      if (!text.includes("[dodok context] channel=")) continue;
      const cut = text.lastIndexOf("\n---\n");
      return cut === -1 ? text : text.slice(cut + 5);
    }
  }
  return undefined;
}

/**
 * 마지막 사용자 메시지의 도구 결과들. CLI 는 도구 결과 뒤에도 시스템 역할 메시지(`<system-reminder>`)를 붙여 보내므로 그것을
 * 건너뛴다 — 맨 끝만 보면 도구 결과를 못 보고 같은 도구를 다시 내 승인이 끝없이 되풀이된다
 */
function lastToolResults(messages: ApiMessage[]): Block[] {
  const last = [...messages].reverse().find((m) => m.role !== "system");
  if (last?.role !== "user") return [];
  return textBlocks(last).filter((b) => b.type === "tool_result");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c as Block).text ?? "").join(" ");
  return "";
}

type Plan = { scenario: string; text?: string[]; tool?: ToolStep; intervalMs: number };

function plan(body: Json): Plan {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as ApiMessage[];
  const results = lastToolResults(messages);
  if (results.length > 0) {
    const first = results[0] as Block;
    const key = toolScripts.get(first.tool_use_id ?? "") ?? "unknown-tool";
    const summary = resultText(first.content).replace(/\s+/g, " ").slice(0, 300);
    return {
      scenario: `${key}:result`,
      text: [`${key}-DONE `, `is_error=${first.is_error === true} `, `결과: ${summary}`],
      intervalMs: 20,
    };
  }
  const prompt = lastPromptBody(messages);
  const script = prompt === undefined ? undefined : SCRIPTS.find((s) => prompt.includes(s.key));
  if (!script) return { scenario: prompt === undefined ? "aux" : "plain", text: ["ok"], intervalMs: 0 };
  return { scenario: script.key, text: script.text, tool: script.tool, intervalMs: script.intervalMs };
}

function sse(res: ServerResponse, event: string, data: Json): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

const usage = (output: number) => ({
  input_tokens: 100,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

async function stream(res: ServerResponse, model: string, p: Plan, closed: () => boolean): Promise<void> {
  const id = `msg_hx_${seq}_${Date.now()}`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(res, "message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usage(1),
    },
  });
  let output = 0;
  if (p.tool) {
    const toolUseId = `toolu_hx_${seq}_${Date.now()}`;
    toolScripts.set(toolUseId, p.scenario);
    sse(res, "content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: toolUseId, name: p.tool.name, input: {} },
    });
    const json = JSON.stringify(p.tool.input);
    // 입력을 두 조각으로 — 실제 스트림처럼 input_json_delta 가 여러 번 온다
    for (const part of [json.slice(0, json.length >> 1), json.slice(json.length >> 1)]) {
      await sleep(p.intervalMs);
      if (closed()) return;
      sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: part } });
    }
    sse(res, "content_block_stop", { index: 0 });
    output = json.length >> 2;
    sse(res, "message_delta", {
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: usage(output),
    });
  } else {
    sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const piece of p.text ?? []) {
      await sleep(p.intervalMs);
      if (closed()) return;
      sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
      output += Math.max(1, piece.length >> 2);
    }
    sse(res, "content_block_stop", { index: 0 });
    sse(res, "message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: usage(output),
    });
  }
  sse(res, "message_stop", {});
  res.end();
}

/** stream: false 요청 — CLI 의 보조 호출이 이 꼴일 수 있다 */
function whole(res: ServerResponse, model: string, p: Plan): void {
  const content = p.tool
    ? [{ type: "tool_use", id: `toolu_hx_${seq}`, name: p.tool.name, input: p.tool.input }]
    : [{ type: "text", text: (p.text ?? []).join("") }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_hx_${seq}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: p.tool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: usage(10),
    }),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const raw = await readBody(req);
  const n = ++seq;
  const t = new Date().toISOString();
  let body: Json = {};
  try {
    body = raw ? (JSON.parse(raw) as Json) : {};
  } catch {
    // 본문이 JSON 이 아니면 빈 것으로 본다 — 줄은 남긴다
  }
  const index = (extra: Json) =>
    appendFileSync(
      join(OUT, "requests.jsonl"),
      `${JSON.stringify({ n, t, method: req.method, path, ...extra })}\n`,
    );

  if (req.method === "POST" && path.endsWith("/v1/messages/count_tokens")) {
    index({ scenario: "count_tokens" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
    index({ scenario: "unhandled" });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake api" } }));
    return;
  }

  writeFileSync(join(OUT, `${String(n).padStart(3, "0")}.json`), raw);
  const p = plan(body);
  const model = typeof body.model === "string" ? body.model : "unknown";
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>) : [];
  index({
    scenario: p.scenario,
    model,
    stream: body.stream === true,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: tools.length,
    bytes: raw.length,
  });
  let aborted = false;
  // 응답 중에 CLI 가 끊으면(interrupt·프로세스 종료) 그 시각을 남기고 대본을 멈춘다
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      index({ scenario: p.scenario, event: "client-closed", at: new Date().toISOString() });
    }
  });
  if (body.stream === true) await stream(res, model, p, () => aborted);
  else whole(res, model, p);
});

server.listen(Number(args.port), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  console.log(`fake messages api — http://127.0.0.1:${port} (요청 기록 ${OUT})`);
});
