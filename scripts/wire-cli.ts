/**
 * wire-cli — 떠 있는 dodok 서버의 REST·wire 를 손으로 두드리는 CLI (서버 코어 스펙 9.3, docs/guides/live-smoke.md).
 *
 *   pnpm wire-cli <origin> [localToken] <명령> …
 *
 * localToken 을 빼면 env DODOK_LOCAL_TOKEN 을 쓴다. 로그인은 레이트리밋(5회/분)이 걸려 있어서
 * 세션 토큰을 data/wire-cli-session.json(ignored, 0600)에 오리진별로 캐시하고, `GET /auth/me` 가 401 이면 다시 로그인한다.
 * 토큰류는 어디에도 출력하지 않는다. @dodok/shared 는 루트에서 풀리지 않으므로 이벤트는 받은 JSON 을 그대로 요약해 찍는다.
 * 실패는 `{ code, message }` 를 stderr 에 찍고 exit 1.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { io, type Socket } from "socket.io-client";

/** packages/shared WIRE_PROTOCOL 과 같은 값 */
const WIRE_PROTOCOL = 1;
const DEFAULT_WATCH_MS = 60_000;
const TEXT_PREVIEW = 100;
const SESSION_FILE = resolve(import.meta.dirname, "../data/wire-cli-session.json");

type Json = Record<string, any>;

const USAGE = `사용: pnpm wire-cli <origin> [localToken] <명령> …   (localToken 이 없으면 env DODOK_LOCAL_TOKEN)

  login                                            세션을 새로 얻고 me 출력
  channels                                         GET /channels
  create-channel <name>                            POST /channels
  add-agent <channelId> <providerAgentId> <handle> 에이전트가 없으면 POST /agents, 있으면 재사용 → POST members
  patch-channel <channelId> <json>                 PATCH /channels/:id
  send <channelId> <text> [--watch-ms 60000]       구독 → message.send → 서버 이벤트를 시간표로
  interact <channelId> <messageId> <itemId> [--watch-ms 60000]
                                                   component.interact ack → 이벤트 시간표
  watch <channelId> [--watch-ms 60000]             구독만 하고 이벤트 시간표(adapter.status 관찰용)
  runs <channelId>                                 GET /channels/:id/runs 요약
  reset <channelId> <agentId|handle>               POST /channels/:id/agents/:agentId/reset`;

const COMMANDS = new Set([
  "login",
  "channels",
  "create-channel",
  "add-agent",
  "patch-channel",
  "send",
  "interact",
  "watch",
  "runs",
  "reset",
]);

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new CliError(code, message);
}

// ── 인자 ──

type Args = {
  origin: string;
  localToken: string | undefined;
  command: string;
  rest: string[];
  watchMs: number;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let watchMs = DEFAULT_WATCH_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--watch-ms") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) fail("USAGE", "--watch-ms 는 0 이상의 정수(ms)");
      watchMs = value;
    } else positional.push(arg);
  }
  const [origin, second, ...others] = positional;
  if (!origin || !second) fail("USAGE", "origin 과 명령이 필요하다");
  // 토큰은 16자 이상이라 명령 이름과 겹치지 않는다
  const tokenGiven = !COMMANDS.has(second);
  const command = tokenGiven ? others.shift() : second;
  if (!command || !COMMANDS.has(command)) fail("USAGE", `모르는 명령: ${command ?? "(없음)"}`);
  return {
    origin: origin.replace(/\/+$/, ""),
    localToken: tokenGiven ? second : process.env["DODOK_LOCAL_TOKEN"] || undefined,
    command,
    rest: others,
    watchMs,
  };
}

function need(rest: string[], names: string[]): string[] {
  if (rest.length < names.length) fail("USAGE", `필요한 인자: ${names.map((n) => `<${n}>`).join(" ")}`);
  return rest.slice(0, names.length);
}

// ── REST ──

type RestResult = { status: number; body: any };

