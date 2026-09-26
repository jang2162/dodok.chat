/** 레이트리밋 숫자의 유일한 자리(운영 보강 스펙 4장). 테스트는 AppDeps.limits 로 줄인다 */
export const LIMITS = {
  /** /api/auth/*(Better Auth) — IP 당 분당 */
  betterAuthPerMin: 30,
  /** /api/v1/auth/local(로그인)과 me/password — IP 당 분당, 한 버킷. 비밀번호 추측을 막는다 */
  localLoginPerMin: 5,
  /**
   * 초대 조회·수락·재설정 — IP 당 분당, 셋이 한 버킷(로그인과 나눈다). 토큰은 32바이트 난수라 추측 방어가 아니라 폭주 방어다 —
   * 한 사무실(NAT)에서 여러 사람이 링크를 동시에 열어도 로그인 실패 몇 번에 가입이 막히지 않게
   */
  invitePublicPerMin: 20,
  /** REST /api/v1/* — 사용자당 분당 */
  restPerMin: 300,
  /** 첨부 업로드 — 사용자당 분당(REST 상한 위에 한 번 더) */
  uploadPerMin: 30,
  /** 초대·재설정 링크 발급 — 사용자당 분당(둘이 한 버킷, 팀 스펙 7장) */
  inviteIssuePerMin: 20,
  /** GET /api/v1/search — 사용자당 분당(REST 상한 위에 한 번 더, 스레드·검색 스펙 5.2) */
  searchPerMin: 60,
  /** wire 이벤트 — 소켓마다 토큰 버킷 */
  wire: {
    heavy: { perMin: 30, burst: 10 }, // message.send·component.interact·run.abort
    // run.events.replay — 웹이 채널 입장·재접속·resync 때 활성 런마다 스스로 부른다. heavy 와 나누면 채널을 몇 번 오가는 것만으로
    // message.send 가 막힌다(o3-t3 리뷰 I1). 읽기 전용이라 쓰기 경로보다 넉넉하다
    replay: { perMin: 120, burst: 30 },
    approval: { perMin: 60, burst: 20 }, // approval.resolve
    chatter: { perMin: 120, burst: 30 }, // typing·presence.update
  },
  /** 사용자당 동시 wire 소켓 */
  socketsPerUser: 20,
  /** 브리지 인증 실패 카운터(BridgeAuthGuard) — 핸드셰이크와 /bridge/attachments 가 같이 쓴다 */
  bridgeFail: { maxFailures: 10, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 },
} as const;

export type Limits = {
  betterAuthPerMin: number;
  localLoginPerMin: number;
  invitePublicPerMin: number;
  restPerMin: number;
  uploadPerMin: number;
  searchPerMin: number;
  inviteIssuePerMin: number;
  wire: Record<keyof (typeof LIMITS)["wire"], { perMin: number; burst: number }>;
  socketsPerUser: number;
  bridgeFail: { maxFailures: number; windowMs: number; blockMs: number; maxAddresses: number };
};
