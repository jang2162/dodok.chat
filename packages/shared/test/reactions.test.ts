import { describe, expect, it } from "vitest";
import { InboundContext } from "../src/bridge";
import { Message, REACTION_EMOJIS, ReactionEmoji } from "../src/domain";
import { formatReactionFacts } from "../src/reactions";
import { ReactionSet } from "../src/wire";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;

const reaction = (n: number, emoji: ReactionEmoji, by: string, at: string, excerpt = "본문") => ({
  messageId: ID(n),
  excerpt,
  emoji,
  by,
  at,
});

describe("ReactionEmoji", () => {
  it("고정 8종만 받는다", () => {
    expect(REACTION_EMOJIS).toEqual(["👍", "👎", "❤️", "😂", "🎉", "👀", "✅", "❓"]);
    for (const e of REACTION_EMOJIS) expect(ReactionEmoji.safeParse(e).success).toBe(true);
    expect(ReactionEmoji.safeParse("🔥").success).toBe(false);
  });
});

describe("ReactionSet", () => {
  it("켜기/끄기 — on 은 불리언이어야 한다", () => {
    expect(ReactionSet.safeParse({ messageId: ID(1), emoji: "👍", on: true }).success).toBe(true);
    expect(ReactionSet.safeParse({ messageId: ID(1), emoji: "👍" }).success).toBe(false);
    expect(ReactionSet.safeParse({ messageId: ID(1), emoji: "🔥", on: true }).success).toBe(false);
  });
});

describe("formatReactionFacts", () => {
  it("비면 빈 문자열", () => {
    expect(formatReactionFacts([])).toBe("");
    expect(formatReactionFacts([], 3)).toBe("");
  });

  it('머리줄 + 줄마다 `- @핸들 이모지 "앞글"`, 넣은 순서와 상관없이 at 오름차순', () => {
    const late = reaction(1, "👎", "owner", "2026-10-07T00:02:00.000Z", "테스트는 모두 통과했습니다");
    const early = reaction(2, "👍", "mia", "2026-10-07T00:01:00.000Z", "배포 순서는");
    expect(formatReactionFacts([late, early])).toBe(
      [
        "반응(지난 턴 뒤 네 메시지에 달린 것):",
        '- @mia 👍 "배포 순서는"',
        '- @owner 👎 "테스트는 모두 통과했습니다"',
      ].join("\n"),
    );
  });

  it("omitted 가 있으면 끝 줄 `(외 n개)`", () => {
    const out = formatReactionFacts([reaction(1, "👍", "mia", "2026-10-07T00:01:00.000Z")], 3);
    expect(out.split("\n").at(-1)).toBe("(외 3개)");
    expect(formatReactionFacts([reaction(1, "👍", "mia", "2026-10-07T00:01:00.000Z")])).not.toContain("외");
  });
});

describe("InboundContext.reactions", () => {
  const base = { recentMessages: [], participants: [], relayRules: "r" };
  const withReactions = {
    ...base,
    reactions: [reaction(1, "👍", "mia", "2026-10-07T00:01:00.000Z")],
    reactionsOmitted: 2,
  };

  it("싣고 파싱한다 — 20개 상한", () => {
    expect(InboundContext.parse(withReactions).reactions).toHaveLength(1);
    const many = Array.from({ length: 21 }, (_, i) =>
      reaction(1, "👍", "mia", `2026-10-07T00:00:${String(i).padStart(2, "0")}.000Z`),
    );
    expect(InboundContext.safeParse({ ...base, reactions: many }).success).toBe(false);
  });

  it("옛 스키마(필드 없는 사본)가 새 페이로드를 받고 그 키를 버린다", () => {
    const old = InboundContext.omit({ reactions: true, reactionsOmitted: true });
    const parsed = old.safeParse(withReactions);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("reactions");
    expect(parsed.data).not.toHaveProperty("reactionsOmitted");
  });
});

describe("Message.reactions", () => {
  it("없이 파싱하면 []", () => {
    const m = Message.parse({
      id: ID(1),
      channelId: ID(2),
      seq: 1,
      kind: "normal",
      authorType: "user",
      authorId: ID(3),
      bodyMd: "hi",
      mentions: { agents: [], users: [] },
      createdAt: "2026-10-07T00:00:00.000Z",
    });
    expect(m.reactions).toEqual([]);
  });
});
