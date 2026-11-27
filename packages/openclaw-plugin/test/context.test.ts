import {
  formatReactionFacts,
  type InboundDeliver,
  type InboundReaction,
  type InboundThreadUpdate,
} from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText, channelPromptContext, formatInboundContext } from "../src/context";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const deliver: InboundDeliver = {
  deliveryId: "01a09fc9-d204-7551-89d6-38544d07a101",
  kind: "message",
  channelId: CH,
  conversationId: CH,
  conversationTitle: "배포 점검",
  agentId: "researcher",
  sessionKey: `agent:researcher:dodok:channel:${CH}`,
  runId: "01a09fc9-d204-7551-89d6-38544d07a103",
  message: {
    id: "01a09fc9-d204-7551-89d6-38544d07a104",
    author: { type: "user", handle: "jang", displayName: "장병현" },
    text: "@researcher 이 버그 원인 찾아줘",
    attachments: [],
    ts: "2026-09-14T00:14:00Z",
  },
  context: {
    recentMessages: [
      {
        author: { type: "user", handle: "jang", displayName: "장병현" },
        text: "로그인이 가끔 실패해",
        ts: "2026-09-14T00:12:00Z",
      },
      {
        author: { type: "agent", handle: "planner", displayName: "Planner" },
        text: "재현 조건을 모아보죠",
        ts: "2026-09-14T00:13:00Z",
      },
    ],
    participants: [
      { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
      { type: "agent", handle: "researcher", displayName: "Researcher", isSelf: true },
      { type: "agent", handle: "planner", displayName: "Planner", isSelf: false },
    ],
    relayRules:
      "다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
    channelPrompt: "이 채널은 버그 분류용입니다.",
    promptOverride: "간결하게 답하세요.",
  },
  options: {},
};

/** 워크스페이스 시간대를 Asia/Seoul 로 실은 delivery — 서버가 `context.timeZone` 을 채운다 */
const seoul = (d: InboundDeliver): InboundDeliver => ({
  ...d,
  context: { ...d.context, timeZone: "Asia/Seoul" },
});

describe("formatInboundContext", () => {
  it("첫 줄의 session= 은 대화 id 다 — 채널 id 와 다른 세션이면 둘 다 싣는다(OpenClaw chat_id·세션 키의 그 id)", () => {
    const CONV = "01a09fc9-d204-7551-89d6-38544d07a1aa";
    expect(formatInboundContext({ ...deliver, conversationId: CONV }).split("\n")[0]).toBe(
      `[dodok context] channel=${CH} session=${CONV} you=@researcher`,
    );
  });

  it("스펙 8.3 형식 (Asia/Seoul 시각) — channelPrompt·promptOverride 줄은 헤더에 넣지 않는다", () => {
    expect(formatInboundContext(seoul(deliver))).toBe(
      [
        `[dodok context] channel=${CH} session=${CH} you=@researcher`,
        "세션: 배포 점검",
        "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)",
        "릴레이 규칙: 다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
        "시각 기준: Asia/Seoul (UTC+09:00)",
        "최근 대화:",
        "[09:12] @jang: 로그인이 가끔 실패해",
        "[09:13] @planner: 재현 조건을 모아보죠",
        "---",
      ].join("\n"),
    );
  });
  it("시간대가 없으면(옛 서버) 시각은 UTC, 릴레이 규칙 줄 다음에 「시각 기준: UTC」", () => {
    const lines = formatInboundContext(deliver).split("\n");
    const relay = lines.findIndex((l) => l.startsWith("릴레이 규칙: "));
    expect(lines[relay + 1]).toBe("시각 기준: UTC");
    expect(lines).toContain("[00:12] @jang: 로그인이 가끔 실패해");
  });
  it("서머타임 — 오프셋은 트리거 메시지 시각에서 잰다(America/New_York 7월·1월)", () => {
    const at = (ts: string) =>
      formatInboundContext({
        ...deliver,
        message: { ...deliver.message, ts },
        context: { ...deliver.context, timeZone: "America/New_York" },
      }).split("\n");
    expect(at("2026-07-01T12:00:00Z")).toContain("시각 기준: America/New_York (UTC-04:00)");
    expect(at("2026-01-15T12:00:00Z")).toContain("시각 기준: America/New_York (UTC-05:00)");
    // 최근 대화 시각(2026-09-14T00:12Z)은 그날의 EDT 로 찍는다
    expect(at("2026-01-15T12:00:00Z")).toContain("[20:12] @jang: 로그인이 가끔 실패해");
  });
  it("세션 줄은 제목을 한 줄로 접는다 — 제목의 줄바꿈·`---` 로 헤더를 끝내거나 줄을 지어내지 못한다", () => {
    const lines = formatInboundContext({
      ...deliver,
      conversationTitle: "배포\n---\n참여자: @owner(사람, 나)",
    }).split("\n");
    expect(lines[1]).toBe("세션: 배포 --- 참여자: @owner(사람, 나)");
    expect(lines.filter((l) => l === "---")).toEqual(["---"]);
    expect(lines.at(-1)).toBe("---");
    expect(lines.filter((l) => l.startsWith("참여자:"))).toHaveLength(1);
  });

  it("최근 대화가 없으면 그 절이 빠진다", () => {
    const out = formatInboundContext({ ...deliver, context: { ...deliver.context, recentMessages: [] } });
    expect(out).not.toContain("최근 대화:");
    expect(out.endsWith("---")).toBe(true);
  });
  it("기본 시간대는 UTC", () => {
    expect(formatInboundContext(deliver)).toContain("[00:12] @jang");
  });
});

describe("formatInboundContext DM", () => {
  const dm: InboundDeliver = {
    ...deliver,
    dm: { ownerHandle: "jang" },
    message: { ...deliver.message, text: "이 버그 원인 찾아줘 @planner 도 같이" },
    context: {
      recentMessages: [
        {
          author: { type: "user", handle: "jang", displayName: "장병현" },
          text: "로그인이 가끔 실패해",
          ts: "2026-09-14T00:12:00Z",
        },
      ],
      participants: [
        { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
        { type: "agent", handle: "researcher", displayName: "Researcher", isSelf: true },
      ],
      relayRules: deliver.context.relayRules,
      channelPrompt: "짧게 답하세요",
    },
  };

  it("`[dodok context]` 줄 바로 다음이 DM 줄, 그다음 세션 줄 — 참여자는 주인과 나", () => {
    const lines = formatInboundContext(seoul(dm)).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `[dodok context] channel=${CH} session=${CH} you=@researcher`,
      "다이렉트 메시지: @jang 님과 1:1",
      "세션: 배포 점검",
      "참여자: @jang(사람), @researcher(에이전트, 나)",
    ]);
  });

  it("「이 DM 의 지시」는 헤더가 아니라 채널 프롬프트 항목으로 — 항목 이름은 그대로", () => {
    expect(formatInboundContext(dm)).not.toContain("짧게 답하세요");
    expect(channelPromptContext(dm)).toEqual(["채널 프롬프트: 짧게 답하세요"]);
  });

  it("dm 이 없으면 DM 줄이 없다 — 일반 채널 헤더는 이전과 글자까지 같다", () => {
    expect(formatInboundContext(deliver)).not.toContain("다이렉트 메시지");
  });
});

