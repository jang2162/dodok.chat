import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerServerUrl } from "../src/modules/runners/routes";
import { readRunnerFile, RUNNER_BUNDLE_ENTRY, runnerDirCandidates } from "../src/modules/runners/runner-file";
import { PLUGIN_BUNDLE_ENTRY } from "../src/modules/setup/plugin-file";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** 이름·내용 쌍을 ustar 블록으로 이어 gzip 한 tgz(체크섬은 읽는 쪽이 보지 않는다) */
function tgzOf(entries: Array<[string, Buffer]>): Buffer {
  const blocks = entries.flatMap(([name, content]) => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
    content.copy(body);
    return [header, body];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("readRunnerFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-runner-file-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("러너 tgz — 파일 sha256·크기와 안의 package/dist/main.js sha256", () => {
    const bundle = Buffer.from("#!/usr/bin/env node\nconsole.log('runner');\n");
    const tgz = tgzOf([
      ["package/package.json", Buffer.from('{"name":"@dodok/runner"}')],
      [RUNNER_BUNDLE_ENTRY, bundle],
    ]);
    writeFileSync(join(dir, "dodok-claude-runner-0.0.0.tgz"), tgz);
    expect(readRunnerFile([join(dir, "missing"), dir])).toEqual({
      path: join(dir, "dodok-claude-runner-0.0.0.tgz"),
      sha256: sha(tgz),
      bundleSha256: sha(bundle),
      bytes: tgz.length,
    });
  });

  it("플러그인 tgz(dist/index.js 만)는 러너 파일이 아니다, 디렉터리가 없거나 비었으면 null", () => {
    writeFileSync(join(dir, "plugin.tgz"), tgzOf([[PLUGIN_BUNDLE_ENTRY, Buffer.from("x")]]));
    expect(readRunnerFile([dir])).toBeNull();
    expect(readRunnerFile([join(dir, "missing")])).toBeNull();
    expect(readRunnerFile([])).toBeNull();
  });
});

describe("runnerDirCandidates", () => {
  const sourceDist = fileURLToPath(new URL("../../../packages/claude-runner/dist", import.meta.url));

  it("DODOK_RUNNER_DIR 먼저, 소스 실행이면 저장소의 packages/claude-runner/dist", () => {
    expect(runnerDirCandidates({ DODOK_RUNNER_DIR: "/app/runner" }, false)).toEqual([
      "/app/runner",
      sourceDist,
    ]);
    expect(runnerDirCandidates({}, false)).toEqual([sourceDist]);
  });

  it("번들에서는 DODOK_RUNNER_DIR 만", () => {
    expect(runnerDirCandidates({ DODOK_RUNNER_DIR: "/app/runner" }, true)).toEqual(["/app/runner"]);
    expect(runnerDirCandidates({}, true)).toEqual([]);
  });
});

describe("runnerServerUrl", () => {
  it("브리지 공개 주소의 오리진을 http(s) 로 — 러너 설정의 serverUrl", () => {
    expect(runnerServerUrl("wss://chat.example.com/bridge")).toBe("https://chat.example.com");
    expect(runnerServerUrl("ws://localhost:3000/bridge")).toBe("http://localhost:3000");
    expect(runnerServerUrl("wss://b.example:8443/x/bridge")).toBe("https://b.example:8443");
  });
});
