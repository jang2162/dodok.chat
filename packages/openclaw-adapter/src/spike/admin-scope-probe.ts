/**
 * 원격 Gateway 공유 토큰이 `operator.admin` 을 주는지 잰다(계획서 10장 #15).
 * 남기는 것: 세션 1개(`agent:main:dodok:channel:<probe uuid>`).
 *
 * 실행: `pnpm -F @dodok/openclaw-adapter spike:admin-scope`
 * (.env 의 `OPENCLAW_GATEWAY_URL`·`OPENCLAW_GATEWAY_TOKEN` 을 셸이 읽어 둔 상태에서,
 *  `OPENCLAW_DEVICE_IDENTITY_PATH` 로 스파이크 1 디바이스 아이덴티티를 재사용한다.)
 */
import { randomUUID } from "node:crypto";
import { connectGateway, GatewayPairingRequiredError } from "../gateway/client";

const PAIRING_RETRY_INTERVAL_MS = 3_000;
const PAIRING_MAX_ATTEMPTS = 5;

const rawUrl = process.env.OPENCLAW_GATEWAY_URL;
const rawToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const identityPath = process.env.OPENCLAW_DEVICE_IDENTITY_PATH ?? "./data/openclaw-device.json";
if (!rawUrl || !rawToken) throw new Error("OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN 이 필요하다");
const url: string = rawUrl;
const token: string = rawToken;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * 새 디바이스 아이덴티티는 첫 연결에서 `PAIRING_REQUIRED` 로 거절된다(ADR 0001 3절).
 * 공유 토큰이 있으면 몇 초 안에 사람 없이 자동 승인되므로 짧은 간격으로 재시도한다.
 */
async function connectWithPairingRetry(): ReturnType<typeof connectGateway> {
  for (let attempt = 1; attempt <= PAIRING_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await connectGateway({
        caps: [],
        clientDisplayName: "dodok-admin-probe",
        connectTimeoutMs: 30_000,
        deviceIdentityPath: identityPath,
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
        token,
        url,
      });
    } catch (error) {
      if (!(error instanceof GatewayPairingRequiredError) || attempt === PAIRING_MAX_ATTEMPTS) throw error;
      console.log(
        `connect 시도 ${attempt}/${PAIRING_MAX_ATTEMPTS} — 페어링 대기 중 (${error.message}), ${PAIRING_RETRY_INTERVAL_MS}ms 뒤 재시도`,
      );
      await sleep(PAIRING_RETRY_INTERVAL_MS);
    }
  }
  throw new Error("unreachable");
}

const conn = await connectWithPairingRetry();
const grantedScopes = conn.hello.auth.scopes;
const key = `agent:main:dodok:channel:${randomUUID()}`;

let resetOutcome: string;
try {
  const res = await conn.request("sessions.reset", { key }, { timeoutMs: 15_000 });
  resetOutcome = `ok: ${JSON.stringify(res).slice(0, 200)}`;
} catch (error) {
  const details = (error as { details?: { code?: string; missingScope?: string } }).details;
  resetOutcome = `error: ${(error as Error).message} code=${details?.code ?? "?"} missingScope=${details?.missingScope ?? "-"}`;
}

// resetOutcome 이 스코프 부족을 가리키면, 연결 자체는 정상인지(없는 메서드와 구분) sessions.list 로 한 번 더 본다.
let sessionsListOutcome: string;
try {
  await conn.request("sessions.list", {}, { timeoutMs: 15_000 });
  sessionsListOutcome = "ok";
} catch (error) {
  sessionsListOutcome = `error: ${(error as Error).message}`;
}

console.log(JSON.stringify({ grantedScopes, probeKey: key, resetOutcome, sessionsListOutcome }, null, 2));
await conn.stop();
