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
  it("OpenClaw Gateway·브리지 토큰 변수 없이 읽힌다 — 옛 .env 에 남은 값은 읽지 않는다(멀티 Gateway 스펙 「.env」 절)", () => {
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

  describe("첨부 저장소(S3 스펙 S1·S2)", () => {
    const s3Env = {
      ...testEnv,
      ATTACHMENTS_STORAGE: "s3",
      S3_REGION: "ap-northeast-2",
      S3_BUCKET: "dodok-files",
      S3_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID",
      S3_SECRET_ACCESS_KEY: "very-secret-value-123",
    };
    it("기본은 local — S3 설정이 없다", () => {
      const c = loadConfig(testEnv);
      expect(c.attachmentsStorage).toBe("local");
      expect(c.s3).toBeUndefined();
      expect(loadConfig({ ...testEnv, ATTACHMENTS_STORAGE: "" }).attachmentsStorage).toBe("local");
    });
    it("s3 모드 — 값을 읽고 PREFIX 기본 빈 값, FORCE_PATH_STYLE 기본 false, ENDPOINT 선택", () => {
      const c = loadConfig(s3Env);
      expect(c.attachmentsStorage).toBe("s3");
      expect(c.s3).toEqual({
        region: "ap-northeast-2",
        bucket: "dodok-files",
        prefix: "",
        accessKeyId: "AKIAEXAMPLEKEYID",
        secretAccessKey: "very-secret-value-123",
        forcePathStyle: false,
      });
      const minio = loadConfig({
        ...s3Env,
        S3_ENDPOINT: "http://127.0.0.1:9000",
        S3_PREFIX: "dodok/",
        S3_FORCE_PATH_STYLE: "true",
      });
      expect(minio.s3).toMatchObject({
        endpoint: "http://127.0.0.1:9000",
        prefix: "dodok/",
        forcePathStyle: true,
      });
    });
    it.each([
      ["dodok", "dodok/"],
      ["/dodok/", "dodok/"],
      ["//a/b//", "a/b/"],
      ["/", ""],
    ])("S3_PREFIX %j → %j — 앞 / 는 떼고 끝은 / 하나", (raw, want) => {
      expect(loadConfig({ ...s3Env, S3_PREFIX: raw }).s3?.prefix).toBe(want);
    });
    it("S3_FORCE_PATH_STYLE 는 true|false 만", () => {
      expect(() => loadConfig({ ...s3Env, S3_FORCE_PATH_STYLE: "yes" })).toThrow(/S3_FORCE_PATH_STYLE/);
    });
    it.each(["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])(
      "s3 모드에서 %s 가 없으면 그 이름이 든 오류 — 다른 값(시크릿)은 싣지 않는다",
      (key) => {
        let message = "";
        try {
          loadConfig({ ...s3Env, [key]: undefined });
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(key);
        expect(message).not.toContain("very-secret-value-123");
        expect(message).not.toContain("AKIAEXAMPLEKEYID");
      },
    );
    it("local 모드면 S3 값이 비어도 된다", () => {
      expect(() => loadConfig({ ...testEnv, ATTACHMENTS_STORAGE: "local" })).not.toThrow();
    });
  });
});
