import { type GatewaySetupEntry, OPENCLAW_PINNED_VERSION } from "@dodok/openclaw-adapter";
import { type RunnerConnection, SetupStatus } from "@dodok/shared";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_BUNDLE_ENTRY,
  pluginDirCandidates,
  readPluginFile,
  tarEntry,
} from "../src/modules/setup/plugin-file";
import { bridgePublicUrl, buildSetupStatus } from "../src/modules/setup/status";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** ustar 헤더 한 블록 + 내용(512 배수로 채움). type "0" 파일, "x" pax 확장 헤더 */
function tarBlock(name: string, content: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148); // 체크섬 자리는 공백으로 두고 더한다
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (`${len}${body}`.length !== len) len += 1;
  return `${len}${body}`;
}

const tarOf = (blocks: Buffer[]) => Buffer.concat([...blocks, Buffer.alloc(1024)]);

const BUNDLE = Buffer.from("export default { id: 'dodok' };\n".repeat(40)); // 512 을 넘겨 두 블록 이상

function pluginTgz(bundle = BUNDLE): Buffer {
  return gzipSync(
    tarOf([
      tarBlock("package/package.json", Buffer.from('{"name":"@dodok/openclaw-plugin"}')),
      tarBlock("package/openclaw.plugin.json", Buffer.from("{}")),
      tarBlock(PLUGIN_BUNDLE_ENTRY, bundle),
    ]),
  );
}

describe("tarEntry", () => {
  it("이름으로 파일 내용을 찾는다 — 앞 항목의 크기만큼 건너뛴다", () => {
    const tar = tarOf([tarBlock("package/a.txt", Buffer.alloc(700, 1)), tarBlock("package/b.txt", BUNDLE)]);
    expect(tarEntry(tar, "package/b.txt")).toEqual(BUNDLE);
    expect(tarEntry(tar, "package/c.txt")).toBeUndefined();
  });

  it("pax 확장 헤더의 path 가 다음 항목 이름을 덮는다", () => {
    const tar = tarOf([
      tarBlock("PaxHeader/x", Buffer.from(paxRecord("path", "package/long.js")), "x"),
      tarBlock("package/short", BUNDLE),
    ]);
    expect(tarEntry(tar, "package/long.js")).toEqual(BUNDLE);
    expect(tarEntry(tar, "package/short")).toBeUndefined();
  });

  it("pax path 는 바로 다음 항목에만 — 그 뒤 항목은 제 이름으로 돌아간다", () => {
    const tar = tarOf([
      tarBlock("PaxHeader/x", Buffer.from(paxRecord("path", "package/README.md")), "x"),
      tarBlock("package/README", Buffer.from("readme")),
      tarBlock(PLUGIN_BUNDLE_ENTRY, BUNDLE),
    ]);
    expect(tarEntry(tar, PLUGIN_BUNDLE_ENTRY)).toEqual(BUNDLE);
    expect(tarEntry(tar, "package/README.md")).toEqual(Buffer.from("readme"));
  });

  it("ustar prefix 와 이름을 이어 붙인다", () => {
    const block = tarBlock("index.js", BUNDLE);
    block.write("package/dist", 345, 155, "utf8");
    expect(tarEntry(tarOf([block]), "package/dist/index.js")).toEqual(BUNDLE);
  });

  it("잘린 tar 는 undefined(던지지 않는다)", () => {
    const tar = tarOf([tarBlock("package/b.txt", BUNDLE)]);
    expect(tarEntry(tar.subarray(0, 600), "package/b.txt")).toBeUndefined();
    expect(tarEntry(Buffer.alloc(0), "package/b.txt")).toBeUndefined();
  });
});

