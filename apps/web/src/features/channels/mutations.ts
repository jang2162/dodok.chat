import type { Channel } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { applyChannel } from "./archived";

export type CreateChannelInput = { name: string; topic?: string };

/**
 * `POST /channels` → 만든 채널(봉투를 벗긴 것). 목록 캐시에 넣고(다시 불러오지 않는다) 채널 캐시도 채운다.
 * 목록이 아직 없으면(불러오기 전) 무효화로 맡긴다 — 부분 목록을 완전한 것처럼 두지 않게.
 * 오류 알림은 전역 규칙: VALIDATION·CONFLICT 는 폼이, 그 밖은 토스트가
 */
export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateChannelInput) =>
      (await api<{ channel: Channel }>("POST", "/channels", input)).channel,
    onSuccess: (channel) => {
      qc.setQueryData(qk.channel(channel.id), channel);
      if (qc.getQueryData(qk.channels) === undefined) {
        void qc.invalidateQueries({ queryKey: qk.channels });
        return;
      }
      qc.setQueryData<Channel[]>(qk.channels, (list) =>
        list && !list.some((c) => c.id === channel.id) ? [...list, channel] : list,
      );
    },
  });
}

/**
 * 채널 보관·보관 해제(채널 보관 스펙 「API」 절, admin 이상) — 응답 채널을 캐시 셋에 반영한다(`applyChannel`, 같은 채널이 wire
 * `channel.updated` 로도 오지만 결과가 같다). `run` 은 둘째 클릭을 버린다 — 같은 틱이면 렌더된 `isPending` 이 아직 false 라 통과한다
 * (DeleteGatewayConfirm 과 같은 까닭). 실패는 전역 토스트가 알린다
 */
function useChannelArchiveAction(action: "archive" | "unarchive", channelId: string) {
  const qc = useQueryClient();
  const sending = useRef(false);
  const mutation = useMutation({
    mutationFn: async () =>
      (await api<{ channel: Channel }>("POST", `/channels/${channelId}/${action}`)).channel,
    onSuccess: (channel) => applyChannel(qc, channel),
  });
  const run = (): Promise<Channel | undefined> => {
    if (sending.current) return Promise.resolve(undefined);
    sending.current = true;
    // 성공하면 풀지 않는다 — 누른 단추는 상태가 바뀌어 사라지는데(작성기 자리·설정 패널·보관 목록 줄), 그 전에 닿은 둘째 클릭이
    // 같은 요청을 다시 보내지 않게. 실패만 풀어 다시 누를 수 있게 한다
    return mutation.mutateAsync().then(
      (channel) => channel,
      () => {
        sending.current = false;
        return undefined;
      },
    );
  };
  return { run, isPending: mutation.isPending };
}

export const useArchiveChannel = (channelId: string) => useChannelArchiveAction("archive", channelId);
export const useUnarchiveChannel = (channelId: string) => useChannelArchiveAction("unarchive", channelId);
