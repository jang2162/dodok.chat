import type { DbOrTx } from "../../db/client";
import { TERMINAL_STATUSES } from "../runs/machine";
import { getRun, getRunConnectionId, getRunRequestedBy } from "../runs/store";

/**
 * 제어 도구 호출의 주체(제어 MCP 스펙 「주체」 장). 권한은 언제나 사람 한 명의 것이다 — 바깥 클라이언트는 개인 토큰의 주인, 채널 안
 * 에이전트는 그 런을 시킨 사람(runs.requested_by). userId 가 null 이면(자동화 글로 시작한 사슬) 읽기만 한다
 */
export type Principal = {
  userId: string | null;
  via: "pat" | "agent";
  /** via agent — 부른 에이전트 */
  agentId?: string;
  /** via agent — 그 에이전트의 열린 런. 확인 카드가 이 런에 붙고, 런이 끝나면 카드도 닫힌다 */
  runId?: string;
  /** via agent — OpenClaw 플러그인(브리지) 경로. 확인 카드 기한이 더 짧다(CONTROL_CONFIRM_TTL_BRIDGE_MS) */
  bridge?: true;
};

/**
 * 연결의 열린 런 하나에서 주체를 만든다 — 런이 없거나 끝났거나 다른 연결의 것이면 undefined(부르는 쪽이 NOT_FOUND). 끝난 런의 이름으로
 * 부를 수 없다(Review Focus 4)
 */
function principalForOpenRun(
  db: DbOrTx,
  connectionId: string,
  runId: string,
  sessionKey?: string,
): Principal | undefined {
  const run = getRun(db, runId);
  if (!run || TERMINAL_STATUSES.has(run.status)) return undefined;
  if (getRunConnectionId(db, runId) !== connectionId) return undefined;
  if (sessionKey !== undefined && run.sessionKey !== sessionKey) return undefined;
  return { userId: getRunRequestedBy(db, runId), via: "agent", agentId: run.agentId, runId: run.id };
}

/** Claude 러너 — runId 는 그 러너 토큰이 맡은 열린 런이어야 한다 */
export function principalForRunner(db: DbOrTx, runnerTokenId: string, runId: string): Principal | undefined {
  return principalForOpenRun(db, runnerTokenId, runId);
}

/**
 * OpenClaw 플러그인 — runId 는 플러그인이 그 세션에서 마지막으로 받은 인바운드의 런이다. 그 런이 열려 있고 세션 키·Gateway 가 모두
 * 맞을 때만 받는다(계획 판정 PC3·Review Focus 4). 세션 키만으로 찾으면 끝난 런의 늦은 호출이 같은 세션의 다음 런을 시킨 사람의 권한을
 * 빌린다
 */
export function principalForBridge(
  db: DbOrTx,
  gatewayId: string,
  sessionKey: string,
  runId: string,
): Principal | undefined {
  const principal = principalForOpenRun(db, gatewayId, runId, sessionKey);
  return principal && { ...principal, bridge: true };
}
