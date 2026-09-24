/** 레이트리밋 숫자의 유일한 자리(운영 보강 스펙 4장). 테스트는 AppDeps.limits 로 줄인다 */
export const LIMITS = {
  /** /api/auth/*(Better Auth) — IP 당 분당 */
  betterAuthPerMin: 30,
  /** REST /api/v1/* — 사용자당 분당 */
  restPerMin: 300,
  /** 첨부 업로드 — 사용자당 분당(REST 상한 위에 한 번 더) */
  uploadPerMin: 30,
  /** wire 이벤트 — 소켓마다 토큰 버킷 */
  wire: {
    heavy: { perMin: 30, burst: 10 }, // message.send·component.interact·run.abort·run.events.replay
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
  restPerMin: number;
  uploadPerMin: number;
  wire: Record<keyof (typeof LIMITS)["wire"], { perMin: number; burst: number }>;
  socketsPerUser: number;
  bridgeFail: { maxFailures: number; windowMs: number; blockMs: number; maxAddresses: number };
};
