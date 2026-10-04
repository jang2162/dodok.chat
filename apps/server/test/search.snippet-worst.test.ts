import { SearchQuery, SearchResult } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { messages } from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { searchMessages } from "../src/modules/search/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

// 스니펫 변환(readable.ts)이 특별히 다루는 표시마다 본문 상한(100 000) 가까이 되풀이한 최악 입력 — 정규식 하나가 줄 끝까지 훑고
// 실패한 뒤 몇 글자만 먹는 꼴이 또 숨으면 행 하나에 몇 초가 된다(줄머리 `- ` 되풀이가 그랬다). 목록은 readable.ts 의 정규식·
// inline() 분기에서 뽑았다 — 표시를 새로 다루면 여기에도 넣는다
const TOKEN = "<@a:0199a0b7-0000-7000-8000-00000000d0e1>";
const UNITS = [
  // 줄머리 — FENCE_LINE · HR_LINE · LINE_MARKER
  "```",
  "~~~",
  "---",
  "#",
  "# ",
  ">",
  "> ",
  "- ",
  "* ",
  "+ ",
  "_ ",
  "1. ",
  "1) ",
  "- [ ] ",
  // 인라인 — INLINE_CODE · EMPHASIS · LINK · AUTOLINK · MENTION_AT · ESCAPE
  "`",
  "``",
  "*",
  "**",
  "***",
  "_",
  "__",
  "~",
  "~~",
  "*a ",
  "_a ",
  "**a ",
  "~~a ",
  "[",
  "![",
  "](",
  "[a]",
  "[a](",
  "[![a](",
  '[a](b "',
  "<",
  "<@",
  "<@a:",
  "<http://a",
  "<http://a>",
  TOKEN,
  "\\",
  "\\*",
  // 변환하지 않는 표시·공백 접기·아스트랄 문자
  "|",
  " ",
  "\n",
  "😀",
];
// 짝 없는 서로게이트가 없는가 — String.prototype.isWellFormed(ES2024)는 이 패키지의 lib 밖이다
const wellFormed = (s: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
const NEEDLE = "목표어";
const LIMIT = 99_990;
// 상한은 회귀를 잡을 만큼만 낮게 — 행 하나가 단독 실행에서 몇 ms 인데 루트 병렬 실행(7 패키지)의 부하에서는 한 행이 수백 ms 로
// 튄다. 잡으려는 것은 제곱 꼴 회귀이고 그 꼴은 행 하나가 수 초다: readable.ts 의 lineHead 가 가로줄을 되풀이마다 시도하고
// fenceBefore 가 모든 줄을 lineHead 로 훑게 되돌리면 넘는 행이 4.5 s·17.5 s 다(BOUND_MS 를 -1 로 두고 이 파일을 돌려 실패 목록에서 읽는다).
// 비율(같은 길이 보통 글과 견주기)로 재지 않는 까닭: 튀는 것은 한 행의 순간 부하라 다른 순간에 잰 기준이 함께 튀지 않는다
const BOUND_MS = 2_000;

/** 되풀이 덩어리를 n 등분한 길이만큼 */
const fill = (unit: string, parts: number) => unit.repeat(Math.floor(LIMIT / unit.length / parts));
const SHAPES: Array<[string, (unit: string) => string]> = [
  ["한 줄", (unit) => unit],
  ["줄마다", (unit) => `${unit}\n`],
];
const PLACES: Array<[string, (unit: string) => string]> = [
  ["앞", (unit) => `${NEEDLE}${fill(unit, 1)}`],
  ["가운데", (unit) => `${fill(unit, 2)}${NEEDLE}${fill(unit, 2)}`],
  ["끝", (unit) => `${fill(unit, 1)}${NEEDLE}`],
  // 일치 앞 줄 전체가 창 밖 — 창 앞 줄머리 훑기(펜스 이어받기)를 탄다
  ["끝 — 다음 줄", (unit) => `${fill(unit, 1)}x\n${NEEDLE}`],
];

describe("스니펫 최악 입력 — 표시마다 100 KB 되풀이", () => {
  const db = newTestDb();
  const bus = new ServerBus();
  const { workspaceId, userId } = seedWorkspace(db);
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  const m = createUserMessage(db, bus, {
    channelId: channel.id,
    authorId: userId,
    bodyMd: "임시",
    clientMsgId: "c0",
  });

  it.each(UNITS.map((unit) => [JSON.stringify(unit), unit]))(
    "%s — 한 줄·줄마다 × 앞·가운데·끝·다음 줄",
    (_name, unit) => {
      const slow: string[] = [];
      for (const [shape, shaped] of SHAPES) {
        for (const [place, body] of PLACES) {
          const bodyMd = body(shaped(unit));
          db.update(messages).set({ bodyMd }).where(eq(messages.id, m.id)).run();
          const started = performance.now();
          const result = searchMessages(
            db,
            workspaceId,
            userId,
            SearchQuery.parse({ q: NEEDLE }),
            new Date(),
          );
          const ms = performance.now() - started;
          const snippet = SearchResult.parse(result).hits[0]?.snippet;
          expect(wellFormed(snippet ?? ""), `${shape} ${place}`).toBe(true);
          if (ms > BOUND_MS) slow.push(`${shape} ${place} ${bodyMd.length}자 ${ms.toFixed(0)} ms`);
        }
      }
      expect(slow).toEqual([]);
    },
    120_000,
  );
});
