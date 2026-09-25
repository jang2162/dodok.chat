import { describe, expect, it } from "vitest";
import { threadMatchesSessionKey } from "../src/bridge";
import {
  dodokSessionKey,
  isOpenClawAgentId,
  isRegistrableAgentId,
  parseDodokSessionKey,
} from "../src/session-key";

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

  it("스레드 없는 채널 키의 대문자 channelId 도 소문자로 돌려준다", () => {
    expect(parseDodokSessionKey(`agent:dev:dodok:channel:${CH.toUpperCase()}`)).toEqual({
      providerAgentId: "dev",
      channelId: CH,
    });
  });

  it("빌더는 channelId 도 소문자로 만든다 — 코어가 키 전체를 소문자로 접으므로 build∘parse 가 항등이다", () => {
    expect(dodokSessionKey("dev", CH.toUpperCase())).toBe(`agent:dev:dodok:channel:${CH}`);
    const key = dodokSessionKey("dev", CH.toUpperCase(), ROOT_UPPER);
    const parsed = parseDodokSessionKey(key)!;
    expect(dodokSessionKey(parsed.providerAgentId, parsed.channelId, parsed.threadRootId)).toBe(key);
  });

  it("에이전트 id 의 대소문자는 그대로 둔다 — 서버가 저장한 providerAgentId 로 에이전트를 찾는다", () => {
    const key = dodokSessionKey("Dev", CH);
    expect(key).toBe(`agent:Dev:dodok:channel:${CH}`);
    expect(parseDodokSessionKey(key)?.providerAgentId).toBe("Dev");
  });

  it.each([
    ["빈 문자열", ""],
    ["공백", "a b"],
    ["줄바꿈", "a\nb"],
    ["끝 줄바꿈", "dev\n"],
    ["콜론", "a:b"],
    ["밑줄로 시작", "_dev"],
    ["65자", "a".repeat(65)],
  ])("빌더는 OpenClaw agentId 가 아닌 것을 던진다 — %s", (_label, agentId) => {
    expect(() => dodokSessionKey(agentId, CH)).toThrow();
  });

  it("빌더는 64자·밑줄·하이픈 agentId 를 받는다", () => {
    expect(() => dodokSessionKey("a".repeat(64), CH)).not.toThrow();
    expect(() => dodokSessionKey("dev_main-2", CH)).not.toThrow();
  });

  it("빌더는 빈 threadRootId 를 던진다 — 파서가 거절하는 키를 만들지 않는다", () => {
    expect(() => dodokSessionKey("dev", CH, "")).toThrow();
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
    ["에이전트 id 에 콜론", `agent:a:b:dodok:channel:${CH}`],
    ["에이전트 id 에 공백", `agent:a b:dodok:channel:${CH}`],
    ["에이전트 id 에 줄바꿈", `agent:a\nb:dodok:channel:${CH}`],
    ["에이전트 id 가 65자", `agent:${"a".repeat(65)}:dodok:channel:${CH}`],
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

describe("isOpenClawAgentId", () => {
  it.each(["dev", "dev-main", "a_b", "0", "DEV", "a".repeat(64)])("규칙 안 — %s", (id) => {
    expect(isOpenClawAgentId(id)).toBe(true);
    expect(() => dodokSessionKey(id, CH)).not.toThrow();
  });
  it.each(["", "-dev", "_dev", "a:b", "a b", "a.b", "개발", "a".repeat(65), "a\nb"])(
    "규칙 밖 — %j (빌더도 던진다)",
    (id) => {
      expect(isOpenClawAgentId(id)).toBe(false);
      expect(() => dodokSessionKey(id, CH)).toThrow();
    },
  );
});

describe("isRegistrableAgentId", () => {
  it.each(["dev", "dev-main", "a_b", "0", "a".repeat(64)])("소문자 규칙 안 — %s", (id) => {
    expect(isRegistrableAgentId(id)).toBe(true);
  });
  // 코어가 세션 키를 소문자로 접으므로 대문자 id 는 키에서 푼 id 와 날 비교로 어긋난다
  it.each(["DEV", "Dev", "dev-Main", "", "-dev", "a:b", "a".repeat(65)])("거절 — %j", (id) => {
    expect(isRegistrableAgentId(id)).toBe(false);
  });
});
