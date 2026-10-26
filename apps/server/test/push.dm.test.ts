/**
 * DM 의 푸시는 주인에게만(에이전트 DM 계획 판정 PD7) — 승인 알림은 지금 「owner·admin 전원」 갈래를 DM 에서 주인 하나로 바꾸고,
 * 어느 트리거 갈래든 DM 을 겨눈 알림은 발송 직전 거름(attachPushTriggers)이 주인 말고는 걷는다. 본문의 자리는 내부용 이름 대신 「DM」.
 */
import type { Approval, Message } from "@dodok/shared";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { memberships, users } from "../src/db/schema.sqlite";
import { attachPushTriggers, createTriggerLookups } from "../src/modules/push/service";
import { type PushTarget, targetsForApproval } from "../src/modules/push/triggers";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { createDmChannelForTest, seedChannelWithAgent, seedConversation } from "./helpers/seed";

function setup() {
  const db = newTestDb();
  const s = seedChannelWithAgent(db, { agentHandle: "dev", channelName: "프로젝트" });
  const person = (handle: string, role: string) => {
    const id = uuid();
    db.insert(users)
      .values({
        id,
        workspaceId: s.workspaceId,
        handle,
        displayName: handle,
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    db.insert(memberships).values({ id: uuid(), workspaceId: s.workspaceId, userId: id, role }).run();
    return id;
  };
  db.insert(memberships)
    .values({ id: uuid(), workspaceId: s.workspaceId, userId: s.userId, role: "owner" })
    .run();
  const admin = person("adm", "admin");
  const mia = person("mia", "member");
  const dm = createDmChannelForTest(db, { workspaceId: s.workspaceId, ownerId: mia, agentId: s.agentId });
  const dmConversation = seedConversation(db, dm.id, { createdBy: mia });
  const lookups = createTriggerLookups(db, s.workspaceId);
  const bus = new ServerBus();
  const got: PushTarget[][] = [];
  attachPushTriggers(bus, { dispatch: async (x) => void got.push(x) }, lookups, pino({ level: "silent" }));
  return { ...s, admin, mia, dm, dmConversation, lookups, bus, got };
}

const approvalOf = (over: Partial<Approval>): Approval =>
  ({
    id: uuid(),
    runId: uuid(),
    kind: "tool",
    status: "pending",
    title: "도구",
    ...over,
  }) as Approval;

const agentMessage = (over: Partial<Message>): Message =>
  ({
    id: uuid(),
    seq: 1,
    kind: "normal",
    authorType: "agent",
    bodyMd: "x",
    mentions: { users: [], agents: [] },
    reactions: [],
    ...over,
  }) as Message;

describe("DM 푸시 — 주인에게만", () => {
  it("DM 의 도구 승인은 owner·admin 이 아니라 주인 mia(member)에게만, 본문은 「DM」", () => {
    const t = setup();
    const dm = targetsForApproval(
      approvalOf({ channelId: t.dm.id, conversationId: t.dmConversation }),
      t.lookups,
    );
    expect(dm.map((x) => x.userId)).toEqual([t.mia]);
    expect(dm[0]?.payload.body).toBe("DM에 승인 요청이 있습니다");
    // 일반 채널은 지금 규칙 그대로 — owner·admin 전원, #이름
    const plain = targetsForApproval(
      approvalOf({ channelId: t.channelId, conversationId: t.conversationId }),
      t.lookups,
    );
    expect(plain.map((x) => x.userId).sort()).toEqual([t.userId, t.admin].sort());
    expect(plain[0]?.payload.body).toBe("#프로젝트에 승인 요청이 있습니다");
  });

  it("DM 의 확인 카드도 주인에게만 — 발송까지 버스로", () => {
    const t = setup();
    t.bus.emit("approval.requested", {
      approval: approvalOf({
        channelId: t.dm.id,
        conversationId: t.dmConversation,
        kind: "dodok_control",
        requestedBy: t.mia,
      }),
    });
    t.bus.emit("approval.requested", {
      approval: approvalOf({ channelId: t.dm.id, conversationId: t.dmConversation }),
    });
    expect(t.got.map((batch) => batch.map((x) => x.userId))).toEqual([[t.mia], [t.mia]]);
  });

  it("DM 을 겨눈 멘션 알림은 발송 직전에 주인 말고는 걷는다 — 트리거가 owner 를 골라도 가지 않는다", () => {
    const t = setup();
    t.bus.emit("message.created", {
      message: agentMessage({
        channelId: t.dm.id,
        conversationId: t.dmConversation,
        authorId: t.agentId,
        mentions: { users: [t.userId, t.admin, t.mia], agents: [] },
      }),
    });
    expect(t.got).toHaveLength(1);
    expect(t.got[0]?.map((x) => x.userId)).toEqual([t.mia]);
    expect(t.got[0]?.[0]?.payload.body).toBe("@dev가 DM에서 불렀습니다");
    // 일반 채널 멘션은 그대로 모두에게
    t.bus.emit("message.created", {
      message: agentMessage({
        channelId: t.channelId,
        conversationId: t.conversationId,
        authorId: t.agentId,
        mentions: { users: [t.userId, t.admin], agents: [] },
      }),
    });
    expect(t.got[1]?.map((x) => x.userId).sort()).toEqual([t.userId, t.admin].sort());
  });

  it("dmOwner 풀기 — DM 이면 주인, 일반 채널·없는 채널·다른 워크스페이스면 null", () => {
    const t = setup();
    expect(t.lookups.dmOwner(t.dm.id)).toBe(t.mia);
    expect(t.lookups.dmOwner(t.channelId)).toBeNull();
    expect(t.lookups.dmOwner(uuid())).toBeNull();
  });
});
