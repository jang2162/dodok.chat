/**
 * DM 의 푸시는 주인에게만(에이전트 DM 계획 판정 PD7) — 승인 알림은 지금 「owner·admin 전원」 갈래를 DM 에서 주인 하나로 바꾸고,
 * 어느 트리거 갈래든 DM 을 겨눈 알림은 발송 직전 거름(attachPushTriggers)이 주인 말고는 걷는다. 본문의 자리는 내부용 이름 대신 「DM」.
 * direct 를 겨눈 알림은 같은 거름이 사람 참여자 말고 모두 걷는다(사람 간 DM 스펙 7.1 — 트리거 갈래는 계획 태스크 3·4).
 */
import type { Approval, Message } from "@dodok/shared";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { memberships, users } from "../src/db/schema.sqlite";
import { attachPushTriggers, createTriggerLookups } from "../src/modules/push/service";
import { type PushTarget, targetsForApproval } from "../src/modules/push/triggers";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import {
  createDirectChannelForTest,
  createDmChannelForTest,
  seedChannelWithAgent,
  seedConversation,
} from "./helpers/seed";

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
  return { ...s, db, admin, mia, dm, dmConversation, lookups, bus, got };
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

  it("DM 의 에이전트 글은 멘션과 무관하게 주인에게만 「답했습니다」 알림 — 일반 채널 멘션은 그대로 모두에게", () => {
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
    expect(t.got[0]?.[0]?.payload).toMatchObject({ title: "@dev가 답했습니다", body: "DM" });
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

  it("발송 직전 거름 — 트리거가 DM 을 일반 채널로 잘못 보고 owner 를 골라도 주인 말고는 가지 않는다", () => {
    const db = setup();
    // 트리거 계산 동안에는 DM 이 아니라고 속이고, 거름(보관 확인 → DM 주인 확인 순)에서만 참을 준다 — 어느 갈래가 받을 사람을
    // 잘못 골라도 남에게 DM 이 드러나지 않는다는 방어선만 본다
    let filtering = false;
    const lying = {
      ...db.lookups,
      channelArchived: (id: string) => {
        filtering = true;
        return db.lookups.channelArchived(id);
      },
      dmOwner: (id: string) => (filtering ? db.lookups.dmOwner(id) : null),
    };
    const bus = new ServerBus();
    const got: PushTarget[][] = [];
    attachPushTriggers(
      bus,
      {
        dispatch: async (x) => {
          filtering = false;
          got.push(x);
        },
      },
      lying,
      pino({ level: "silent" }),
    );
    bus.emit("message.created", {
      message: agentMessage({
        channelId: db.dm.id,
        conversationId: db.dmConversation,
        authorId: db.agentId,
        mentions: { users: [db.userId, db.admin, db.mia], agents: [] },
      }),
    });
    expect(got.map((batch) => batch.map((x) => x.userId))).toEqual([[db.mia]]);
  });

  it("dmOwner·dmAgent 풀기 — DM 이면 주인·에이전트, 일반 채널·없는 채널이면 null", () => {
    const t = setup();
    expect(t.lookups.dmOwner(t.dm.id)).toBe(t.mia);
    expect(t.lookups.dmOwner(t.channelId)).toBeNull();
    expect(t.lookups.dmOwner(uuid())).toBeNull();
    expect(t.lookups.dmAgent(t.dm.id)).toBe(t.agentId);
    expect(t.lookups.dmAgent(t.channelId)).toBeNull();
  });

  it("발송 직전 거름 — 트리거가 direct 를 일반 채널로 잘못 보고 owner·admin 을 골라도 사람 참여자 말고는 가지 않는다(사람 간 DM 스펙 7.1)", () => {
    const db = setup();
    // mia 와 adm(참여한 admin)의 그룹 direct — owner(db.userId)는 참여하지 않았다
    const direct = createDirectChannelForTest(db.db, {
      workspaceId: db.workspaceId,
      createdBy: db.mia,
      userIds: [db.admin],
      agentIds: [db.agentId],
    });
    const conversationId = seedConversation(db.db, direct.id, { createdBy: db.mia });
    // 트리거는 지금 direct 를 일반 채널 갈래로 계산한다 — 멘션에 owner 를 넣어 그 갈래가 owner 를 고르게 한다
    db.bus.emit("message.created", {
      message: agentMessage({
        channelId: direct.id,
        conversationId,
        authorId: db.agentId,
        mentions: { users: [db.userId, db.admin, db.mia], agents: [] },
      }),
    });
    // 승인(tool)은 일반 채널 갈래가 owner·admin 전원을 고른다 — owner 는 걷히고 참여한 admin 만 남는다
    db.bus.emit("approval.requested", {
      approval: approvalOf({ channelId: direct.id, conversationId }),
    });
    const receivers = db.got.map((batch) => batch.map((x) => x.userId).sort());
    expect(receivers.flat()).not.toContain(db.userId);
    expect(receivers).toEqual([[db.admin, db.mia].sort(), [db.admin]]);
  });

  it("발송 직전 거름 — 비활성화된 참여자에게도, 모르는 kind 의 채널을 겨눈 알림은 누구에게도 가지 않는다", () => {
    const db = setup();
    const direct = createDirectChannelForTest(db.db, {
      workspaceId: db.workspaceId,
      createdBy: db.mia,
      userIds: [db.admin],
      agentIds: [db.agentId],
    });
    const conversationId = seedConversation(db.db, direct.id, { createdBy: db.mia });
    db.db
      .update(memberships)
      .set({ deactivatedAt: new Date() })
      .where(eq(memberships.userId, db.admin))
      .run();
    db.bus.emit("message.created", {
      message: agentMessage({
        channelId: direct.id,
        conversationId,
        authorId: db.agentId,
        mentions: { users: [db.admin, db.mia], agents: [] },
      }),
    });
    expect(db.got.map((batch) => batch.map((x) => x.userId))).toEqual([[db.mia]]);
    expect(db.lookups.directParticipants(direct.id)).toEqual([db.mia]);
    expect(db.lookups.directParticipants(db.channelId)).toBeNull();
    expect(db.lookups.directParticipants(db.dm.id)).toBeNull();
    expect(db.lookups.directParticipants(uuid())).toBeNull();
    db.db.run(sql`UPDATE channels SET kind = 'zzz' WHERE id = ${db.channelId}`);
    expect(db.lookups.directParticipants(db.channelId)).toEqual([]);
  });
});