describe("formatInboundContext 그룹 DM", () => {
  const group: InboundDeliver = {
    ...deliver,
    groupDm: true,
    context: {
      ...deliver.context,
      participants: [
        { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
        { type: "user", handle: "mia", displayName: "Mia", isSelf: false },
        { type: "agent", handle: "researcher", displayName: "Researcher", isSelf: true },
        { type: "agent", handle: "planner", displayName: "Planner", isSelf: false },
      ],
    },
  };

  it("`[dodok context]` 줄 바로 다음이 그룹 DM 줄, 그다음 세션 줄 — 참여자는 그룹의 참여자 전부", () => {
    const lines = formatInboundContext(seoul(group)).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `[dodok context] channel=${CH} session=${CH} you=@researcher`,
      "그룹 DM: 참여자만 보는 대화",
      "세션: 배포 점검",
      "참여자: @jang(사람), @mia(사람), @researcher(에이전트, 나), @planner(에이전트)",
    ]);
  });

  it("groupDm 이 없으면 그룹 DM 줄이 없다", () => {
    expect(formatInboundContext(deliver)).not.toContain("그룹 DM");
  });
});

describe("formatInboundContext — 세션에 초대한 에이전트 [세션 에이전트 초대 스펙 5.2]", () => {
  const participants = [
    ...deliver.context.participants,
    { type: "agent" as const, handle: "guest", displayName: "Guest", isSelf: false, invited: true },
  ];

  it("초대한 에이전트는 `(에이전트, 초대됨)` — 초대받지 않은 에이전트의 헤더에는 세션 초대 줄이 없다", () => {
    const text = formatInboundContext({ ...deliver, context: { ...deliver.context, participants } });
    expect(text).toContain(
      "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트), @guest(에이전트, 초대됨)",
    );
    expect(text).not.toContain("세션 초대:");
  });

  it("자기 자신이 초대받았으면 세션 줄 바로 다음에 세션 초대 줄", () => {
    const asGuest = participants.map((p) => ({ ...p, isSelf: p.handle === "guest" }));
    const lines = formatInboundContext({
      ...deliver,
      agentId: "guest",
      context: { ...deliver.context, participants: asGuest },
    }).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `[dodok context] channel=${CH} session=${CH} you=@guest`,
      "세션: 배포 점검",
      "세션 초대: 이 세션에만 초대됐습니다 — 이 채널의 다른 세션에서는 불리지 않습니다.",
      "참여자: @jang(사람), @researcher(에이전트), @planner(에이전트), @guest(에이전트, 나, 초대됨)",
    ]);
  });
});

