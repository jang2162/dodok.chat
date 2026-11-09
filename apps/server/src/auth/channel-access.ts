import { and, eq, or, type SQL, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { channelMembers, channels, runs } from "../db/schema.sqlite";
import { apiError } from "../http/errors";

// 채널 접근 판정 — 누가 이 채널을 읽고 쓰나(사람 간 DM 스펙 4장이 정본, 그 아래 에이전트 DM 스펙 4장). 채널·대화·메시지·런·승인·첨부를 내보내거나 바꾸는 모든 경로가
// 이 파일의 함수를 지난다. 역할 판정(403)보다 먼저 부른다 — 남의 DM 에 역할 정책이 403 을 내면 있다는 것이 드러난다.
// 워크스페이스·멤버십·비활성은 여기서 보지 않는다: roleOf(auth/roles.ts)와 워크스페이스로 거른 조회가 앞에서 막는다

type ChannelAccessFacts = { id: string; kind: string; dmOwnerId: string | null };

// 기본이 닫힘(사람 간 DM 스펙 4.2) — kind 갈래는 「channel 이면 열림, dm 은 주인, direct 는 사람 참여자, 그 밖은 닫힘」으로 쓴다.
// 「dm 이 아니면 일반 채널」로 읽으면 새 kind 가 생길 때 빠뜨린 자리마다 전원에게 샌다

/** 참여자만 읽는 채널인가 — 지금은 direct 하나. 비공개 채널(K)은 여기와 readableChannelSql 의 EXISTS 갈래에 visibility = 'private' 를 더한다 */
export function membersOnly(channel: { kind: string }): boolean {
  return channel.kind === "direct";
}

/** 그 채널의 사람 참여자(channel_members 의 user 행)인가 — 에이전트 id 를 넣어도 user 행이 아니라 false */
function isHumanParticipant(db: DbOrTx, channelId: string, userId: string): boolean {
  const row = db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "user"),
        eq(channelMembers.memberId, userId),
      ),
    )
    .get();
  return row !== undefined;
}

/**
 * 일반 채널은 누구나, DM 은 주인만, direct 는 사람 참여자만, 모르는 kind 는 아무도. userId 가 빈 문자열(주체 없는 자동화 사슬)이면
 * 일반 채널만 읽는다
 */
export function canReadChannel(db: DbOrTx, viewer: { userId: string }, channel: ChannelAccessFacts): boolean {
  if (channel.kind === "channel") return true;
  if (viewer.userId === "") return false;
  if (channel.kind === "dm") return channel.dmOwnerId === viewer.userId;
  if (membersOnly(channel)) return isHumanParticipant(db, channel.id, viewer.userId);
  return false;
}

/** channels 행이 userId 의 사람 참여자 행을 가진 참여자 전용 채널인가 — readableChannelSql·readableChannelSqlFor 가 같이 쓴다 */
function participantSql(userId: string): SQL {
  return and(
    eq(channels.kind, "direct"),
    sql`EXISTS (SELECT 1 FROM ${channelMembers} WHERE ${channelMembers.channelId} = ${channels.id} AND ${channelMembers.memberType} = 'user' AND ${channelMembers.memberId} = ${userId})`,
  )!;
}

/** 목록 쿼리의 WHERE 에 and 로 붙인다 — 결과를 뽑은 뒤 거르면 페이지·커서·개수가 남의 DM 을 센다(스펙 4장) */
export function readableChannelSql(userId: string): SQL {
  return or(
    eq(channels.kind, "channel"),
    and(eq(channels.kind, "dm"), eq(channels.dmOwnerId, userId)),
    participantSql(userId),
  )!;
}

/**
 * 제어 도구 주체(modules/control/principal.ts Principal)가 읽을 수 있는 채널 — 목록·검색·한 행 조회 모두 이것으로 거른다. 바깥 MCP
 * (개인 토큰)는 사람과 같은 범위(일반 채널 + 주인의 DM 전부). 채널 안 에이전트는 일반 채널 + 그 런의 채널이 시킨 사람의 DM 이면 그 DM
 * 하나 — 시킨 사람의 다른 DM 은 없는 채널과 같다. 프롬프트 주입·모델 오판으로 DM 이 채널 답에 옮겨지는 길을 dodok 이 막는다(에이전트
 * DM 계획 판정 PD3). 그 런의 채널이 direct 면 시킨 사람이 그 대화의 사람 참여자일 때만 그 direct 하나(사람 간 DM 스펙 4.4). 런이 없는
 * 에이전트 주체는 일반 채널만
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
      eq(channels.id, sql`(SELECT ${runs.channelId} FROM ${runs} WHERE ${runs.id} = ${principal.runId})`),
      or(and(eq(channels.kind, "dm"), eq(channels.dmOwnerId, userId)), participantSql(userId)),
    ),
  )!;
}

/** 읽는 사람 — 사람 id(REST·wire, readableChannelSql 로 푼다) 또는 이미 좁힌 범위(제어 도구 주체, readableChannelSqlFor) */
export type ChannelReader = string | SQL;

export function readerSql(reader: ChannelReader): SQL {
  return typeof reader === "string" ? readableChannelSql(reader) : reader;
}

/** 못 읽으면 없는 채널과 같은 404 — 문구도 getChannel 이 없을 때와 같다 */
export function assertChannelReadable(db: DbOrTx, channel: ChannelAccessFacts, userId: string): void {
  if (!canReadChannel(db, { userId }, channel)) throw apiError("NOT_FOUND", "channel not found");
}
