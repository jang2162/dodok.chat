import { describe, expect, it } from "vitest";
import { threadMatchesSessionKey } from "../src/bridge";
import { dodokSessionKey, parseDodokSessionKey } from "../src/session-key";

const CH = "01a09fc9-d204-7551-89d6-38544d07a101";
const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1ab";
const ROOT_UPPER = ROOT.toUpperCase();

describe("dodokSessionKey·parseDodokSessionKey", () => {
  it("채널 키 왕복", () => {
    const key = dodokSessionKey("dev", CH);
    expect(key).toBe(`agent:dev:dodok:channel:${CH}`);
    expect(parseDodokSessionKey(key)).toEqual({ providerAgentId: "dev", channelId: CH });
  });

  it("스레드 키 왕복 — 대문자 rootId 는 소문자로 만들고 소문자로 풀린다", () => {
    const key = dodokSessionKey("dev", CH, ROOT_UPPER);
    expect(key).toBe(`agent:dev:dodok:channel:${CH}:thread:${ROOT}`);
    expect(parseDodokSessionKey(key)).toEqual({ providerAgentId: "dev", channelId: CH, threadRootId: ROOT });
  });

  it("대문자 UUID 가 든 키도 소문자로 돌려준다", () => {
    const parsed = parseDodokSessionKey(`agent:dev:dodok:channel:${CH.toUpperCase()}:thread:${ROOT_UPPER}`);
    expect(parsed).toEqual({ providerAgentId: "dev", channelId: CH, threadRootId: ROOT });
  });

  it("채널 키에는 threadRootId 키 자체가 없다", () => {
    expect(parseDodokSessionKey(dodokSessionKey("dev", CH))).not.toHaveProperty("threadRootId");
  });

  it.each([
    ["없음", undefined],
    ["빈 문자열", ""],
    ["세대 접미사", `agent:dev:dodok:channel:${CH}:g2`],
    ["스레드 접미사 뒤가 UUID 아님", `agent:dev:dodok:channel:${CH}:thread:abc`],
    ["스레드 접미사 뒤가 빔", `agent:dev:dodok:channel:${CH}:thread:`],
    ["스레드 뒤에 또 붙음", `agent:dev:dodok:channel:${CH}:thread:${ROOT}:thread:${ROOT}`],
    ["앞 공백", ` agent:dev:dodok:channel:${CH}`],
    ["뒤 공백", `agent:dev:dodok:channel:${CH} `],
    ["다른 채널 종류", `agent:dev:other:channel:${CH}`],
    ["채널 id 가 UUID 아님", "agent:dev:dodok:channel:general"],
    ["에이전트 id 빔", `agent::dodok:channel:${CH}`],
  ])("우리 모양이 아니면 undefined — %s", (_label, key) => {
    expect(parseDodokSessionKey(key)).toBeUndefined();
  });
});

describe("threadMatchesSessionKey", () => {
  it("둘 다 없으면 참", () => {
    expect(threadMatchesSessionKey(dodokSessionKey("dev", CH), undefined)).toBe(true);
  });
  it("같으면 참 — 대소문자는 가리지 않는다", () => {
    expect(threadMatchesSessionKey(dodokSessionKey("dev", CH, ROOT), ROOT)).toBe(true);
    expect(threadMatchesSessionKey(dodokSessionKey("dev", CH, ROOT), ROOT_UPPER)).toBe(true);
  });
  it("다르면 거짓", () => {
    expect(threadMatchesSessionKey(dodokSessionKey("dev", CH, ROOT), CH)).toBe(false);
  });
  it("키만 스레드면 거짓", () => {
    expect(threadMatchesSessionKey(dodokSessionKey("dev", CH, ROOT), undefined)).toBe(false);
  });
  it("threadId 만 있으면 거짓", () => {
    expect(threadMatchesSessionKey(dodokSessionKey("dev", CH), ROOT)).toBe(false);
  });
  it("우리 모양이 아닌 키는 threadId 가 없어도 거짓", () => {
    expect(threadMatchesSessionKey(`agent:dev:dodok:channel:${CH}:g2`, undefined)).toBe(false);
  });
});
