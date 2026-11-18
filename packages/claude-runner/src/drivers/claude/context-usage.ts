import { RunnerContextBreakdown } from "@dodok/shared";
import type { SdkContextUsage, SdkQuery } from "./sdk";

// 런 끝 컨텍스트 세부(작성기 칩 스펙 5.1·C7) — 결과 메시지를 받은 뒤 입력을 닫기 전에 같은 query 에서 한 번 묻고, 줄인 모양을
// run.final 의 usage 에 싣는다. 세부 때문에 런이 실패하거나 늦게 끝나지 않게 상한을 두고 던지지 않는다

/** final 이 이만큼까지 늦는 것은 받아들인다(답 글은 이미 흘러 나와 있다) */
export const CONTEXT_USAGE_TIMEOUT_MS = 2000;

const CATEGORY_MAX = 32;
const NAME_MAX = 80;
const MODEL_MAX = 128;

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : n);

/**
 * SDK 응답을 계약 모양으로 줄인다 — 필드 다섯만. memoryFiles·mcpTools·agents·skills·gridRows 의 줄별 목록은 경로·이름이 머신
 * 정보를 드러내고 화면에 쓰지 않아 버린다. 0 토큰 줄은 남긴다(화면이 숨긴다). 모양이 어긋나면 undefined
 */
export function toContextBreakdown(raw: SdkContextUsage): RunnerContextBreakdown | undefined {
  const r = raw as Partial<SdkContextUsage> | null | undefined;
  if (!r || !Array.isArray(r.categories)) return undefined;
  const parsed = RunnerContextBreakdown.safeParse({
    model: typeof r.model === "string" ? r.model.slice(0, MODEL_MAX) : r.model,
    totalTokens: count(r.totalTokens),
    maxTokens: count(r.maxTokens),
    percentage: r.percentage,
    categories: r.categories.slice(0, CATEGORY_MAX).map((c) => ({
      name: typeof c?.name === "string" ? c.name.slice(0, NAME_MAX) : c?.name,
      tokens: count(c?.tokens),
      kind: c?.kind,
    })),
  });
  return parsed.success ? parsed.data : undefined;
}

/** 던지지 않는다 — 실패·시간 초과·모양 어긋남이면 undefined(세부 없이 지금처럼 final) */
export async function fetchContextBreakdown(
  q: Pick<SdkQuery, "getContextUsage">,
  timeoutMs: number = CONTEXT_USAGE_TIMEOUT_MS,
): Promise<RunnerContextBreakdown | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const raw = await Promise.race([q.getContextUsage({ detail: "summary" }), timeout]);
    return raw === undefined ? undefined : toContextBreakdown(raw);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
