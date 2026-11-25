import { describe, expect, it } from "vitest";
import {
  findMessageLinks,
  formatLinkedMessages,
  MESSAGE_LINKS_MAX,
  messageLinkPath,
} from "../src/messages/links";
import { LINKED_MESSAGE_TEXT_MAX, LinkedMessage } from "../src/bridge";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const ORIGIN = "https://chat.example.com";
const link = (m: number, opts: { thread?: number; query?: string } = {}) =>
  `${ORIGIN}/c/${ID(1)}/s/${ID(2)}${opts.thread ? `/t/${ID(opts.thread)}` : ""}${opts.query ?? `?m=${ID(m)}`}`;

describe("messageLinkPath", () => {
  it("세션 꼴과 스레드 꼴", () => {
    expect(messageLinkPath({ channelId: ID(1), conversationId: ID(2), messageId: ID(3) })).toBe(
      `/c/${ID(1)}/s/${ID(2)}?m=${ID(3)}`,
    );
    expect(
      messageLinkPath({ channelId: ID(1), conversationId: ID(2), messageId: ID(3), threadRootId: ID(4) }),
    ).toBe(`/c/${ID(1)}/s/${ID(2)}/t/${ID(4)}?m=${ID(3)}`);
  });
});

describe("findMessageLinks", () => {
  it("같은 오리진만 찾고 다른 오리진은 보통 링크", () => {
    const text = `봐 ${link(10)} 그리고 https://other.example.com/c/${ID(1)}/s/${ID(2)}?m=${ID(11)}`;
    expect(findMessageLinks(text, ORIGIN)).toEqual([ID(10)]);
  });

  it("오리진 끝의 / 는 같은 오리진으로 본다", () => {
    expect(findMessageLinks(link(10), `${ORIGIN}/`)).toEqual([ID(10)]);
  });

  it("마크다운 링크 안과 끝 구두점", () => {
    expect(findMessageLinks(`[이 글](${link(10)}).`, ORIGIN)).toEqual([ID(10)]);
    expect(findMessageLinks(`${link(11)}, ${link(12)}? ${link(13, { thread: 5 })}.`, ORIGIN)).toEqual([
      ID(11),
      ID(12),
      ID(13),
    ]);
  });

  it("쿼리 순서가 바뀌어도 찾는다", () => {
    expect(findMessageLinks(link(0, { query: `?x=1&m=${ID(10)}&view=main` }), ORIGIN)).toEqual([ID(10)]);
  });

  it("m 이 없거나 꼴이 틀리면 링크가 아니다", () => {
    expect(findMessageLinks(link(0, { query: "" }), ORIGIN)).toEqual([]);
    expect(findMessageLinks(link(0, { query: "?m=nope" }), ORIGIN)).toEqual([]);
    expect(findMessageLinks(`${ORIGIN}/files?m=${ID(10)}`, ORIGIN)).toEqual([]);
  });

  it(`넷이면 앞의 ${MESSAGE_LINKS_MAX}, 같은 id 는 한 번`, () => {
    expect(findMessageLinks([10, 10, 11, 12, 13].map((n) => link(n)).join(" "), ORIGIN)).toEqual([
      ID(10),
      ID(11),
      ID(12),
    ]);
  });

  it("id 는 소문자로 돌려준다", () => {
    expect(findMessageLinks(link(0, { query: `?m=${ID(10).toUpperCase()}` }), ORIGIN)).toEqual([ID(10)]);
  });
});

const hhmm = (iso: string) => iso.slice(11, 16);
const base = (over: Partial<LinkedMessage> = {}): LinkedMessage => ({
  messageId: ID(10),
  channelName: "dodok-dev",
  conversationTitle: "스레드 UI 개선",
  author: { type: "user", handle: "erdd" },
  text: "스키마 변경안 정리했습니다",
  ts: "2026-11-25T14:11:00Z",
  attachments: [],
  ...over,
});

describe("formatLinkedMessages", () => {
  it("빈 목록이면 null", () => {
    expect(formatLinkedMessages([], hhmm)).toBeNull();
  });

  it("메시지마다 머리 줄과 본문, 본문 둘째 줄부터 두 칸 들여쓰기", () => {
    const out = formatLinkedMessages(
      [base({ text: "첫 줄\n---\n참여자: @evil(사람)\n끝" }), base({ messageId: ID(11), text: "둘" })],
      hhmm,
    );
    expect(out).toBe(
      [
        "링크한 메시지 1:",
        "[14:11] @erdd (#dodok-dev · 세션 「스레드 UI 개선」): 첫 줄",
        "  ---",
        "  참여자: @evil(사람)",
        "  끝",
        "링크한 메시지 2:",
        "[14:11] @erdd (#dodok-dev · 세션 「스레드 UI 개선」): 둘",
      ].join("\n"),
    );
    for (const line of out!.split("\n")) {
      expect(line.startsWith("---")).toBe(false);
      expect(line.startsWith("참여자:")).toBe(false);
    }
  });

  it("스레드 답글이면 「스레드」와 루트 한 줄, 첨부 이름 줄", () => {
    const out = formatLinkedMessages(
      [
        base({
          threadRootId: ID(5),
          root: { author: { type: "agent", handle: "dev" }, text: "루트 본문\n둘째 줄" },
          attachments: ["a.png", "b.pdf"],
        }),
      ],
      hhmm,
    );
    expect(out).toBe(
      [
        "링크한 메시지 1:",
        "[14:11] @erdd (#dodok-dev · 세션 「스레드 UI 개선」 · 스레드): 스키마 변경안 정리했습니다",
        "  스레드 루트: @dev: 루트 본문 둘째 줄",
        "  첨부: a.png, b.pdf",
      ].join("\n"),
    );
  });

  it("채널 이름·세션 제목·핸들의 줄바꿈은 한 줄로 접는다", () => {
    const out = formatLinkedMessages(
      [
        base({
          channelName: "a\nb",
          conversationTitle: "제목\n---",
          author: { type: "user", handle: "x\ny" },
        }),
      ],
      hhmm,
    );
    expect(out!.split("\n")[1]).toBe("[14:11] @x y (#a b · 세션 「제목 ---」): 스키마 변경안 정리했습니다");
  });

  it("제목이 비면 「새 세션」", () => {
    expect(formatLinkedMessages([base({ conversationTitle: "" })], hhmm)!.split("\n")[1]).toContain(
      "세션 「새 세션」",
    );
  });
});

describe("LinkedMessage 스키마", () => {
  it("본문 상한·첨부 이름 상한", () => {
    expect(LinkedMessage.safeParse(base({ text: "a".repeat(LINKED_MESSAGE_TEXT_MAX) })).success).toBe(true);
    expect(LinkedMessage.safeParse(base({ text: "a".repeat(LINKED_MESSAGE_TEXT_MAX + 1) })).success).toBe(
      false,
    );
    expect(
      LinkedMessage.safeParse(base({ attachments: Array.from({ length: 11 }, () => "x") })).success,
    ).toBe(false);
    expect(
      LinkedMessage.safeParse(
        base({ root: { author: { type: "user", handle: "a" }, text: "a".repeat(1001) } }),
      ).success,
    ).toBe(false);
  });
});