describe("readPluginFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-plugin-file-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("후보 디렉터리의 tgz — 파일 sha256·크기와 안의 dist/index.js sha256(tgz 전체가 아니다) [Review Focus 5]", () => {
    const tgz = pluginTgz();
    writeFileSync(join(dir, "dodok-openclaw-plugin-0.0.0.tgz"), tgz);
    const file = readPluginFile([join(dir, "missing"), dir]);
    expect(file).toEqual({
      path: join(dir, "dodok-openclaw-plugin-0.0.0.tgz"),
      sha256: sha(tgz),
      bundleSha256: sha(BUNDLE),
      bytes: tgz.length,
    });
    expect(file?.bundleSha256).not.toBe(file?.sha256);
  });

  it("앞 후보가 이긴다, 한 디렉터리에 여럿이면 가장 최근 것", () => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(second, "p.tgz"), pluginTgz(Buffer.from("second")));
    writeFileSync(join(first, "old.tgz"), pluginTgz(Buffer.from("old")));
    writeFileSync(join(first, "new.tgz"), pluginTgz(Buffer.from("new")));
    utimesSync(join(first, "old.tgz"), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(first, "new.tgz"), new Date(2_000_000), new Date(2_000_000));
    expect(readPluginFile([first, second])?.bundleSha256).toBe(sha("new"));
    expect(readPluginFile([second, first])?.bundleSha256).toBe(sha("second"));
  });

  it("가장 최근은 이름순이 아니라 mtime 으로, 더 최근이어도 tgz 가 아닌 파일은 보지 않는다", () => {
    const at = (s: number) => new Date(s * 1000);
    writeFileSync(join(dir, "a-new.tgz"), pluginTgz(Buffer.from("a-new")));
    writeFileSync(join(dir, "z-old.tgz"), pluginTgz(Buffer.from("z-old")));
    utimesSync(join(dir, "a-new.tgz"), at(2_000), at(2_000));
    utimesSync(join(dir, "z-old.tgz"), at(1_000), at(1_000));
    expect(readPluginFile([dir])?.bundleSha256).toBe(sha("a-new"));
    utimesSync(join(dir, "z-old.tgz"), at(3_000), at(3_000));
    expect(readPluginFile([dir])?.bundleSha256).toBe(sha("z-old"));
    // 더 최근인 tgz 모양의 비-tgz 파일(다른 확장자)은 후보가 아니다
    writeFileSync(join(dir, "zz-latest.tgz.bak"), pluginTgz(Buffer.from("bak")));
    writeFileSync(join(dir, "index.js"), "x");
    utimesSync(join(dir, "zz-latest.tgz.bak"), at(4_000), at(4_000));
    utimesSync(join(dir, "index.js"), at(4_000), at(4_000));
    expect(readPluginFile([dir])?.bundleSha256).toBe(sha("z-old"));
  });

  it("tgz 가 없거나, gzip 이 아니거나, 안에 번들이 없으면 null", () => {
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(readPluginFile([dir])).toBeNull();
    writeFileSync(join(dir, "broken.tgz"), "not gzip");
    expect(readPluginFile([dir])).toBeNull();
    rmSync(join(dir, "broken.tgz"));
    writeFileSync(
      join(dir, "empty.tgz"),
      gzipSync(tarOf([tarBlock("package/package.json", Buffer.from("{}"))])),
    );
    expect(readPluginFile([dir])).toBeNull();
    expect(readPluginFile([])).toBeNull();
  });
});

describe("pluginDirCandidates", () => {
  const sourceDist = fileURLToPath(new URL("../../../packages/openclaw-plugin/dist", import.meta.url));

  it("DODOK_PLUGIN_DIR 먼저, 소스 실행이면 저장소의 packages/openclaw-plugin/dist", () => {
    expect(pluginDirCandidates({ DODOK_PLUGIN_DIR: "/app/plugin" }, false)).toEqual([
      "/app/plugin",
      sourceDist,
    ]);
    expect(pluginDirCandidates({}, false)).toEqual([sourceDist]);
  });

  it("번들에서는 DODOK_PLUGIN_DIR 만", () => {
    expect(pluginDirCandidates({ DODOK_PLUGIN_DIR: "/app/plugin" }, true)).toEqual(["/app/plugin"]);
    expect(pluginDirCandidates({}, true)).toEqual([]);
  });
});

