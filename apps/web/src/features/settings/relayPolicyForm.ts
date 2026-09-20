import type { RelayPolicy } from "@dodok/shared";

/** 릴레이 정책 폼 상태 — 숫자 칸은 친 글자 그대로 둔다(검증은 저장할 때 `fromForm`) */
export type RelayForm = {
  maxRelayTurns: string;
  /** 빈칸이면 상한 없음 */
  dailyRunLimit: string;
  allowAll: boolean;
  /** allowAll 이 거짓일 때만 쓴다. from·to 는 에이전트 id */
  pairs: Array<{ from: string; to: string }>;
};

/** shared RelayPolicy 와 같은 한계 — 서버 VALIDATION(영문 message)보다 먼저 막는다 */
const MAX_TURNS = 32;
const MAX_PAIRS = 64;
/** 일일 상한의 실질 한계 — 계약에는 상한이 없지만 이보다 큰 값은 잘못 친 것으로 본다(칸은 자르지 않는다) */
const MAX_DAILY = 999_999_999;

/** 오류가 어느 칸의 것인가 — 그 칸에 aria-invalid·설명을 단다 */
export type RelayFormField = "maxRelayTurns" | "dailyRunLimit";
export type RelayFormResult =
  | { ok: true; policy: RelayPolicy }
  | { ok: false; error: string; field?: RelayFormField };

export function toForm(policy: RelayPolicy): RelayForm {
  return {
    maxRelayTurns: String(policy.maxRelayTurns),
    dailyRunLimit: policy.dailyRunLimit === undefined ? "" : String(policy.dailyRunLimit),
    allowAll: policy.allowPairs === "all",
    pairs: policy.allowPairs === "all" ? [] : policy.allowPairs.map(({ from, to }) => ({ from, to })),
  };
}

/** 0 이상 정수만(`1.5`·`1e1`·`-1` 거부). 아니면 undefined */
function nonNegativeInt(text: string): number | undefined {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : undefined;
}

export function fromForm(form: RelayForm): RelayFormResult {
  const turns = nonNegativeInt(form.maxRelayTurns);
  if (turns === undefined || turns > MAX_TURNS) {
    return { ok: false, error: `턴 상한은 0~${MAX_TURNS} 사이 정수로 적어 주세요`, field: "maxRelayTurns" };
  }
  let daily: number | undefined;
  if (form.dailyRunLimit.trim() !== "") {
    daily = nonNegativeInt(form.dailyRunLimit);
    if (daily === undefined || daily < 1 || daily > MAX_DAILY) {
      return {
        ok: false,
        error: `일일 상한은 1~${MAX_DAILY.toLocaleString("en-US")} 사이 정수로 적거나 비워 두세요(비우면 상한 없음)`,
        field: "dailyRunLimit",
      };
    }
  }
  let allowPairs: RelayPolicy["allowPairs"] = "all";
  if (!form.allowAll) {
    if (form.pairs.some((p) => p.from === p.to)) {
      return { ok: false, error: "자기 자신에게 넘기는 쌍은 만들 수 없습니다" };
    }
    if (form.pairs.length > MAX_PAIRS) {
      return { ok: false, error: `허용 쌍은 ${MAX_PAIRS}개까지 고를 수 있습니다` };
    }
    allowPairs = form.pairs.map(({ from, to }) => ({ from, to }));
  }
  return {
    ok: true,
    policy: { maxRelayTurns: turns, allowPairs, ...(daily === undefined ? {} : { dailyRunLimit: daily }) },
  };
}
