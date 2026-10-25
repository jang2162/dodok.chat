import type { JSONContent } from "@tiptap/core";
import { expect, it } from "vitest";
import { parseSlash } from "./slash";

const A = "01a00000-0000-7000-8000-00000000000a";
const U = "01a00000-0000-7000-8000-00000000000b";
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string): JSONContent => ({ type: "text", text });
const mention = (id: string, label = "x"): JSONContent => ({ type: "mention", attrs: { id, label } });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

it("/stop — 뒤에 다른 글이 있어도", () => {
  expect(parseSlash(doc(p(t("/stop"))))).toEqual({ kind: "stop" });
  expect(parseSlash(doc(p(t("/stop 지금 멈춰"))))).toEqual({ kind: "stop" });
  expect(parseSlash(doc(p(t("/stop")), p(t("둘째 문단"))))).toEqual({ kind: "stop" });
});

it("/new 는 명령이 아니다 — 에이전트 멘션이 붙어도 null(일반 메시지)", () => {
  expect(parseSlash(doc(p(t("/new "), mention(`a:${A}`, "dev"))))).toBeNull();
  expect(parseSlash(doc(p(t("/new"))))).toBeNull();
  expect(parseSlash(doc(p(t("/new "), mention(`u:${U}`))))).toBeNull();
});

it("알 수 없는 / 명령·경로·URL 은 null(일반 메시지)", () => {
  expect(parseSlash(doc(p(t("/usr/local/bin 확인해 줘"))))).toBeNull();
  expect(parseSlash(doc(p(t("/stopped"))))).toBeNull();
  expect(parseSlash(doc(p(t("/newest"), mention(`a:${A}`))))).toBeNull();
  expect(parseSlash(doc(p(t("/"))))).toBeNull();
});

it("첫 글자가 / 가 아니면 null — 문서 맨 앞에서만", () => {
  expect(parseSlash(doc(p(t("안녕 /stop"))))).toBeNull();
  expect(parseSlash(doc(p(t(" /stop"))))).toBeNull();
  expect(parseSlash(doc(p(mention(`a:${A}`), t(" /stop"))))).toBeNull();
  expect(parseSlash(doc(p(t("앞")), p(t("/stop"))))).toBeNull();
  expect(parseSlash(doc({ type: "codeBlock", content: [t("/stop")] }))).toBeNull();
  expect(parseSlash(doc(p()))).toBeNull();
  expect(parseSlash({ type: "doc" })).toBeNull();
});
