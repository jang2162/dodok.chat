import type { Channel } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

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
