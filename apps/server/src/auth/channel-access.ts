import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { channels, runs } from "../db/schema.sqlite";
import { apiError } from "../http/errors";

// 채널 접근 판정 — 누가 이 채널을 읽고 쓰나(에이전트 DM 스펙 4장). 채널·대화·메시지·런·승인·첨부를 내보내거나 바꾸는 모든 경로가
// 이 파일의 함수를 지난다. 역할 판정(403)보다 먼저 부른다 — 남의 DM 에 역할 정책이 403 을 내면 있다는 것이 드러난다.
// 워크스페이스·멤버십·비활성은 여기서 보지 않는다: roleOf(auth/roles.ts)와 워크스페이스로 거른 조회가 앞에서 막는다

type ChannelAccessFacts = { kind: string; dmOwnerId: string | null };

/** DM 이면 주인만, 일반 채널이면 누구나. userId 가 빈 문자열(주체 없는 자동화 사슬)이면 DM 은 읽지 못한다 */
export function canReadChannel(viewer: { userId: string }, channel: ChannelAccessFacts): boolean {
  if (channel.kind !== "dm") return true;
  return viewer.userId !== "" && channel.dmOwnerId === viewer.userId;
}

/** 목록 쿼리의 WHERE 에 and 로 붙인다 — 결과를 뽑은 뒤 거르면 페이지·커서·개수가 남의 DM 을 센다(스펙 4장) */
export function readableChannelSql(userId: string): SQL {
  return or(eq(channels.kind, "channel"), eq(channels.dmOwnerId, userId))!;
}

/**
 * 제어 도구 주체(modules/control/principal.ts Principal)가 읽을 수 있는 채널 — 목록·검색·한 행 조회 모두 이것으로 거른다. 바깥 MCP
 * (개인 토큰)는 사람과 같은 범위(일반 채널 + 주인의 DM 전부). 채널 안 에이전트는 일반 채널 + 그 런의 채널이 시킨 사람의 DM 이면 그 DM
 * 하나 — 시킨 사람의 다른 DM 은 없는 채널과 같다. 프롬프트 주입·모델 오판으로 DM 이 채널 답에 옮겨지는 길을 dodok 이 막는다(에이전트
 * DM 계획 판정 PD3). 런이 없는 에이전트 주체는 일반 채널만
 */
export function readableChannelSqlFor(principal: {
  userId: string | null;
  via: "pat" | "agent";
  runId?: string;
}): SQL {
  const userId = principal.userId ?? "";
  if (principal.via === "pat") return readableChannelSql(userId);
  if (principal.runId === undefined) return eq(channels.kind, "channel");
  return or(
    eq(channels.kind, "channel"),
    and(
      eq(channels.dmOwnerId, userId),
      eq(channels.id, sql`(SELECT ${runs.channelId} FROM ${runs} WHERE ${runs.id} = ${principal.runId})`),
    ),
  )!;
}

/** 읽는 사람 — 사람 id(REST·wire, readableChannelSql 로 푼다) 또는 이미 좁힌 범위(제어 도구 주체, readableChannelSqlFor) */
export type ChannelReader = string | SQL;

export function readerSql(reader: ChannelReader): SQL {
  return typeof reader === "string" ? readableChannelSql(reader) : reader;
}

/** 못 읽으면 없는 채널과 같은 404 — 문구도 getChannel 이 없을 때와 같다 */
export function assertChannelReadable(channel: ChannelAccessFacts, userId: string): void {
  if (!canReadChannel({ userId }, channel)) throw apiError("NOT_FOUND", "channel not found");
}
