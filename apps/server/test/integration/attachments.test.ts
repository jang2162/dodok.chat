/**
 * 첨부 스펙 8.1 — 통합 시나리오 11a~11i(가짜 Gateway·플러그인, 실제 시계). 11j·11k 는 파일함 스펙 10장(사람의 일반 파일·파일 목록).
 * 사람 업로드는 REST(`POST /api/v1/attachments`), 에이전트 업로드·받기는 가짜 플러그인의 브리지 HTTP 로 한다.
 */
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  BRIDGE_ATTACHMENT_HEADERS,
  type Channel,
  type FileList,
  type Message,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachments, channels, runEvents, workspaces } from "../../src/db/schema.sqlite";
import {
  type AttachmentDeps,
  sweepAttachments,
  uploadAttachment,
} from "../../src/modules/attachments/service";
import { blobPath, sha256Of } from "../../src/modules/attachments/store";
import { createAgentMessage } from "../../src/modules/messages/service";
import { prepareInboundMedia } from "../../../../packages/openclaw-plugin/src/inbound-media";
import { createScenario } from "../fakes/scenario";
import { userWithRole } from "../helpers/app";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import { HTML_BYTES, makePng, PDF_BYTES, SVG_BYTES } from "../helpers/png";
import {
  openChannelWire,
  rest,
  sendMessage,
  setupRelayChannel,
  uploadImage,
} from "../helpers/scenario-steps";
import { connectWire, type WireClient } from "../helpers/wire";
import { channelConversation, seedConversation, sendTarget } from "../helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };

describe("통합 시나리오 11 — 첨부", () => {
  const sockets: WireClient[] = [];
  let live: LiveApp | undefined;

  async function boot(opts: LiveAppOptions = {}): Promise<LiveApp> {
    live = await bootLiveApp(opts);
    return live;
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live?.close();
    live = undefined;
  });

  const depsOf = (l: LiveApp): AttachmentDeps => ({
    db: l.app.db,
    dir: join(l.dir, "attachments"),
    locks: l.app.blobLocks,
  });

  /** 사람 업로드를 날것으로 — 상태 코드를 잴 때 */
  const rawUpload = (l: LiveApp, channelId: string, payload: Buffer, contentType = "image/png") =>
    l.app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${channelId}`,
      headers: { ...l.auth.headers, "content-type": contentType },
      payload,
    });

  const humanGet = (l: LiveApp, id: string) =>
    l.app.fastify.inject({ method: "GET", url: `/api/v1/attachments/${id}`, headers: l.auth.headers });

  /** 가짜 플러그인이 받은 인바운드 중 조건에 맞는 첫 것 */
  const inbound = (l: LiveApp, pick: (d: LiveApp["plugin"]["received"][number]) => boolean) =>
    vi.waitFor(
      () => {
        const d = l.plugin.received.find(pick);
        if (!d) throw new Error("no inbound yet");
        return d;
      },
      { timeout: 5_000 },
    );

  /** 그 채널의 열린 세션(테스트는 채널마다 세션 하나) 타임라인 — 채널 경로 목록은 걷었다(채널 세션 계획 판정 PS5) */
  const channelMessages = async (l: LiveApp, channelId: string) =>
    (
      await rest<{ messages: Message[] }>(
        l,
        "GET",
        `/conversations/${channelConversation(l.app.db, channelId)}/messages`,
      )
    ).body.messages;

  it("11a 사람 이미지 → message.created 에 artifact:// 첨부, 인바운드에 같은 것, 브리지 받기가 같은 바이트", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    // 런을 열어 둔다 — 브리지는 열린 런의 트리거 첨부만 받는다(멀티 Gateway 스펙 「브리지 첨부 범위」 절). 실제 플러그인은 ack 전에 받는다
    createScenario({
      gateway: l.gateway,
      plugin: l.plugin,
      agents: { dev: () => ({ reply: "봤어요", holdFinal: true }) },
    });
    const png = makePng(8, 6);
    const att = await uploadImage(l, setup.channel.id, png, "스샷.png");
    expect(att).toMatchObject({ kind: "image", url: `artifact://${att.id}`, width: 8, height: 6 });

    await sendMessage(log.socket, setup.channel.id, "@dev 이거 봐", { attachments: [att.id] });
    const mine = await log.until(() => log.created.find((m) => m.authorType === "user"), "사람 메시지");
    expect(mine.attachments).toEqual([att]);

    const delivered = await inbound(l, (d) => d.message.id === mine.id);
    expect(delivered.message.attachments).toEqual([att]);
    const got = await l.plugin.downloadAttachment(att.id);
    expect(got.status).toBe(200);
    expect(got.bytes.equals(png)).toBe(true);
  });

  it("11a′ [Review Focus 3] 본문 없는 이미지 메시지도 에이전트 인바운드까지 — text 는 빈 문자열, 이미지 하나", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    // 멘션 없이도 받도록 dev 를 자동 응답으로 — 빈 본문에는 멘션이 있을 수 없다
    const patched = await rest(l, "PATCH", `/channels/${setup.channel.id}/members/${setup.dev.id}`, {
      autoRespond: true,
    });
    expect(patched.status).toBe(200);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    createScenario({
      gateway: l.gateway,
      plugin: l.plugin,
      agents: { dev: () => ({ reply: "이미지네요" }) },
    });
    const att = await uploadImage(l, setup.channel.id, makePng(3, 2), "a.png");

    const sent = await sendMessage(log.socket, setup.channel.id, "", { attachments: [att.id] });
    expect(sent).toMatchObject({ bodyMd: "", attachments: [att] });
    const delivered = await inbound(l, (d) => d.message.id === sent.id);
    expect(delivered.message.text).toBe("");
    expect(delivered.message.attachments).toEqual([att]);
    await log.until(() => log.created.find((m) => m.authorType === "agent"), "에이전트 답");
  });

  it("11b 권한 — 남의 미묶음·다른 채널·없는 id 로 보내기는 거부, 다른 워크스페이스 채널의 첨부 GET 은 404", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    const otherChannel = (await rest<{ channel: Channel }>(l, "POST", "/channels", { name: "other" })).body
      .channel;
    const theirs = await uploadAttachment(depsOf(l), {
      channelId: setup.channel.id,
      uploader: { type: "user", userId: uuid() },
      bytes: makePng(2, 2),
    });
    const elsewhere = await uploadImage(l, otherChannel.id, makePng(2, 3), "b.png");

    for (const id of [theirs.id, elsewhere.id, uuid()]) {
      const res = await log.socket.emitWithAck("message.send", {
        channelId: setup.channel.id,
        ...sendTarget(l.app.db, setup.channel.id),
        clientMsgId: uuid(),
        bodyMd: "x",
        attachments: [id],
      });
      expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(await channelMessages(l, setup.channel.id)).toEqual([]);

    // 다른 워크스페이스 채널 메시지에 묶인 첨부 — 이 사람은 그 채널의 멤버가 아니다
    const ws = uuid();
    l.app.db.insert(workspaces).values({ id: ws, name: "other", createdAt: new Date() }).run();
    const foreignChannel = uuid();
    l.app.db
      .insert(channels)
      .values({
        id: foreignChannel,
        workspaceId: ws,
        name: "foreign",
        relayPolicy: RELAY_POLICY,
        visibility: "public",
        createdBy: l.app.ownerUserId,
        createdAt: new Date(),
      })
      .run();
    seedConversation(l.app.db, foreignChannel, { createdBy: l.app.ownerUserId, createdAt: new Date() });
    const foreign = await uploadAttachment(depsOf(l), {
      channelId: foreignChannel,
      uploader: { type: "bridge", runnerTokenId: "runner-token-1" },
      bytes: makePng(4, 4),
    });
    const bound = createAgentMessage(l.app.db, l.app.bus, {
      conversationId: channelConversation(l.app.db, foreignChannel),
      agentId: setup.dev.id,
      externalId: uuid(),
      bodyMd: "",
      attachmentIds: [foreign.id],
      uploadedBy: { runnerTokenId: "runner-token-1" },
    });
    expect(bound.attachments).toEqual([foreign]);
    const got = await humanGet(l, foreign.id);
    expect(got.statusCode).toBe(404);
    expect(got.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("11c 브리지로 사람의 미묶음 첨부를 받으면 404, 토큰이 틀리면 401", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const att = await uploadImage(l, setup.channel.id, makePng(2, 2), "a.png");
    expect((await l.plugin.downloadAttachment(att.id)).status).toBe(404);
    expect((await l.plugin.downloadAttachment(att.id, { token: "wrong" })).status).toBe(401);
  });

  it("11d 판별 — image/png 라고 한 HTML·SVG 는 브리지·사람 모두 file, 5 MiB 넘는 이미지는 400(maxBytes 5 MiB)", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    for (const bytes of [HTML_BYTES, SVG_BYTES]) {
      const viaBridge = await l.plugin.uploadAttachment({
        conversationId: channelConversation(l.app.db, setup.channel.id),
        bytes,
        name: "x.png",
        mime: "image/png",
      });
      expect(viaBridge.kind).toBe("file");
      expect(viaBridge.mime).not.toMatch(/^image\//);
      const human = await rawUpload(l, setup.channel.id, bytes);
      expect(human.statusCode).toBe(200);
      expect(human.json()).toMatchObject({ kind: "file", mime: "application/octet-stream" });
    }
    const big = Buffer.concat([makePng(1, 1), Buffer.alloc(ATTACHMENT_LIMITS.userImageMaxBytes)]);
    const tooBig = await rawUpload(l, setup.channel.id, big);
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json()).toMatchObject({
      code: "VALIDATION",
      details: { maxBytes: ATTACHMENT_LIMITS.userImageMaxBytes },
    });
  });

  it("11e 에이전트 — 올린 파일 둘을 attachmentIds 순서대로 묶고, 다른 채널 id 는 그것만 뺀다", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const otherChannel = (await rest<{ channel: Channel }>(l, "POST", "/channels", { name: "other" })).body
      .channel;
    const log = await openChannelWire(l, setup.channel.id, sockets);
    const second = await l.plugin.uploadAttachment({
      conversationId: channelConversation(l.app.db, setup.channel.id),
      bytes: PDF_BYTES,
      name: "2.pdf",
    });
    const stray = await l.plugin.uploadAttachment({
      conversationId: channelConversation(l.app.db, otherChannel.id),
      bytes: PDF_BYTES,
      name: "x.pdf",
    });
    const first = await l.plugin.uploadAttachment({
      conversationId: channelConversation(l.app.db, setup.channel.id),
      bytes: makePng(5, 5),
      name: "1.png",
    });
    createScenario({
      gateway: l.gateway,
      plugin: l.plugin,
      agents: { dev: () => ({ reply: "파일 둘", attachmentIds: [second.id, stray.id, first.id] }) },
    });

    await sendMessage(log.socket, setup.channel.id, "@dev 파일 줘");
    const reply = await log.until(() => log.created.find((m) => m.authorType === "agent"), "에이전트 답");
    expect(reply.attachments).toEqual([second, first]);
    // 빠진 것은 여전히 미묶음이다
    const strayRow = l.app.db.select().from(attachments).where(eq(attachments.id, stray.id)).get();
    expect(strayRow?.messageId).toBeNull();
    // 묶인 뒤에는 브리지도 받을 수 있다
    expect((await l.plugin.downloadAttachment(second.id)).bytes.equals(PDF_BYTES)).toBe(true);
  });

  it("11f 텍스트 없이 첨부만 있는 outbound.message 가 저장된다", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    const png = makePng(7, 3);
    createScenario({
      gateway: l.gateway,
      plugin: l.plugin,
      agents: {
        dev: () => ({ reply: "", attachments: [{ name: "chart.png", mime: "image/png", bytes: png }] }),
      },
    });

    await sendMessage(log.socket, setup.channel.id, "@dev 차트");
    const reply = await log.until(() => log.created.find((m) => m.authorType === "agent"), "에이전트 답");
    expect(reply.bodyMd).toBe("");
    expect(reply.attachments).toEqual([
      expect.objectContaining({ kind: "image", name: "chart.png", width: 7, height: 3 }),
    ]);
    const run = await log.terminal(reply.runId ?? "");
    expect(run).toMatchObject({ status: "done", finalSource: "plugin" });
    expect((await humanGet(l, reply.attachments[0]?.id ?? "")).statusCode).toBe(200);
  });

  describe("11g 폴백 — 정본 없이 WS 스냅샷만(finalizing 상한을 줄여 실제 시계로)", () => {
    // 줄당 연장(Ruling 2)도 줄여 잰다 — 1줄이면 300 + 700 = 1000ms. 연장 없음(300ms)과 여유를 넓게 둬
    // 부하에서 finalizing 진입 관측이 늦어도 하한(700)이 깨지지 않게 한다(a3-t4 리뷰 L1)
    const timeouts = { finalizingMs: 300, finalizingMediaLineMs: 700, finalizingMaxMs: 2_000 };

    it("「결과\\n\\nMEDIA:/Users/x/a.png」 → 저장 본문은 「결과」, 상한은 MEDIA 줄만큼 늘었다", async () => {
      const l = await boot({ timeouts });
      const setup = await setupRelayChannel(l, RELAY_POLICY);
      const log = await openChannelWire(l, setup.channel.id, sockets);
      createScenario({
        gateway: l.gateway,
        plugin: l.plugin,
        agents: { dev: () => ({ reply: "결과\n\nMEDIA:/Users/x/a.png", withholdCanonical: true }) },
      });

      await sendMessage(log.socket, setup.channel.id, "@dev 그려 줘");
      const finalizing = await log.until(
        () => log.states.find((s) => s.status === "finalizing"),
        "finalizing",
      );
      const enteredAt = Date.now();
      const final = await log.terminal(finalizing.id);
      expect(Date.now() - enteredAt).toBeGreaterThanOrEqual(700);
      expect(final).toMatchObject({ status: "done", finalSource: "gateway" });
      const agentMessages = (await channelMessages(l, setup.channel.id)).filter(
        (m) => m.authorType === "agent",
      );
      expect(agentMessages.map((m) => m.bodyMd)).toEqual(["결과"]);
      expect(JSON.stringify(agentMessages)).not.toContain("/Users/x");
    });

    it("스냅샷이 MEDIA: 줄뿐이면 메시지를 만들지 않는다", async () => {
      const l = await boot({ timeouts });
      const setup = await setupRelayChannel(l, RELAY_POLICY);
      const log = await openChannelWire(l, setup.channel.id, sockets);
      createScenario({
        gateway: l.gateway,
        plugin: l.plugin,
        agents: { dev: () => ({ reply: "MEDIA:/Users/x/a.png", withholdCanonical: true }) },
      });

      await sendMessage(log.socket, setup.channel.id, "@dev 그려 줘");
      const run = await log.until(() => log.states.find((s) => s.agentId === setup.dev.id), "dev 런");
      expect(await log.terminal(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
      expect((await channelMessages(l, setup.channel.id)).filter((m) => m.authorType === "agent")).toEqual(
        [],
      );
    });
  });

  describe("11j 스트리밍 델타의 MEDIA: 줄(결함 A) — wire 에도 run_events 에도 경로가 없다", () => {
    // 실연 런 ② 모양 — 경로가 델타 셋으로 쪼개진다. 조각 사이를 코얼레싱 창(50ms)보다 벌려 조각마다 따로 저장되게 한다
    const deltas = ["끝났어요.\n\n", "MEDIA:/Users/someone", "/.openclaw-d", "ev/workspace/hello.txt"];
    const storedEvents = (l: LiveApp, runId: string) =>
      l.app.db.select().from(runEvents).where(eq(runEvents.runId, runId)).all();
    const streamedText = (events: { type: string }[]) =>
      events
        .filter(
          (e): e is { type: "TEXT_MESSAGE_CONTENT"; delta: string } => e.type === "TEXT_MESSAGE_CONTENT",
        )
        .map((e) => e.delta)
        .join("");

    it("정본 경로 — 스트리밍 텍스트는 「끝났어요.」 만, 정본은 지금처럼", async () => {
      const l = await boot();
      const setup = await setupRelayChannel(l, RELAY_POLICY);
      const log = await openChannelWire(l, setup.channel.id, sockets);
      createScenario({
        gateway: l.gateway,
        plugin: l.plugin,
        agents: { dev: () => ({ deltas, deltaDelayMs: 60, reply: "끝났어요." }) },
      });

      await sendMessage(log.socket, setup.channel.id, "@dev 파일 써 줘");
      const reply = await log.until(() => log.created.find((m) => m.authorType === "agent"), "에이전트 답");
      const runId = reply.runId ?? "";
      expect(await log.terminal(runId)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(reply.bodyMd).toBe("끝났어요.");
      expect(streamedText(log.eventsOf(runId))).toBe("끝났어요.\n\n");
      expect(JSON.stringify(log.events)).not.toContain("/Users/");
      const stored = storedEvents(l, runId);
      expect(stored.some((e) => e.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
      expect(JSON.stringify(stored)).not.toContain("/Users/");
    });

    it("폴백 경로 — 정본 없이 스냅샷으로 끝나도 델타·저장 본문 어디에도 경로가 없다", async () => {
      const l = await boot({ timeouts: { finalizingMs: 300, finalizingMediaLineMs: 0 } });
      const setup = await setupRelayChannel(l, RELAY_POLICY);
      const log = await openChannelWire(l, setup.channel.id, sockets);
      createScenario({
        gateway: l.gateway,
        plugin: l.plugin,
        agents: {
          dev: () => ({ deltas, deltaDelayMs: 60, reply: deltas.join(""), withholdCanonical: true }),
        },
      });

      await sendMessage(log.socket, setup.channel.id, "@dev 파일 써 줘");
      const run = await log.until(() => log.states.find((s) => s.agentId === setup.dev.id), "dev 런");
      expect(await log.terminal(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
      const agentMessages = (await channelMessages(l, setup.channel.id)).filter(
        (m) => m.authorType === "agent",
      );
      expect(agentMessages.map((m) => m.bodyMd)).toEqual(["끝났어요."]);
      expect(streamedText(log.eventsOf(run.id))).toBe("끝났어요.\n\n");
      expect(JSON.stringify(log.events)).not.toContain("/Users/");
      expect(JSON.stringify(storedEvents(l, run.id))).not.toContain("/Users/");
    });
  });

  it("11h 정리 — 25시간 지난 미묶음 행과 블롭은 지우고, 같은 sha256 을 묶인 행이 쓰면 블롭은 남는다", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    const deps = depsOf(l);
    const lonelyPng = makePng(9, 1);
    const sharedPng = makePng(1, 9);
    const lonely = await uploadImage(l, setup.channel.id, lonelyPng, "lonely.png");
    const staleTwin = await uploadImage(l, setup.channel.id, sharedPng, "twin.png");
    const kept = await uploadImage(l, setup.channel.id, sharedPng, "kept.png");
    await sendMessage(log.socket, setup.channel.id, "묶는다", { attachments: [kept.id] });
    const dayAgo = new Date(Date.now() - 25 * 3600_000);
    for (const id of [lonely.id, staleTwin.id]) {
      l.app.db.update(attachments).set({ createdAt: dayAgo }).where(eq(attachments.id, id)).run();
    }

    expect(await sweepAttachments(deps)).toEqual({ rows: 2, blobs: 1 });
    const ids = l.app.db
      .select({ id: attachments.id })
      .from(attachments)
      .all()
      .map((r) => r.id);
    expect(ids).toEqual([kept.id]);
    expect(existsSync(blobPath(deps.dir, sha256Of(lonelyPng)))).toBe(false);
    expect(existsSync(blobPath(deps.dir, sha256Of(sharedPng)))).toBe(true);
    const got = await humanGet(l, kept.id);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(sharedPng)).toBe(true);
  });

  it("11i 문맥 — 이전 메시지 줄에 [이미지 1장] 이 있고 경로·URL 이 없다", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    createScenario({ gateway: l.gateway, plugin: l.plugin, agents: { dev: () => ({ reply: "네" }) } });
    const att: Attachment = await uploadImage(l, setup.channel.id, makePng(4, 4), "화면.png");
    await sendMessage(log.socket, setup.channel.id, "이거 먼저 올려 둘게요", { attachments: [att.id] });

    const trigger = await sendMessage(log.socket, setup.channel.id, "@dev 위 이미지 봤어?");
    const delivered = await inbound(l, (d) => d.message.id === trigger.id);
    expect(delivered.context.recentMessages.map((m) => m.text)).toEqual([
      "이거 먼저 올려 둘게요\n[이미지 1장]",
    ]);
    const texts = JSON.stringify([delivered.message.text, delivered.context]);
    expect(texts).not.toContain("artifact://");
    expect(texts).not.toContain(att.id);
    expect(texts).not.toContain(l.dir);
    await log.until(() => log.created.find((m) => m.authorType === "agent"), "에이전트 답");
  });

  /** 그 사람(Bearer)으로 첨부를 날것으로 올린다 — 이름은 헤더, 형식 힌트는 content-type */
  const uploadAs = async (
    l: LiveApp,
    headers: Record<string, string>,
    channelId: string,
    payload: Buffer,
    name: string,
    contentType: string,
  ): Promise<Attachment> => {
    const res = await l.app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${channelId}`,
      headers: {
        ...headers,
        "content-type": contentType,
        [BRIDGE_ATTACHMENT_HEADERS.fileName]: encodeURIComponent(name),
      },
      payload,
    });
    if (res.statusCode !== 200) throw new Error(`upload → ${res.statusCode} ${res.body}`);
    return res.json() as Attachment;
  };

  const filesAs = (l: LiveApp, headers: Record<string, string>, query = "") =>
    l.app.fastify.inject({ method: "GET", url: `/api/v1/attachments${query}`, headers });

  it("11j 파일함 — mia 의 채널 PDF 는 owner 의 채널 목록·내려받기·에이전트 이름 줄까지, mia 의 에이전트 DM 사진은 owner 어디에도 없다", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    expect((await rest(l, "PATCH", `/agents/${setup.dev.id}`, { dmAccess: "everyone" })).status).toBe(200);
    createScenario({ gateway: l.gateway, plugin: l.plugin, agents: { dev: () => ({ reply: "받았어요" }) } });
    const mia = await userWithRole(l.app, "mia", "member");
    const miaHeaders = { authorization: `Bearer ${mia.token}` };
    const socket = await connectWire(l.app, mia.token);
    sockets.push(socket);

    // mia 가 일반 채널에 PDF 를 올려 dev 에게 보낸다
    const pdf = await uploadAs(l, miaHeaders, setup.channel.id, PDF_BYTES, "보고서.pdf", "application/pdf");
    expect(pdf).toMatchObject({ kind: "file", mime: "application/pdf", name: "보고서.pdf" });
    const sent = await sendMessage(socket, setup.channel.id, "@dev 보고서 봐 주세요", {
      attachments: [pdf.id],
    });

    // 에이전트 쪽 — deliver 에 그 첨부, 플러그인은 받기 없이 이름 한 줄로 알린다
    const delivered = await inbound(l, (d) => d.message.id === sent.id);
    expect(delivered.message.attachments).toEqual([pdf]);
    const download = vi.fn(async () => ({ bytes: Buffer.alloc(0), mime: "application/pdf" }));
    const save = vi.fn(async () => ({ path: "/nowhere" }));
    const media = await prepareInboundMedia(delivered.message.attachments, { download, save });
    expect(media.notes).toEqual(["[첨부 파일: 보고서.pdf]"]);
    expect(media.facts).toEqual([]);
    expect(download).not.toHaveBeenCalled();

    // owner 의 채널 파일함 — 그 항목, 내려받기 바이트가 같다
    const listed = await filesAs(l, l.auth.headers, `?channelId=${setup.channel.id}`);
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as FileList).items;
    expect(items.map((i) => [i.attachment.id, i.messageId, i.authorType, i.authorId])).toEqual([
      [pdf.id, sent.id, "user", mia.id],
    ]);
    const got = await l.app.fastify.inject({
      method: "GET",
      url: `/api/v1/attachments/${pdf.id}?download=1`,
      headers: l.auth.headers,
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-disposition"]).toMatch(/^attachment/);
    expect(got.rawPayload.equals(PDF_BYTES)).toBe(true);

    // mia 의 에이전트 DM 에 사진 — mia 에게는 보이고 owner 에게는 전체 목록·채널 거름 어디에도 없다
    const miaDm = await l.app.fastify.inject({
      method: "POST",
      url: "/api/v1/dms",
      headers: miaHeaders,
      payload: { agentId: setup.dev.id },
    });
    expect(miaDm.statusCode).toBe(200);
    const dmId = (miaDm.json() as { channel: Channel }).channel.id;
    const photo = await uploadAs(l, miaHeaders, dmId, makePng(5, 5), "DM 사진.png", "image/png");
    const dmSent = await socket.emitWithAck("message.send", {
      channelId: dmId,
      newConversation: {},
      clientMsgId: randomUUID(),
      bodyMd: "이건 나만",
      attachments: [photo.id],
    });
    expect(dmSent.ok).toBe(true);
    const miaAll = (await filesAs(l, miaHeaders)).json() as FileList;
    expect(miaAll.items.map((i) => i.attachment.id)).toEqual([photo.id, pdf.id]);
    const ownerAll = await filesAs(l, l.auth.headers);
    expect(ownerAll.statusCode).toBe(200);
    expect((ownerAll.json() as FileList).items.map((i) => i.attachment.id)).toEqual([pdf.id]);
    const ownerDm = await filesAs(l, l.auth.headers, `?channelId=${dmId}`);
    expect(ownerDm.statusCode).toBe(404);
    expect(ownerDm.json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await humanGet(l, photo.id)).statusCode).toBe(404);
  });

  it("11k 사람이 힌트 image/svg+xml·text/html 로 올린 SVG·HTML — GET 은 ?download=1 있음·없음 모두 octet-stream·attachment·sandbox CSP·nosniff", async () => {
    const l = await boot();
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const cases = [
      { bytes: SVG_BYTES, name: "logo.svg", hint: "image/svg+xml" },
      { bytes: HTML_BYTES, name: "page.html", hint: "text/html" },
    ];
    for (const c of cases) {
      const att = await uploadAs(l, l.auth.headers, setup.channel.id, c.bytes, c.name, c.hint);
      expect(att, c.name).toMatchObject({ kind: "file", mime: "application/octet-stream" });
      for (const query of ["", "?download=1"]) {
        const res = await l.app.fastify.inject({
          method: "GET",
          url: `/api/v1/attachments/${att.id}${query}`,
          headers: l.auth.headers,
        });
        const label = `${c.name}${query}`;
        expect(res.statusCode, label).toBe(200);
        expect(res.headers["content-type"], label).toBe("application/octet-stream");
        expect(res.headers["content-disposition"], label).toMatch(/^attachment/);
        expect(res.headers["content-security-policy"], label).toBe("default-src 'none'; sandbox");
        expect(res.headers["x-content-type-options"], label).toBe("nosniff");
        expect(res.rawPayload.equals(c.bytes), label).toBe(true);
      }
    }
  });
});
