import {
  type ClientToServerEvents,
  ComponentsV1,
  type Field,
  type InboundDeliver,
  type Message,
  type ServerToClientEvents,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_FAKE_LOCAL_TOKEN, type DevFake, fakeAgentScript, startDevFake } from "../scripts/dev-fake";
import { findItem, formatInteractionText } from "../src/modules/components/interact";
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

  describe("components 키워드 — 폼·폼 둘·고르기·카드·재사용·짧게", () => {
    const KEYWORDS = ["폼", "폼 둘", "고르기", "카드", "재사용", "짧게"] as const;
    /** 대본이 낸 components 를 플러그인·서버와 같은 스키마로 파싱한다 — 어기면 여기서 던진다 */
    const cardOf = (text: string) =>
      ComponentsV1.parse(fakeAgentScript("dev", delivery(text, owner)).components);
    const fieldTypes = (text: string) => (cardOf(text).modal?.fields ?? []).map((f) => f.type);
    const actionItems = (text: string) =>
      cardOf(text).blocks.flatMap((b) => (b.type === "actions" ? b.items : []));

    it("키워드마다 ComponentsV1 을 통과하는 components 가 나오고, 키워드가 없으면 싣지 않는다", () => {
      for (const keyword of KEYWORDS) {
        const components = fakeAgentScript("dev", delivery(`@dev ${keyword}`, owner)).components;
        expect(components, keyword).toBeDefined();
        expect(ComponentsV1.safeParse(components).success, keyword).toBe(true);
      }
      expect(fakeAgentScript("dev", delivery("@dev 안녕", owner)).components).toBeUndefined();
      // 카드는 답(정본)에 실린다 — 받은 글을 되받는 모양은 그대로다
      expect(fakeAgentScript("dev", delivery("@dev 카드", owner)).reply).toContain("잘 받았어요");
    });

    it("폼 → 모달 필드 5개, 폼 둘 → 다른 모달 — 둘을 합치면 필드 7종이 다 나온다(모달 필드는 5개까지)", () => {
      expect(fieldTypes("@dev 폼")).toEqual(["text", "textarea", "number", "date", "select"]);
      expect(fieldTypes("@dev 폼 둘")).toEqual(["text", "checkbox", "radio"]);
      const all: Field["type"][] = ["text", "textarea", "number", "date", "select", "checkbox", "radio"];
      expect(new Set([...fieldTypes("@dev 폼"), ...fieldTypes("@dev 폼 둘")])).toEqual(new Set(all));
      // 화면 검사를 눈으로 보려면 필수와 기본값이 둘 다 있어야 한다
      for (const text of ["@dev 폼", "@dev 폼 둘"]) {
        const fields = cardOf(text).modal?.fields ?? [];
        expect(fields.some((f) => f.required)).toBe(true);
        expect(fields.some((f) => !f.required)).toBe(true);
        expect(fields.some((f) => f.default !== undefined)).toBe(true);
      }
      expect(cardOf("@dev 폼").modal?.id).not.toBe(cardOf("@dev 폼 둘").modal?.id);
    });

    it("고르기 → 셀렉트 단일 1개 + 다중(최소 2·최대 3) 1개, 다중은 최대보다 옵션이 많고 스크롤 상자가 넘칠 만큼 많다", () => {
      const selects = actionItems("@dev 고르기").filter((i) => i.type === "select");
      expect(selects.map((s) => [s.multi, s.minValues, s.maxValues])).toEqual([
        [false, undefined, undefined],
        [true, 2, 3],
      ]);
      expect(selects[1]?.options.length).toBeGreaterThan(3);
      // 옵션 6개 초과면 스크롤 상자(최대 224px), 한 줄 25px 꼴(c2-t9 실측 8개 = 200px, 안 넘침) — 12개면 약 300px 로 넉넉히 넘친다
      expect(selects[1]?.options.length).toBeGreaterThanOrEqual(12);
    });

    it("카드 → section·separator·actions(버튼 셋 + artifact 링크 버튼)·media(https + artifact)·file(https + artifact)", () => {
      const { blocks } = cardOf("@dev 카드");
      expect(new Set(blocks.map((b) => b.type))).toEqual(
        new Set(["section", "separator", "actions", "media", "file"]),
      );
      expect(actionItems("@dev 카드").map((i) => i.type)).toEqual(["button", "button", "button", "button"]);
      const scheme = (url: string) => url.slice(0, url.indexOf("://"));
      // `artifact://` 가 링크 버튼·media·file 셋에서 같은 문구인지 한 카드에서 보려면 셋 다 artifact 가 있어야 한다
      const linkUrls = actionItems("@dev 카드").flatMap((i) => (i.type === "button" && i.url ? [i.url] : []));
      expect(linkUrls.map(scheme)).toEqual(["artifact"]);
      const mediaUrls = blocks.flatMap((b) => (b.type === "media" ? b.items.map((i) => i.url) : []));
      expect(mediaUrls.map(scheme)).toEqual(["https", "artifact"]);
      const fileUrls = blocks.flatMap((b) => (b.type === "file" ? [b.url] : []));
      expect(fileUrls.map(scheme)).toEqual(["https", "artifact"]);
      // 브라우저 검증이 오프라인이어도 바깥 네트워크를 타지 않게 — https 는 이 기계만 가리킨다
      for (const url of [...mediaUrls, ...fileUrls].filter((u) => u.startsWith("https://"))) {
        expect(new URL(url).hostname).toBe("localhost");
      }
      // 그림이 안 떠도 대체 글로 확인할 수 있게 모든 그림에 alt 가 있다
      for (const b of blocks) if (b.type === "media") for (const i of b.items) expect(i.alt).toBeTruthy();
    });

    it("재사용 → reusable 버튼 + 모달 카드(결과 줄 상한과 모달 제출 뒤 초점을 한 카드에서 본다)", () => {
      expect(cardOf("@dev 재사용").reusable).toBe(true);
      expect(actionItems("@dev 재사용").every((i) => i.type === "button")).toBe(true);
      expect(actionItems("@dev 재사용").length).toBeGreaterThan(0);
      expect(cardOf("@dev 재사용").modal?.fields.length).toBeGreaterThan(0);
      for (const keyword of KEYWORDS.filter((k) => k !== "재사용")) {
        expect(cardOf(`@dev ${keyword}`).reusable, keyword).toBe(false);
      }
    });

    it("짧게 → TTL 20초 카드(버튼·셀렉트·모달이 함께 잠기는 것을 본다), 다른 키워드와 오면 그 카드의 TTL 만 줄인다", () => {
      const short = cardOf("@dev 짧게");
      // 기본 TTL 30분 대신 만료를 눈으로 볼 수 있게 줄였다(승인 대본의 TTL 을 줄인 것과 같은 까닭)
      expect(short.ttlMs).toBe(20_000);
      expect(new Set(actionItems("@dev 짧게").map((i) => i.type))).toEqual(new Set(["button", "select"]));
      expect(short.modal).toBeDefined();
      expect(cardOf("@dev 카드 짧게")).toEqual({ ...cardOf("@dev 카드"), ttlMs: 20_000 });
      for (const keyword of KEYWORDS.filter((k) => k !== "짧게")) {
        expect(cardOf(`@dev ${keyword}`).ttlMs, keyword).toBe(1_800_000);
      }
    });

    it("카드를 누른 상호작용 글(라벨·옵션·제목이 실린다)에는 키워드가 없어 카드·승인을 다시 내지 않는다", () => {
      for (const keyword of KEYWORDS) {
        const components = { ...cardOf(`@dev ${keyword}`), id: "cmp_x" };
        const items = [
          ...components.blocks.flatMap((b) => (b.type === "actions" ? b.items : [])),
          ...(components.modal ? [components.modal] : []),
        ];
        for (const item of items) {
          const found = findItem(components, item.id);
          if (!found) throw new Error(`${keyword}: ${item.id} 를 못 찾는다`);
          const values =
            found.kind === "select"
              ? { values: found.item.options.map((o) => o.value) }
              : found.kind === "modal"
                ? { fields: Object.fromEntries(found.item.fields.map((f) => [f.id, sampleValue(f)])) }
                : {};
          const text = formatInteractionText({ userHandle: "owner", components, found, values });
          const next = fakeAgentScript("dev", delivery(text, owner));
          expect(next.components, `${keyword} → ${item.id}`).toBeUndefined();
          expect(next.approval, `${keyword} → ${item.id}`).toBeUndefined();
          expect(next.fail ?? next.drop ?? next.tool, `${keyword} → ${item.id}`).toBeUndefined();
        }
      }
    });
  });
});

