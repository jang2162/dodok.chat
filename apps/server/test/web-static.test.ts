import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { SECURITY_HEADERS } from "../src/http/web-static";
import { bootTestApp } from "./helpers/app";

// 옛 infra/Caddyfile 의 header Content-Security-Policy 값 그대로 — 서버가 Caddy 대신 낸다(앱 컨테이너 하나 스펙 3.2)
const CADDY_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const INDEX = "<!doctype html><title>dodok</title><p>index</p>";
const APP_JS = `console.log(${JSON.stringify("x".repeat(4000))});`;
const SECRET = "TOP-SECRET-OUTSIDE-WEB-DIR";

let root: string;
let webDir: string;
beforeAll(() => {
  // root/secret.txt 는 웹 디렉터리(root/web) 밖 — 경로 탈출이 이 내용을 내면 안 된다
  root = mkdtempSync(join(tmpdir(), "dodok-web-static-"));
  webDir = join(root, "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), SECRET);
  writeFileSync(join(root, "package.json"), SECRET);
  writeFileSync(join(webDir, "index.html"), INDEX);
  writeFileSync(join(webDir, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(webDir, "manifest.webmanifest"), "{}");
  writeFileSync(join(webDir, "assets", "app-abc.js"), APP_JS);
  writeFileSync(join(webDir, "assets", "app-abc.js.br"), brotliCompressSync(APP_JS));
  // 웹 디렉터리 안의 심볼릭 링크가 밖을 가리켜도 내지 않는다
  symlinkSync(join(root, "secret.txt"), join(webDir, "link.txt"));
  symlinkSync(root, join(webDir, "assets", "up"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app!.fastify.inject({ method: "GET", url, headers });

describe("서버가 웹을 낸다(DODOK_WEB_DIR)", () => {
  it("GET / — index.html, no-cache, 보안 헤더 셋(Caddyfile 과 같은 CSP), http 오리진이면 HSTS 없음", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir });
    const res = await get("/");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toBe(INDEX);
    expect(res.headers["content-security-policy"]).toBe(CADDY_CSP);
    expect(SECURITY_HEADERS["content-security-policy"]).toBe(CADDY_CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers).not.toHaveProperty("strict-transport-security");
  });

  it("APP_ORIGIN 이 https 면 HSTS max-age=31536000", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir, APP_ORIGIN: "https://x.example" });
    const res = await get("/");
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
  });

  it("SPA 깊은 경로는 index.html, 있는 파일은 그 파일 — 둘 다 no-cache(sw.js·매니페스트 포함)", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir });
    const deep = await get("/c/abc");
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toBe(INDEX);
    expect(deep.headers["cache-control"]).toBe("no-cache");
    const sw = await get("/sw.js");
    expect(sw.statusCode).toBe(200);
    expect(sw.body).toContain("install");
    expect(sw.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(sw.headers["cache-control"]).toBe("no-cache");
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers["content-type"]).toMatch(/^application\/manifest\+json/);
    expect(manifest.headers["cache-control"]).toBe("no-cache");
  });

  it("/assets/* — 있는 파일은 immutable, br 를 받으면 미리 압축한 것·Vary, 없는 청크는 404(index.html·immutable 아님)", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir });
    const plain = await get("/assets/app-abc.js");
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(plain.headers).not.toHaveProperty("content-encoding");
    expect(plain.headers.vary).toMatch(/Accept-Encoding/i);
    expect(plain.body).toBe(APP_JS);

    const br = await get("/assets/app-abc.js", { "accept-encoding": "gzip, deflate, br" });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(br.headers.vary).toMatch(/Accept-Encoding/i);
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(APP_JS);

    const missing = await get("/assets/none.js");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("<p>index</p>");
    expect(missing.headers["cache-control"] ?? "").not.toContain("immutable");
  });

  it("백엔드 경로는 SPA 폴백을 타지 않는다 — 없는 API 는 지금의 JSON 404(보안 헤더는 붙는다)", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir });
    const api = await get("/api/v1/nope");
    expect(api.statusCode).toBe(404);
    expect(api.headers["content-type"]).toMatch(/^application\/json/);
    expect(api.body).not.toContain("<p>index</p>");
    expect(api.headers["content-security-policy"]).toBe(CADDY_CSP);
    for (const url of ["/hooks/x", "/mcp", "/bridge/nope", "/runner/nope", "/socket.io/nope"]) {
      const res = await get(url);
      expect(res.body, url).not.toContain("<p>index</p>");
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    // 백엔드 라우트는 그대로
    expect((await get("/healthz")).json()).toEqual({ ok: true, db: "ok" });
  });

  it("경로 탈출 — 웹 디렉터리 밖 파일을 내지 않는다(404 또는 index.html)", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir });
    for (const url of [
      "/..%2f..%2fetc%2fpasswd",
      "/..%2fsecret.txt",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/assets/..%5c..%5cpackage.json",
      "/..%5csecret.txt",
      "/a%00b",
      "/secret.txt%00.js",
      "/%",
      "/link.txt",
      "/assets/up/secret.txt",
    ]) {
      const res = await get(url);
      expect([200, 400, 404], url).toContain(res.statusCode);
      if (res.statusCode === 200) expect(res.body, url).toBe(INDEX);
      expect(res.body, url).not.toContain(SECRET);
    }
  });

  it("POST 는 폴백하지 않는다(404 JSON), HEAD / 는 200·본문 없음·같은 캐시 헤더", async () => {
    app = await bootTestApp({ DODOK_WEB_DIR: webDir });
    const post = await app.fastify.inject({ method: "POST", url: "/c/x", payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.headers["content-type"]).toMatch(/^application\/json/);
    const head = await app.fastify.inject({ method: "HEAD", url: "/" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["cache-control"]).toBe("no-cache");
    expect(head.headers["content-type"]).toMatch(/^text\/html/);
    expect(head.headers["content-security-policy"]).toBe(CADDY_CSP);
  });

  it("DODOK_WEB_DIR 이 없으면 정적 서빙을 끈다 — GET / 는 지금처럼 404", async () => {
    app = await bootTestApp();
    const res = await get("/");
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("<p>index</p>");
  });

  it("DODOK_WEB_DIR 에 index.html 이 없으면 error 한 줄을 남기고 끈다", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dodok-web-empty-"));
    const lines: Array<{ level: number; msg?: string; webDir?: string }> = [];
    const logger = pino({ level: "info" }, { write: (l: string) => void lines.push(JSON.parse(l)) });
    try {
      app = await bootTestApp({ DODOK_WEB_DIR: empty }, { logger });
      expect((await get("/")).statusCode).toBe(404);
      const errors = lines.filter((l) => l.level === 50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ webDir: empty });
      expect(errors[0]?.msg).toMatch(/index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("precompress-web.mjs", () => {
  it("1 KiB 이상인 텍스트 파일 옆에 .br·.gz 를 쓰고, 풀면 원본과 같다 — 작은 파일·이미지는 건너뛴다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-precompress-"));
    try {
      mkdirSync(join(dir, "assets"));
      const big = `export const a = ${JSON.stringify("y".repeat(5000))};`;
      writeFileSync(join(dir, "assets", "big.js"), big);
      writeFileSync(join(dir, "index.html"), `<!doctype html>${"<p>z</p>".repeat(300)}`);
      writeFileSync(join(dir, "small.js"), "1;");
      writeFileSync(join(dir, "pic.png"), Buffer.alloc(5000, 1));
      const script = fileURLToPath(new URL("../scripts/precompress-web.mjs", import.meta.url));
      execFileSync(process.execPath, [script, dir]);
      expect(brotliDecompressSync(readFileSync(join(dir, "assets", "big.js.br"))).toString()).toBe(big);
      expect(gunzipSync(readFileSync(join(dir, "assets", "big.js.gz"))).toString()).toBe(big);
      expect(() => readFileSync(join(dir, "index.html.br"))).not.toThrow();
      expect(() => readFileSync(join(dir, "small.js.br"))).toThrow();
      expect(() => readFileSync(join(dir, "pic.png.br"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
