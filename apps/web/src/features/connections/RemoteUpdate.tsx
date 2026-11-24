import {
  compareVersions,
  type GatewaySetup,
  type GatewayUpdatePreview,
  type RemoteUpdateProgress,
  type RemoteUpdateStarted,
  type RunnerSummary,
} from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, api } from "@/api/http";
import { qk } from "@/api/queries";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { CopyBlock } from "@/features/setup/sections";
import { Button } from "@/ui/button";
import { ArrowUpCircleIcon } from "lucide-react";

// 원격 업데이트(원격 업데이트 스펙 U8·U9) — 러너 상세 머리의 「러너 업데이트」와 「판 X · 최신 Y」, Gateway 상세의 「[업데이트]」. 누르면 확인 → 「업데이트 중…」 →
// 다시 붙으면 새 판(진행이 사라진다) / 실패면 사유 한 줄 / 상한 안에 다시 붙지 않으면 「응답이 없습니다 — 그 머신에서 확인하세요」

/** 옛 러너(능력 remoteUpdate 없음)에 보이는 명령 한 줄(U8) */
export const RUNNER_UPDATE_COMMAND = "npm i -g @dodok/runner@latest";
export const NO_RESPONSE_TEXT = "응답이 없습니다 — 그 머신에서 확인하세요";
/** 업데이트 중에 상태를 다시 받는 간격 — 다시 붙음은 wire 로도 오지만 상한 지남은 오지 않는다 */
const POLL_MS = 3_000;

/** 서버 오류의 사람 문구 — 서버가 이 화면에 맞춰 한국어 문구를 싣는다(409·503). 네트워크·그 밖은 고정 문구 */
function updateError(error: unknown): string {
  if (error instanceof ApiRequestError && (error.status === 409 || error.status === 503))
    return error.message;
  return "업데이트를 시작하지 못했습니다 — 잠시 뒤 다시 시도하세요";
}

/** updating 인데 상한이 지났으면 「응답이 없습니다」로 — 서버도 다음 읽기에 timeout 으로 바꾼다 */
function useProgressView(update: RemoteUpdateProgress | null | undefined, refresh: () => void) {
  const [now, setNow] = useState(() => Date.now());
  const updating = update?.state === "updating";
  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [updating, refresh]);
  if (update?.state === "updating" && now > Date.parse(update.deadline)) return { state: "timeout" as const };
  return update ?? null;
}

function ProgressLine({ view }: { view: ReturnType<typeof useProgressView> }) {
  if (!view) return null;
  if (view.state === "updating")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        업데이트 중…
      </p>
    );
  if (view.state === "failed")
    return (
      <p role="alert" className="text-sm font-medium text-destructive">
        업데이트하지 못했습니다 — {view.message}
      </p>
    );
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      {NO_RESPONSE_TEXT}
    </p>
  );
}

/**
 * 러너 업데이트의 상태(U2·U3) — 머리의 「러너 업데이트」 단추(`RunnerUpdateButton`)와 머리 아래 상태 줄(`RunnerUpdateStatus`)이 함께 쓴다
 * (연결 재설계 스펙 목표 2 — 자주 쓰는 동작 하나는 머리 오른쪽). 붙어 있지 않거나 판을 모르면 `null`
 */
export function useRunnerUpdate(runner: RunnerSummary) {
  const qc = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const refresh = useRef(() => void qc.invalidateQueries({ queryKey: qk.runners() })).current;
  const view = useProgressView(runner.update, refresh);
  const start = useMutation({
    mutationFn: () => api<RemoteUpdateStarted>("POST", `/runners/${runner.id}/update`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.runners() }),
    onSuccess: () => setOpen(false),
  });
  if (!runner.connected || runner.runnerVersion === null || runner.latestVersion === undefined) return null;
  const latest = runner.latestVersion;
  const newer = latest !== null && compareVersions(latest, runner.runnerVersion) > 0;
  return { runner, button, open, setOpen, view, start, latest, newer, updating: view?.state === "updating" };
}
export type RunnerUpdateState = NonNullable<ReturnType<typeof useRunnerUpdate>>;

/** 머리의 「러너 업데이트」 — 최신보다 낮고 그 머신이 원격 업데이트를 켰을 때만 */
export function RunnerUpdateButton({ update: u }: { update: RunnerUpdateState | null }) {
  if (!u || !u.newer || u.runner.remoteUpdate !== "on") return null;
  return (
    <Button
      ref={u.button}
      type="button"
      size="sm"
      variant="outline"
      disabled={u.updating || u.start.isPending}
      onClick={() => {
        u.start.reset();
        u.setOpen(true);
      }}
    >
      <ArrowUpCircleIcon />
      러너 업데이트
    </Button>
  );
}

