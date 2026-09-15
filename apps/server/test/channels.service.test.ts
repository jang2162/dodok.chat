import { Channel, ChannelMember } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { channels } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import {
  addMember,
  channelParticipants,
  createChannel,
  getChannel,
  listChannels,
  listMembers,
  removeMember,
  updateAgentMember,
  updateChannel,
} from "../src/modules/channels/service";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

function setup() {
  const db = newTestDb();
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "jang" });
  const logger = { warn: vi.fn() };
  const agent = (handle: string) =>
    createAgent(db, { workspaceId, providerAgentId: handle, handle, name: handle.toUpperCase() });
  return { db, workspaceId, userId, logger, agent };
}

const revisionOf = (db: ReturnType<typeof newTestDb>, id: string) =>
  db.select({ r: channels.promptRevision }).from(channels).where(eq(channels.id, id)).get()?.r;

describe("channels service", () => {
  it("createChannel 은 relayPolicy·visibility 기본값을 채우고 만든 사람을 멤버로 넣는다", () => {
    const { db, workspaceId, userId } = setup();
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    expect(Channel.parse(channel)).toMatchObject({ name: "general", workspaceId, createdBy: userId });
    expect(channel.relayPolicy).toEqual({ maxRelayTurns: 4, allowPairs: "all" });
    expect(channel.visibility).toBe("public");
    expect(channel.promptRevision).toBe(1);
    expect(channel.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(listMembers(db, channel.id)).toEqual([
      expect.objectContaining({ memberType: "user", memberId: userId, autoRespond: false, aliases: [] }),
    ]);
    expect(getChannel(db, channel.id)).toEqual(channel);
    expect(listChannels(db, workspaceId)).toEqual([channel]);
  });

  it("다른 워크스페이스의 채널은 getChannel·listChannels 에 보이지 않는다", () => {
    const { db, workspaceId, userId } = setup();
    const other = seedWorkspace(db, { userHandle: "other" });
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    expect(getChannel(db, channel.id, workspaceId)).toEqual(channel);
    expect(getChannel(db, channel.id, other.workspaceId)).toBeUndefined();
    expect(listChannels(db, other.workspaceId)).toEqual([]);
    expect(getChannel(db, uuid())).toBeUndefined();
  });

  it("updateChannel 은 prompt 가 바뀔 때만 promptRevision 을 올린다", () => {
    const { db, workspaceId, userId } = setup();
    const { id } = createChannel(db, { workspaceId, createdBy: userId, name: "general" });

    const a = updateChannel(db, id, { prompt: "짧게 답해" });
    expect(a).toMatchObject({ promptChanged: true, channel: { prompt: "짧게 답해", promptRevision: 2 } });
    expect(revisionOf(db, id)).toBe(2);

    const b = updateChannel(db, id, { name: "renamed", topic: "t" });
    expect(b).toMatchObject({
      promptChanged: false,
      channel: { name: "renamed", topic: "t", promptRevision: 2 },
    });

    const same = updateChannel(db, id, { prompt: "짧게 답해" });
    expect(same.promptChanged).toBe(false);
    expect(revisionOf(db, id)).toBe(2);

    const cleared = updateChannel(db, id, { prompt: null, topic: null });
    expect(cleared.promptChanged).toBe(true);
    expect(cleared.channel.promptRevision).toBe(3);
    expect(cleared.channel.prompt).toBeUndefined();
    expect(cleared.channel.topic).toBeUndefined();
  });

  it("updateChannel 은 relayPolicy 가 값으로 달라질 때만 리비전을 올린다", () => {
    const { db, workspaceId, userId } = setup();
    const { id } = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    expect(
      updateChannel(db, id, { relayPolicy: { allowPairs: "all", maxRelayTurns: 4 } }).promptChanged,
    ).toBe(false);
    const changed = updateChannel(db, id, { relayPolicy: { maxRelayTurns: 2 } });
    expect(changed.promptChanged).toBe(true);
    expect(changed.channel.relayPolicy).toEqual({ maxRelayTurns: 2, allowPairs: "all" });
    expect(changed.channel.promptRevision).toBe(2);
  });

  it("updateChannel 은 없는 채널이면 NOT_FOUND", () => {
    const { db } = setup();
    expect(() => updateChannel(db, uuid(), { name: "x" })).toThrow(
      expect.objectContaining({ status: 404, body: expect.objectContaining({ code: "NOT_FOUND" }) }),
    );
  });

  it("autoRespond=true 에이전트가 둘이 되면 저장은 하되 경고한다", () => {
    const { db, workspaceId, userId, logger, agent } = setup();
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const dev = agent("dev");
    const fin = agent("fin");

    addMember(db, channel.id, { memberType: "agent", memberId: dev.id, autoRespond: true }, logger);
    expect(logger.warn).not.toHaveBeenCalled();

    const second = addMember(
      db,
      channel.id,
      { memberType: "agent", memberId: fin.id, autoRespond: true },
      logger,
    );
    expect(ChannelMember.parse(second)).toMatchObject({ memberId: fin.id, autoRespond: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(listMembers(db, channel.id).filter((m) => m.autoRespond)).toHaveLength(2);
  });

  it("addMember 는 중복이면 CONFLICT, 없는·다른 워크스페이스 에이전트면 NOT_FOUND", () => {
    const { db, workspaceId, userId, logger, agent } = setup();
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const dev = agent("dev");
    addMember(db, channel.id, { memberType: "agent", memberId: dev.id }, logger);
    expect(() => addMember(db, channel.id, { memberType: "agent", memberId: dev.id }, logger)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => addMember(db, channel.id, { memberType: "user", memberId: userId }, logger)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    // 사람 멤버는 에이전트 전용 필드를 갖지 않는다
    expect(() =>
      addMember(db, channel.id, { memberType: "user", memberId: userId, aliases: ["boss"] }, logger),
    ).toThrow(expect.objectContaining({ status: 400 }));

    const other = seedWorkspace(db, { userHandle: "other" });
    const foreign = createAgent(db, {
      workspaceId: other.workspaceId,
      providerAgentId: "x",
      handle: "x1",
      name: "x",
    });
    expect(() => addMember(db, channel.id, { memberType: "agent", memberId: foreign.id }, logger)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => addMember(db, channel.id, { memberType: "user", memberId: other.userId }, logger)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => addMember(db, uuid(), { memberType: "agent", memberId: dev.id }, logger)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("updateAgentMember 는 promptOverride 가 바뀔 때만 채널 리비전을 올리고, autoRespond 중복을 경고한다", () => {
    const { db, workspaceId, userId, logger, agent } = setup();
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const dev = agent("dev");
    const fin = agent("fin");
    addMember(db, channel.id, { memberType: "agent", memberId: dev.id, autoRespond: true }, logger);
    addMember(db, channel.id, { memberType: "agent", memberId: fin.id }, logger);

    const a = updateAgentMember(db, channel.id, dev.id, { promptOverride: "너는 리뷰어" }, logger);
    expect(a).toMatchObject({
      promptChanged: true,
      member: { memberId: dev.id, promptOverride: "너는 리뷰어" },
    });
    expect(revisionOf(db, channel.id)).toBe(2);

    const b = updateAgentMember(db, channel.id, dev.id, { aliases: ["reviewer"] }, logger);
    expect(b).toMatchObject({ promptChanged: false, member: { aliases: ["reviewer"] } });
    expect(
      updateAgentMember(db, channel.id, dev.id, { promptOverride: "너는 리뷰어" }, logger).promptChanged,
    ).toBe(false);
    expect(revisionOf(db, channel.id)).toBe(2);

    const cleared = updateAgentMember(db, channel.id, dev.id, { promptOverride: null }, logger);
    expect(cleared.promptChanged).toBe(true);
    expect(cleared.member.promptOverride).toBeUndefined();
    expect(revisionOf(db, channel.id)).toBe(3);

    expect(logger.warn).not.toHaveBeenCalled();
    updateAgentMember(db, channel.id, fin.id, { autoRespond: true }, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    expect(() => updateAgentMember(db, channel.id, userId, { autoRespond: true }, logger)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("removeMember 는 멤버를 빼고, 없으면 NOT_FOUND", () => {
    const { db, workspaceId, userId, logger, agent } = setup();
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const dev = agent("dev");
    addMember(db, channel.id, { memberType: "agent", memberId: dev.id }, logger);
    removeMember(db, channel.id, dev.id);
    expect(listMembers(db, channel.id).map((m) => m.memberId)).toEqual([userId]);
    expect(() => removeMember(db, channel.id, dev.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("channelParticipants 는 사람 handle 과 에이전트 handle·aliases 를 낸다", () => {
    const { db, workspaceId, userId, logger, agent } = setup();
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const dev = agent("dev");
    agent("outsider");
    addMember(db, channel.id, { memberType: "agent", memberId: dev.id, aliases: ["reviewer", "rv"] }, logger);

    const participants = channelParticipants(db, channel.id);
    expect(participants).toHaveLength(2);
    expect(participants).toEqual(
      expect.arrayContaining([
        { type: "user", id: userId, handle: "jang", displayName: "jang" },
        { type: "agent", id: dev.id, handle: "dev", displayName: "DEV", aliases: ["reviewer", "rv"] },
      ]),
    );
  });
});
