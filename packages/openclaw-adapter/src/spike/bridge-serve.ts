/**
 * Phase 0 스파이크 2 — 브리지 서버만 띄우는 최소 명령 (원격 Gateway 확인용, ADR 0002 9절).
 *
 * 러너(`bridge-spike.ts`)는 로컬 dev Gateway 전용이다. 원격에서는 이 명령으로 브리지만 열고,
 * 표준 입력 한 줄을 사람(또는 에이전트) 인바운드 1건으로 보내고, 판정은 콘솔의 `outbound.message` 로 한다.
 * Gateway WS·설정 변경·관찰 파일은 없다 — C/D 의 설정은 호스트 CLI(`openclaw config patch`)로 바꾼다.
 *
 * 환경(.env): BRIDGE_URL(리슨 오리진, 예 ws://127.0.0.1:19100), BRIDGE_TOKEN.
 *   DODOK_SPIKE_CHANNEL_ID  인바운드 채널 id(기본 0199a6c0-0000-7000-8000-000000000c01)
 *   DODOK_SPIKE_AGENT       대상 에이전트 기본값(기본 main)
 *
 * 실행: `pnpm -F @dodok/openclaw-adapter spike:bridge-serve`
 * 입력 한 줄 = 인바운드 1건 = 원격 모델 런 1회(봇 루프 보호로 막히면 런 없음):
 *   `@<agentId> 본문`          사람(operator) 작성, <agentId> 에게
 *   `<handle>> @<agentId> 본문` 에이전트 <handle> 작성(시나리오 C — 봇 루프 보호 사실이 붙는다)
 *   `@` 로 시작하지 않으면 DODOK_SPIKE_AGENT 에게
 *
 * 이 파일은 스파이크용이라 테스트하지 않는다.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";
import type { InboundDeliver } from "@dodok/shared";
import Fastify from "fastify";
import { Server } from "socket.io";
import { attachBridge } from "../bridge/server";
import { verifyBridgeToken } from "../bridge/session";

function findRepoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const env = parseEnv(readFileSync(join(findRepoRoot(), ".env"), "utf8"));
function envValue(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} 이 .env 에 없다`);
  return value;
}
const BRIDGE_URL = new URL(envValue("BRIDGE_URL"));
const BRIDGE_TOKEN = envValue("BRIDGE_TOKEN");
const CHANNEL_ID = process.env["DODOK_SPIKE_CHANNEL_ID"] ?? "0199a6c0-0000-7000-8000-000000000c01";
const DEFAULT_AGENT = process.env["DODOK_SPIKE_AGENT"] ?? "main";
const OPERATOR = { type: "user" as const, handle: "operator", displayName: "operator" };

const LINE_RE = /^(?:([\w.-]+)>\s*)?(?:@([\w.-]+)\s+)?([\s\S]+)$/;

function toDelivery(line: string): InboundDeliver | null {
  const match = LINE_RE.exec(line.trim());
  if (!match?.[3]) return null;
  const [, authorHandle, target, rest] = match;
  const agentId = target ?? DEFAULT_AGENT;
  const author = authorHandle
    ? { type: "agent" as const, handle: authorHandle, displayName: authorHandle }
    : OPERATOR;
  const text = target ? `@${target} ${rest}` : rest;
  const handles = new Set([agentId, ...(authorHandle ? [authorHandle] : [])]);
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: CHANNEL_ID,
    conversationId: CHANNEL_ID,
    conversationTitle: "spike",
    agentId,
    sessionKey: `agent:${agentId}:dodok:channel:${CHANNEL_ID}`,
    runId: randomUUID(),
    message: { id: randomUUID(), author, text, attachments: [], ts: new Date().toISOString() },
    context: {
      recentMessages: [],
      participants: [
        { type: "user", handle: OPERATOR.handle, displayName: OPERATOR.displayName, isSelf: false },
        ...[...handles].map((handle) => ({
          type: "agent" as const,
          handle,
          displayName: handle,
          isSelf: handle === agentId,
        })),
      ],
      relayRules: "다른 에이전트를 @멘션하면 그 에이전트가 이어받는다. 최대 4턴.",
    },
    options: {},
  };
}

const app = Fastify({ logger: false });
const io = new Server(app.server, { transports: ["websocket"] });
const bridgeServer = attachBridge(io, {
  verifyToken: (presented) =>
    verifyBridgeToken(BRIDGE_TOKEN, presented) ? { tokenId: "spike", gatewayId: "spike" } : null,
  acceptGateway: () => true,
  serverVersion: "spike-2-serve",
  onHello: (_session, hello) => console.log(`플러그인 hello: ${JSON.stringify(hello)}`),
  onOutboundMessage: async (_session, message) => {
    const { outboundId, agentId, runId, text, components } = message;
    console.log(`← outbound.message ${JSON.stringify({ outboundId, agentId, runId, text, components })}`);
    return { messageId: randomUUID() };
  },
  onClose: (session) => console.log(`플러그인 연결 닫힘 (${session.closeReason ?? "?"})`),
  onRejected: (reason) => console.log(`핸드셰이크 거부: ${reason}`),
});
// 스파이크는 Gateway 하나 — 브리지 자리도 하나만 쓴다
const bridge = bridgeServer.forGateway("spike");

await app.listen({ host: BRIDGE_URL.hostname, port: Number(BRIDGE_URL.port) });
console.log(
  `브리지 ${BRIDGE_URL.hostname}:${BRIDGE_URL.port} 네임스페이스 /bridge, 채널 ${CHANNEL_ID}, 기본 에이전트 ${DEFAULT_AGENT}`,
);
console.log("플러그인 hello 를 기다린다. 한 줄 입력 = 인바운드 1건(원격 모델 런 1회). 끝내려면 Ctrl+D");

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const delivery = toDelivery(line);
  if (!delivery) continue;
  const res = await bridge.deliverInbound(delivery);
  // ack {admission:"dispatch", providerRunId} = 런 시작, {admission:"drop", reason} = 런 없이 끝남(봇 루프 보호 등), 오류 = 플러그인 미연결·타임아웃·디스패치 실패
  console.log(
    `→ inbound.deliver [${delivery.message.author.handle} → ${delivery.agentId}] ack ${JSON.stringify(res)}`,
  );
}

bridgeServer.close();
io.close();
await app.close();