describe("bridgePublicUrl", () => {
  it("BRIDGE_PUBLIC_URL 이 있으면 그대로", () => {
    expect(
      bridgePublicUrl({ BRIDGE_PUBLIC_URL: "wss://b.example/bridge", APP_ORIGIN: "https://a.example" }),
    ).toBe("wss://b.example/bridge");
  });

  it("없으면 APP_ORIGIN 의 https:→wss:·http:→ws: + /bridge (경로는 버린다)", () => {
    expect(bridgePublicUrl({ APP_ORIGIN: "https://chat.example.com" })).toBe("wss://chat.example.com/bridge");
    expect(bridgePublicUrl({ APP_ORIGIN: "http://localhost:5173" })).toBe("ws://localhost:5173/bridge");
    expect(bridgePublicUrl({ APP_ORIGIN: "https://chat.example.com:8443/" })).toBe(
      "wss://chat.example.com:8443/bridge",
    );
  });
});

describe("buildSetupStatus", () => {
  const BUNDLE_SHA = "b".repeat(64);
  const GW = "01999999-0000-7000-8000-0000000000a1";
  const plugin = {
    version: "0.0.0",
    sdkVersion: "2026.9.4",
    gatewayVersion: "2026.9.5",
    bundleSha256: BUNDLE_SHA,
    tokenId: "01999999-0000-7000-8000-000000000001",
    connectedAt: "2026-09-24T00:00:00.000Z",
  };
  const row = { id: GW, name: "사무실", url: "wss://gw.example:443", enabled: true };
  const entry = (
    p: GatewaySetupEntry["bridge"]["plugin"],
    version: string | null = "2026.9.5",
  ): GatewaySetupEntry => ({
    ...row,
    gateway: { state: "connected", host: "gw.example:443", version, pairing: null },
    bridge: { state: p ? "connected" : "down", plugin: p },
  });
  const file = { path: "/app/plugin/p.tgz", sha256: "c".repeat(64), bundleSha256: BUNDLE_SHA, bytes: 1234 };
  const base = {
    runners: [],
    runnerFile: null,
    serverVersion: "1.2.3",
    publicUrl: "wss://chat.example.com/bridge",
  };
  const build = (p: GatewaySetupEntry["bridge"]["plugin"], f: typeof file | null) =>
    buildSetupStatus({ ...base, gateways: [row], details: [entry(p)], pluginFile: f });
  const first = (status: SetupStatus) => {
    const gateway = status.gateways[0];
    if (!gateway) throw new Error("no gateway");
    return gateway;
  };

  it("계약 모양 — 파일 경로는 싣지 않는다", () => {
    const status = build(plugin, file);
    expect(SetupStatus.parse(status)).toEqual(status);
    expect(status).toEqual({
      server: { version: "1.2.3" },
      bridge: { publicUrl: "wss://chat.example.com/bridge" },
      pluginFile: { available: true, sha256: file.sha256, bundleSha256: BUNDLE_SHA, bytes: 1234 },
      gateways: [
        {
          ...row,
          gateway: {
            state: "connected",
            host: "gw.example:443",
            version: "2026.9.5",
            pinned: OPENCLAW_PINNED_VERSION,
            drift: true,
            pairing: null,
          },
          bridge: { state: "connected", plugin },
          pluginMatches: true,
        },
      ],
      runners: { list: [], runnerFile: { available: false } },
    });
    expect(JSON.stringify(status)).not.toContain("/app/plugin");
  });

  it("Gateway 가 없으면 빈 목록 — 머리 값(publicUrl·pluginFile)은 그대로 [Review Focus 5]", () => {
    const status = buildSetupStatus({ ...base, gateways: [], details: [], pluginFile: file });
    expect(SetupStatus.parse(status)).toEqual(status);
    expect(status.gateways).toEqual([]);
    expect(status.bridge.publicUrl).toBe("wss://chat.example.com/bridge");
    expect(status.pluginFile.available).toBe(true);
  });

  it("목록은 DB 행의 차례·이름·주소·켜짐을 따르고 상세는 id 로 짝짓는다 — 어댑터가 모르는 행은 down(꺼졌으면 disabled)", () => {
    const off = {
      id: "01999999-0000-7000-8000-0000000000a2",
      name: "집",
      url: "ws://home:18789",
      enabled: false,
    };
    const unknown = {
      id: "01999999-0000-7000-8000-0000000000a3",
      name: "새로",
      url: "ws://new:1",
      enabled: true,
    };
    const status = buildSetupStatus({
      ...base,
      gateways: [off, row, unknown],
      // 어댑터 차례는 다르다 — 꺼진 Gateway 의 상세가 아직 붙은 것처럼 남아 있어도 행의 켜짐이 이긴다
      details: [entry(plugin), { ...entry(plugin), ...off }],
      pluginFile: null,
    });
    expect(SetupStatus.parse(status)).toEqual(status);
    expect(status.gateways.map((g) => [g.name, g.gateway.state, g.bridge.state, g.gateway.host])).toEqual([
      ["집", "disabled", "down", "gw.example:443"],
      ["사무실", "connected", "connected", "gw.example:443"],
      ["새로", "down", "down", "new:1"],
    ]);
    expect(status.gateways[0]?.bridge.plugin).toBeNull();
  });

  it("러너 블록 — 붙은 러너 목록을 그대로, 러너 파일은 경로 없이", () => {
    const runner: RunnerConnection = {
      tokenId: "01999999-0000-7000-8000-000000000002",
      label: "macbook",
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.283",
      claudeCodeVersion: "2.1.283",
      bundleSha256: null,
      capabilities: ["threads"],
      connectedAt: "2026-09-27T00:00:00.000Z",
      agents: [
        {
          id: "coder",
          name: "Coder",
          model: "sonnet",
          workdirLabel: "repo",
          conflict: false,
          boundTokenId: null,
        },
      ],
    };
    const runnerFile = {
      path: "/app/runner/r.tgz",
      sha256: "e".repeat(64),
      bundleSha256: "f".repeat(64),
      bytes: 99,
    };
    const status = buildSetupStatus({
      ...base,
      gateways: [],
      details: [],
      pluginFile: null,
      runners: [runner],
      runnerFile,
    });
    expect(SetupStatus.parse(status)).toEqual(status);
    expect(status.runners).toEqual({
      list: [runner],
      runnerFile: {
        available: true,
        sha256: runnerFile.sha256,
        bundleSha256: runnerFile.bundleSha256,
        bytes: 99,
      },
    });
    expect(JSON.stringify(status)).not.toContain("/app/runner");
  });

  it("pluginMatches: 같은 번들 → true, 다른 번들 → false, 파일·플러그인·bundleSha256 이 없으면 null [Review Focus 5]", () => {
    expect(first(build(plugin, file)).pluginMatches).toBe(true);
    expect(first(build({ ...plugin, bundleSha256: "d".repeat(64) }, file)).pluginMatches).toBe(false);
    // tgz 전체 sha 와 같아도 번들 sha 가 다르면 다른 빌드다
    expect(first(build({ ...plugin, bundleSha256: file.sha256 }, file)).pluginMatches).toBe(false);
    expect(first(build(plugin, null)).pluginMatches).toBeNull();
    expect(first(build(null, file)).pluginMatches).toBeNull();
    expect(first(build({ ...plugin, bundleSha256: null }, file)).pluginMatches).toBeNull();
    expect(build(plugin, null).pluginFile).toEqual({ available: false });
  });

  it("gateway.drift: 받은 버전이 핀과 다를 때만 — 같거나 모르면(null) false [운영 보강 5.2]", () => {
    const withVersion = (version: string | null) =>
      first(buildSetupStatus({ ...base, gateways: [row], details: [entry(null, version)], pluginFile: null }))
        .gateway;
    expect(withVersion("2026.9.5")).toMatchObject({ pinned: OPENCLAW_PINNED_VERSION, drift: true });
    expect(withVersion(OPENCLAW_PINNED_VERSION)).toMatchObject({ drift: false });
    expect(withVersion(null)).toMatchObject({ version: null, drift: false });
  });
});
