import { useMutation } from "@tanstack/react-query";
import { api, ApiRequestError, NetworkError } from "@/api/http";

/**
 * 「새 대화」(스펙 6.4) — `POST /channels/:id/agents/:agentId/reset`, 변수는 agentId. 성공하면 서버가 info 시스템 메시지를
 * 채널에 보내므로 캐시를 고치지 않는다. 오류는 대화상자 안에 `resetErrorMessage` 로 그리므로 전역 토스트를 끈다(401 은 그대로 로그인)
 */
export function useResetSession(channelId: string) {
  return useMutation<void, Error, string>({
    mutationFn: async (agentId) => {
      await api<{ ok: true }>("POST", `/channels/${channelId}/agents/${agentId}/reset`);
    },
    meta: { silent: true },
  });
}

/** 서버는 sessions.reset 권한 부족을 409 CONFLICT + message 접두사 `ADAPTER_CAPABILITY_MISSING` 로 알린다 */
export function resetErrorMessage(e: Error): string {
  if (e instanceof NetworkError) return e.message;
  if (!(e instanceof ApiRequestError)) return "새 대화를 시작하지 못했습니다";
  if (e.code === "CONFLICT" && e.message.startsWith("ADAPTER_CAPABILITY_MISSING")) {
    return "Gateway 권한(operator.admin)이 없어 새 대화를 시작할 수 없습니다";
  }
  if (e.status === 503) return "Gateway 에 연결되지 않았습니다";
  return e.message;
}
