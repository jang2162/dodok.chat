import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { testEnv } from "./helpers/env";

describe("loadConfig", () => {
  it("기본값 — DB 는 DATA_DIR/dodok.sqlite, 포트 3000", () => {
    // DB_PATH·PORT 를 비워 기본값 경로를 본다
    const c = loadConfig({ ...testEnv, DATA_DIR: "./tmp-data", DB_PATH: undefined, PORT: undefined });
    expect(c.dbPath).toBe("tmp-data/dodok.sqlite");
    expect(c.PORT).toBe(3000);
  });
  it("OpenClaw Gateway·브리지 토큰 변수 없이 읽힌다 — 옛 .env 에 남은 값은 읽지 않는다(멀티 Gateway 스펙 3.4)", () => {
    const old = {
      OPENCLAW_TARGET: "remote",
      OPENCLAW_GATEWAY_URL: "wss://gw.example",
      OPENCLAW_GATEWAY_TOKEN: "t",
      OPENCLAW_DEV_GATEWAY_URL: "ws://127.0.0.1:19001",
      OPENCLAW_DEV_GATEWAY_TOKEN: "t",
      OPENCLAW_DEVICE_IDENTITY_PATH: "data/openclaw-device.json",
      BRIDGE_TOKEN: "short",
    };
    expect(() => loadConfig(testEnv)).not.toThrow();
    const c = loadConfig({ ...testEnv, ...old }) as unknown as Record<string, unknown>;
    for (const key of Object.keys(old)) expect(c, key).not.toHaveProperty(key);
    expect(c).not.toHaveProperty("gateway");
    expect(c).not.toHaveProperty("deviceIdentityPath");
  });
  it(".env 의 빈 값(KEY=)은 설정하지 않은 것으로 보고 기본값을 쓴다", () => {
    const c = loadConfig({ ...testEnv, PORT: "", DB_PATH: "", HOST: "", BRIDGE_PUBLIC_URL: "" });
    expect(c.PORT).toBe(3000);
    expect(c.HOST).toBe("127.0.0.1");
    expect(c.dbPath).toBe("test-data-unused/dodok.sqlite");
    expect(c.BRIDGE_PUBLIC_URL).toBeUndefined();
  });
  it("OPENCLAW_FRAME_DUMP_PATH 는 선택 — 없거나 빈 값이면 undefined, 있으면 그대로", () => {
    expect(loadConfig(testEnv).OPENCLAW_FRAME_DUMP_PATH).toBeUndefined();
    expect(loadConfig({ ...testEnv, OPENCLAW_FRAME_DUMP_PATH: "" }).OPENCLAW_FRAME_DUMP_PATH).toBeUndefined();
    expect(
      loadConfig({ ...testEnv, OPENCLAW_FRAME_DUMP_PATH: "data/frames.jsonl" }).OPENCLAW_FRAME_DUMP_PATH,
    ).toBe("data/frames.jsonl");
  });
  it("ATTACHMENTS_DIR 이 없거나 빈 값이면 DATA_DIR/attachments, 있으면 그대로", () => {
    expect(
      loadConfig({ ...testEnv, ATTACHMENTS_DIR: undefined, DATA_DIR: "./tmp-data" }).attachmentsDir,
    ).toBe("tmp-data/attachments");
    expect(loadConfig({ ...testEnv, ATTACHMENTS_DIR: "", DATA_DIR: "./tmp-data" }).attachmentsDir).toBe(
      "tmp-data/attachments",
    );
    expect(loadConfig({ ...testEnv, ATTACHMENTS_DIR: "/srv/blobs" }).attachmentsDir).toBe("/srv/blobs");
  });
  it("LOCAL_AUTH_TOKEN 이 16자 미만이면 실패한다", () => {
    expect(() => loadConfig({ ...testEnv, LOCAL_AUTH_TOKEN: "short" })).toThrow(/LOCAL_AUTH_TOKEN/);
  });
  it("DODOK_RUNNER_DIR 는 선택", () => {
    expect(loadConfig(testEnv).DODOK_RUNNER_DIR).toBeUndefined();
    expect(loadConfig({ ...testEnv, DODOK_RUNNER_DIR: "/app/runner" }).DODOK_RUNNER_DIR).toBe("/app/runner");
  });

  it("DODOK_PLUGIN_DIR 는 선택", () => {
    expect(loadConfig(testEnv).DODOK_PLUGIN_DIR).toBeUndefined();
    expect(loadConfig({ ...testEnv, DODOK_PLUGIN_DIR: "/app/plugin" }).DODOK_PLUGIN_DIR).toBe("/app/plugin");
  });
});
