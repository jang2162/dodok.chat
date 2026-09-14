/**
 * 디바이스 아이덴티티 — 네트워크 없이 순수하게 동작하는 호스트 저장소.
 *
 * `GatewayClient` 는 디바이스 키를 스스로 만들지도, OpenClaw 의 로컬 자격 증명을 읽지도 않는다.
 * 키 생성·보관·서명은 전부 호스트(우리 서버)가 `hostDeps` 로 주입한다.
 * 인코딩 규약은 OpenClaw 레퍼런스 구현(`ed25519-signature`)과 맞춘다:
 * 공개키 SPKI PEM, 개인키 PKCS#8 PEM, 서명·raw 공개키는 base64url,
 * `deviceId` 는 raw 공개키 32바이트의 sha256 hex.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ED25519_RAW_KEY_LENGTH = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** `GatewayClientHostDeps.loadOrCreateDeviceIdentity` 가 돌려줘야 하는 모양. */
export type DeviceIdentity = {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

type StoredDeviceIdentity = DeviceIdentity & { createdAtMs: number };

export class DeviceIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeviceIdentityError";
  }
}

function deriveRawPublicKey(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new DeviceIdentityError("공개키가 Ed25519 가 아니다");
  }
  const der = Buffer.from(key.export({ format: "der", type: "spki" }));
  if (
    der.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH ||
    !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new DeviceIdentityError("공개키 SPKI 인코딩이 표준형이 아니다");
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

/** PEM 공개키를 Gateway 가 받는 raw base64url 32바이트로 바꾼다. */
export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return deriveRawPublicKey(publicKeyPem).toString("base64url");
}

/** UTF-8 페이로드를 Ed25519 개인키로 서명하고 base64url 로 돌려준다. */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new DeviceIdentityError("개인키가 Ed25519 가 아니다");
  }
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

/** raw 공개키의 sha256 hex — Gateway 가 디바이스를 식별하는 값. */
export function deviceIdFromPublicKeyPem(publicKeyPem: string): string {
  return createHash("sha256").update(deriveRawPublicKey(publicKeyPem)).digest("hex");
}

function generateDeviceIdentity(nowMs: number): StoredDeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }) as string;
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  return {
    createdAtMs: nowMs,
    deviceId: deviceIdFromPublicKeyPem(publicKeyPem),
    privateKeyPem,
    publicKeyPem,
  };
}

function keyPairMatches(publicKeyPem: string, privateKeyPem: string): boolean {
  try {
    const derivedPublicKeyDer = createPublicKey(privateKeyPem).export({ format: "der", type: "spki" });
    const storedPublicKeyDer = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
    return Buffer.from(derivedPublicKeyDer).equals(Buffer.from(storedPublicKeyDer));
  } catch {
    return false;
  }
}

function parseStoredDeviceIdentity(raw: string, filePath: string): StoredDeviceIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DeviceIdentityError(`디바이스 아이덴티티 파일이 JSON 이 아니다: ${filePath}`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DeviceIdentityError(`디바이스 아이덴티티 파일이 객체가 아니다: ${filePath}`);
  }
  const value = parsed as Record<string, unknown>;
  const { createdAtMs, deviceId, privateKeyPem, publicKeyPem } = value;
  if (
    typeof deviceId !== "string" ||
    typeof privateKeyPem !== "string" ||
    typeof publicKeyPem !== "string" ||
    typeof createdAtMs !== "number" ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0
  ) {
    throw new DeviceIdentityError(`디바이스 아이덴티티 파일의 필드가 깨졌다: ${filePath}`);
  }
  if (!keyPairMatches(publicKeyPem, privateKeyPem)) {
    throw new DeviceIdentityError(`디바이스 아이덴티티의 공개키·개인키가 짝이 아니다: ${filePath}`);
  }
  if (deviceIdFromPublicKeyPem(publicKeyPem) !== deviceId) {
    throw new DeviceIdentityError(`디바이스 아이덴티티의 deviceId 가 공개키와 어긋난다: ${filePath}`);
  }
  return { createdAtMs, deviceId, privateKeyPem, publicKeyPem };
}

function writeStoredDeviceIdentity(filePath: string, stored: StoredDeviceIdentity): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  // 같은 디렉터리에 쓰고 rename 해야 부분 기록된 키 파일이 남지 않는다.
  const temporaryPath = join(directory, `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
}

/**
 * 파일이 있으면 검증해 그대로 읽고, 없으면 새 Ed25519 키를 만들어 저장한 뒤 돌려준다.
 * 같은 경로로 다시 부르면 같은 키가 나온다 — 그래야 Gateway 페어링 승인이 유지된다.
 */
export function loadOrCreateDeviceIdentity(filePath: string, nowMs: number = Date.now()): DeviceIdentity {
  let raw: string | undefined;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DeviceIdentityError(`디바이스 아이덴티티 파일을 읽지 못했다: ${filePath}`, { cause: error });
    }
  }
  if (raw !== undefined) {
    const { createdAtMs: _createdAtMs, ...identity } = parseStoredDeviceIdentity(raw, filePath);
    return identity;
  }
  const created = generateDeviceIdentity(nowMs);
  writeStoredDeviceIdentity(filePath, created);
  const { createdAtMs: _createdAtMs, ...identity } = created;
  return identity;
}
