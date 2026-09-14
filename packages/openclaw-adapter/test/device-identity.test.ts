import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../src/gateway/device-identity";

describe("device-identity", () => {
  let dir: string;
  let identityPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-device-"));
    identityPath = join(dir, "nested", "openclaw-device.json");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("파일이 없으면 새 아이덴티티를 만들어 저장한다", () => {
    const identity = loadOrCreateDeviceIdentity(identityPath);

    expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(createPublicKey(identity.privateKeyPem).asymmetricKeyType).toBe("ed25519");

    const persisted = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
    expect(persisted.deviceId).toBe(identity.deviceId);
    expect(persisted.publicKeyPem).toBe(identity.publicKeyPem);
    expect(persisted.privateKeyPem).toBe(identity.privateKeyPem);
    expect(typeof persisted.createdAtMs).toBe("number");
  });

  it("파일이 있으면 같은 키를 다시 읽는다", () => {
    const first = loadOrCreateDeviceIdentity(identityPath);
    const second = loadOrCreateDeviceIdentity(identityPath);

    expect(second).toEqual(first);
  });

  it("공개키는 raw 32바이트 base64url 이다", () => {
    const identity = loadOrCreateDeviceIdentity(identityPath);
    const encoded = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(encoded, "base64url")).toHaveLength(32);
    expect(Buffer.from(encoded, "base64url").toString("base64url")).toBe(encoded);
  });

  it("서명은 crypto.verify 로 검증된다", () => {
    const identity = loadOrCreateDeviceIdentity(identityPath);
    const payload = "v3|device|gateway-client|backend|operator|operator.read|1|token|nonce|darwin|";
    const signature = signDevicePayload(identity.privateKeyPem, payload);

    expect(
      verify(
        null,
        Buffer.from(payload, "utf8"),
        createPublicKey(identity.publicKeyPem),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(`${payload}tampered`, "utf8"),
        createPublicKey(identity.publicKeyPem),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
  });
});
