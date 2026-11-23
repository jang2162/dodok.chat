import { describe, expect, it } from "vitest";
import {
  type AppMcpCeiling,
  appMcpBlockText,
  appMcpCeilingOf,
  appMcpVerdict,
  isPrivateAddress,
  MCP_SECRET_MASK,
  maskMcpSecrets,
  type McpServerConfig,
  McpServers,
  McpServersPaste,
  mergeMcpSecrets,
  RunnerBotDefinition,
  stableJson,
} from "../src";

const GH: McpServerConfig = {
  type: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { Authorization: "Bearer ghp_SECRET" },
};
const STDIO: McpServerConfig = {
  command: "npx",
  args: ["-y", "@linear/mcp"],
  env: { LINEAR_TOKEN: "lin_SECRET" },
};

const HTTP: AppMcpCeiling = { appMcp: "http", appMcpCommands: null, allowedToolsCeiling: null };
const ALL: AppMcpCeiling = { appMcp: "all", appMcpCommands: null, allowedToolsCeiling: null };
const OFF: AppMcpCeiling = { appMcp: "off", appMcpCommands: null, allowedToolsCeiling: null };

describe("McpServers — .mcp.json 의 mcpServers 꼴(T1)", () => {
  it(".mcp.json 통째와 값만 둘 다 받는다", () => {
    const value = { gh: GH, linear: STDIO };
    expect(McpServersPaste.parse({ mcpServers: value })).toEqual(value);
    expect(McpServersPaste.parse(value)).toEqual(value);
    expect(McpServers.parse({ s: { type: "stdio", command: "uvx" } })).toEqual({
      s: { type: "stdio", command: "uvx" },
    });
  });

  it("dodok·__ 든 이름·이름 꼴 밖·17개·ftp: ·모르는 키는 거절", () => {
    expect(McpServers.safeParse({ dodok: GH }).success).toBe(false);
    expect(McpServers.safeParse({ Dodok: GH }).success).toBe(false);
    expect(McpServers.safeParse({ dodok__post: GH }).success).toBe(false);
    expect(McpServers.safeParse({ "a b": GH }).success).toBe(false);
    expect(McpServers.safeParse({ ["x".repeat(65)]: GH }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, GH]));
    expect(McpServers.safeParse(many).success).toBe(false);
    expect(McpServers.safeParse(Object.fromEntries(Object.entries(many).slice(0, 16))).success).toBe(true);
    expect(McpServers.safeParse({ gh: { type: "http", url: "ftp://x.example/" } }).success).toBe(false);
    expect(McpServers.safeParse({ gh: { ...GH, cwd: "/" } }).success).toBe(false);
    expect(McpServers.safeParse({ gh: { type: "http", command: "npx" } }).success).toBe(false);
  });

  it("봇 정의 — MCP·자동 허용·내장 도구는 선택(옛 네 칸 정의도 받는다)", () => {
    const four = { purpose: "p", watches: "", does: "", reports: "" };
    expect(RunnerBotDefinition.parse(four)).toEqual(four);
    expect(
      RunnerBotDefinition.parse({
        ...four,
        mcpServers: { gh: GH },
        mcpAutoAllow: { gh: { mode: "all" } },
        builtinTools: ["runnerControl"],
      }).builtinTools,
    ).toEqual(["runnerControl"]);
    expect(RunnerBotDefinition.safeParse({ ...four, builtinTools: ["shell"] }).success).toBe(false);
    expect(
      RunnerBotDefinition.safeParse({ ...four, mcpAutoAllow: { gh: { mode: "tools", tools: [] } } }).success,
    ).toBe(false);
  });
});

