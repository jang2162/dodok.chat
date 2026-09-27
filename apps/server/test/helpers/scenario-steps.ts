/**
 * 통합 시나리오(태스크 14) 공통 단계 — REST 준비, wire 구독, 이벤트 기록과 이벤트 구동 대기.
 *
 * 시간으로 기다리지 않는다: `WireLog.until` 은 이미 받은 것을 먼저 보고, 그 뒤로는 wire 이벤트가 올 때마다 조건을 다시 잰다.
 * 상한(WAIT_MS)은 실패를 드러내는 용도일 뿐이다.
 */
import {
  type Agent,
  type Approval,
  Attachment,
  BRIDGE_ATTACHMENT_HEADERS,
  type ApprovalDecision,
  type Channel,
  type Message,
  type RelayPolicy,
  type Run,
  type RunEvent,
  type RunState,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { LiveApp } from "./live-app";
import { connectWire, type WireClient } from "./wire";

export const WAIT_MS = 5_000;

const TERMINAL = new Set<RunState["status"]>(["done", "error", "aborted"]);
export const isTerminal = (run: Pick<RunState, "status">): boolean => TERMINAL.has(run.status);

export type RestResponse<T> = { status: number; body: T };

export async function rest<T = unknown>(
  live: LiveApp,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: object,
): Promise<RestResponse<T>> {
  const res = await live.app.fastify.inject({
    method,
    url: `/api/v1${url}`,
    headers: live.auth.headers,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json() as T };
}

export async function getRunRest(live: LiveApp, runId: string): Promise<Run> {
  const res = await rest<{ run: Run }>(live, "GET", `/runs/${runId}`);
  expect(res.status).toBe(200);
  return res.body.run;
}

export async function listRunsRest(live: LiveApp, channelId: string): Promise<Run[]> {
  const res = await rest<{ runs: Run[] }>(live, "GET", `/channels/${channelId}/runs`);
  expect(res.status).toBe(200);
  return res.body.runs;
}

export type RelayChannel = {
  channel: Channel;
  dev: Agent;
  fin: Agent;
  /** 시나리오 1 이 재는 REST 상태 코드 */
  statuses: {
    channel: number;
    dev: number;
    fin: number;
    devMember: number;
    finMember: number;
    relayPolicy: number;
  };
};

type PolicyInput = RelayPolicy | ((agents: { dev: Agent; fin: Agent }) => RelayPolicy);

/** 시나리오 1 — 채널 → 에이전트 dev·fin 등록 → 멤버 추가 → relayPolicy PATCH. 2xx 가 아니면 본문을 싣고 던진다. */
export async function setupRelayChannel(live: LiveApp, policy: PolicyInput): Promise<RelayChannel> {
  const ok = <T>(what: string, res: RestResponse<T>): T => {
    if (res.status >= 300) throw new Error(`${what} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const created = await rest<{ channel: Channel }>(live, "POST", "/channels", { name: "relay" });
  const channelId = ok("POST /channels", created).channel.id;
  const devRes = await rest<{ agent: Agent }>(live, "POST", "/agents", {
    providerAgentId: "dev",
    handle: "dev",
    name: "Dev",
  });
  const dev = ok("POST /agents dev", devRes).agent;
  const finRes = await rest<{ agent: Agent }>(live, "POST", "/agents", {
    providerAgentId: "fin",
    handle: "fin",
    name: "Fin",
  });
  const fin = ok("POST /agents fin", finRes).agent;
  const devMember = await rest(live, "POST", `/channels/${channelId}/members`, {
    memberType: "agent",
    memberId: dev.id,
  });
  ok("POST members dev", devMember);
  const finMember = await rest(live, "POST", `/channels/${channelId}/members`, {
    memberType: "agent",
    memberId: fin.id,
  });
  ok("POST members fin", finMember);
  const relayPolicy = typeof policy === "function" ? policy({ dev, fin }) : policy;
  const patched = await rest<{ channel: Channel }>(live, "PATCH", `/channels/${channelId}`, { relayPolicy });
  const channel = ok("PATCH relayPolicy", patched).channel;
  return {
    channel,
    dev,
    fin,
    statuses: {
      channel: created.status,
      dev: devRes.status,
      fin: finRes.status,
      devMember: devMember.status,
      finMember: finMember.status,
      relayPolicy: patched.status,
    },
  };
}

export async function subscribe(
  socket: WireClient,
  channelId: string,
  lastSeq?: number,
): Promise<{ messages: Message[]; hasMore: boolean; activeRuns: RunState[] }> {
  const res = await socket.emitWithAck("channel.subscribe", {
    channelId,
    ...(lastSeq === undefined ? {} : { lastSeq }),
  });
  if (!res.ok) throw new Error(`channel.subscribe 실패: ${res.error.code} ${res.error.message}`);
  return res.data;
}

export async function sendMessage(
  socket: WireClient,
  channelId: string,
  bodyMd: string,
  opts: { attachments?: string[]; clientMsgId?: string; threadRootId?: string } = {},
): Promise<Message> {
  const res = await socket.emitWithAck("message.send", {
    channelId,
    clientMsgId: opts.clientMsgId ?? randomUUID(),
    bodyMd,
    ...(opts.attachments === undefined ? {} : { attachments: opts.attachments }),
    ...(opts.threadRootId === undefined ? {} : { threadRootId: opts.threadRootId }),
  });
  if (!res.ok) throw new Error(`message.send 실패: ${res.error.code} ${res.error.message}`);
  return res.data.message;
}

/** owner 세션으로 `POST /api/v1/attachments` — 2xx 가 아니면 상태·본문을 싣고 던진다 */
export async function uploadImage(
  live: LiveApp,
  channelId: string,
  bytes: Uint8Array,
  name: string,
): Promise<Attachment> {
  const res = await live.app.fastify.inject({
    method: "POST",
    url: `/api/v1/attachments?channelId=${channelId}`,
    headers: {
      ...live.auth.headers,
      "content-type": "image/png",
      [BRIDGE_ATTACHMENT_HEADERS.fileName]: encodeURIComponent(name),
    },
    payload: Buffer.from(bytes),
  });
  if (res.statusCode !== 200) throw new Error(`upload → ${res.statusCode} ${res.body}`);
  return Attachment.parse(res.json());
}

/** 승인 카드의 버튼을 누른다 — ack 가 실패면 코드를 싣고 던진다 */
export async function resolveApproval(
  socket: WireClient,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const res = await socket.emitWithAck("approval.resolve", { approvalId, decision });
  if (!res.ok) throw new Error(`approval.resolve 실패: ${res.error.code} ${res.error.message}`);
}

export type WireLog = {
  readonly socket: WireClient;
  /** run.state 의 run, 도착 순서 */
  readonly states: RunState[];
  readonly events: RunEvent[];
  readonly created: Message[];
  readonly updated: Message[];
  readonly adapterStatus: Array<{ gateway: string; bridge: string }>;
  /** approval.requested 의 approval, 도착 순서 */
  readonly approvals: Approval[];
  /** approval.resolved 의 approval, 도착 순서(만료·취소도 여기로 온다) */
  readonly resolvedApprovals: Approval[];
  statesOf(runId: string): RunState[];
  eventsOf(runId: string): RunEvent[];
  /** pick 이 undefined·false 가 아닌 값을 낼 때까지 — 받은 것부터 보고, 이후 wire 이벤트마다 다시 잰다 */
  until<T>(pick: () => T | undefined | false, what: string, timeoutMs?: number): Promise<T>;
  /** 그 런의 종료 run.state 를 기다려 돌려준다 */
  terminal(runId: string): Promise<RunState>;
};

/** 채널을 구독한 wire 소켓을 열고, 구독 직후부터 받은 서버 이벤트를 기록한다. 닫는 건 호출자(sockets 목록) 몫. */
export async function openChannelWire(
  live: LiveApp,
  channelId: string,
  sockets: WireClient[],
): Promise<WireLog> {
  const socket = await connectWire(live.app, live.auth.token);
  sockets.push(socket);
  const log = recordWire(socket);
  await subscribe(socket, channelId);
  return log;
}

export function recordWire(socket: WireClient): WireLog {
  const states: RunState[] = [];
  const events: RunEvent[] = [];
  const created: Message[] = [];
  const updated: Message[] = [];
  const adapterStatus: WireLog["adapterStatus"] = [];
  const approvals: Approval[] = [];
  const resolvedApprovals: Approval[] = [];
  const waiters = new Set<() => void>();
  const record =
    <P>(push: (payload: P) => void) =>
    (payload: P) => {
      push(payload);
      // check 는 끝나면 자기를 지운다 — Set 순회 중 현재 항목 삭제는 안전하다
      for (const check of waiters) check();
    };
  socket.on(
    "run.state",
    record((p) => states.push(p.run)),
  );
  socket.on(
    "run.event",
    record((p) => events.push(p.event)),
  );
  socket.on(
    "message.created",
    record((p) => created.push(p.message)),
  );
  socket.on(
    "message.updated",
    record((p) => updated.push(p.message)),
  );
  socket.on(
    "adapter.status",
    record((p) => {
      if (p.provider === "openclaw") adapterStatus.push({ gateway: p.gateway, bridge: p.bridge });
    }),
  );
  socket.on(
    "approval.requested",
    record((p) => approvals.push(p.approval)),
  );
  socket.on(
    "approval.resolved",
    record((p) => resolvedApprovals.push(p.approval)),
  );

  const log: WireLog = {
    socket,
    states,
    events,
    created,
    updated,
    adapterStatus,
    approvals,
    resolvedApprovals,
    statesOf: (runId) => states.filter((s) => s.id === runId),
    eventsOf: (runId) => events.filter((e) => e.runId === runId),
    until(pick, what, timeoutMs = WAIT_MS) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        const check = () => {
          let value: ReturnType<typeof pick>;
          try {
            value = pick();
          } catch (error) {
            cleanup();
            reject(error);
            return;
          }
          if (value === undefined || value === false) return;
          cleanup();
          resolve(value);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`wire 대기 ${timeoutMs}ms 초과: ${what}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    terminal(runId) {
      return log.until(() => log.statesOf(runId).find(isTerminal), `런 ${runId} 종료 run.state`);
    },
  };
  return log;
}