describe("formatInboundContext 리액션", () => {
  const REACTIONS: InboundReaction[] = [
    {
      messageId: "01a09fc9-d204-7551-89d6-38544d07a110",
      excerpt: "재현 조건",
      emoji: "👍",
      by: "jang",
      at: "2026-09-14T00:15:00Z",
    },
    {
      messageId: "01a09fc9-d204-7551-89d6-38544d07a111",
      excerpt: "원인 후보",
      emoji: "🎉",
      by: "mia",
      at: "2026-09-14T00:16:00Z",
    },
  ];
  const withReactions = (reactions?: InboundReaction[], reactionsOmitted?: number): InboundDeliver => ({
    ...deliver,
    context: { ...deliver.context, reactions, reactionsOmitted },
  });

  it("리액션이 있으면 `---` 바로 앞에 formatReactionFacts 결과를 줄째로 싣는다", () => {
    const lines = formatInboundContext(seoul(withReactions(REACTIONS, 3))).split("\n");
    const facts = formatReactionFacts(REACTIONS, 3).split("\n");
    expect(lines.at(-1)).toBe("---");
    expect(lines.slice(-1 - facts.length, -1)).toEqual(facts);
  });
  it("없거나 빈 배열이면 반응 줄이 없고 헤더는 이전과 글자까지 같다", () => {
    const base = formatInboundContext(seoul(deliver));
    expect(formatInboundContext(seoul(withReactions(undefined)))).toBe(base);
    expect(formatInboundContext(seoul(withReactions([], 2)))).toBe(base);
    expect(base).not.toContain("반응(");
  });
});

