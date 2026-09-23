import { describe, expect, it } from "vitest";
import { createPresence } from "../src/modules/push/presence";

const CH = "0199a000-0000-7000-8000-000000000001";
const OTHER = "0199a000-0000-7000-8000-000000000002";
const ALICE = "0199a000-0000-7000-8000-00000000a11c";
const BOB = "0199a000-0000-7000-8000-000000000b0b";

describe("presence — 보고 있으면 거르기(스펙 5.3)", () => {
  it("[Review Focus 3] 같은 채널을 보이는 탭으로 볼 때만 「보고 있음」", () => {
    const p = createPresence();
    expect(p.isWatching(ALICE, CH)).toBe(false); // 아무 소식도 없으면 안 보고 있음
    p.set("s1", ALICE, { visible: true, channelId: CH });
    expect(p.isWatching(ALICE, CH)).toBe(true);
    expect(p.isWatching(ALICE, OTHER)).toBe(false); // 다른 채널
    expect(p.isWatching(BOB, CH)).toBe(false); // 다른 사람
    p.set("s1", ALICE, { visible: false, channelId: CH }); // 백그라운드 탭
    expect(p.isWatching(ALICE, CH)).toBe(false);
    p.set("s1", ALICE, { visible: true }); // 채널 밖 화면(설정 등)
    expect(p.isWatching(ALICE, CH)).toBe(false);
  });

  it("한 사람의 소켓이 여럿이면 하나라도 보고 있으면 「보고 있음」, 그 소켓이 끊기면 풀린다", () => {
    const p = createPresence();
    p.set("s1", ALICE, { visible: false, channelId: CH }); // 백그라운드 탭
    p.set("s2", ALICE, { visible: true, channelId: CH }); // 다른 탭
    p.set("s3", ALICE, { visible: true, channelId: OTHER }); // 셋째 탭은 다른 채널
    expect(p.isWatching(ALICE, CH)).toBe(true);
    expect(p.isWatching(ALICE, OTHER)).toBe(true);
    p.drop("s2");
    expect(p.isWatching(ALICE, CH)).toBe(false);
    expect(p.isWatching(ALICE, OTHER)).toBe(true); // 남은 소켓은 그대로
    p.drop("s3");
    p.drop("s1");
    p.drop("s1"); // 두 번 지워도 된다
    p.drop("nope");
    expect(p.isWatching(ALICE, OTHER)).toBe(false);
    expect(p.isWatching(BOB, CH)).toBe(false);
  });

  it("같은 소켓의 새 소식이 앞 소식을 덮는다 — 채널을 옮기면 앞 채널은 안 보고 있음", () => {
    const p = createPresence();
    p.set("s1", ALICE, { visible: true, channelId: CH });
    p.set("s1", ALICE, { visible: true, channelId: OTHER });
    expect(p.isWatching(ALICE, CH)).toBe(false);
    expect(p.isWatching(ALICE, OTHER)).toBe(true);
  });
});
