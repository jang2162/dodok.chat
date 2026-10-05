import type { Channel } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { qk } from "@/api/queries";

/**
 * 보관한 채널인가(채널 보관 스펙 「채널 보관」 장). `null` 과 비교하지 않는다 — 보관 열이 생기기 전의 오프라인 사본은 `archivedAt` 이
 * 없어서, 그러면 모든 채널이 보관된 것으로 보인다(에이전트 `isArchived` 와 같은 까닭)
 */
export const isChannelArchived = (channel: Pick<Channel, "archivedAt">): boolean =>
  Boolean(channel.archivedAt);

/** 서버 목록 순서(`listChannels` — 만든 시각, 같으면 id) */
const byCreated = (a: Channel, b: Channel) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);

/** 같은 id 를 빼고, `keep` 이면 순서 자리에 넣는다. 목록을 아직 안 받았으면 만들지 않는다 — 한 채널짜리 목록을 완전한 것처럼 두지 않게 */
const place = (list: Channel[] | undefined, channel: Channel, keep: boolean): Channel[] | undefined => {
  if (!list) return list;
  const rest = list.filter((c) => c.id !== channel.id);
  return keep ? [...rest, channel].sort(byCreated) : rest;
};

/**
 * 바뀐 채널 하나를 캐시 셋에 반영한다 — wire `channel.updated` 와 보관·보관 해제 응답이 함께 쓴다. 상세(`[channel, id]`)는 그대로 바꾸고,
 * 사이드바 목록에는 살아 있는 채널만, 보관 목록에는 보관한 채널만 둔다(서버 `GET /channels` 와 `?archived=1` 이 그렇게 나눈다)
 */
export function applyChannel(qc: QueryClient, channel: Channel): void {
  const archived = isChannelArchived(channel);
  qc.setQueryData<Channel>(qk.channel(channel.id), channel);
  qc.setQueryData<Channel[]>(qk.channels, (list) => place(list, channel, !archived));
  qc.setQueryData<Channel[]>(qk.archivedChannels, (list) => place(list, channel, archived));
}

/**
 * 서버가 409 `CHANNEL_ARCHIVED` 로 거절했다 — 이 탭은 아직 보관을 모른다(`channel.updated` 를 끊긴 사이에 놓쳤거나 이벤트보다 먼저 보냈다).
 * 채널을 다시 받아 화면을 읽기 전용으로 바꾼다. 사이드바 목록도 다시 받는다 — 보관한 채널이 빠진다
 */
export function refreshArchivedChannel(qc: QueryClient, channelId: string): void {
  void qc.invalidateQueries({ queryKey: qk.channel(channelId), exact: true });
  void qc.invalidateQueries({ queryKey: qk.channels, exact: true });
}

/**
 * 지금 그리는 채널이 보관됐는가 — 채널 화면(ChannelPage)이 그 아래(메시지 목록·카드·오른쪽 패널)에 내려 준다. 카드 하나하나가 채널
 * 쿼리를 구독하지 않게 하고, 채널 화면 밖(테스트·다른 화면)의 기본값은 「살아 있음」이다
 */
export const ChannelArchivedContext = createContext(false);
export const useChannelArchived = (): boolean => useContext(ChannelArchivedContext);