describe("formatInboundContext 스레드 소식", () => {
  const UPDATES: InboundThreadUpdate[] = [
    {
      rootId: "01a09fc9-d204-7551-89d6-38544d07a1bb",
      rootExcerpt: "pick 폼 제출",
      newReplies: 4,
      recent: [
        {
          author: { type: "user", handle: "jang", displayName: "장병현" },
          text: "제출 된 폼인데?",
          ts: "2026-09-14T00:28:00Z",
        },
        {
          author: { type: "agent", handle: "researcher", displayName: "Researcher" },
          text: "제가 잘못 말했습니다.",
          ts: "2026-09-14T00:29:00Z",
        },
      ],
    },
  ];
  const REACTIONS: InboundReaction[] = [
    {
      messageId: "01a09fc9-d204-7551-89d6-38544d07a110",
      excerpt: "재현 조건",
      emoji: "👍",
      by: "jang",
      at: "2026-09-14T00:15:00Z",
    },
  ];

  it("「최근 대화」 절 다음, 반응 줄 앞에 「스레드 소식」 절 (Asia/Seoul 시각)", () => {
    const lines = formatInboundContext(
      seoul({
        ...deliver,
        context: {
          ...deliver.context,
          threadUpdates: UPDATES,
          threadUpdatesOmitted: 2,
          reactions: REACTIONS,
        },
      }),
    ).split("\n");
    const recent = lines.indexOf("[09:13] @planner: 재현 조건을 모아보죠");
    const facts = formatReactionFacts(REACTIONS).split("\n");
    expect(lines.slice(recent + 1, recent + 6)).toEqual([
      "스레드 소식(지난 턴 뒤 이 세션의 스레드에 새로 달린 답글):",
      "- threadRootId=01a09fc9-d204-7551-89d6-38544d07a1bb 「pick 폼 제출」 새 답글 4(최근 2):",
      "  [09:28] @jang: 제출 된 폼인데?",
      "  [09:29] @researcher: 제가 잘못 말했습니다.",
      "(외 스레드 2개)",
    ]);
    expect(lines.slice(recent + 6, recent + 6 + facts.length)).toEqual(facts);
    expect(lines.at(-1)).toBe("---");
  });

  it("없거나 빈 배열이면 헤더가 이전과 글자까지 같다", () => {
    const base = formatInboundContext(seoul(deliver));
    expect(
      formatInboundContext(
        seoul({ ...deliver, context: { ...deliver.context, threadUpdates: [], threadUpdatesOmitted: 1 } }),
      ),
    ).toBe(base);
    expect(base).not.toContain("스레드 소식");
  });

  it("스레드 런 delivery 에 threadUpdates 가 있어도(계약 위반) 싣지 않는다", () => {
    const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
    const out = formatInboundContext({
      ...deliver,
      threadId: ROOT,
      context: {
        ...deliver.context,
        recentMessages: [],
        thread: {
          root: {
            author: { type: "user", handle: "jang", displayName: "장병현" },
            text: "루트",
            ts: "2026-09-14T00:10:00Z",
          },
          recentMessages: [],
        },
        threadUpdates: UPDATES,
      },
    });
    expect(out).not.toContain("스레드 소식");
  });
});