describe("appMcpVerdict — 서버 표시와 러너 런이 같은 판정(T2·T3·T15·T17·T18)", () => {
  it.each([
    ["off + http", OFF, GH, "appMcpOff"],
    ["off + stdio", OFF, STDIO, "appMcpOff"],
    ["http + stdio", HTTP, STDIO, "stdioNotAllowed"],
    ["http + 127.0.0.1", HTTP, { type: "http", url: "http://127.0.0.1:3000/mcp" }, "privateAddress"],
    ["http + [::1]", HTTP, { type: "http", url: "http://[::1]/mcp" }, "privateAddress"],
    ["http + foo.localhost", HTTP, { type: "sse", url: "http://foo.localhost/sse" }, "privateAddress"],
    ["http + 192.168.1.2", HTTP, { type: "http", url: "http://192.168.1.2/" }, "privateAddress"],
  ] as Array<[string, AppMcpCeiling, McpServerConfig, string]>)("%s → %s", (_, ceiling, server, reason) => {
    expect(appMcpVerdict(ceiling, "s", server, undefined)).toMatchObject({ ok: false, reason });
  });

  it("all 은 사설 주소도 받는다, http 는 공개 주소를 받는다", () => {
    expect(appMcpVerdict(ALL, "s", { type: "http", url: "http://127.0.0.1/" }, undefined)).toEqual({
      ok: true,
      allowedTools: [],
    });
    expect(appMcpVerdict(HTTP, "gh", GH, undefined)).toEqual({ ok: true, allowedTools: [] });
  });

  it("명령 허용 목록은 basename 으로 — /usr/local/bin/npx·./npx·/tmp/npx 는 npx, npx.sh 는 아니다", () => {
    const ceiling: AppMcpCeiling = { ...ALL, appMcpCommands: ["npx"] };
    for (const command of ["npx", "/usr/local/bin/npx", "./npx", "/tmp/npx"])
      expect(appMcpVerdict(ceiling, "s", { command }, undefined).ok, command).toBe(true);
    expect(appMcpVerdict(ceiling, "s", { command: "npx.sh" }, undefined)).toEqual({
      ok: false,
      reason: "commandNotAllowed",
      detail: "npx.sh",
    });
    expect(appMcpVerdict(ceiling, "s", { command: "uvx" }, undefined)).toMatchObject({
      reason: "commandNotAllowed",
    });
  });

  it.each(["DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "path"])(
    "all 이어도 env %s 는 거절",
    (key) => {
      expect(appMcpVerdict(ALL, "s", { command: "npx", env: { [key]: "x" } }, undefined)).toEqual({
        ok: false,
        reason: "envKeyNotAllowed",
        detail: key,
      });
    },
  );

  it("자동 허용 — 전부는 mcp__<서버>, 목록은 mcp__<서버>__<도구>, 없음은 빈 목록", () => {
    expect(appMcpVerdict(HTTP, "gh", GH, { mode: "all" })).toEqual({ ok: true, allowedTools: ["mcp__gh"] });
    expect(appMcpVerdict(HTTP, "gh", GH, { mode: "tools", tools: ["a"] })).toEqual({
      ok: true,
      allowedTools: ["mcp__gh__a"],
    });
    expect(appMcpVerdict(HTTP, "gh", GH, { mode: "none" })).toEqual({ ok: true, allowedTools: [] });
  });

  it("러너 도구 상한 밖의 자동 허용은 toolCeiling", () => {
    const ceiling: AppMcpCeiling = { ...HTTP, allowedToolsCeiling: ["mcp__gh__a"] };
    expect(appMcpVerdict(ceiling, "gh", GH, { mode: "all" })).toEqual({
      ok: false,
      reason: "toolCeiling",
      detail: "mcp__gh",
    });
    expect(appMcpVerdict(ceiling, "gh", GH, { mode: "tools", tools: ["a"] }).ok).toBe(true);
    expect(appMcpVerdict(ceiling, "gh", GH, undefined).ok).toBe(true);
  });

  it("사유 문구", () => {
    expect(appMcpBlockText("appMcpOff")).toBe("앱 MCP 꺼짐");
    expect(appMcpBlockText("stdioNotAllowed")).toBe("이 러너는 stdio 서버를 받지 않음");
    expect(appMcpBlockText("commandNotAllowed", "npx")).toBe("명령 npx 이 허용 목록에 없음");
    expect(appMcpBlockText("privateAddress")).toBe("로컬·사설 주소는 받지 않음");
    expect(appMcpBlockText("envKeyNotAllowed", "PATH")).toBe("env PATH 는 받지 않음");
    expect(appMcpBlockText("toolCeiling")).toBe("도구 상한 밖");
  });

  it("옛 러너의 천장(appMcp 없음)은 off 로 읽는다", () => {
    expect(appMcpCeilingOf({ ceiling: { maxPermissionMode: "default", allowedToolsCeiling: null } })).toEqual(
      OFF,
    );
    expect(appMcpCeilingOf(undefined)).toEqual(OFF);
    expect(
      appMcpCeilingOf({
        ceiling: {
          maxPermissionMode: "default",
          allowedToolsCeiling: ["x"],
          appMcp: "all",
          appMcpCommands: ["npx"],
        },
      }),
    ).toEqual({ appMcp: "all", appMcpCommands: ["npx"], allowedToolsCeiling: ["x"] });
  });
});

describe("isPrivateAddress — 주소 글자(T17)", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST./",
    "http://a.b.localhost:8080/",
    "http://127.0.0.1/",
    "http://127.255.0.9/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0177.0.0.1/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/",
    "http://user:pw@127.0.0.1:80/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
  ])("%s 는 막는다", (url) => {
    expect(isPrivateAddress(url)).toBe(true);
  });

  it.each([
    "https://api.githubcopilot.com/mcp/",
    "https://mcp.linear.app/sse",
    "http://172.32.0.1/",
    "http://8.8.8.8/",
    "http://[2001:db8::1]/",
    "https://localhost.example.com/",
  ])("%s 는 받는다", (url) => {
    expect(isPrivateAddress(url)).toBe(false);
  });
});

