import { z } from "zod";
import { Id } from "./common";

/** 저장 본문의 멘션 토큰. 그룹1: a|u, 그룹2: uuid */
export const MENTION_TOKEN_RE = /<@(a|u):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** 핸들 한 글자 — 영문 소문자·숫자·_·- 와 한글 완성형 음절(가~힣). shared `Handle` 이 이것으로 2~32글자를 잰다 */
export const HANDLE_CHAR_CLASS = "a-z0-9_가-힣-";
const HANDLE_RE = new RegExp(`^[${HANDLE_CHAR_CLASS}]{2,32}$`, "u");
/** 핸들 뒤에 붙여 쓴 조사로 떼어 낼 수 있는 꼬리 — 한글 음절만 */
const HANGUL_TAIL_RE = /^[가-힣]+$/u;

/**
 * 평문 멘션 후보. 그룹1: 앞 문맥(문장 시작/공백/구두점·한글), 그룹2: `@` 뒤에 이어진 핸들 글자 전부(ASCII 대문자 포함, NFD 로 온
 * 한글 자모 포함). 이어진 글자가 곧 핸들은 아니다 — 「@개발봇에게」처럼 조사가 붙을 수 있어 `resolveMentionRun` 으로 핸들을 가른다.
 * `i` 플래그를 쓰지 않는다 — `iu` 는 유니코드 대소문자 접기라 켈빈 기호(U+212A)를 k 로 잡는다. 대문자는 A-Z 만 받는다
 */
export const PLAIN_MENTION_RE = new RegExp(`(^|[^\\w@])@([${HANDLE_CHAR_CLASS}A-Z\\u1100-\\u11ff]+)`, "gu");

/**
 * `PLAIN_MENTION_RE` 그룹2 → 멘션할 핸들(소문자·NFC)과 그 뒤에 남는 꼬리(NFC). 핸들이 아니면 undefined.
 * `isKnown` 은 워크스페이스가 아는 핸들 전부(사람·에이전트, 보관·비활성·채널 밖·별칭 포함)여야 한다 — 이 대화의 참가자만 주면
 * 채널 밖 「개발봇」 대신 채널 안 「개발」이 「@개발봇에게」를 가로챈다. 고른 핸들이 이 대화의 대상인지는 부르는 쪽이 따로 본다.
 * - 이어진 글자 전부가 핸들 꼴이고 `isKnown` 이 없거나 그것을 알면 전부가 핸들이다.
 * - 아니면 `isKnown` 이 아는 가장 긴 앞부분을 핸들로 — 남는 꼬리가 한글 음절만일 때만(붙여 쓴 조사: 「@개발봇에게」·「@dev님」).
 *   꼬리에 영문·숫자가 섞이면(「@개발봇x」) 자르지 않는다 — 영문 핸들이 `@devs` 를 dev 로 읽지 않던 것과 같다.
 * - 그래도 없으면 이어진 글자 전부(꼴이 맞을 때) — 모르는 핸들. tokenize 는 평문으로 두고, 미리 보기는 경고에 쓴다
 */
export function resolveMentionRun(
  run: string,
  isKnown?: (handle: string) => boolean,
): { handle: string; rest: string } | undefined {
  const text = run.normalize("NFC").toLowerCase();
  const whole = HANDLE_RE.test(text) ? text : undefined;
  if (whole !== undefined && (!isKnown || isKnown(whole))) return { handle: whole, rest: "" };
  if (isKnown) {
    for (let end = Math.min(text.length, 32); end >= 2; end--) {
      const handle = text.slice(0, end);
      const rest = text.slice(end);
      if (HANGUL_TAIL_RE.test(rest) && HANDLE_RE.test(handle) && isKnown(handle)) return { handle, rest };
    }
  }
  return whole === undefined ? undefined : { handle: whole, rest: "" };
}

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

/**
 * 평문 `@핸들` 을 참가자 토큰으로. `knownHandles` 는 워크스페이스가 아는 핸들 전부(`resolveMentionRun`) — 그것으로 가장 긴 핸들을
 * 고르고, 그 핸들이 참가자가 아니면 짧은 참가자 핸들로 내려가지 않고 글자로 남긴다(「@개발봇에게」는 채널 밖 개발봇이지 채널의 개발이
 * 아니다). 안 주면 참가자만으로 가른다
 */
export function tokenize(
  text: string,
  participants: Participant[],
  knownHandles?: (handle: string) => boolean,
): { bodyMd: string; mentions: MentionSet } {
  const byHandle = new Map<string, Participant>();
  for (const p of participants) {
    byHandle.set(p.handle.normalize("NFC").toLowerCase(), p);
    for (const a of p.aliases ?? []) byHandle.set(a.normalize("NFC").toLowerCase(), p);
  }
  const bodyMd = splitCode(text)
    .map((part) =>
      part.code
        ? part.text
        : part.text.replace(PLAIN_MENTION_RE, (whole: string, pre: string, run: string) => {
            const found = resolveMentionRun(run, (h) => byHandle.has(h) || knownHandles?.(h) === true);
            const p = found && byHandle.get(found.handle);
            if (!p) return whole;
            return `${pre}<@${p.type === "agent" ? "a" : "u"}:${p.id}>${found.rest}`;
          }),
    )
    .join("");
  return { bodyMd, mentions: parseMentions(bodyMd) };
}

/**
 * 본문의 평문 `@핸들` — tokenize 가 풀어 보려는 것과 같은 집합(코드 밖, 앞뒤 문맥 규칙 같음). 소문자·NFC, 처음 나온 차례, 중복 없음.
 * 게시하기 전에 어느 핸들이 멘션으로 풀릴지 미리 볼 때 쓴다(서버 자동화 목록의 경고). `isKnown` 을 주면 붙여 쓴 조사를 그것으로
 * 뗀다(`resolveMentionRun`) — 안 주면 이어진 핸들 글자 전부다
 */
export function plainMentionHandles(text: string, isKnown?: (handle: string) => boolean): string[] {
  const handles = new Set<string>();
  for (const part of splitCode(text)) {
    if (part.code) continue;
    for (const m of part.text.matchAll(PLAIN_MENTION_RE)) {
      const found = resolveMentionRun(m[2] as string, isKnown);
      if (found) handles.add(found.handle);
    }
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
