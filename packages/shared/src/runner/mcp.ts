import { z } from "zod";

// 봇의 MCP 서버(러너 봇 2부 스펙 T1~T4·T15·T17·T18) — 꼴은 Claude Code `.mcp.json` 의 `mcpServers` 값과 같다. 서버(표시·전송)와
// 러너(런)가 같은 판정 함수 appMcpVerdict 를 쓴다 — 러너는 서버를 믿지 않고 런마다 다시 판정한다. 이 파일은 zod 만 import 한다
// (domain·runner/index 가 이것을 import 한다 — 거꾸로 import 하면 순환이 된다)

/** 봇 하나의 MCP 서버 수 상한 */
export const MCP_SERVERS_MAX = 16;

/**
 * 서버 이름 — 도구 이름 `mcp__<서버>__<도구>` 의 가운데. `dodok`(대소문자 무시)은 러너의 dodok MCP 자리라 거절한다. `__` 와 처음·끝의
 * `_` 도 거절한다 — `dodok__x`·`dodok_` 같은 이름이면 도구 이름이 `mcp__dodok__…` 로 시작해 러너가 늘 허용하는 dodok 도구로 읽히고,
 * `a_` 의 도구 `mcp__a___x` 는 서버 `a` 의 「전부」(`mcp__a__` 로 시작)에 든다
 */
export const McpServerName = z
  .string()
  .regex(
    /^[a-zA-Z0-9-](?:[a-zA-Z0-9_-]{0,62}[a-zA-Z0-9-])?$/,
    "MCP server name must match [a-zA-Z0-9_-]{1,64} and not start or end with _",
  )
  .refine((name) => name.toLowerCase() !== "dodok", "MCP server name dodok is reserved")
  .refine((name) => !name.includes("__"), "MCP server name must not contain __");
export type McpServerName = z.infer<typeof McpServerName>;

/** 헤더·env — 키는 이름, 값은 비밀일 수 있다(T4 — REST 읽기에는 MCP_SECRET_MASK 로) */
const SecretMap = z.record(z.string().min(1).max(256), z.string().max(8192));

/**
 * 주소의 authority(`://` 뒤 첫 `/`·`?`·`#` 앞)가 판정(isPrivateAddress)이 읽는 글자 그대로 연결되는가(T17) — WHATWG URL 은 http(s)
 * 에서 `\` 를 `/` 로 보고(`127.0.0.1\@example.com` 의 호스트는 127.0.0.1), 전각 숫자·`。`·`ⓛ` 같은 글자를 ASCII 로 바꾸고, 탭·줄바꿈을
 * 지운다. 그런 글자가 authority 에 있으면 받지 않는다
 */
function plainAuthority(url: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  return m !== null && /^[\x21-\x7e]*$/.test(m[1] ?? "") && !(m[1] ?? "").includes("\\");
}

/** 원격 서버 — 주소는 http(s) 만, authority 는 ASCII 만(plainAuthority) */
export const McpRemoteServer = z.strictObject({
  type: z.enum(["http", "sse"]),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .refine(plainAuthority, "MCP server url host must be plain ASCII without \\"),
  headers: SecretMap.optional(),
});
export type McpRemoteServer = z.infer<typeof McpRemoteServer>;

/** 명령 서버 — 러너 머신에서 그 명령을 띄운다. 러너 로컬 appMcp 가 "all" 일 때만 쓴다(T2) */
export const McpStdioServer = z.strictObject({
  type: z.literal("stdio").optional(),
  command: z.string().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(64).optional(),
  env: SecretMap.optional(),
});
export type McpStdioServer = z.infer<typeof McpStdioServer>;

export const McpServerConfig = z.union([McpRemoteServer, McpStdioServer]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const isStdioServer = (server: McpServerConfig): server is McpStdioServer =>
  server.type === undefined || server.type === "stdio";

/** 서버 이름 → 설정. 봇마다 MCP_SERVERS_MAX 개까지 */
export const McpServers = z
  .record(McpServerName, McpServerConfig)
  .refine((servers) => Object.keys(servers).length <= MCP_SERVERS_MAX, {
    message: `at most ${MCP_SERVERS_MAX} MCP servers`,
  });
export type McpServers = z.infer<typeof McpServers>;

/**
 * 붙여넣기(T1) — `.mcp.json` 을 통째로(`{ "mcpServers": { … } }`) 붙여도, 그 값만 붙여도 받는다. 웹 편집기와 시험이 쓴다
 */
export const McpServersPaste = z.preprocess(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && "mcpServers" in value
      ? (value as { mcpServers: unknown }).mcpServers
      : value,
  McpServers,
);

/** MCP 도구 이름(서버 안) — 자동 허용 목록의 한 줄 */
export const McpToolName = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/, "invalid MCP tool name");

