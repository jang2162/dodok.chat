/**
 * attachWireFanout 의 message.created 두 처리기 — 가짜 io 로 룸별 emit 순서를 본다. 실제 소켓 없이 처리기 자체만 잰다
 * (소켓을 붙이는 팬아웃은 realtime.dm-fanout.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger";
import { createUserMessage } from "../src/modules/messages/service";
import { withReactions } from "../src/modules/reactions/service";
import { ServerBus } from "../src/realtime/bus";
import { attachWireFanout } from "../src/realtime/events";
import { channelRoom, workspaceRoom } from "../src/realtime/socket";
import type { WireServer } from "../src/realtime/types";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

vi.mock("../src/modules/reactions/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/modules/reactions/service")>();
  return { ...real, withReactions: vi.fn(real.withReactions) };
});

type Emitted = { room: string | string[]; event: string; payload: unknown };

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const ids = seedChannelWithAgent(db);
  const emitted: Emitted[] = [];
  const io = {
    to: (room: string | string[]) => ({
      emit: (event: string, payload: unknown) => void emitted.push({ room, event, payload }),
    }),
  } as unknown as WireServer;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fanout = attachWireFanout(io, bus, {
    db,
    logger: logger as unknown as Logger,
    workspaceId: ids.workspaceId,
  });
  let n = 0;
  const say = (bodyMd = "안녕") =>
    createUserMessage(db, bus, {
      conversationId: ids.conversationId,
      authorId: ids.userId,
      bodyMd,
      clientMsgId: `c${++n}`,
    });
  return { db, bus, ids, emitted, logger, fanout, say };
}

describe("attachWireFanout — message.created", () => {
  afterEach(() => {
    vi.mocked(withReactions).mockReset();
  });

  it("채널 룸의 message.created 가 사이드바 channel.activity 보다 먼저 나간다(처리기 등록 순서)", () => {
    const t = setup();
    const message = t.say();
    expect(t.emitted.map((e) => [e.event, e.room])).toEqual([
      ["message.created", channelRoom(t.ids.channelId)],
      // channelAudience 는 룸 목록을 낸다(direct 는 참여자마다 user 룸) — 일반 채널은 workspace 룸 하나
      ["channel.activity", [workspaceRoom(t.ids.workspaceId)]],
    ]);
    expect(t.emitted[0]?.payload).toMatchObject({ message: { id: message.id } });
    t.fanout.close();
  });

  it("하이드레이션이 던지면 원본 메시지로 낸다(+warn) — 채널 룸 구독자가 그 글을 잃지 않는다", () => {
    const t = setup();
    vi.mocked(withReactions).mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const message = t.say("하이드레이션 실패");
    expect(t.emitted.map((e) => e.event)).toEqual(["message.created", "channel.activity"]);
    expect(t.emitted[0]).toMatchObject({
      room: channelRoom(t.ids.channelId),
      payload: { message: { id: message.id, bodyMd: "하이드레이션 실패" } },
    });
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: message.id }),
      "message.created hydration failed — sent unhydrated",
    );
    expect(t.logger.error).not.toHaveBeenCalled();
    t.fanout.close();
  });
});
