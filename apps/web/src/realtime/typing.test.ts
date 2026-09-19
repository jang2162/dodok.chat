import { beforeEach, describe, expect, it } from "vitest";
import { AGENT, CH, CH2, USER } from "../../test/fixtures";
import { TYPING_TTL_MS, typingActors, useTypingStore } from "./typing";

describe("useTypingStore", () => {
  beforeEach(() => useTypingStore.setState({ byChannel: {} }));

  it("기록한 행위자는 5초 안에는 보이고, 5초가 지나면 사라진다 — 채널별로", () => {
    useTypingStore.getState().note({ channelId: CH, actorType: "agent", actorId: AGENT }, 1_000);
    const s = useTypingStore.getState();
    expect(typingActors(s, CH, 1_000 + TYPING_TTL_MS - 1)).toEqual([{ actorType: "agent", actorId: AGENT }]);
    expect(typingActors(s, CH, 1_000 + TYPING_TTL_MS)).toEqual([]);
    expect(typingActors(s, CH2, 1_000)).toEqual([]);
  });

  it("같은 행위자를 다시 기록하면 만료가 늘어나고 한 번만 보인다", () => {
    const { note } = useTypingStore.getState();
    note({ channelId: CH, actorType: "user", actorId: USER }, 0);
    note({ channelId: CH, actorType: "user", actorId: USER }, 4_000);
    note({ channelId: CH, actorType: "agent", actorId: AGENT }, 4_000);
    const s = useTypingStore.getState();
    expect(typingActors(s, CH, 8_000)).toEqual([
      { actorType: "user", actorId: USER },
      { actorType: "agent", actorId: AGENT },
    ]);
    expect(TYPING_TTL_MS).toBe(5_000);
  });
});