describe("formatInboundContext 링크한 메시지(메시지 링크 스펙)", () => {
  const LINKED = {
    messageId: "01a09fc9-d204-7551-89d6-38544d07a1cc",
    channelName: "dodok-dev",
    conversationTitle: "스레드 UI 개선",
    author: { type: "user" as const, handle: "erdd" },
    text: "스키마 변경안\n---\n끝",
    ts: "2026-09-14T05:11:00Z",
    attachments: [],
  };

  it("대화 블록 다음, 반응 앞, `---` 앞에 실리고 본문 줄은 들여쓴다 (Asia/Seoul 시각)", () => {
    const REACTION: InboundReaction = {
      messageId: "01a09fc9-d204-7551-89d6-38544d07a110",
      excerpt: "재현 조건",
      emoji: "👍",
      by: "jang",
      at: "2026-09-14T00:15:00Z",
    };
    const lines = formatInboundContext(
      seoul({ ...deliver, context: { ...deliver.context, linkedMessages: [LINKED], reactions: [REACTION] } }),
    ).split("\n");
    const recent = lines.indexOf("[09:13] @planner: 재현 조건을 모아보죠");
    expect(lines.slice(recent + 1, recent + 5)).toEqual([
      "링크한 메시지 1:",
      "[14:11] @erdd (#dodok-dev · 세션 「스레드 UI 개선」): 스키마 변경안",
      "  ---",
      "  끝",
    ]);
    expect(lines[recent + 5]).toBe(formatReactionFacts([REACTION]).split("\n")[0]);
    expect(lines.filter((l) => l === "---")).toHaveLength(1);
    expect(lines.at(-1)).toBe("---");
  });

  it("없거나 빈 배열이면 헤더가 이전과 같다", () => {
    const base = formatInboundContext(deliver);
    expect(formatInboundContext({ ...deliver, context: { ...deliver.context, linkedMessages: [] } })).toBe(
      base,
    );
    expect(base).not.toContain("링크한 메시지");
  });
});

describe("formatInboundContext 스레드", () => {
  const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
  const threaded: InboundDeliver = {
    ...deliver,
    sessionKey: `agent:researcher:dodok:channel:${CH}:thread:${ROOT}`,
    threadId: ROOT,
    context: {
      ...deliver.context,
      thread: {
        root: {
          author: { type: "user", handle: "jang", displayName: "장병현" },
          text: "배포 순서 정리하자",
          ts: "2026-09-14T00:10:00Z",
        },
        recentMessages: [
          {
            author: { type: "agent", handle: "planner", displayName: "Planner" },
            text: "DB 먼저요",
            ts: "2026-09-14T00:11:00Z",
          },
        ],
      },
    },
  };

  it("스레드 루트·스레드 최근 줄을 싣고 채널 최근 대화는 싣지 않는다", () => {
    expect(formatInboundContext(seoul(threaded))).toBe(
      [
        `[dodok context] channel=${CH} session=${CH} thread=${ROOT} you=@researcher`,
        "세션: 배포 점검",
        "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)",
        "릴레이 규칙: 다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
        "시각 기준: Asia/Seoul (UTC+09:00)",
        "스레드 루트: [09:10] @jang: 배포 순서 정리하자",
        "스레드 최근:",
        "[09:11] @planner: DB 먼저요",
        "---",
      ].join("\n"),
    );
  });

  it("스레드 런에서도 리액션 블록이 `---` 바로 앞에 실린다", () => {
    const reactions: InboundReaction[] = [
      {
        messageId: "01a09fc9-d204-7551-89d6-38544d07a110",
        excerpt: "DB 먼저요",
        emoji: "👍",
        by: "jang",
        at: "2026-09-14T00:15:00Z",
      },
    ];
    const lines = formatInboundContext(
      seoul({ ...threaded, context: { ...threaded.context, reactions, reactionsOmitted: 2 } }),
    ).split("\n");
    const facts = formatReactionFacts(reactions, 2).split("\n");
    expect(lines.at(-1)).toBe("---");
    expect(lines.slice(-1 - facts.length, -1)).toEqual(facts);
    expect(lines).toContain("스레드 루트: [09:10] @jang: 배포 순서 정리하자");
  });

  it("스레드 최근 메시지가 없으면 그 줄이 빠진다", () => {
    const out = formatInboundContext({
      ...threaded,
      context: { ...threaded.context, thread: { ...threaded.context.thread!, recentMessages: [] } },
    });
    expect(out).toContain("스레드 루트: [00:10] @jang: 배포 순서 정리하자");
    expect(out).not.toContain("스레드 최근:");
    expect(out).not.toContain("최근 대화:");
  });
});

describe("buildInboundText", () => {
  it("헤더 다음 줄에 본문", () => {
    const out = buildInboundText(deliver);
    expect(out.endsWith("---\n@researcher 이 버그 원인 찾아줘")).toBe(true);
  });
});

