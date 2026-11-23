import { z } from "zod";
import { IsoDateTime } from "../common";

// 러너·플러그인 원격 업데이트(원격 업데이트 스펙 2026-11-23 U1~U9) — 서버 → 러너 `runner.update`·서버 → 플러그인 `plugin.update` 의
// 응답과, 웹이 러너·Gateway 상세에서 보는 업데이트 상태. 기본 허용이고 그 머신의 로컬 설정 `remoteUpdate: false` 로 끈다(U1)

/** 올릴 판 — 정확한 semver 만. `latest`·범위·`../x`·URL·`file:` 은 받지 않는다(npm 에 넘기는 값이다) */
export const REMOTE_UPDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const RemoteUpdateVersion = z.string().max(64).regex(REMOTE_UPDATE_VERSION_PATTERN);
export type RemoteUpdateVersion = z.infer<typeof RemoteUpdateVersion>;

/** 다시 붙기를 기다리는 상한(U9) — 넘으면 웹이 「응답이 없습니다 — 그 머신에서 확인하세요」 */
export const RUNNER_UPDATE_DEADLINE_MS = 180_000;
export const PLUGIN_UPDATE_DEADLINE_MS = 300_000;

/**
 * 업데이트 요청의 답. disabled — 그 머신이 원격 업데이트를 껐다, busy — 런이 도는 중이거나 이미 업데이트하는 중, unsupported — 그 설치
 * 방식으로는 할 수 없다, invalid_version — 판이 정확한 semver 가 아니거나 지금보다 높지 않다, failed — 설치 등이 실패했다(message 에 한 줄)
 */
export const RemoteUpdateFailReason = z.enum([
  "disabled",
  "busy",
  "unsupported",
  "invalid_version",
  "failed",
]);
export type RemoteUpdateFailReason = z.infer<typeof RemoteUpdateFailReason>;

export const RemoteUpdateAck = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: RemoteUpdateFailReason, message: z.string().max(400).optional() }),
]);
export type RemoteUpdateAck = z.infer<typeof RemoteUpdateAck>;

/** 플러그인이 다시 붙을 때 hello 에 싣는 마지막 업데이트 결과(U5) — 업데이트 스크립트가 상태 디렉터리 파일에 남긴 것 */
export const RemoteUpdateOutcome = z.object({
  ok: z.boolean(),
  version: z.string().max(64).optional(),
  message: z.string().max(400).optional(),
  at: IsoDateTime,
});
export type RemoteUpdateOutcome = z.infer<typeof RemoteUpdateOutcome>;

/** 붙은 머신의 원격 업데이트 — on(된다)·off(그 머신에서 껐다)·unsupported(능력이 없는 옛 판 — 명령 한 줄 안내) */
export const RemoteUpdateSupport = z.enum(["on", "off", "unsupported"]);
export type RemoteUpdateSupport = z.infer<typeof RemoteUpdateSupport>;

/**
 * 서버가 메모리에 쥔 업데이트 진행(U9) — updating 은 요청이 받아들여져 다시 붙기를 기다린다(deadline 까지), failed 는 사유 한 줄,
 * timeout 은 deadline 안에 다시 붙지 않았다. 다시 붙어 새 판이 되면 사라진다(null)
 */
export const RemoteUpdateProgress = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("updating"),
    targetVersion: z.string().max(64).nullable(),
    startedAt: IsoDateTime,
    deadline: IsoDateTime,
  }),
  z.object({ state: z.literal("failed"), message: z.string().max(400), at: IsoDateTime }),
  z.object({ state: z.literal("timeout"), at: IsoDateTime }),
]);
export type RemoteUpdateProgress = z.infer<typeof RemoteUpdateProgress>;

/** POST /api/v1/runners/:id/update·POST /api/v1/gateways/:id/update 응답(202) */
export const RemoteUpdateStarted = z.object({ update: RemoteUpdateProgress });
export type RemoteUpdateStarted = z.infer<typeof RemoteUpdateStarted>;

/** GET /api/v1/gateways/:id/update — 확인 대화상자의 「진행 중인 런 N개가 끊깁니다」(U6) */
export const GatewayUpdatePreview = z.object({ activeRuns: z.int().min(0) });
export type GatewayUpdatePreview = z.infer<typeof GatewayUpdatePreview>;

/** 판 비교 — a 가 b 보다 높으면 양수. 정확한 semver 꼴만 넘긴다(아니면 NaN). 프리릴리스는 정식보다 낮고, 프리릴리스끼리는 점 성분별로 */
export function compareVersions(a: string, b: string): number {
  if (!REMOTE_UPDATE_VERSION_PATTERN.test(a) || !REMOTE_UPDATE_VERSION_PATTERN.test(b)) return Number.NaN;
  const split = (v: string) => {
    const dash = v.indexOf("-");
    const core = (dash < 0 ? v : v.slice(0, dash)).split(".").map(Number);
    return { core, pre: dash < 0 ? null : v.slice(dash + 1).split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
