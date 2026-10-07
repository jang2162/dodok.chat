import { z } from "zod";
import { Id } from "./common";

/** 저장 본문의 멘션 토큰. 그룹1: a|u, 그룹2: uuid */
export const MENTION_TOKEN_RE = /<@(a|u):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** 평문 멘션. 그룹1: 앞 문맥(문장 시작/공백/구두점), 그룹2: 핸들. 뒤는 단어 경계. 대소문자 무시. */
export const PLAIN_MENTION_RE = /(^|[^\w@])@([a-z0-9_-]{2,32})(?![\w-])/gi;

export const MentionSet = z.object({ agents: z.array(Id), users: z.array(Id) });
export type MentionSet = z.infer<typeof MentionSet>;

export type Participant = {
  type: "agent" | "user";
  id: string;
  handle: string;
  aliases?: string[];
  displayName: string;
};

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; type: "agent" | "user"; id: string };

/**
 * 남이 보낸 원문(웹훅 본문 등)을 본문에 그대로 실을 때 — 그 안의 멘션 토큰 꼴이 멘션으로 읽히지 않게 `<` 와 `@` 사이에 보이지 않는
 * 단어 잇기(U+2060)를 넣는다. 보이는 글자는 그대로다. parseMentions 는 코드 블록을 가리지 않으므로 펜스 안에 있어도 이것을 거쳐야 한다
 */
export function neutralizeMentionTokens(text: string): string {
  return text.replace(MENTION_TOKEN_RE, (token) => `<\u2060${token.slice(1)}`);
}

export function parseMentions(bodyMd: string): MentionSet {
  const agents: string[] = [];
  const users: string[] = [];
  for (const m of bodyMd.matchAll(MENTION_TOKEN_RE)) {
    const kind = m[1];
    const id = m[2] as string;
    const list = kind === "a" ? agents : users;
    if (!list.includes(id)) list.push(id);
  }
  return { agents, users };
}

export function segment(bodyMd: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of bodyMd.matchAll(MENTION_TOKEN_RE)) {
    const idx = m.index as number;
    if (idx > last) out.push({ kind: "text", text: bodyMd.slice(last, idx) });
    out.push({ kind: "mention", type: m[1] === "a" ? "agent" : "user", id: m[2] as string });
    last = idx + m[0].length;
  }
  if (last < bodyMd.length) out.push({ kind: "text", text: bodyMd.slice(last) });
  return out;
}

export function renderForAgent(bodyMd: string, participants: Participant[]): string {
  const byKey = new Map(participants.map((p) => [`${p.type === "agent" ? "a" : "u"}:${p.id}`, p]));
  return bodyMd.replace(MENTION_TOKEN_RE, (_whole, kind: string, id: string) => {
    const p = byKey.get(`${kind}:${id}`);
    return p ? `@${p.handle}` : "@unknown";
  });
}

export function tokenize(
  text: string,
  participants: Participant[],
): { bodyMd: string; mentions: MentionSet } {
  const byHandle = new Map<string, Participant>();
  for (const p of participants) {
    byHandle.set(p.handle.toLowerCase(), p);
    for (const a of p.aliases ?? []) byHandle.set(a.toLowerCase(), p);
  }
  const bodyMd = splitCode(text)
    .map((part) =>
      part.code
        ? part.text
        : part.text.replace(PLAIN_MENTION_RE, (whole: string, pre: string, handle: string) => {
            const p = byHandle.get(handle.toLowerCase());
            if (!p) return whole;
            return `${pre}<@${p.type === "agent" ? "a" : "u"}:${p.id}>`;
          }),
    )
    .join("");
  return { bodyMd, mentions: parseMentions(bodyMd) };
}

/**
 * 본문의 평문 `@핸들` — tokenize 가 풀어 보려는 것과 같은 집합(코드 밖, 앞뒤 문맥 규칙 같음). 소문자, 처음 나온 차례, 중복 없음.
 * 게시하기 전에 어느 핸들이 멘션으로 풀릴지 미리 볼 때 쓴다(서버 자동화 목록의 경고)
 */
export function plainMentionHandles(text: string): string[] {
  const handles = new Set<string>();
  for (const part of splitCode(text)) {
    if (part.code) continue;
    for (const m of part.text.matchAll(PLAIN_MENTION_RE)) handles.add((m[2] as string).toLowerCase());
  }
  return [...handles];
}

/** 펜스 코드 블록(```...```)과 인라인 코드(`...`)를 분리한다. */
function splitCode(text: string): Array<{ text: string; code: boolean }> {
  const re = /```[\s\S]*?```|`[^`\n]*`/g;
  const out: Array<{ text: string; code: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index as number;
    if (idx > last) out.push({ text: text.slice(last, idx), code: false });
    out.push({ text: m[0], code: true });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false });
  return out;
}
