import { describe, expect, it } from "vitest";
import {
  MENTION_TOKEN_RE,
  type Participant,
  parseMentions,
  renderForAgent,
  segment,
  tokenize,
} from "../src/mention";

const A1 = "01a09fc9-d204-7551-89d6-38544d07a13a";
const A2 = "01a09fc9-d204-7551-89d6-38544d07a13b";
const U1 = "01a09fc9-d204-7551-89d6-38544d07a13c";

const participants: Participant[] = [
  { type: "agent", id: A1, handle: "researcher", aliases: ["res"], displayName: "Researcher" },
  { type: "agent", id: A2, handle: "planner", displayName: "Planner" },
  { type: "user", id: U1, handle: "jang", displayName: "장병현" },
];

describe("parseMentions", () => {
  it("에이전트·사람 토큰을 종류별로 모으고 중복을 제거하며 등장 순서를 지킨다", () => {
    const body = `<@a:${A2}> 그리고 <@u:${U1}> 또 <@a:${A1}> 다시 <@a:${A2}>`;
    expect(parseMentions(body)).toEqual({ agents: [A2, A1], users: [U1] });
  });
  it("토큰이 없으면 빈 집합", () => {
    expect(parseMentions("hello @researcher")).toEqual({ agents: [], users: [] });
  });
  it("정규식은 전역 플래그를 가진다", () => {
    expect(MENTION_TOKEN_RE.flags).toContain("g");
  });
});

describe("segment", () => {
  it("텍스트와 멘션 세그먼트로 나눈다", () => {
    expect(segment(`안녕 <@a:${A1}>!`)).toEqual([
      { kind: "text", text: "안녕 " },
      { kind: "mention", type: "agent", id: A1 },
      { kind: "text", text: "!" },
    ]);
  });
  it("멘션만 있는 본문", () => {
    expect(segment(`<@u:${U1}>`)).toEqual([{ kind: "mention", type: "user", id: U1 }]);
  });
});

describe("renderForAgent", () => {
  it("토큰을 @handle로 치환한다", () => {
    expect(renderForAgent(`<@a:${A2}> 이거 봐줘 <@u:${U1}>`, participants)).toBe("@planner 이거 봐줘 @jang");
  });
  it("모르는 토큰은 @unknown", () => {
    expect(renderForAgent("<@a:01a09fc9-d204-7551-89d6-000000000000> hi", participants)).toBe("@unknown hi");
  });
});

describe("tokenize", () => {
  it("참여자 핸들·별칭을 토큰으로 바꾸고 mentions를 파생한다", () => {
    const r = tokenize("@planner 와 @res 확인해줘. @nobody 는 무시", participants);
    expect(r.bodyMd).toBe(`<@a:${A2}> 와 <@a:${A1}> 확인해줘. @nobody 는 무시`);
    expect(r.mentions).toEqual({ agents: [A2, A1], users: [] });
  });
  it("대소문자를 무시한다", () => {
    expect(tokenize("@Planner", participants).bodyMd).toBe(`<@a:${A2}>`);
  });
  it("이메일 주소의 @는 건드리지 않는다", () => {
    expect(tokenize("메일은 a@planner.com", participants).bodyMd).toBe("메일은 a@planner.com");
  });
  it("코드 블록·인라인 코드 안은 건드리지 않는다", () => {
    const text = "```\n@planner\n```\n그리고 `@jang` 그러나 @jang";
    expect(tokenize(text, participants).bodyMd).toBe(
      `\`\`\`\n@planner\n\`\`\`\n그리고 \`@jang\` 그러나 <@u:${U1}>`,
    );
  });
  it("renderForAgent와 왕복한다", () => {
    const body = `<@a:${A1}> 다음 <@u:${U1}> 끝`;
    expect(tokenize(renderForAgent(body, participants), participants).bodyMd).toBe(body);
  });
});