describe("비밀값 — 쓰기 전용(T4)", () => {
  const stored = McpServers.parse({ gh: GH, linear: STDIO });

  it("maskMcpSecrets 뒤에는 키 이름만, 원문은 없다", () => {
    const masked = maskMcpSecrets(stored);
    expect(masked).toEqual({
      gh: { ...GH, headers: { Authorization: MCP_SECRET_MASK } },
      linear: { ...STDIO, env: { LINEAR_TOKEN: MCP_SECRET_MASK } },
    });
    expect(JSON.stringify(masked)).not.toMatch(/SECRET/);
    expect(MCP_SECRET_MASK).toBe("••••");
  });

  it("mergeMcpSecrets — 가림 자리는 저장 값으로, 바꾼 값은 새 값으로", () => {
    const merged = mergeMcpSecrets(maskMcpSecrets(stored), stored);
    expect(merged).toEqual({ ok: true, servers: stored });
    const changed = mergeMcpSecrets(
      { ...maskMcpSecrets(stored), gh: { ...GH, headers: { Authorization: "Bearer NEW", "X-Extra": "1" } } },
      stored,
    );
    expect(changed.ok && changed.servers.gh).toEqual({
      ...GH,
      headers: { Authorization: "Bearer NEW", "X-Extra": "1" },
    });
  });

  it("서버 이름만 바꾼 편집도 같은 주소·명령의 저장 값을 지킨다", () => {
    const { gh, linear } = maskMcpSecrets(stored);
    const merged = mergeMcpSecrets({ github: gh!, lin: linear! }, stored);
    expect(merged).toEqual({ ok: true, servers: { github: GH, lin: STDIO } });
  });

  it("저장 값이 없는 가림 자리는 거절 — 가림 글자를 값으로 저장하지 않는다", () => {
    expect(mergeMcpSecrets({ gh: { ...GH, headers: { Other: MCP_SECRET_MASK } } }, stored)).toEqual({
      ok: false,
      server: "gh",
      key: "Other",
    });
    expect(mergeMcpSecrets(maskMcpSecrets(stored), undefined)).toMatchObject({ ok: false });
  });

  it("stableJson 은 키 순서와 상관없다", () => {
    expect(stableJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      stableJson({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
  });
});
