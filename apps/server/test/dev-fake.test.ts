import {
  type ClientToServerEvents,
  type InboundDeliver,
  type ServerToClientEvents,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_FAKE_LOCAL_TOKEN, type DevFake, fakeAgentScript, startDevFake } from "../scripts/dev-fake";
import type { ScenarioApproval } from "./fakes/scenario";

type Author = { type: "user" | "agent"; handle: string };

/** 대본이 읽는 필드만 채운다 — 채널 참여자는 owner·dev·fin, self 는 isSelf */
const delivery = (
  text: string,
  author: Author,
  self = "dev",
  agents: string[] = ["dev", "fin"],
): InboundDeliver =>
  ({
    message: { text, author: { ...author, displayName: author.handle } },
    context: {
      participants: [
        { type: "user", handle: "owner", displayName: "owner", isSelf: false },
        ...agents.map((h) => ({ type: "agent", handle: h, displayName: h, isSelf: h === self })),
      ],
    },
  }) as unknown as InboundDeliver;

describe("fakeAgentScript", () => {
  const owner: Author = { type: "user", handle: "owner" };

  it("받은 글을 @ 없이 인용해 답하고, 델타를 이어 붙이면 답이 된다", () => {
    const s = fakeAgentScript("dev", delivery("@dev 안녕", owner));
    expect(s.reply).toContain("잘 받았어요");
    expect(s.reply).not.toContain("@dev");
    expect(s.deltas?.length).toBeGreaterThanOrEqual(3);
    expect(s.deltas?.length).toBeLessThanOrEqual(6);
    expect((s.deltas ?? []).join("")).toBe(s.reply);
    expect(s.deltaDelayMs).toBe(150);
    expect(s.fail).toBeUndefined();
    expect(s.drop).toBeUndefined();
    expect(s.tool).toBeUndefined();
  });

  it("다른 에이전트 멘션과 보낸 에이전트를 답에 싣는다(릴레이)", () => {
    expect(fakeAgentScript("dev", delivery("@dev @fin 에게 전해줘", owner)).reply).toContain("@fin");
    expect(
      fakeAgentScript("fin", delivery("잘 받았어요 @fin", { type: "agent", handle: "dev" }, "fin")).reply,
    ).toContain("@dev");
  });

  it("채널 참여 에이전트만 부른다 — 자기·채널 밖 핸들은 싣지 않고, 핸들이 providerAgentId 와 달라도 된다", () => {
    const reply = fakeAgentScript(
      "dev",
      delivery("@devbot @ghost @owner 안녕", owner, "devbot", ["devbot", "fin"]),
    ).reply;
    expect(reply).not.toMatch(/@(devbot|ghost|owner)\b/);
    expect(reply).not.toContain("@fin");
    expect(
      fakeAgentScript("dev", delivery("@devbot @fin 둘 다", owner, "devbot", ["devbot", "fin"])).reply,
    ).toContain("@fin");
  });

  it("긴 글·서로게이트 쌍도 코드 포인트 단위로 자르고 나눈다", () => {
    // u 플래그에서 짝이 맞는 서로게이트는 한 코드 포인트라 \p{Cs} 는 외톨이 서로게이트만 잡는다
    const loneSurrogate = /\p{Cs}/u;
    const s = fakeAgentScript("dev", delivery(`@dev ${"😀".repeat(60)}`, owner));
    expect(s.reply).not.toMatch(loneSurrogate);
    for (const delta of s.deltas ?? []) expect(delta).not.toMatch(loneSurrogate);
  });

  it("승인 → 승인 대본 하나, 승인 둘 → 만료 시각이 다른 둘, 승인 항상 → 버튼 셋", () => {
    const one = fakeAgentScript("dev", delivery("@dev 승인", owner)).approval as ScenarioApproval;
    // TTL 20초는 브라우저 검증이 만료까지 볼 수 있게 줄인 값이다(실물 120초)
    expect(one).toMatchObject({
      title: "claude-cli native tool: Write",
      toolName: "Write",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 20_000,
    });
    // 이어갈 모양을 고정하지 않는다 — 허용이면 툴 성공, 거절·만료면 툴 오류
    expect(one.onDecision).toBeUndefined();

    const two = fakeAgentScript("dev", delivery("@dev 승인 둘", owner)).approval as ScenarioApproval[];
    expect(two.map((a) => [a.toolName, a.ttlMs])).toEqual([
      ["Write", 20_000],
      ["Read", 60_000],
    ]);

    const always = fakeAgentScript("dev", delivery("@dev 승인 항상", owner)).approval as ScenarioApproval;
    expect(always.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);

    expect(fakeAgentScript("dev", delivery("@dev 안녕", owner)).approval).toBeUndefined();
  });

  it("느리게 → 1.5s 간격, 실패 → fail, 드롭 → drop, 도구 → tool", () => {
    expect(fakeAgentScript("dev", delivery("@dev 느리게", owner)).deltaDelayMs).toBe(1_500);
    expect(fakeAgentScript("dev", delivery("@dev 실패", owner)).fail).toBeDefined();
    expect(fakeAgentScript("dev", delivery("@dev 드롭", owner)).drop).toBe("bot-loop-protection");
    expect(fakeAgentScript("dev", delivery("@dev 도구", owner)).tool?.name).toBe("Read");
  });
});

type WireSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe("startDevFake", () => {
  let dir: string;
  let dev: DevFake;
  let sessionToken: string;
  let cookie: string;
  const sockets: WireSocket[] = [];

  async function api<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${dev.url}/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** 없으면 등록한다 — 테스트 순서와 무관하게 */
  async function agentId(handle: "dev" | "fin"): Promise<string> {
    const { agents } = await api<{ agents: Array<{ id: string; handle: string }> }>("GET", "/agents");
    const found = agents.find((a) => a.handle === handle);
    if (found) return found.id;
    const { agent } = await api<{ agent: { id: string } }>("POST", "/agents", {
      providerAgentId: handle,
      handle,
      name: handle,
    });
    return agent.id;
  }

  async function channelWith(name: string, handles: Array<"dev" | "fin">): Promise<string> {
    const { channel } = await api<{ channel: { id: string } }>("POST", "/channels", { name });
    for (const handle of handles) {
      await api("POST", `/channels/${channel.id}/members`, {
        memberType: "agent",
        memberId: await agentId(handle),
      });
    }
    return channel.id;
  }

  async function openWire(channelId: string): Promise<WireSocket> {
    const socket: WireSocket = io(dev.url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { protocol: WIRE_PROTOCOL, token: sessionToken },
    });
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId });
    if (!res.ok) throw new Error(`channel.subscribe → ${res.error.code}`);
    return socket;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    // /auth/local 은 5회/분 레이트리밋 — 한 번만 로그인해 두 테스트가 같이 쓴다
    const login = await fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
    });
    expect(login.status).toBe(200);
    sessionToken = ((await login.json()) as { sessionToken: string }).sessionToken;
    cookie = `dodok.session=${sessionToken}`;
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("고정 토큰으로 로그인 → discover 에 dev·fin → 등록·채널·멤버 → @dev 에 에이전트 답이 온다", async () => {
    const { agents: found } = await api<{ agents: Array<{ providerAgentId: string }> }>(
      "GET",
      "/agents/discover",
    );
    expect(found.map((a) => a.providerAgentId).sort()).toEqual(["dev", "fin"]);
    const channelId = await channelWith("t", ["dev"]);
    const devId = await agentId("dev");

    const socket = await openWire(channelId);
    const reply = new Promise<string>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent") resolve(message.bodyMd);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c1",
      bodyMd: `<@a:${devId}> 안녕`,
    });
    expect(sent.ok).toBe(true);
    await expect(reply).resolves.toContain("잘 받았어요");
  }, 20_000);

  it("@dev @fin 이면 서로 부르다가 릴레이 턴 상한에서 relay_limit 시스템 메시지가 생긴다", async () => {
    const channelId = await channelWith("relay", ["dev", "fin"]);
    // 기본 상한 4 대신 1 로 낮춰 빨리 잰다
    await api("PATCH", `/channels/${channelId}`, { relayPolicy: { maxRelayTurns: 1, allowPairs: "all" } });

    const socket = await openWire(channelId);
    const limit = new Promise<string>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.kind === "system" && message.systemMeta?.kind === "relay_limit") resolve(message.bodyMd);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c2",
      bodyMd: "@dev @fin 시작",
    });
    expect(sent.ok && sent.data.message.mentions.agents).toHaveLength(2);
    await expect(limit).resolves.toContain("릴레이 한도(1턴)");
  }, 20_000);
});
