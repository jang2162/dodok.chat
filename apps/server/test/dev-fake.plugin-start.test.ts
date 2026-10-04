import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_FAKE_HOME_GATEWAY_ID,
  DEV_FAKE_LOCAL_TOKEN,
  DEV_FAKE_OFFICE_GATEWAY_ID,
  type DevFake,
  startDevFake,
} from "../scripts/dev-fake";
import { openclawOf } from "./helpers/openclaw";

/**
 * 시작 때 고정 짝의 가짜 플러그인이 못 붙는 원인 가르기(태스크 7 재리뷰 N1). `corrupt` 가 켜지면 가짜 플러그인이 고정 토큰 끝에 한 글자를
 * 더 붙여 붙는다 — 시딩·브리지가 깨진 회귀의 대역이다(실제 핸드셰이크가 거절한다)
 */
const corrupt = vi.hoisted(() => ({ on: false }));
vi.mock("./fakes/fake-plugin", async (importActual) => {
  const actual = await importActual<typeof import("./fakes/fake-plugin")>();
  return {
    ...actual,
    startFakePlugin: (opts: Parameters<typeof actual.startFakePlugin>[0]) =>
      actual.startFakePlugin(corrupt.on ? { ...opts, token: `${opts.token}x` } : opts),
  };
});

let dir: string;
let dev: DevFake | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-plugin-start-"));
  corrupt.on = false;
});

afterEach(async () => {
  await dev?.close();
  dev = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function ownerCookie(url: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
  });
  expect(res.status).toBe(200);
  const { sessionToken } = (await res.json()) as { sessionToken: string };
  return `dodok.session=${sessionToken}`;
}

async function call(url: string, cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : ((await res.json()) as unknown);
}

const lineOf = (app: DevFake["app"], id: string) => {
  const status = openclawOf(app).status();
  const line = status.provider === "openclaw" ? status.gateways.find((g) => g.id === id) : undefined;
  return [line?.gateway, line?.bridge];
};

describe("startDevFake — 고정 짝의 가짜 플러그인이 못 붙으면(태스크 7 재리뷰 N1)", () => {
  it("새 DB·사람 손 0 인데 못 붙으면 시작이 실패한다 — 어느 Gateway 인지 오류에 싣는다", async () => {
    corrupt.on = true;
    await expect(startDevFake({ port: 0, dataDir: dir, logLevel: "fatal" })).rejects.toThrow(
      /dev:fake plugin for fixed Gateway 사무실 could not connect/,
    );
  }, 30_000);

  it("--keep 이어도 사람이 바꾼 것이 없으면 실패한다 — 켜진 Gateway·살아 있는 고정 토큰", async () => {
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "fatal" });
    await dev.close();
    dev = undefined;
    corrupt.on = true;
    await expect(startDevFake({ port: 0, dataDir: dir, keep: true, logLevel: "fatal" })).rejects.toThrow(
      /could not connect/,
    );
  }, 30_000);

  it("--keep 으로 사람이 폐기한 고정 토큰을 이어받으면 그대로 뜬다 — 그 짝만 플러그인 없이, 다른 짝은 붙는다", async () => {
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "fatal" });
    const cookie = await ownerCookie(dev.url);
    const { tokens } = (await call(
      dev.url,
      cookie,
      "GET",
      `/gateways/${DEV_FAKE_HOME_GATEWAY_ID}/bridge-tokens`,
    )) as { tokens: Array<{ id: string; label: string }> };
    const fixed = tokens.find((t) => t.label === "dev-fake");
    expect(fixed).toBeDefined();
    await call(
      dev.url,
      cookie,
      "DELETE",
      `/gateways/${DEV_FAKE_HOME_GATEWAY_ID}/bridge-tokens/${fixed?.id ?? ""}`,
    );
    await dev.close();
    dev = undefined;

    dev = await startDevFake({ port: 0, dataDir: dir, keep: true, logLevel: "fatal" });
    expect(lineOf(dev.app, DEV_FAKE_OFFICE_GATEWAY_ID)).toEqual(["connected", "connected"]);
    expect(lineOf(dev.app, DEV_FAKE_HOME_GATEWAY_ID)[1]).not.toBe("connected");
  }, 30_000);
});
