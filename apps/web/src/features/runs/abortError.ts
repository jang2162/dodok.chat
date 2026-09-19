import { WireAckError } from "@/realtime/wire";

/**
 * `run.abort` ack 실패 토스트 문구(스펙 5.4 코드표·8장). wire 오류는 REST 전역 토스트 밖이라 부르는 쪽이 토스트한다 —
 * 작성기 `/stop`(태스크 9)과 버블의 중지 버튼(태스크 8)이 같이 쓴다
 */
export function abortErrorMessage(e: unknown): string {
  if (!(e instanceof WireAckError)) return "실행을 중지하지 못했습니다";
  switch (e.code) {
    case "NOT_FOUND":
      return "이미 끝났거나 없는 실행입니다";
    case "FORBIDDEN":
      return "이 실행을 중지할 권한이 없습니다";
    case "VALIDATION":
      return "처리할 수 없는 요청입니다";
    case "TIMEOUT":
      return "서버 응답이 없어 실행을 중지하지 못했습니다";
    case "ADAPTER_UNAVAILABLE":
      return "Gateway 에 연결되지 않았습니다";
    default:
      return `실행을 중지하지 못했습니다 (${e.code})`;
  }
}