/** 머리 아래의 판 X · 최신 Y 와 안내·진행·실패 줄, 확인 대화상자 */
export function RunnerUpdateStatus({ update: u }: { update: RunnerUpdateState | null }) {
  if (!u) return null;
  const { runner, latest, newer, start, open } = u;
  return (
    <div aria-label="러너 업데이트" role="group" className="flex flex-col gap-1.5 text-sm">
      <p className="text-muted-foreground">
        판 {runner.runnerVersion} · 최신 {latest ?? "알 수 없음"}
      </p>
      {latest === null && (
        <p className="text-muted-foreground">npm 레지스트리에 닿지 않아 최신 판을 알 수 없습니다</p>
      )}
      {newer && runner.remoteUpdate === "off" && (
        <p className="text-muted-foreground">
          이 머신에서 원격 업데이트를 껐습니다 — 그 머신에서 직접 올리세요
        </p>
      )}
      {newer && runner.remoteUpdate === "unsupported" && (
        <>
          <p className="text-muted-foreground">
            이 러너 판은 원격 업데이트를 지원하지 않습니다 — 그 머신에서:
          </p>
          <CopyBlock text={RUNNER_UPDATE_COMMAND} label="업데이트 명령 복사" />
        </>
      )}
      <ProgressLine view={u.view} />
      {start.isError && !open && (
        <p role="alert" className="font-medium text-destructive">
          {updateError(start.error)}
        </p>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          u.setOpen(next);
          if (!next) start.reset();
        }}
        title={`러너를 ${latest ?? ""} 로 업데이트할까요?`}
        description={
          start.isError
            ? updateError(start.error)
            : "그 머신이 npm 에서 새 판을 설치하고 같은 설정으로 다시 뜹니다. 도는 런이 있으면 러너가 거절합니다."
        }
        confirmLabel="업데이트"
        pendingLabel="보내는 중…"
        pending={start.isPending}
        returnFocus={u.button}
        onConfirm={() => start.mutate()}
      />
    </div>
  );
}

/**
 * Gateway 플러그인 — 서버가 품은 빌드와 다르면 업데이트(U4·U5). 확인 대화상자는 그 Gateway 의 끝나지 않은 런 수를 먼저 받아 「진행 중인
 * 런 N개가 끊깁니다」(U6)
 */
export function PluginUpdate({
  gateway,
  pluginFileAvailable,
}: {
  gateway: GatewaySetup;
  pluginFileAvailable: boolean;
}) {
  const qc = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeRuns, setActiveRuns] = useState<number | null>(null);
  const refresh = useRef(() => void qc.invalidateQueries({ queryKey: qk.setupStatus })).current;
  const view = useProgressView(gateway.update, refresh);
  const start = useMutation({
    mutationFn: () => api<RemoteUpdateStarted>("POST", `/gateways/${gateway.id}/update`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.setupStatus }),
    onSuccess: () => setOpen(false),
  });
  const plugin = gateway.bridge.plugin;
  if (!plugin || plugin.remoteUpdate === undefined) return null;
  // 같은 빌드면 할 것이 없다. 진행·실패가 남아 있으면 그 줄은 보인다
  const behind = pluginFileAvailable && gateway.pluginMatches !== true;
  const updating = view?.state === "updating";
  const openDialog = () => {
    start.reset();
    setActiveRuns(null);
    setOpen(true);
    void api<GatewayUpdatePreview>("GET", `/gateways/${gateway.id}/update`).then(
      (p) => setActiveRuns(p.activeRuns),
      () => setActiveRuns(null),
    );
  };
  const runsLine =
    activeRuns === null
      ? "진행 중인 런을 세는 중입니다…"
      : activeRuns > 0
        ? `진행 중인 런 ${activeRuns}개가 끊깁니다.`
        : "진행 중인 런은 없습니다.";
  return (
    <div aria-label="플러그인 업데이트" role="group" className="flex flex-col gap-1.5 text-sm">
      {behind && plugin.remoteUpdate === "on" && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>플러그인 {plugin.version} · 최신은 서버가 품은 빌드</span>
          <Button
            ref={button}
            size="sm"
            variant="outline"
            disabled={updating || start.isPending}
            onClick={openDialog}
          >
            업데이트
          </Button>
        </p>
      )}
      {behind && plugin.remoteUpdate === "off" && (
        <p className="text-muted-foreground">
          이 Gateway 에서 원격 업데이트를 껐습니다 — 「새 토큰 발급」의 설치 한 줄을 그 호스트에서 돌리세요
        </p>
      )}
      {behind && plugin.remoteUpdate === "unsupported" && (
        <p className="text-muted-foreground">
          이 플러그인 판은 원격 업데이트를 지원하지 않습니다 — 「새 토큰 발급」의 설치 한 줄을 그 호스트에서
          돌리세요
        </p>
      )}
      <ProgressLine view={view} />
      {start.isError && !open && (
        <p role="alert" className="font-medium text-destructive">
          {updateError(start.error)}
        </p>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) start.reset();
        }}
        title="플러그인을 서버의 빌드로 업데이트할까요?"
        description={
          start.isError
            ? updateError(start.error)
            : `Gateway 를 내리고 서버가 품은 플러그인을 설치한 뒤 다시 올립니다. ${runsLine}`
        }
        confirmLabel="업데이트"
        pendingLabel="보내는 중…"
        pending={start.isPending}
        destructive={activeRuns !== null && activeRuns > 0}
        returnFocus={button}
        onConfirm={() => start.mutate()}
      />
    </div>
  );
}
