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
  /** GET /llms.txt(로그인 없음) — IP 당 분당. 부팅 때 만든 평문이라 비싸지 않다 — 폭주 방어다 */
  llmsTxtPerMin: 30,
  /** REST /api/v1/* — 사용자당 분당 */
  restPerMin: 300,
  /** 첨부 업로드 — 사용자당 분당(REST 상한 위에 한 번 더) */
  uploadPerMin: 30,
  /** 초대·재설정 링크 발급 — 사용자당 분당(둘이 한 버킷, 팀 스펙 7장) */
  inviteIssuePerMin: 20,
  /** GET /api/v1/search — 사용자당 분당(REST 상한 위에 한 번 더, 스레드·검색 스펙 5.2) */
  searchPerMin: 60,
  /**
   * POST /hooks/<token>(로그인 없음) — 웹훅 토큰마다 분당. 게시 하나가 멘션 런을 만들 수 있어 런 비용을 바깥 서비스가 정하지 않게
   * 막는다(자동화 스펙 「웹훅」 절). 토큰을 맞혀 보는 것은 상한이 아니라 실패 카운터(bridgeFail)가 막는다
   */
  webhookPerMin: 30,
  /** wire 이벤트 — 소켓마다 토큰 버킷 */
  wire: {
    heavy: { perMin: 30, burst: 10 }, // message.send·component.interact·run.abort
    // run.events.replay — 웹이 채널 입장·재접속·resync 때 활성 런마다 스스로 부른다. heavy 와 나누면 채널을 몇 번 오가는 것만으로
    // message.send 가 막힌다(o3-t3 리뷰 I1). 읽기 전용이라 쓰기 경로보다 넉넉하다
    replay: { perMin: 120, burst: 30 },
    approval: { perMin: 60, burst: 20 }, // approval.resolve
    chatter: { perMin: 120, burst: 30 }, // typing·presence.update·channel.read·reaction.set
  },
  /**
   * 러너가 보내는 프레임 — 러너 소켓마다 토큰 버킷(러너 어댑터 FRAME_BUCKET). 가장 잦은 것은 텍스트 델타다 — 러너는 모델 텍스트 델타를
   * 하나씩 run.event 로 보내고(도구 입력은 블록이 끝날 때 한 번에), 간격 중앙값은 26ms(Haiku 4.5)·46ms(Sonnet 5) — 런 하나 초당 약 40
   * (ADR 0007 「스트리밍 (질문 1)」 절). 러너 동시 런 상한(maxConcurrentRuns 최대 16)이 모두 텍스트를 흘려도 초당 약 640 이라 지속
   * 1,000/초 안이고, 네트워크가 델타를 몰아 보내는 순간은 2,000 버스트가 받는다. 기본 3런(초당 약 120)이면 여덟 배 남는다
   */
  runner: {
    events: { perMin: 60_000, burst: 2_000 }, // run.event
    // hello·outbound.post, 그리고 가리키는 것이 없거나 처리기가 버릴 run.final·run.error·approval.* — 런마다 몇 번뿐이다. 도구 병렬 호출(한 메시지에
    // 다섯)이 16런에서 겹쳐도 버스트 안이다. 열린 런을 닫는 종결 프레임·그 런의 승인 요청(런마다 누계 RUN_FREE_APPROVALS 개까지)·기다리는 승인의
    // 철회는 세지 않는다 — post 가 이 버킷을 비워도 런이 runMs 까지 매달리지 않게(러너 어댑터 namesOpenWork)
    control: { perMin: 600, burst: 100 },
  },
  /** 사용자당 동시 wire 소켓 */
  socketsPerUser: 20,
  /** 브리지 인증 실패 카운터(BridgeAuthGuard) — 핸드셰이크·첨부 HTTP·설치 파일(plugin.tgz·runner.tgz) 토큰 받기·웹훅이 같이 쓴다 */
  bridgeFail: { maxFailures: 10, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 },
} as const;

export type Limits = {
  betterAuthPerMin: number;
  localLoginPerMin: number;
  invitePublicPerMin: number;
  llmsTxtPerMin: number;
  restPerMin: number;
  uploadPerMin: number;
  searchPerMin: number;
  webhookPerMin: number;
  inviteIssuePerMin: number;
  wire: Record<keyof (typeof LIMITS)["wire"], { perMin: number; burst: number }>;
  runner: Record<keyof (typeof LIMITS)["runner"], { perMin: number; burst: number }>;
  socketsPerUser: number;
  bridgeFail: { maxFailures: number; windowMs: number; blockMs: number; maxAddresses: number };
};