/** 상호작용 글을 만들 때 필드마다 넣는 값 — 옵션 필드는 라벨이 글에 실리게 옵션 값을 고른다 */
function sampleValue(f: Field): unknown {
  switch (f.type) {
    case "select":
      return f.options.map((o) => o.value);
    case "radio":
      return f.options[0]?.value;
    case "checkbox":
      return true;
    case "number":
      return f.min ?? 1;
    case "date":
      return "2026-10-01";
    default:
      return "메모";
  }
}

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

  it("「카드 짧게」 → 플러그인·서버를 지나 블록 다섯 종이 든 카드가 저장되고, 만료는 20초 뒤다", async () => {
    const channelId = await channelWith("cards", ["dev"]);
    const devId = await agentId("dev");
    const socket = await openWire(channelId);
    const card = new Promise<Message>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent" && message.components) resolve(message);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c3",
      bodyMd: `<@a:${devId}> 카드 짧게`,
    });
    expect(sent.ok).toBe(true);
    const message = await card;
    expect(message.components?.id).toMatch(/^cmp_/);
    expect(message.components?.ttlMs).toBe(20_000);
    expect(new Set(message.components?.blocks.map((b) => b.type))).toEqual(
      new Set(["section", "separator", "actions", "media", "file"]),
    );
    const ttl = Date.parse(message.componentState?.expiresAt ?? "") - Date.parse(message.createdAt);
    expect(ttl).toBeGreaterThan(19_000);
    expect(ttl).toBeLessThanOrEqual(20_000);
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
