import { describe, expect, it } from "vitest";
import { createPresence } from "../src/modules/push/presence";

const CH = "0199a000-0000-7000-8000-000000000001";
const OTHER_CH = "0199a000-0000-7000-8000-000000000002";
/** CH 의 세션 둘(A·B)과 OTHER_CH 의 세션 하나 — 거르기는 세션 단위다(채널 세션 계획 판정 PS7) */
const A = "0199a000-0000-7000-8000-000000000011";
const B = "0199a000-0000-7000-8000-000000000012";
const OTHER = "0199a000-0000-7000-8000-000000000021";
const ALICE = "0199a000-0000-7000-8000-00000000a11c";
const BOB = "0199a000-0000-7000-8000-000000000b0b";

describe("presence — 보고 있으면 거르기(스펙 5.3, 단위는 세션)", () => {
  it("[Review Focus 3] 같은 세션을 보이는 탭으로 볼 때만 「보고 있음」", () => {
    const p = createPresence();
    expect(p.isWatching(ALICE, A)).toBe(false); // 아무 소식도 없으면 안 보고 있음
    p.set("s1", ALICE, { visible: true, channelId: CH, conversationId: A });
    expect(p.isWatching(ALICE, A)).toBe(true);
    expect(p.isWatching(ALICE, OTHER)).toBe(false); // 다른 채널의 세션
    expect(p.isWatching(BOB, A)).toBe(false); // 다른 사람
    p.set("s1", ALICE, { visible: false, channelId: CH, conversationId: A }); // 백그라운드 탭
    expect(p.isWatching(ALICE, A)).toBe(false);
    p.set("s1", ALICE, { visible: true }); // 채널 밖 화면(설정 등)
    expect(p.isWatching(ALICE, A)).toBe(false);
  });

  it("[판정 PS7] 같은 채널의 다른 세션은 보고 있는 것이 아니다 — 새 세션 창(세션 없음)도", () => {
    const p = createPresence();
    p.set("s1", ALICE, { visible: true, channelId: CH, conversationId: A });
    expect(p.isWatching(ALICE, A)).toBe(true);
    expect(p.isWatching(ALICE, B)).toBe(false);
    p.set("s1", ALICE, { visible: true, channelId: CH });
    expect(p.isWatching(ALICE, A)).toBe(false);
    expect(p.isWatching(ALICE, B)).toBe(false);
  });

  it("한 사람의 소켓이 여럿이면 하나라도 보고 있으면 「보고 있음」, 그 소켓이 끊기면 풀린다", () => {
    const p = createPresence();
    p.set("s1", ALICE, { visible: false, channelId: CH, conversationId: A }); // 백그라운드 탭
    p.set("s2", ALICE, { visible: true, channelId: CH, conversationId: A }); // 다른 탭
    p.set("s3", ALICE, { visible: true, channelId: OTHER_CH, conversationId: OTHER }); // 셋째 탭은 다른 채널
    expect(p.isWatching(ALICE, A)).toBe(true);
    expect(p.isWatching(ALICE, OTHER)).toBe(true);
    p.drop("s2");
    expect(p.isWatching(ALICE, A)).toBe(false);
    expect(p.isWatching(ALICE, OTHER)).toBe(true); // 남은 소켓은 그대로
    p.drop("s3");
    p.drop("s1");
    p.drop("s1"); // 두 번 지워도 된다
    p.drop("nope");
    expect(p.isWatching(ALICE, OTHER)).toBe(false);
    expect(p.isWatching(BOB, A)).toBe(false);
  });

  it("같은 소켓의 새 소식이 앞 소식을 덮는다 — 세션을 옮기면 앞 세션은 안 보고 있음", () => {
    const p = createPresence();
    p.set("s1", ALICE, { visible: true, channelId: CH, conversationId: A });
    p.set("s1", ALICE, { visible: true, channelId: CH, conversationId: B });
    expect(p.isWatching(ALICE, A)).toBe(false);
    expect(p.isWatching(ALICE, B)).toBe(true);
  });
});