describe("channelPromptContext", () => {
  it("channelPrompt·promptOverride 를 이 순서로 ChannelPromptContext 항목에 담는다", () => {
    expect(channelPromptContext(deliver)).toEqual([
      "채널 프롬프트: 이 채널은 버그 분류용입니다.",
      "채널 지시: 간결하게 답하세요.",
    ]);
  });
  it("하나만 있으면 그 항목만", () => {
    expect(
      channelPromptContext({ ...deliver, context: { ...deliver.context, promptOverride: undefined } }),
    ).toEqual(["채널 프롬프트: 이 채널은 버그 분류용입니다."]);
    expect(
      channelPromptContext({ ...deliver, context: { ...deliver.context, channelPrompt: undefined } }),
    ).toEqual(["채널 지시: 간결하게 답하세요."]);
  });
  it("둘 다 없으면 undefined", () => {
    expect(
      channelPromptContext({
        ...deliver,
        context: { ...deliver.context, channelPrompt: undefined, promptOverride: undefined },
      }),
    ).toBeUndefined();
  });
});

describe("formatInboundContext — 이어 가는 세션(지난 턴 뒤 새 글만)", () => {
  const withSelf: InboundDeliver = {
    ...deliver,
    context: {
      ...deliver.context,
      recentMessages: [
        ...deliver.context.recentMessages,
        {
          author: { type: "agent", handle: "researcher", displayName: "Researcher" },
          text: "제 앞 답",
          ts: "2026-09-14T00:13:30Z",
        },
      ],
      deliveredUpTo: "2026-09-14T00:12:00Z",
    },
  };

  it("continuing + deliveredUpTo — 커서까지의 글과 자기 글을 빼고 「최근 대화(지난 턴 뒤)」", () => {
    const lines = formatInboundContext(withSelf, { continuing: true }).split("\n");
    expect(lines.slice(lines.indexOf("최근 대화(지난 턴 뒤):"))).toEqual([
      "최근 대화(지난 턴 뒤):",
      "[00:13] @planner: 재현 조건을 모아보죠",
      "---",
    ]);
    expect(lines.join("\n")).not.toContain("로그인이 가끔 실패해");
    expect(lines.join("\n")).not.toContain("제 앞 답");
  });

  it("남는 글이 없으면 「최근 대화: (지난 턴 뒤 새 글 없음)」", () => {
    const out = formatInboundContext(
      { ...withSelf, context: { ...withSelf.context, deliveredUpTo: "2026-09-14T00:13:00Z" } },
      { continuing: true },
    );
    expect(out).toContain("\n최근 대화: (지난 턴 뒤 새 글 없음)\n---");
  });

  it("이어 가지 않으면(기본) 커서가 있어도 지금처럼 전부", () => {
    const out = formatInboundContext(withSelf);
    expect(out).toContain(
      "최근 대화:\n[00:12] @jang: 로그인이 가끔 실패해\n[00:13] @planner: 재현 조건을 모아보죠\n[00:13] @researcher: 제 앞 답",
    );
  });

  it("스레드 세션을 이어 가면 스레드 루트를 뺀다", () => {
    const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
    const out = buildInboundText(
      {
        ...deliver,
        sessionKey: `agent:researcher:dodok:channel:${CH}:thread:${ROOT}`,
        threadId: ROOT,
        context: {
          ...deliver.context,
          deliveredUpTo: "2026-09-14T00:12:00Z",
          thread: {
            root: { author: deliver.message.author, text: "배포 순서 정리하자", ts: "2026-09-14T00:10:00Z" },
            recentMessages: [],
          },
        },
      },
      { continuing: true },
    );
    expect(out).not.toContain("스레드 루트:");
    expect(out).toContain("\n스레드 최근: (지난 턴 뒤 새 글 없음)\n---\n");
  });
});
