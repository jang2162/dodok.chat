import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { channels, messages, users, workspaces } from "../src/db/schema.sqlite";
import { allocateSeq } from "../src/modules/messages/seq";
import { channelConversation, seedConversation } from "./helpers/seed";

function seed() {
  const db = createDb(":memory:");
  const ws = uuid();
  const user = uuid();
  const ch = uuid();
  db.insert(workspaces).values({ id: ws, name: "w", createdAt: new Date() }).run();
  db.insert(users)
    .values({
      id: user,
      workspaceId: ws,
      handle: "jang",
      displayName: "장",
      authProvider: "local",
      createdAt: new Date(),
    })
    .run();
  db.insert(channels)
    .values({
      id: ch,
      workspaceId: ws,
      name: "g",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
      createdBy: user,
      createdAt: new Date(),
    })
    .run();
  seedConversation(db, ch, { createdBy: user, createdAt: new Date() });
  return { db, ch };
}

describe("allocateSeq", () => {
  it("1부터 연속으로 발급하고 INSERT와 함께 쓰인다", () => {
    const { db, ch } = seed();
    const seqs: number[] = [];
    for (let i = 0; i < 100; i++) {
      db.transaction((tx) => {
        const seq = allocateSeq(tx, ch);
        tx.insert(messages)
          .values({
            id: uuid(),
            channelId: ch,
            conversationId: channelConversation(db, ch),
            seq,
            kind: "normal",
            authorType: "user",
            bodyMd: "m",
            mentions: { agents: [], users: [] },
            createdAt: new Date(),
          })
          .run();
        seqs.push(seq);
      });
    }
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("롤백된 트랜잭션은 seq를 소비하지 않는다", () => {
    const { db, ch } = seed();
    expect(() =>
      db.transaction((tx) => {
        allocateSeq(tx, ch);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(allocateSeq(db, ch)).toBe(1);
  });

  it("없는 채널이면 throw", () => {
    const { db } = seed();
    expect(() => allocateSeq(db, uuid())).toThrow(/channel not found/);
  });
});
