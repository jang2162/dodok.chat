import { describe, expect, it } from "vitest";
import {
  MENTION_TOKEN_RE,
  neutralizeMentionTokens,
  type Participant,
  parseMentions,
  plainMentionHandles,
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
  describe("한글 핸들", () => {
    const A3 = "01a09fc9-d204-7551-89d6-38544d07a13d";
    const A4 = "01a09fc9-d204-7551-89d6-38544d07a13e";
    const U2 = "01a09fc9-d204-7551-89d6-38544d07a13f";
    const ko: Participant[] = [
      ...participants,
      { type: "agent", id: A3, handle: "개발봇", aliases: ["개발"], displayName: "개발봇" },
      { type: "agent", id: A4, handle: "개발봇2", displayName: "개발봇 둘" },
      { type: "user", id: U2, handle: "지은", displayName: "지은" },
    ];

    it("한글 핸들·별칭을 토큰으로 바꾼다", () => {
      expect(tokenize("@개발봇 확인해줘, @지은 도", ko).bodyMd).toBe(`<@a:${A3}> 확인해줘, <@u:${U2}> 도`);
      expect(tokenize("@개발 봐줘", ko).bodyMd).toBe(`<@a:${A3}> 봐줘`);
    });

    it("붙여 쓴 조사는 떼고 가장 긴 아는 핸들을 멘션한다 — 조사는 본문에 남는다", () => {
      expect(tokenize("@개발봇에게 물어봐", ko).bodyMd).toBe(`<@a:${A3}>에게 물어봐`);
      expect(tokenize("@지은님 안녕", ko).bodyMd).toBe(`<@u:${U2}>님 안녕`);
      // 「개발」(별칭)보다 긴 「개발봇」이 이긴다
      expect(tokenize("@개발봇이 했어", ko).bodyMd).toBe(`<@a:${A3}>이 했어`);
      // 영문 핸들 뒤 조사도 그대로(전에도 그랬다)
      expect(tokenize("@planner에게", ko).bodyMd).toBe(`<@a:${A2}>에게`);
    });

    it("떼어 낸 꼬리가 한글 음절만일 때만 자른다 — 영문·숫자가 섞이면 멘션이 아니다", () => {
      // 「개발봇2」는 따로 있는 핸들이다 — 숫자를 떼어 「개발봇」으로 읽지 않는다
      expect(tokenize("@개발봇2 와", ko).bodyMd).toBe(`<@a:${A4}> 와`);
      expect(tokenize("@개발봇x 와", ko).bodyMd).toBe("@개발봇x 와");
      expect(tokenize("@plannerx 와", ko).bodyMd).toBe("@plannerx 와");
    });

    it("모르는 한글 핸들은 평문으로 남는다", () => {
      expect(tokenize("@없는사람에게", ko).bodyMd).toBe("@없는사람에게");
    });

    it("NFD(조합형)로 쓴 멘션도 NFC 핸들로 풀린다", () => {
      const text = "@개발봇에게 물어봐".normalize("NFD");
      // 멘션 자리(조사 포함)만 NFC 로 바뀌고 나머지 본문은 보낸 그대로다
      expect(tokenize(text, ko).bodyMd).toBe(`<@a:${A3}>에게 ${"물어봐".normalize("NFD")}`);
    });

    it("plainMentionHandles 도 아는 핸들 판정을 받으면 조사를 뗀다, 없으면 이어진 글자 전부", () => {
      const known = new Set(["개발봇", "지은"]);
      expect(plainMentionHandles("@개발봇에게 @지은님 @없는이", (h) => known.has(h))).toEqual([
        "개발봇",
        "지은",
        "없는이",
      ]);
      expect(plainMentionHandles("@개발봇에게")).toEqual(["개발봇에게"]);
    });
  });

  it("renderForAgent와 왕복한다", () => {
    const body = `<@a:${A1}> 다음 <@u:${U1}> 끝`;
    expect(tokenize(renderForAgent(body, participants), participants).bodyMd).toBe(body);
  });
});

describe("plainMentionHandles", () => {
  it("코드 밖의 평문 @핸들 — 소문자, 처음 나온 차례, 중복 없음(이메일·코드 안은 빠진다)", () => {
    const text = "@Planner 와 @res 확인. @nobody, `@code`\n```\n@fenced\n```\na@planner.com @planner 다시";
    expect(plainMentionHandles(text)).toEqual(["planner", "res", "nobody"]);
  });

  it("tokenize 가 풀어 보려는 핸들과 같다 — 풀린 것은 토큰이 되고 나머지는 평문으로 남는다", () => {
    const text = "@planner 와 @ghost `@jang` @jang";
    const handles = plainMentionHandles(text);
    expect(handles).toEqual(["planner", "ghost", "jang"]);
    expect(tokenize(text, participants).bodyMd).toBe(`<@a:${A2}> 와 @ghost \`@jang\` <@u:${U1}>`);
  });

  it("멘션이 없으면 빈 목록", () => {
    expect(plainMentionHandles("멘션 없음 a@b.com")).toEqual([]);
  });
});

describe("neutralizeMentionTokens", () => {
  it("토큰 꼴만 멘션으로 읽히지 않게 바꾸고, 보이는 글자는 그대로다 — 평문 @핸들·다른 꼴은 건드리지 않는다", () => {
    const raw = `{"a":"<@a:${A1}>","u":"<@u:${U1}>","x":"<@a:${A1}><@a:${A1}>"} @researcher <@x:${A1}> <@a:not-a-uuid>`;
    const out = neutralizeMentionTokens(raw);
    expect(parseMentions(out)).toEqual({ agents: [], users: [] });
    expect([...out.matchAll(MENTION_TOKEN_RE)]).toHaveLength(0);
    expect(out.replaceAll("\u2060", "")).toBe(raw);
    expect(segment(out)).toEqual([{ kind: "text", text: out }]);
  });

  it("토큰이 없으면 같은 문자열", () => {
    expect(neutralizeMentionTokens("평문 @jang `<@a:x>`")).toBe("평문 @jang `<@a:x>`");
  });
});