async function request(
  origin: string,
  method: string,
  path: string,
  opts: { session?: string; body?: unknown } = {},
): Promise<RestResult> {
  const headers: Record<string, string> = {};
  if (opts.session) headers["authorization"] = `Bearer ${opts.session}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch (err) {
    const cause = (err as Error & { cause?: { message?: string } }).cause;
    fail("NETWORK", `${method} ${path}: ${cause?.message ?? (err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // JSON 이 아니면 문자열 그대로
  }
  return { status: res.status, body };
}

/** 2xx 가 아니면 ApiError 로 실패 */
function ok(what: string, res: RestResult): any {
  if (res.status >= 200 && res.status < 300) return res.body;
  const body = res.body as Json | null;
  if (body && typeof body === "object" && typeof body["code"] === "string")
    fail(body["code"], `${what} → HTTP ${res.status}: ${body["message"]}`);
  fail(`HTTP_${res.status}`, `${what}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
}

function printRest(method: string, path: string, res: RestResult): void {
  console.log(`HTTP ${res.status} ${method} /api/v1${path}`);
  console.log(JSON.stringify(res.body, null, 2));
}

// ── 세션 ──

function readSessions(): Record<string, string> {
  if (!existsSync(SESSION_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSession(origin: string, token: string): void {
  const all = { ...readSessions(), [origin]: token };
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

async function login(args: Args): Promise<{ session: string; me: Json }> {
  if (!args.localToken) fail("USAGE", "로컬 토큰이 없다 — 인자로 주거나 env DODOK_LOCAL_TOKEN");
  const res = await request(args.origin, "POST", "/auth/local", { body: { token: args.localToken } });
  const body = ok("POST /auth/local", res) as { sessionToken: string };
  saveSession(args.origin, body.sessionToken);
  const me = ok(
    "GET /auth/me",
    await request(args.origin, "GET", "/auth/me", { session: body.sessionToken }),
  );
  return { session: body.sessionToken, me };
}

/** 캐시한 세션이 살아 있으면 쓰고, 아니면 로그인한다 */
async function session(args: Args): Promise<{ session: string; me: Json }> {
  const cached = readSessions()[args.origin];
  if (cached) {
    const res = await request(args.origin, "GET", "/auth/me", { session: cached });
    if (res.status === 200) return { session: cached, me: res.body as Json };
    if (res.status !== 401) ok("GET /auth/me", res);
  }
  return login(args);
}

// ── wire ──

type Wire = Socket;

function connectWire(origin: string, sessionToken: string): Promise<Wire> {
  const socket = io(origin, {
    auth: { token: sessionToken, protocol: WIRE_PROTOCOL },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolvePromise, reject) => {
    socket.once("connect", () => resolvePromise(socket));
    socket.once("connect_error", (err: Error & { data?: Json }) => {
      socket.close();
      if (err.data && typeof err.data["code"] === "string")
        reject(new CliError(err.data["code"], `wire connect: ${err.data["message"]}`));
      else reject(new CliError("NETWORK", `wire connect: ${err.message}`));
    });
  });
}

async function emitAck(socket: Wire, event: string, payload: unknown): Promise<any> {
  const res = (await socket.timeout(15_000).emitWithAck(event, payload)) as
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };
  if (!res.ok) fail(res.error.code, `${event}: ${res.error.message}`);
  return res.data;
}

/** 에이전트·사용자 id → @핸들 (출력 가독용) */
async function loadNames(args: Args, sessionToken: string, me: Json): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const user = me["user"] as Json | undefined;
  if (user) names.set(user["id"], `@${user["handle"]}`);
  const res = await request(args.origin, "GET", "/agents", { session: sessionToken });
  if (res.status === 200)
    for (const a of (res.body as Json)["agents"] as Json[]) names.set(a["id"], `@${a["handle"]}`);
  return names;
}

const clip = (text: string, max = TEXT_PREVIEW): string =>
  JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);

/** 서버 → 클라이언트 이벤트를 `[+123ms] <event> <요약>` 한 줄씩. t0 는 헤더에 절대 시각으로 찍는다. */
function createTimeline(names: Map<string, string>) {
  const t0 = Date.now();
  console.log(`# t0 ${new Date(t0).toISOString()} (epoch ${t0})`);
  const who = (id: unknown): string => (typeof id === "string" ? (names.get(id) ?? id) : String(id));
  const line = (event: string, summary: string, at = Date.now()) =>
    console.log(`[+${at - t0}ms] ${event} ${summary}`);
  // 런별 델타 뭉치 — 첫 델타는 바로 찍고(지연 측정), 나머지는 다른 이벤트가 오거나 끝날 때 한 줄로
  const deltas = new Map<string, { count: number; text: string; firstAt: number }>();

  const flush = (runId: string) => {
    const d = deltas.get(runId);
    if (!d) return;
    deltas.delete(runId);
    line(
      "run.event",
      `TEXT_MESSAGE_CONTENT×${d.count} run=${runId} (첫 델타 +${d.firstAt - t0}ms) ${clip(d.text)}`,
    );
  };

  const summarizeMessage = (m: Json): string => {
    const parts = [
      `id=${m["id"]}`,
      `seq=${m["seq"]}`,
      `kind=${m["kind"]}`,
      `author=${m["authorType"]}${m["authorId"] ? `:${who(m["authorId"])}` : ""}`,
    ];
    if (m["runId"]) parts.push(`runId=${m["runId"]}`);
    if (m["replyTo"]) parts.push(`replyTo=${m["replyTo"]}`);
    if (m["systemMeta"]) parts.push(`systemMeta=${JSON.stringify(m["systemMeta"])}`);
    const components = m["components"] as Json | undefined;
    if (components) {
      const items = (components["blocks"] as Json[]).flatMap((b) =>
        ((b["items"] as Json[] | undefined) ?? []).map((i) => i["id"]),
      );
      parts.push(`components=${components["id"]} items=[${items.join(",")}]`);
    }
    const state = m["componentState"] as Json | undefined;
    if (state) parts.push(`consumed=[${(state["consumed"] as string[]).join(",")}]`);
    parts.push(`body=${clip(String(m["bodyMd"] ?? ""))}`);
    return parts.join(" ");
  };

  const summarizeRunEvent = (e: Json): string => {
    const { type, runId, seq, ts: _ts, ...rest } = e;
    const head = `${type} run=${runId} seq=${seq}`;
    switch (type) {
      case "RUN_STARTED":
        return `${head} agent=${who(rest["agentId"])} providerRunId=${rest["providerRunId"]} sessionKey=${rest["sessionKey"]}`;
      case "RUN_FINISHED":
        return `${head} messageIds=${JSON.stringify(rest["messageIds"])} usage=${JSON.stringify(rest["usage"])} stopReason=${rest["stopReason"]}`;
      case "RUN_ERROR":
        return `${head} code=${rest["code"]} message=${clip(String(rest["message"]))}`;
      case "STATE_SNAPSHOT": {
        const s = rest["snapshot"] as Json;
        return `${head} status=${s["status"]} finalSource=${s["finalSource"]}`;
      }
      default: {
        const json = JSON.stringify(rest);
        return `${head} ${json.length > 200 ? `${json.slice(0, 200)}…` : json}`;
      }
    }
  };

  const onEvent = (event: string, payload: Json) => {
    const at = Date.now();
    switch (event) {
      case "message.created":
      case "message.updated":
        line(event, summarizeMessage(payload["message"] as Json), at);
        return;
      case "run.state": {
        const r = payload["run"] as Json;
        if (["done", "error", "aborted"].includes(r["status"])) flush(r["id"]);
        line(
          event,
          [
            `run=${r["id"]}`,
            `agent=${who(r["agentId"])}`,
            `status=${r["status"]}`,
            `depth=${r["relayDepth"]}`,
            r["finalSource"] ? `finalSource=${r["finalSource"]}` : "",
            r["hasCanonical"] ? "hasCanonical" : "",
            r["error"] ? `error=${JSON.stringify(r["error"])}` : "",
            payload["resync"] ? "resync" : "",
          ]
            .filter(Boolean)
            .join(" "),
          at,
        );
        return;
      }
      case "run.event": {
        const e = payload["event"] as Json;
        const runId = String(e["runId"]);
        if (e["type"] === "TEXT_MESSAGE_CONTENT") {
          const d = deltas.get(runId);
          if (d) {
            d.count++;
            d.text += e["delta"];
          } else {
            deltas.set(runId, { count: 1, text: String(e["delta"]), firstAt: at });
            line(
              event,
              `TEXT_MESSAGE_CONTENT run=${runId} seq=${e["seq"]} 첫 델타 ${clip(String(e["delta"]))}`,
              at,
            );
          }
          return;
        }
        flush(runId);
        line(event, summarizeRunEvent(e), at);
        return;
      }
      case "adapter.status":
        line(event, `gateway=${payload["gateway"]} bridge=${payload["bridge"]}`, at);
        return;
      case "system.notice":
        line(event, `${payload["level"]} ${clip(String(payload["message"]), 200)}`, at);
        return;
      default: {
        const json = JSON.stringify(payload);
        line(event, json.length > 300 ? `${json.slice(0, 300)}…` : json, at);
      }
    }
  };

  return {
    t0,
    line,
    attach(socket: Wire) {
      socket.onAny((event: string, payload: Json) => onEvent(event, payload));
      socket.on("disconnect", (reason) => line("disconnect", reason));
    },
    flushAll() {
      for (const runId of Array.from(deltas.keys())) flush(runId);
    },
  };
}

async function openChannel(args: Args, channelId: string) {
  const { session: token, me } = await session(args);
  const names = await loadNames(args, token, me);
  const socket = await connectWire(args.origin, token);
  const timeline = createTimeline(names);
  timeline.attach(socket);
  const sub = (await emitAck(socket, "channel.subscribe", { channelId })) as Json;
  const active = (sub["activeRuns"] as Json[]).map((r) => `${r["id"]}:${r["status"]}`);
  timeline.line(
    "channel.subscribe",
    `ack messages=${(sub["messages"] as unknown[]).length} hasMore=${sub["hasMore"]} activeRuns=[${active.join(",")}]`,
  );
  return { socket, timeline, token };
}

async function watchFor(
  args: Args,
  socket: Wire,
  timeline: ReturnType<typeof createTimeline>,
): Promise<void> {
  await new Promise((r) => setTimeout(r, args.watchMs));
  timeline.flushAll();
  timeline.line("watch", `${args.watchMs}ms 끝`);
  socket.close();
}

// ── 명령 ──

async function run(args: Args): Promise<void> {
  const { origin, rest } = args;
  switch (args.command) {
    case "login": {
      const { me } = await login(args);
      console.log(JSON.stringify(me, null, 2));
      return;
    }
    case "channels": {
      const { session: token } = await session(args);
      const res = await request(origin, "GET", "/channels", { session: token });
      ok("GET /channels", res);
      printRest("GET", "/channels", res);
      return;
    }
    case "create-channel": {
      const [name] = need(rest, ["name"]) as [string];
      const { session: token } = await session(args);
      const res = await request(origin, "POST", "/channels", { session: token, body: { name } });
      ok("POST /channels", res);
      printRest("POST", "/channels", res);
      return;
    }
    case "add-agent": {
      const [channelId, providerAgentId, handle] = need(rest, ["channelId", "providerAgentId", "handle"]) as [
        string,
        string,
        string,
      ];
      const { session: token } = await session(args);
      const agents = ok("GET /agents", await request(origin, "GET", "/agents", { session: token }))[
        "agents"
      ] as Json[];
      let agent = agents.find((a) => a["providerAgentId"] === providerAgentId);
      if (agent) {
        console.log(
          `에이전트 재사용: id=${agent["id"]} providerAgentId=${providerAgentId} handle=@${agent["handle"]}`,
        );
      } else {
        const created = await request(origin, "POST", "/agents", {
          session: token,
          body: { providerAgentId, handle, name: handle },
        });
        ok("POST /agents", created);
        printRest("POST", "/agents", created);
        agent = (created.body as Json)["agent"] as Json;
      }
      const path = `/channels/${channelId}/members`;
      const member = await request(origin, "POST", path, {
        session: token,
        body: { memberType: "agent", memberId: agent["id"] },
      });
      ok(`POST ${path}`, member);
      printRest("POST", path, member);
      return;
    }
    case "patch-channel": {
      const [channelId, raw] = need(rest, ["channelId", "json"]) as [string, string];
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch (err) {
        fail("USAGE", `json 파싱 실패: ${(err as Error).message}`);
      }
      const { session: token } = await session(args);
      const path = `/channels/${channelId}`;
      const res = await request(origin, "PATCH", path, { session: token, body });
      ok(`PATCH ${path}`, res);
      printRest("PATCH", path, res);
      return;
    }
    case "send": {
      const [channelId, text] = need(rest, ["channelId", "text"]) as [string, string];
      const { socket, timeline } = await openChannel(args, channelId);
      timeline.line("message.send", `emit ${clip(text)}`);
      const data = (await emitAck(socket, "message.send", {
        channelId,
        clientMsgId: randomUUID(),
        bodyMd: text,
      })) as Json;
      const m = data["message"] as Json;
      timeline.line("message.send", `ack id=${m["id"]} seq=${m["seq"]}`);
      await watchFor(args, socket, timeline);
      return;
    }
    case "interact": {
      const [channelId, messageId, itemId] = need(rest, ["channelId", "messageId", "itemId"]) as [
        string,
        string,
        string,
      ];
      const { socket, timeline, token } = await openChannel(args, channelId);
      const path = `/channels/${channelId}/messages?limit=200`;
      const page = ok(`GET ${path}`, await request(origin, "GET", path, { session: token })) as Json;
      const message = (page["messages"] as Json[]).find((m) => m["id"] === messageId);
      if (!message) fail("NOT_FOUND", `최근 200개 메시지에 ${messageId} 가 없다`);
      const components = message["components"] as Json | undefined;
      if (!components) fail("NOT_FOUND", `메시지 ${messageId} 에 components 가 없다`);
      // 계약 9.3: componentId 는 ComponentsV1.id(cmp_…). blockId 는 서버가 아이템으로 찾는다
      const payload = { messageId, componentId: components["id"], itemId, values: {} };
      timeline.line("component.interact", `emit ${JSON.stringify(payload)}`);
      const data = (await emitAck(socket, "component.interact", payload)) as Json;
      timeline.line("component.interact", `ack ${JSON.stringify(data)}`);
      await watchFor(args, socket, timeline);
      return;
    }
    case "watch": {
      const [channelId] = need(rest, ["channelId"]) as [string];
      const { socket, timeline } = await openChannel(args, channelId);
      await watchFor(args, socket, timeline);
      return;
    }
    case "runs": {
      const [channelId] = need(rest, ["channelId"]) as [string];
      const { session: token, me } = await session(args);
      const names = await loadNames(args, token, me);
      const path = `/channels/${channelId}/runs`;
      const res = ok(`GET ${path}`, await request(origin, "GET", path, { session: token })) as Json;
      console.log(`HTTP 200 GET /api/v1${path} — ${(res["runs"] as unknown[]).length}건(최근 순)`);
      for (const r of res["runs"] as Json[]) {
        console.log(
          [
            r["id"],
            names.get(r["agentId"]) ?? r["agentId"],
            r["status"],
            `trigger=${r["triggerKind"]}`,
            `depth=${r["relayDepth"]}`,
            `root=${r["rootMessageId"]}`,
            r["providerRunId"] ? `providerRunId=${r["providerRunId"]}` : "providerRunId=-",
            `finalSource=${r["finalSource"] ?? "-"}`,
            r["error"] ? `error=${JSON.stringify(r["error"])}` : "",
            r["usage"] ? `usage=${JSON.stringify(r["usage"])}` : "",
            `created=${r["createdAt"]}`,
            `started=${r["startedAt"] ?? "-"}`,
            `ended=${r["endedAt"] ?? "-"}`,
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      return;
    }
    case "reset": {
      const [channelId, agentRef] = need(rest, ["channelId", "agentId|handle"]) as [string, string];
      const { session: token } = await session(args);
      let agentId = agentRef;
      if (!/^[0-9a-f-]{36}$/i.test(agentRef)) {
        const agents = ok("GET /agents", await request(origin, "GET", "/agents", { session: token }))[
          "agents"
        ] as Json[];
        const found = agents.find((a) => a["handle"] === agentRef.replace(/^@/, ""));
        if (!found) fail("NOT_FOUND", `핸들 ${agentRef} 인 에이전트가 없다`);
        agentId = found["id"];
      }
      const path = `/channels/${channelId}/agents/${agentId}/reset`;
      const res = await request(origin, "POST", path, { session: token });
      ok(`POST ${path}`, res);
      printRest("POST", path, res);
      return;
    }
  }
}

// 루트 package.json 은 type 이 없어 tsx 가 CJS 로 돌린다 — 최상위 await 대신 프로미스로 끝낸다
Promise.resolve()
  .then(() => run(parseArgs(process.argv.slice(2))))
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const body =
      err instanceof CliError
        ? { code: err.code, message: err.message }
        : { code: "INTERNAL", message: (err as Error).stack ?? String(err) };
    console.error(JSON.stringify(body));
    if (body.code === "USAGE") console.error(USAGE);
    process.exit(1);
  });
