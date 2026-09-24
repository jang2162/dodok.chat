import type { AdapterSetupDetail } from "@dodok/openclaw-adapter";
import { SetupStatus } from "@dodok/shared";
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
  const plugin = {
    version: "0.0.0",
    sdkVersion: "2026.9.4",
    gatewayVersion: "2026.9.5",
    bundleSha256: BUNDLE_SHA,
    tokenId: "01999999-0000-7000-8000-000000000001",
    connectedAt: "2026-09-24T00:00:00.000Z",
  };
  const detail = (p: AdapterSetupDetail["bridge"]["plugin"]): AdapterSetupDetail => ({
    gateway: { state: "connected", host: "gw.example:443", version: "2026.9.5", pairing: null },
    bridge: { state: p ? "connected" : "down", plugin: p },
  });
  const file = { path: "/app/plugin/p.tgz", sha256: "c".repeat(64), bundleSha256: BUNDLE_SHA, bytes: 1234 };
  const build = (p: AdapterSetupDetail["bridge"]["plugin"], f: typeof file | null, envTokenIgnored = false) =>
    buildSetupStatus({
      detail: detail(p),
      pluginFile: f,
      serverVersion: "1.2.3",
      publicUrl: "wss://chat.example.com/bridge",
      envTokenIgnored,
    });

  it("계약 모양 — 파일 경로는 싣지 않는다", () => {
    const status = build(plugin, file);
    expect(SetupStatus.parse(status)).toEqual(status);
    expect(status).toEqual({
      server: { version: "1.2.3" },
      gateway: { state: "connected", host: "gw.example:443", version: "2026.9.5", pairing: null },
      bridge: { state: "connected", publicUrl: "wss://chat.example.com/bridge", plugin },
      pluginFile: { available: true, sha256: file.sha256, bundleSha256: BUNDLE_SHA, bytes: 1234 },
      pluginMatches: true,
      envTokenIgnored: false,
    });
    expect(JSON.stringify(status)).not.toContain("/app/plugin");
  });

  it("pluginMatches: 같은 번들 → true, 다른 번들 → false, 파일·플러그인·bundleSha256 이 없으면 null [Review Focus 5]", () => {
    expect(build(plugin, file).pluginMatches).toBe(true);
    expect(build({ ...plugin, bundleSha256: "d".repeat(64) }, file).pluginMatches).toBe(false);
    // tgz 전체 sha 와 같아도 번들 sha 가 다르면 다른 빌드다
    expect(build({ ...plugin, bundleSha256: file.sha256 }, file).pluginMatches).toBe(false);
    expect(build(plugin, null).pluginMatches).toBeNull();
    expect(build(null, file).pluginMatches).toBeNull();
    expect(build({ ...plugin, bundleSha256: null }, file).pluginMatches).toBeNull();
    expect(build(plugin, null).pluginFile).toEqual({ available: false });
  });

  it("envTokenIgnored 를 그대로 싣는다", () => {
    expect(build(null, null, true).envTokenIgnored).toBe(true);
    expect(SetupStatus.parse(build(null, null, true)).bridge).toEqual({
      state: "down",
      publicUrl: "wss://chat.example.com/bridge",
      plugin: null,
    });
  });
});