/** 서버마다 「묻지 않음」(T15) — 없음(기본)·전부·도구 이름 목록 */
export const McpAutoAllow = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({ mode: z.literal("tools"), tools: z.array(McpToolName).min(1).max(100) }),
]);
export type McpAutoAllow = z.infer<typeof McpAutoAllow>;

/** 서버 이름 → 자동 허용. 없는 서버는 「없음」 */
export const McpAutoAllowMap = z.record(McpServerName, McpAutoAllow);
export type McpAutoAllowMap = z.infer<typeof McpAutoAllowMap>;

/** 봇 내장 도구(T7) — 「이 러너 설정 제어」 */
export const RunnerBotBuiltinTool = z.enum(["runnerControl"]);
export type RunnerBotBuiltinTool = z.infer<typeof RunnerBotBuiltinTool>;
export const RunnerBotBuiltinTools = z.array(RunnerBotBuiltinTool).max(8);

/** 러너 로컬 설정 appMcp(T2) — off: 모두 막음, http: http·sse 만(기본), all: stdio 도 */
export const AppMcpMode = z.enum(["off", "http", "all"]);
export type AppMcpMode = z.infer<typeof AppMcpMode>;

/** 판정에 쓰는 러너의 천장 — hello 의 programs[].ceiling 에서 꺼낸다(T3) */
export type AppMcpCeiling = {
  appMcp: AppMcpMode;
  /** stdio 명령의 basename 허용 목록 — null 이면 명령을 가리지 않는다 */
  appMcpCommands: string[] | null;
  /** 러너 allowedToolsCeiling — null 이면 상한 없음 */
  allowedToolsCeiling: string[] | null;
};

export const AppMcpBlockReason = z.enum([
  "appMcpOff",
  "stdioNotAllowed",
  "commandNotAllowed",
  "privateAddress",
  "envKeyNotAllowed",
]);
export type AppMcpBlockReason = z.infer<typeof AppMcpBlockReason>;

/**
 * ok 면 서버는 붙는다. allowedTools 는 묻지 않을 이름, outsideCeiling 은 자동 허용으로 골랐지만 러너 allowedToolsCeiling 밖이라
 * 「묻기」로 내린 이름(T15 — 서버째 막지 않는다)
 */
export type AppMcpVerdict =
  | { ok: true; allowedTools: string[]; outsideCeiling: string[] }
  | { ok: false; reason: AppMcpBlockReason; detail?: string };

/** 「이 러너가 막음 — <문구>」 의 문구 */
export function appMcpBlockText(reason: AppMcpBlockReason, detail?: string): string {
  switch (reason) {
    case "appMcpOff":
      return "앱 MCP 꺼짐";
    case "stdioNotAllowed":
      return "이 러너는 stdio 서버를 받지 않음";
    case "commandNotAllowed":
      return `명령 ${detail ?? "?"} 이 허용 목록에 없음`;
    case "privateAddress":
      return "로컬·사설 주소는 받지 않음";
    case "envKeyNotAllowed":
      return `env ${detail ?? "?"} 는 받지 않음`;
  }
}

/** ok 판정의 outsideCeiling 문구 — 「이 러너가 막음 — <문구>」. 서버는 붙고 그 이름의 자동 허용만 막힌다 */
export function appMcpCeilingText(outsideCeiling: readonly string[]): string {
  return `도구 상한 밖: ${outsideCeiling.join(", ")}(자동 허용만 막힘)`;
}

/** 명령 목록을 비켜 가는 쉬운 길(T18) — 이 env 키는 "all" 에서도 받지 않는다 */
const BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PATH",
]);
export function isBlockedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return BLOCKED_ENV_KEYS.has(upper) || upper.startsWith("DYLD_");
}

/** 경로 구분자(`/`·`\`) 뒤의 마지막 이름 — `/usr/local/bin/npx`·`./npx` → `npx`, `npx.sh` 는 그대로 */
export function commandBasename(command: string): string {
  const parts = command.split(/[/\\]/);
  return parts[parts.length - 1] ?? command;
}

