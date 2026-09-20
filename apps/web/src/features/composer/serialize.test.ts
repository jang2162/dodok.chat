import { MENTION_TOKEN_RE, parseMentions } from "@dodok/shared";
import type { JSONContent } from "@tiptap/core";
import { expect, it } from "vitest";
import { toBodyMd } from "./serialize";

const A = "01a00000-0000-7000-8000-00000000000a";
const U = "01a00000-0000-7000-8000-00000000000b";
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text,
  ...(marks ? { marks } : {}),
});
const mention = (id: string, label: string): JSONContent => ({ type: "mention", attrs: { id, label } });

it("멘션 노드는 토큰, 텍스트·마크는 마크다운", () => {
  const doc = {
    type: "doc",
    content: [p(mention(`a:${A}`, "dev"), t(" 안녕 "), t("굵게", [{ type: "bold" }]))],
  };
  expect(toBodyMd(doc)).toBe(`<@a:${A}> 안녕 **굵게**`);
});
it("문단은 빈 줄, hardBreak 는 줄바꿈, 코드 블록 안 @ 는 그대로", () => {
  const doc = {
    type: "doc",
    content: [
      p(t("첫"), { type: "hardBreak" }, t("줄")),
      { type: "codeBlock", attrs: { language: "ts" }, content: [t("const a = '@dev'")] },
    ],
  };
  expect(toBodyMd(doc)).toBe("첫\n줄\n\n```ts\nconst a = '@dev'\n```");
});
it("목록", () => {
  const li = (s: string): JSONContent => ({ type: "listItem", content: [p(t(s))] });
  expect(
    toBodyMd({
      type: "doc",
      content: [
        { type: "bulletList", content: [li("a"), li("b")] },
        { type: "orderedList", content: [li("c")] },
      ],
    }),
  ).toBe("- a\n- b\n\n1. c");
});
it("공백만이면 빈 문자열", () => {
  expect(toBodyMd({ type: "doc", content: [p(t("   "))] })).toBe("");
  expect(toBodyMd({ type: "doc", content: [p()] })).toBe("");
  expect(toBodyMd({ type: "doc" })).toBe("");
});

it("사람 멘션·여러 마크·인용·언어 없는 코드 블록", () => {
  const doc = {
    type: "doc",
    content: [
      p(
        mention(`u:${U}`, "owner"),
        t(" "),
        t("기울임", [{ type: "italic" }]),
        t(" "),
        t("취소", [{ type: "strike" }]),
        t(" "),
        t("x()", [{ type: "code" }]),
      ),
      { type: "blockquote", content: [p(t("인용 1")), p(t("인용 2"))] },
      { type: "codeBlock", attrs: { language: null }, content: [t("a\nb")] },
    ],
  };
  expect(toBodyMd(doc)).toBe(
    `<@u:${U}> *기울임* ~~취소~~ \`x()\`\n\n> 인용 1\n>\n> 인용 2\n\n\`\`\`\na\nb\n\`\`\``,
  );
});

it("번호 목록의 시작 번호, 안에 든 목록은 들여 쓴다", () => {
  const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });
  const doc = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [li(p(t("셋")), { type: "bulletList", content: [li(p(t("안")))] }), li(p(t("넷")))],
      },
    ],
  };
  expect(toBodyMd(doc)).toBe("3. 셋\n  - 안\n4. 넷");
});

it("사이의 빈 문단은 한 번의 빈 줄로 접는다", () => {
  expect(toBodyMd({ type: "doc", content: [p(t("가")), p(), p(t("  ")), p(t("나"))] })).toBe("가\n\n나");
});

it("접두사(a:/u:)가 없는 멘션은 토큰이 아니라 평문 @라벨", () => {
  const doc = { type: "doc", content: [p(mention("dev", "dev"), t(" 안녕"))] };
  expect(toBodyMd(doc)).toBe("@dev 안녕");
});

it("결과 토큰은 shared MENTION_TOKEN_RE·parseMentions 가 받는다", () => {
  const body = toBodyMd({
    type: "doc",
    content: [p(mention(`a:${A}`, "dev"), t(" 와 "), mention(`u:${U}`, "owner"))],
  });
  expect([...body.matchAll(MENTION_TOKEN_RE)]).toHaveLength(2);
  expect(parseMentions(body)).toEqual({ agents: [A], users: [U] });
});

it("줄 머리에 친 블록 표시는 평문으로 — 작성기는 제목·목록 확장이 꺼져 있다", () => {
  const one = (s: string) => toBodyMd({ type: "doc", content: [p(t(s))] });
  expect(one("# 제목")).toBe("\\# 제목");
  expect(one("### 작은 제목")).toBe("\\### 작은 제목");
  expect(one("> 인용")).toBe("\\> 인용");
  expect(one("- 항목")).toBe("\\- 항목");
  expect(one("* 별")).toBe("\\* 별");
  expect(one("+ 더하기")).toBe("\\+ 더하기");
  expect(one("1. 첫째")).toBe("1\\. 첫째");
  expect(one("10) 열째")).toBe("10\\) 열째");
});

it("블록 표시가 아닌 줄 머리는 건드리지 않는다 — 줄마다 따로 본다", () => {
  const one = (s: string) => toBodyMd({ type: "doc", content: [p(t(s))] });
  expect(one("#태그")).toBe("#태그"); // 뒤에 공백이 없으면 제목이 아니다
  expect(one("-5도")).toBe("-5도");
  expect(one("2026년")).toBe("2026년");
  expect(one("값 - 1")).toBe("값 - 1"); // 줄 머리만 본다
  expect(toBodyMd({ type: "doc", content: [p(t("굵게", [{ type: "bold" }]))] })).toBe("**굵게**");
  expect(toBodyMd({ type: "doc", content: [p(t("가"), { type: "hardBreak" }, t("- 둘째 줄"))] })).toBe(
    "가\n\\- 둘째 줄",
  );
});

it("마크 앞뒤 공백은 표시 밖으로 — `**굵게 **` 는 마크다운에서 굵게가 아니다", () => {
  const bold = [{ type: "bold" }];
  expect(toBodyMd({ type: "doc", content: [p(t("가"), t(" 굵게 ", bold), t("나"))] })).toBe("가 **굵게** 나");
  expect(toBodyMd({ type: "doc", content: [p(t("가"), t("  ", bold), t("나"))] })).toBe("가  나");
  expect(toBodyMd({ type: "doc", content: [p(t(" 코드 ", [{ type: "code" }]))] })).toBe("` 코드 `");
});
