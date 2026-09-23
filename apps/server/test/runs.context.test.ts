import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Attachment, InboundDeliver, type Run } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid, version } from "uuid";
import { describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "../src/db/client";
import { agents, attachments, componentInteractions } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { toAttachment } from "../src/modules/attachments/service";
import { addMember, updateAgentMember, updateChannel } from "../src/modules/channels/service";
import { createAgentMessage, createSystemMessage, createUserMessage } from "../src/modules/messages/service";
import { type InboundTrigger, attachmentPlaceholder, buildInboundDeliver } from "../src/modules/runs/context";
import { ensureSession } from "../src/modules/sessions/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

/** 서술 속 @핸들도 릴레이가 된다(live-smoke 5.4-5) — 부를 때만 @ 를 쓰게 한다 */
const rule = (turns: number) =>
  `다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 ${turns}턴). 언급만 할 때는 @ 없이 이름만 쓰세요.`;

/** 첨부 행을 바로 넣는다 — 블롭 없이 묶기·문맥만 볼 때 */
function insertAttachment(
  db: DbOrTx,
  opts: {
    channelId: string;
    uploaderType?: "user" | "bridge";
    uploaderId?: string;
    kind?: "image" | "file";
    name?: string;
  },
): Attachment {
  const file = opts.kind === "file";
  const row = db
    .insert(attachments)
    .values({
      id: uuid(),
      channelId: opts.channelId,
      uploaderType: opts.uploaderType ?? "user",
      uploaderId: opts.uploaderType === "bridge" ? null : (opts.uploaderId ?? null),
      kind: opts.kind ?? "image",
      name: opts.name ?? "a.png",
      mime: file ? "application/pdf" : "image/png",
      size: 10,
      width: file ? null : 4,
      height: file ? null : 3,
      sha256: "0".repeat(64),
      messageId: null,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return toAttachment(row);
}

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const adapter = new FakeAdapter();
  const logger = { warn: vi.fn() };
  const { workspaceId, userId, agentId: devId, channelId } = seedChannelWithAgent(db);
  // providerAgentId·name 을 handle 과 다르게 두어 각 필드의 출처를 가른다
  db.update(agents).set({ providerAgentId: "dev-main", name: "Dev" }).where(eq(agents.id, devId)).run();
  const fin = createAgent(db, { workspaceId, providerAgentId: "fin", handle: "fin", name: "Fin" });
  addMember(db, channelId, { memberType: "agent", memberId: fin.id }, logger);

  let n = 0;
  const say = (bodyMd: string) =>
    createUserMessage(db, bus, { channelId, authorId: userId, bodyMd, clientMsgId: `c${++n}` });
  const agentSays = (agentId: string, bodyMd: string) =>
    createAgentMessage(db, bus, { channelId, agentId, externalId: `o${++n}`, bodyMd });

  const deliver = (
    trigger: InboundTrigger,
    opts: { run?: Partial<Run>; needsPromptContext?: boolean; now?: Date } = {},
  ) => {
    const agentId = opts.run?.agentId ?? devId;
    const { session } = ensureSession(db, adapter, { channelId, agentId });
    const run: Run = {
      id: uuid(),
      channelId,
      agentId,
      triggerKind: "mention",
      triggerMessageId: trigger.message?.id,
      rootMessageId: trigger.message?.id ?? uuid(),
      relayDepth: 0,
      sessionKey: session.sessionKey,
      status: "queued",
      hasCanonical: false,
      createdAt: new Date().toISOString(),
      ...opts.run,
    };
    const inbound = buildInboundDeliver(db, {
      run,
      trigger,
      session,
      needsPromptContext: opts.needsPromptContext ?? false,
      now: opts.now,
    });
    return { inbound, run, session };
  };

  const interactionOn = (messageId: string, componentId: string) => {
    const id = uuid();
    db.insert(componentInteractions)
      .values({ id, messageId, componentId, userId, itemId: "ok", values: {}, createdAt: new Date() })
      .run();
    return id;
  };

  return {
    db,
    bus,
    logger,
    workspaceId,
    userId,
    devId,
    finId: fin.id,
    channelId,
    say,
    agentSays,
    deliver,
    interactionOn,
  };
}

describe("buildInboundDeliver", () => {
  it("메시지 트리거: 봉투 필드와 message 를 채우고 InboundDeliver 계약을 통과한다", () => {
    const { channelId, devId, finId, say, agentSays, deliver } = setup();
    const trigger = say("@dev @fin 안녕 @nobody");
    const { inbound, run } = deliver({ message: trigger });

    expect(InboundDeliver.safeParse(inbound).success).toBe(true);
    expect(version(inbound.deliveryId)).toBe(7);
    expect(inbound).toEqual({
      deliveryId: inbound.deliveryId,
      kind: "message",
      channelId,
      agentId: "dev-main",
      sessionKey: `agent:dev-main:dodok:channel:${channelId}`,
      runId: run.id,
      message: {
        id: trigger.id,
        author: { type: "user", handle: "owner", displayName: "owner" },
        text: "@dev @fin 안녕 @nobody",
        attachments: [],
        ts: trigger.createdAt,
      },
      context: {
        recentMessages: [],
        participants: expect.any(Array),
        relayRules: rule(4),
      },
      options: {},
    });
    expect(deliver({ message: trigger }).inbound.deliveryId).not.toBe(inbound.deliveryId);

    // 에이전트가 쓴 메시지로 다른 에이전트 런(릴레이)
    const relay = agentSays(devId, "@fin 넘겨요");
    const { inbound: toFin } = deliver({ message: relay }, { run: { agentId: finId, triggerKind: "relay" } });
    expect(InboundDeliver.safeParse(toFin).success).toBe(true);
    expect(toFin).toMatchObject({
      kind: "message",
      agentId: "fin",
      sessionKey: `agent:fin:dodok:channel:${channelId}`,
      message: {
        id: relay.id,
        author: { type: "agent", handle: "dev", displayName: "Dev" },
        text: "@fin 넘겨요",
      },
    });
  });

  it("recentMessages 는 트리거 이전 normal 메시지 최근 20개 — 시스템·트리거·이후 메시지 제외, 오름차순, renderForAgent", () => {
    const { db, bus, channelId, devId, say, agentSays, deliver } = setup();
    for (let i = 1; i <= 20; i++) say(`m${i}`);
    createSystemMessage(db, bus, { channelId, kind: "info", bodyMd: "시스템 안내" });
    const fromDev = agentSays(devId, "@fin @owner 확인해 줘");
    const last = say("@dev 한 줄 더");
    const trigger = say("@dev 요약해");
    say("트리거 뒤");

    const { inbound } = deliver({ message: trigger });
    const recent = inbound.context.recentMessages;
    expect(InboundDeliver.safeParse(inbound).success).toBe(true);
    expect(recent).toHaveLength(20);
    expect(recent.map((m) => m.text)).toEqual([
      ...Array.from({ length: 18 }, (_, i) => `m${i + 3}`),
      "@fin @owner 확인해 줘",
      "@dev 한 줄 더",
    ]);
    expect(recent[0]?.author).toEqual({ type: "user", handle: "owner", displayName: "owner" });
    expect(recent[18]).toEqual({
      author: { type: "agent", handle: "dev", displayName: "Dev" },
      text: "@fin @owner 확인해 줘",
      ts: fromDev.createdAt,
    });
    expect(recent[19]?.ts).toBe(last.createdAt);
  });

  describe("첨부(스펙 4.5)", () => {
    it("트리거 메시지의 첨부는 message.attachments 에 그대로 — 사람 이미지도, 릴레이된 에이전트 이미지도", () => {
      const { db, bus, channelId, userId, devId, finId, deliver } = setup();
      const img = insertAttachment(db, { channelId, uploaderId: userId });
      const mine = createUserMessage(db, bus, {
        channelId,
        authorId: userId,
        bodyMd: "",
        clientMsgId: "img",
        attachments: [img.id],
      });
      const { inbound } = deliver({ message: mine });
      expect(InboundDeliver.safeParse(inbound).success).toBe(true);
      // [Review Focus 3] 본문이 비어도 이미지는 실린다 — 트리거 텍스트에 자리표시를 붙이지 않는다(플러그인 몫, 스펙 5.1-4)
      expect(inbound.message).toMatchObject({ text: "", attachments: [img] });

      const chart = insertAttachment(db, { channelId, uploaderType: "bridge", name: "chart.png" });
      const relay = createAgentMessage(db, bus, {
        channelId,
        agentId: devId,
        externalId: "o-chart",
        bodyMd: "@fin 이 차트 봐",
        attachmentIds: [chart.id],
      });
      const { inbound: toFin } = deliver(
        { message: relay },
        { run: { agentId: finId, triggerKind: "relay" } },
      );
      expect(toFin.message).toMatchObject({ text: "@fin 이 차트 봐", attachments: [chart] });
    });

    it("이전 메시지 줄은 자리표시로만 — 「본문\n[이미지 2장] [파일: a.pdf]」, 본문이 비면 자리표시만, 경로·URL 은 어디에도 없다", () => {
      const { db, bus, channelId, userId, devId, say, deliver } = setup();
      const withBody = createAgentMessage(db, bus, {
        channelId,
        agentId: devId,
        externalId: "o1",
        bodyMd: "본문",
        attachmentIds: [
          insertAttachment(db, { channelId, uploaderType: "bridge", name: "x.png" }).id,
          insertAttachment(db, { channelId, uploaderType: "bridge", kind: "file", name: "a.pdf" }).id,
          insertAttachment(db, { channelId, uploaderType: "bridge", name: "y.png" }).id,
        ],
      });
      expect(withBody.attachments).toHaveLength(3);
      createAgentMessage(db, bus, {
        channelId,
        agentId: devId,
        externalId: "o2",
        bodyMd: "",
        attachmentIds: [
          insertAttachment(db, { channelId, uploaderType: "bridge", name: "x.png" }).id,
          insertAttachment(db, { channelId, uploaderType: "bridge", name: "y.png" }).id,
          insertAttachment(db, { channelId, uploaderType: "bridge", kind: "file", name: "a.pdf" }).id,
        ],
      });
      say("글만");
      const img = insertAttachment(db, { channelId, uploaderId: userId });
      const trigger = createUserMessage(db, bus, {
        channelId,
        authorId: userId,
        bodyMd: "@dev 봐 줘",
        clientMsgId: "t",
        attachments: [img.id],
      });

      const { inbound } = deliver({ message: trigger });
      expect(inbound.context.recentMessages.map((m) => m.text)).toEqual([
        "본문\n[이미지 2장] [파일: a.pdf]",
        "[이미지 2장] [파일: a.pdf]",
        "글만",
      ]);
      const texts = [inbound.message.text, ...inbound.context.recentMessages.map((m) => m.text)].join("\n");
      expect(texts).not.toContain("artifact://");
      expect(texts).not.toMatch(/(^|\s)\//m);
    });

    it("attachmentPlaceholder — 이미지는 장 수 하나로, 파일은 이름마다, 없으면 빈 문자열", () => {
      const { db, channelId } = setup();
      const image = insertAttachment(db, { channelId, uploaderType: "bridge" });
      const file = (name: string) =>
        insertAttachment(db, { channelId, uploaderType: "bridge", kind: "file", name });
      expect(attachmentPlaceholder([])).toBe("");
      expect(attachmentPlaceholder([image])).toBe("[이미지 1장]");
      expect(attachmentPlaceholder([file("보고서 최종.pdf"), file("b.csv")])).toBe(
        "[파일: 보고서 최종.pdf] [파일: b.csv]",
      );
    });
  });

  it("participants 는 채널 멤버 전부이고 isSelf 는 이 런의 에이전트 하나", () => {
    const { finId, say, deliver } = setup();
    const trigger = say("@fin 안녕");

    const { inbound } = deliver({ message: trigger }, { run: { agentId: finId } });
    expect(inbound.context.participants).toEqual([
      { type: "user", handle: "owner", displayName: "owner", isSelf: false },
      { type: "agent", handle: "dev", displayName: "Dev", isSelf: false },
      { type: "agent", handle: "fin", displayName: "Fin", isSelf: true },
    ]);
    expect(inbound.context.participants.filter((p) => p.isSelf)).toHaveLength(1);
  });

  it("relayRules — allowPairs 가 all 이면 최대 턴만", () => {
    const { db, channelId, say, deliver } = setup();
    expect(deliver({ message: say("@dev") }).inbound.context.relayRules).toBe(
      "다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
    );
    updateChannel(db, channelId, { relayPolicy: { maxRelayTurns: 7 } });
    expect(deliver({ message: say("@dev 다시") }).inbound.context.relayRules).toBe(rule(7));
  });

  it("relayRules — allowPairs 제한이면 이 에이전트가 부를 수 있는 채널 에이전트 핸들을 나열한다", () => {
    const { db, workspaceId, userId, logger, channelId, devId, finId, say, deliver } = setup();
    const ops = createAgent(db, { workspaceId, providerAgentId: "ops", handle: "ops", name: "Ops" });
    addMember(db, channelId, { memberType: "agent", memberId: ops.id }, logger);
    const ghost = createAgent(db, { workspaceId, providerAgentId: "ghost", handle: "ghost", name: "Ghost" }); // 채널 밖
    updateChannel(db, channelId, {
      relayPolicy: {
        maxRelayTurns: 2,
        allowPairs: [
          { from: devId, to: finId },
          { from: devId, to: devId },
          { from: devId, to: userId }, // 사람 id — 에이전트가 아니므로 나열하지 않는다
          { from: devId, to: ghost.id },
          { from: finId, to: devId },
          { from: devId, to: ops.id },
          { from: devId, to: finId },
        ],
      },
    });
    const trigger = say("@dev @fin @ops");

    expect(deliver({ message: trigger }).inbound.context.relayRules).toBe(
      `${rule(2)} 당신이 부를 수 있는 에이전트: @fin, @ops.`,
    );
    expect(deliver({ message: trigger }, { run: { agentId: finId } }).inbound.context.relayRules).toBe(
      `${rule(2)} 당신이 부를 수 있는 에이전트: @dev.`,
    );
    expect(deliver({ message: trigger }, { run: { agentId: ops.id } }).inbound.context.relayRules).toBe(
      `${rule(2)} 당신은 다른 에이전트를 부를 수 없습니다.`,
    );
  });

  it("channelPrompt 는 needsPromptContext 이고 채널 prompt 가 있을 때만", () => {
    const { db, channelId, say, deliver } = setup();
    const trigger = say("@dev");
    expect(deliver({ message: trigger }, { needsPromptContext: true }).inbound.context).not.toHaveProperty(
      "channelPrompt",
    );

    updateChannel(db, channelId, { prompt: "한국어로 짧게" });
    const without = deliver({ message: trigger }, { needsPromptContext: false }).inbound;
    expect(without.context).not.toHaveProperty("channelPrompt");
    expect(without.context).not.toHaveProperty("promptOverride");

    const withPrompt = deliver({ message: trigger }, { needsPromptContext: true }).inbound;
    expect(InboundDeliver.safeParse(withPrompt).success).toBe(true);
    expect(withPrompt.context.channelPrompt).toBe("한국어로 짧게");
  });

  it("promptOverride 는 이 에이전트 멤버에 있으면 needsPromptContext 와 무관하게 항상", () => {
    const { db, logger, channelId, devId, finId, say, deliver } = setup();
    updateAgentMember(db, channelId, devId, { promptOverride: "리뷰어처럼 답해" }, logger);
    const trigger = say("@dev @fin");

    const dev = deliver({ message: trigger }, { needsPromptContext: false }).inbound;
    expect(InboundDeliver.safeParse(dev).success).toBe(true);
    expect(dev.context.promptOverride).toBe("리뷰어처럼 답해");
    expect(dev.context).not.toHaveProperty("channelPrompt");
    expect(deliver({ message: trigger }, { needsPromptContext: true }).inbound.context.promptOverride).toBe(
      "리뷰어처럼 답해",
    );
    expect(deliver({ message: trigger }, { run: { agentId: finId } }).inbound.context).not.toHaveProperty(
      "promptOverride",
    );
  });

  it("상호작용·이어가기 트리거: 누른 사람이 author, text 는 interactionText, ts 는 now, recentMessages 는 그 메시지까지", () => {
    const { db, bus, channelId, devId, finId, say, deliver, interactionOn } = setup();
    say("m1");
    const card = createAgentMessage(db, bus, {
      channelId,
      agentId: devId,
      externalId: "o-card",
      bodyMd: "@owner 골라 주세요",
      components: { blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }] },
    });
    say("카드 뒤");
    const now = new Date("2026-09-15T03:00:00.000Z");
    const text =
      '[dodok interaction] user=@owner kind=button component=c item=ok\n@owner 님이 "확인" 버튼을 눌렀습니다.';

    const { inbound } = deliver(
      { interactionText: text, interactionMessageId: card.id },
      {
        run: {
          triggerKind: "interaction",
          triggerInteractionId: interactionOn(card.id, card.components?.id ?? ""),
        },
        now,
      },
    );
    expect(InboundDeliver.safeParse(inbound).success).toBe(true);
    expect(inbound).toMatchObject({
      kind: "interaction",
      agentId: "dev-main",
      message: {
        id: card.id,
        author: { type: "user", handle: "owner", displayName: "owner" },
        text,
        attachments: [],
        ts: now.toISOString(),
      },
    });
    expect(inbound.context.recentMessages.map((m) => m.text)).toEqual(["m1", "@owner 골라 주세요"]);

    // relay_limit 카드의 이어가기 — 카드 자체는 시스템 메시지라 recentMessages 에 없다
    const limit = createSystemMessage(db, bus, {
      channelId,
      kind: "relay_limit",
      bodyMd: "릴레이 한도(4턴)에 도달했습니다.",
      components: {
        blocks: [{ type: "actions", items: [{ type: "button", id: "continue_relay", label: "이어가기" }] }],
      },
    });
    say("한도 뒤");
    const { inbound: cont } = deliver(
      { interactionText: "이어가기", interactionMessageId: limit.id },
      {
        run: {
          agentId: finId,
          triggerKind: "continue",
          rootMessageId: limit.id,
          triggerInteractionId: interactionOn(limit.id, limit.components?.id ?? ""),
        },
        now,
      },
    );
    expect(InboundDeliver.safeParse(cont).success).toBe(true);
    expect(cont).toMatchObject({
      kind: "continue",
      agentId: "fin",
      message: {
        id: limit.id,
        author: { type: "user", handle: "owner" },
        text: "이어가기",
        ts: now.toISOString(),
      },
    });
    expect(cont.context.recentMessages.map((m) => m.text)).toEqual(["m1", "@owner 골라 주세요", "카드 뒤"]);
  });
});
