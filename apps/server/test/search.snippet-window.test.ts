import { SearchQuery } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { messages } from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import * as readable from "../src/modules/search/readable";
import { MAX_SNIPPET_WINDOWS, searchMessages } from "../src/modules/search/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

// 변환(readableGlyphs)은 여는 표시마다 줄 끝까지 닫는 짝을 찾아 한 줄 안에서 길이의 제곱으로 느려진다 —
// 그래서 스니펫은 본문 전체가 아니라 일치 주변 창만 변환해야 한다. 시간 대신 변환에 넘긴 창의 길이를 잰다
vi.mock("../src/modules/search/readable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/search/readable")>();
  return { ...actual, readableGlyphs: vi.fn(actual.readableGlyphs) };
});

const NOW = new Date("2026-09-25T12:00:00+09:00");
const BOUND = 2 * readable.READABLE_WINDOW_SPAN + 200;

describe("스니펫 변환 창", () => {
  it("100 KB 한 줄 본문은 일치를 감쌀 때도·본문 머리로 떨어질 때도 창만 변환한다", () => {
    const db = newTestDb();
    const bus = new ServerBus();
    const { workspaceId, userId } = seedWorkspace(db);
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const say = (bodyMd: string, n: number) => {
      const m = createUserMessage(db, bus, {
        channelId: channel.id,
        authorId: userId,
        bodyMd: "임시",
        clientMsgId: `c${n}`,
      });
      db.update(messages).set({ bodyMd }).where(eq(messages.id, m.id)).run();
      return m;
    };
    say(`${"*a ".repeat(16_000)}목표어${"*a ".repeat(16_000)}`, 0);
    // 일치가 숨은 링크 주소 안뿐이면 강조 없이 본문 머리(head)로 떨어진다 — 그 경로도 창만
    say(`[x](http://a/숨은말)${"![a".repeat(33_000)}`, 1);

    const spy = vi.mocked(readable.readableGlyphs);
    for (const q of ["목표어", "숨은말"]) {
      spy.mockClear();
      expect(searchMessages(db, workspaceId, userId, SearchQuery.parse({ q }), NOW).hits).toHaveLength(1);
      expect(spy).toHaveBeenCalled();
      for (const [, , win] of spy.mock.calls) {
        expect(win).toBeDefined();
        expect((win?.to ?? Infinity) - (win?.from ?? 0)).toBeLessThanOrEqual(BOUND);
      }
    }
  });

  it("창 앞의 긴 `- - - … x` 줄 — 펜스 상태 이어받기가 줄 길이의 제곱으로 돌지 않는다", () => {
    const db = newTestDb();
    const bus = new ServerBus();
    const { workspaceId, userId } = seedWorkspace(db);
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const m = createUserMessage(db, bus, {
      channelId: channel.id,
      authorId: userId,
      bodyMd: "임시",
      clientMsgId: "c0",
    });
    // 줄머리를 길이의 제곱으로 훑으면 행 하나에 16 s 남짓, 선형이면 수 ms — 1 s 상한은 흔들리지 않는다. 첫째는 펜스 표시가
    // 없는 줄이라 창 앞 훑기가 건너뛰어야 하고, 둘째는 펜스 표시가 든 줄이라 훑되 가로줄 검사를 줄마다 한 번만 해야 빠르다
    for (const bodyMd of [`${"- ".repeat(48_000)}x\n목표어`, `${"- ".repeat(48_000)}x \`\`\`\n목표어`]) {
      db.update(messages).set({ bodyMd }).where(eq(messages.id, m.id)).run();
      const started = performance.now();
      expect(
        searchMessages(db, workspaceId, userId, SearchQuery.parse({ q: "목표어" }), NOW).hits,
      ).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  }, 60_000);

  it("일치가 모두 숨은 자리에 있는 긴 본문은 창 MAX_SNIPPET_WINDOWS 개까지만 변환하고 본문 머리로", () => {
    const db = newTestDb();
    const bus = new ServerBus();
    const { workspaceId, userId } = seedWorkspace(db);
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
    const m = createUserMessage(db, bus, {
      channelId: channel.id,
      authorId: userId,
      bodyMd: "임시",
      clientMsgId: "c0",
    });
    const body = `${`[x](http://a/숨은말)${"가".repeat(5_000)}`.repeat(19)}끝에 숨은말`;
    db.update(messages).set({ bodyMd: body }).where(eq(messages.id, m.id)).run();
    const spy = vi.mocked(readable.readableGlyphs);
    spy.mockClear();
    const [hit] = searchMessages(db, workspaceId, userId, SearchQuery.parse({ q: "숨은말" }), NOW).hits;
    expect(hit?.snippet.startsWith("x가가가")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(MAX_SNIPPET_WINDOWS + 1);
  });
});
