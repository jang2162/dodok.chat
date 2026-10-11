/** 네이티브 푸시 자격 증명 로더(스펙 「자격 증명·설정」 장) — 키는 테스트가 실행 중에 만들고 임시 디렉터리에만 쓴다 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApnsCredentials } from "../src/modules/push/credentials";

const ecPem = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

describe("loadApnsCredentials", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-apns-creds-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const putFiles = (files: { key?: string; config?: string }) => {
    mkdirSync(join(dir, "apns"), { recursive: true });
    if (files.key !== undefined) writeFileSync(join(dir, "apns", "key.p8"), files.key);
    if (files.config !== undefined) writeFileSync(join(dir, "apns", "config.json"), files.config);
  };

  it("data/apns/key.p8 + config.json 으로 켜진다", () => {
    putFiles({ key: ecPem(), config: JSON.stringify({ keyId: "FILEKEY123", teamId: "FILETEAM12" }) });
    const c = loadApnsCredentials({ dataDir: dir });
    expect(c).toMatchObject({ keyId: "FILEKEY123", teamId: "FILETEAM12" });
    expect("key" in c && c.key.asymmetricKeyType).toBe("ec");
  });

  it("환경 변수가 파일보다 먼저다 — 키 경로·키 id·팀 id 각각", () => {
    putFiles({ key: "깨진 파일", config: JSON.stringify({ keyId: "FILEKEY123", teamId: "FILETEAM12" }) });
    const envKey = join(dir, "env-key.p8");
    writeFileSync(envKey, ecPem());
    expect(
      loadApnsCredentials({ dataDir: dir, keyPath: envKey, keyId: "ENVKEY1234", teamId: "ENVTEAM123" }),
    ).toMatchObject({ keyId: "ENVKEY1234", teamId: "ENVTEAM123" });
    expect(loadApnsCredentials({ dataDir: dir, keyPath: envKey, keyId: "ENVKEY1234" })).toMatchObject({
      keyId: "ENVKEY1234",
      teamId: "FILETEAM12",
    });
  });

  it("환경 변수만으로도 켜진다 — config.json 이 없어도", () => {
    const envKey = join(dir, "env-key.p8");
    writeFileSync(envKey, ecPem());
    expect(
      loadApnsCredentials({ dataDir: join(dir, "없음"), keyPath: envKey, keyId: "K", teamId: "T" }),
    ).toMatchObject({ keyId: "K", teamId: "T" });
  });

  it("키가 없으면 off — 파일도 환경 변수 경로도", () => {
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "no key" });
    expect(
      loadApnsCredentials({ dataDir: dir, keyPath: join(dir, "없는.p8"), keyId: "K", teamId: "T" }),
    ).toEqual({
      off: "no key",
    });
  });

  it("깨진 키·EC 가 아닌 키·다른 곡선은 invalid key 로 끄고 던지지 않는다", () => {
    const config = JSON.stringify({ keyId: "K", teamId: "T" });
    putFiles({ key: "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n", config });
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "invalid key" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    putFiles({ key: rsa });
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "invalid key" });
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    putFiles({ key: p384 });
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "invalid key" });
  });

  it("키 id·팀 id 가 없거나 config.json 이 틀리면 off", () => {
    putFiles({ key: ecPem() });
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "no key id" });
    expect(loadApnsCredentials({ dataDir: dir, keyId: "K" })).toEqual({ off: "no team id" });
    putFiles({ config: "{ 깨짐" });
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "invalid config" });
    putFiles({ config: JSON.stringify({ keyId: "K" }) });
    expect(loadApnsCredentials({ dataDir: dir })).toEqual({ off: "invalid config" });
  });

  it("사유 문자열에 키 원문·키 id·팀 id 가 없다", () => {
    const pem = ecPem();
    const body = pem.split("\n")[1] ?? "";
    putFiles({
      key: `${pem.slice(0, 40)}깨짐`,
      config: JSON.stringify({ keyId: "SECRETKID1", teamId: "SECRETTEAM" }),
    });
    const off = loadApnsCredentials({ dataDir: dir });
    const text = JSON.stringify(off);
    expect(text).not.toContain(body);
    expect(text).not.toContain("SECRETKID1");
    expect(text).not.toContain("SECRETTEAM");
    expect(text).not.toContain(dir);
  });
});
