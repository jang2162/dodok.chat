import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { testEnv } from "./helpers/env";

describe("loadConfig", () => {
  it("dev 대상이면 dev 쌍을 gateway 로 고르고 디바이스 파일 이름에 -dev 를 붙인다", () => {
    // DB_PATH·PORT 를 비워 기본값 경로를 본다
    const c = loadConfig({ ...testEnv, DATA_DIR: "./tmp-data", DB_PATH: undefined, PORT: undefined });
    expect(c.gateway).toEqual({ url: "ws://127.0.0.1:19001", token: "t" });
    expect(c.deviceIdentityPath).toBe("tmp-data/openclaw-device-dev.json");
    expect(c.dbPath).toBe("tmp-data/dodok.sqlite");
    expect(c.PORT).toBe(3000);
  });
  it("remote 대상인데 원격 쌍이 없으면 어떤 변수가 빠졌는지 말하며 실패한다", () => {
    expect(() => loadConfig({ ...testEnv, OPENCLAW_TARGET: "remote" })).toThrow(/OPENCLAW_GATEWAY_URL/);
  });
  it(".env 의 빈 값(KEY=)은 설정하지 않은 것으로 보고 기본값을 쓴다", () => {
    const c = loadConfig({ ...testEnv, PORT: "", DB_PATH: "", HOST: "", OPENCLAW_GATEWAY_TOKEN: "" });
    expect(c.PORT).toBe(3000);
    expect(c.HOST).toBe("127.0.0.1");
    expect(c.dbPath).toBe("test-data-unused/dodok.sqlite");
    expect(c.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
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
  it("BRIDGE_TOKEN 은 선택 — 없거나 빈 값이면 undefined, 있으면 16자 이상", () => {
    expect(loadConfig({ ...testEnv, BRIDGE_TOKEN: undefined }).BRIDGE_TOKEN).toBeUndefined();
    expect(loadConfig({ ...testEnv, BRIDGE_TOKEN: "" }).BRIDGE_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...testEnv, BRIDGE_TOKEN: "short" })).toThrow(/BRIDGE_TOKEN/);
    expect(loadConfig({ ...testEnv, BRIDGE_TOKEN: "b".repeat(16) }).BRIDGE_TOKEN).toBe("b".repeat(16));
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