function ipv4Private(octets: readonly number[]): boolean {
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** URL 의 호스트 글자 — 앞 `scheme://`·사용자 정보·포트·경로를 뗀다(shared 는 URL 전역을 쓰지 않는다 — DOM·Node 어느 쪽 lib 도 없다) */
function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  if (!m) return null;
  const authority = m[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    return close < 0 ? null : hostPort.slice(0, close + 1);
  }
  return hostPort.replace(/:\d*$/, "");
}

/** WHATWG 의 IPv4 꼴(점 1~4개 조각, 조각마다 10진·0x 16진·0 시작 8진 — `2130706433`·`0x7f.1`) — 아니면 null */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return null;
    nums.push(n);
  }
  const last = nums.pop() ?? 0;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  const value = nums.reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) + last;
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** IPv6 글자를 16비트 여덟 칸으로(`::` 펼침·끝의 점 IPv4) — 꼴이 틀리면 null */
function parseIpv6(text: string): number[] | null {
  let body = text;
  let tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(body);
  if (dotted) {
    const v4 = dotted[2]?.split(".").map(Number) ?? [];
    if (v4.some((o) => o > 255)) return null;
    tail = [((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)];
    body = (dotted[1] ?? "").endsWith("::") ? (dotted[1] ?? "") : (dotted[1] ?? "").slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const group = (s: string | undefined) => (s === undefined || s === "" ? [] : s.split(":"));
  const head = group(halves[0]);
  const rest = group(halves[1]);
  if ([...head, ...rest].some((h) => !/^[0-9a-f]{1,4}$/i.test(h))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = Array.from({ length: 8 - known }, () => 0);
  return [...head.map((h) => parseInt(h, 16)), ...zeros, ...rest.map((h) => parseInt(h, 16)), ...tail];
}

/**
 * 주소 글자로 루프백·사설·링크 로컬인가(T17) — `localhost`·`*.localhost`·`127/8`·`10/8`·`172.16/12`·`192.168/16`·`169.254/16`·
 * `0/8`·`::`·`::1`·IPv4 대응 주소·`fc00::/7`·`fe80::/10`. `2130706433` 같은 IPv4 꼴도 점 넷으로 바꿔 본다. 이름 풀이 뒤 주소(DNS
 * 리바인딩)는 보지 못한다. 호스트를 못 읽으면 막는다
 */
export function isPrivateAddress(url: string): boolean {
  const raw = hostOf(url);
  if (raw === null || raw === "" || raw.includes("%")) return true;
  const host = raw.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[")) {
    const h = parseIpv6(host.slice(1, -1));
    if (h === null) return true;
    if (h.slice(0, 7).every((x) => x === 0) && (h[7] ?? 0) <= 1) return true;
    // IPv4 대응(`::ffff:a.b.c.d`)·IPv4 호환(`::a.b.c.d` — 옛 꼴, OS 에 따라 그 IPv4 로 간다)
    if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
      const hi = h[6] ?? 0;
      const lo = h[7] ?? 0;
      return ipv4Private([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
    }
    const first = h[0] ?? 0;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  const v4 = parseIpv4(host);
  return v4 !== null && ipv4Private(v4);
}

/** 자동 허용을 러너 allowedTools 이름으로(T15) — 전부면 `mcp__<서버>`, 목록이면 `mcp__<서버>__<도구>` */
export function autoAllowToolNames(name: string, autoAllow: McpAutoAllow | undefined): string[] {
  if (autoAllow === undefined || autoAllow.mode === "none") return [];
  if (autoAllow.mode === "all") return [`mcp__${name}`];
  return autoAllow.tools.map((tool) => `mcp__${name}__${tool}`);
}

/**
 * 러너가 그 서버를 받는가(T2·T3·T15·T17·T18) — 받으면 allowedTools 에 더할 자동 허용 이름. 서버(봇 상세 표시)와 러너(런)가 같은
 * 함수를 쓴다. 차례: 꺼짐 → 종류 → (stdio) 명령·env → (원격) 주소 → 도구 상한
 */
export function appMcpVerdict(
  ceiling: AppMcpCeiling,
  name: string,
  server: McpServerConfig,
  autoAllow: McpAutoAllow | undefined,
): AppMcpVerdict {
  if (ceiling.appMcp === "off") return { ok: false, reason: "appMcpOff" };
  if (isStdioServer(server)) {
    if (ceiling.appMcp !== "all") return { ok: false, reason: "stdioNotAllowed" };
    const base = commandBasename(server.command);
    if (ceiling.appMcpCommands !== null && !ceiling.appMcpCommands.includes(base))
      return { ok: false, reason: "commandNotAllowed", detail: base };
    const blocked = Object.keys(server.env ?? {}).find(isBlockedEnvKey);
    if (blocked !== undefined) return { ok: false, reason: "envKeyNotAllowed", detail: blocked };
  } else if (ceiling.appMcp === "http" && isPrivateAddress(server.url)) {
    return { ok: false, reason: "privateAddress" };
  }
  const names = autoAllowToolNames(name, autoAllow);
  const limit = ceiling.allowedToolsCeiling;
  if (limit === null) return { ok: true, allowedTools: names, outsideCeiling: [] };
  return {
    ok: true,
    allowedTools: names.filter((tool) => limit.includes(tool)),
    outsideCeiling: names.filter((tool) => !limit.includes(tool)),
  };
}

/** REST 읽기의 비밀값 자리(T4) — U+2022 넷. 쓰기에서 값이 정확히 이것이면 저장된 원래 값을 지킨다 */
export const MCP_SECRET_MASK = "••••";

const maskMap = (map: Record<string, string> | undefined) =>
  map === undefined ? undefined : Object.fromEntries(Object.keys(map).map((key) => [key, MCP_SECRET_MASK]));

/** headers·env 의 값을 모두 MCP_SECRET_MASK 로 — 키 이름은 남긴다 */
export function maskMcpSecrets(servers: McpServers): McpServers {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (isStdioServer(server)) {
        const env = maskMap(server.env);
        return [name, { ...server, ...(env === undefined ? {} : { env }) }];
      }
      const headers = maskMap(server.headers);
      return [name, { ...server, ...(headers === undefined ? {} : { headers }) }];
    }),
  );
}

/** 가림 자리를 못 채움 — missing: 저장된 값이 없다, moved: 같은 이름의 저장 서버가 있지만 주소·명령이 바뀌었다 */
export type McpSecretMerge =
  | { ok: true; servers: McpServers }
  | { ok: false; server: string; key: string; reason: "missing" | "moved" };

/** 비밀값이 따라가도 되는 같은 곳인가 — 원격은 같은 url, stdio 는 같은 command·args */
function sameTarget(a: McpServerConfig, b: McpServerConfig): boolean {
  if (isStdioServer(a) || isStdioServer(b))
    return (
      isStdioServer(a) &&
      isStdioServer(b) &&
      a.command === b.command &&
      stableJson(a.args ?? []) === stableJson(b.args ?? [])
    );
  return a.url === b.url;
}

/**
 * 편집 저장(T4) — 값이 MCP_SECRET_MASK 인 자리는 저장된 값으로 채운다. 같은 곳(sameTarget — 같은 url, 같은 command·args)의 저장 서버에서만
 * 같은 키를 찾는다 — 같은 이름이 먼저, 없으면(서버 이름만 바꾼 편집) 다른 이름. 주소·명령을 바꾸면 이름이 같아도 채우지 않는다(가림 자리를
 * 두고 주소를 제 서버로 바꿔 남이 넣은 비밀값을 빼내지 못하게). 못 찾으면 { ok: false } — 가림 글자를 값으로 저장하지 않는다
 */
export function mergeMcpSecrets(incoming: McpServers, stored: McpServers | undefined): McpSecretMerge {
  const storedEntries = Object.entries(stored ?? {});
  const sourceFor = (name: string, server: McpServerConfig): McpServerConfig | undefined => {
    const same = stored?.[name];
    if (same !== undefined && sameTarget(same, server)) return same;
    return storedEntries.find(([, s]) => sameTarget(s, server))?.[1];
  };
  const out: McpServers = {};
  for (const [name, server] of Object.entries(incoming)) {
    const source = sourceFor(name, server);
    const field = isStdioServer(server) ? "env" : "headers";
    const map = isStdioServer(server) ? server.env : server.headers;
    const from = source === undefined ? undefined : isStdioServer(source) ? source.env : source.headers;
    if (map === undefined) {
      out[name] = server;
      continue;
    }
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
      if (value !== MCP_SECRET_MASK) {
        merged[key] = value;
        continue;
      }
      const kept = from?.[key];
      if (kept === undefined)
        return {
          ok: false,
          server: name,
          key,
          reason: source === undefined && stored?.[name] !== undefined ? "moved" : "missing",
        };
      merged[key] = kept;
    }
    out[name] = { ...server, [field]: merged } as McpServerConfig;
  }
  return { ok: true, servers: out };
}

/** 비밀값 없이 견줄 수 있게 — 키 순서가 달라도 같은 값이면 같은 글. 리비전(T11) 판정에 쓴다 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
