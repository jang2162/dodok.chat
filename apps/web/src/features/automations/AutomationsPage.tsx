import type { AutomationSummary } from "@dodok/shared";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type Ref, type RefObject, useId, useMemo, useRef, useState } from "react";
import { useArchivedChannels, useCanManage, useChannels } from "@/api/queries";
import { useOpsStatus } from "@/features/ops/queries";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { AutomationDialog } from "./AutomationDialog";
import { STATUS_LABEL, describeSchedule, formatAt, warningText } from "./copy";
import { useDeleteAutomation, useRunAutomation, useUpdateAutomation } from "./mutations";
import { useAutomations } from "./queries";

/**
 * 자동화(`/settings/automations`, 자동화 스펙 「웹」 장): 목록·「지금 실행」·켜기/끄기·수정·삭제와 만들기. admin 이상만 본다 — 아니면
 * 자동화 API 를 부르지 않고 「권한이 없습니다」(멤버·운영 페이지와 같은 규칙)
 */
export function AutomationsPage() {
  const manager = useCanManage();
  const createButton = useRef<HTMLButtonElement>(null);
  return (
    <section
      data-testid="page-automations"
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">자동화</h1>
          <p className="text-sm text-muted-foreground">
            정한 시각이나 들어오는 웹훅에 맞춰 채널에 문구를 게시합니다. 문구에서 @로 부른 에이전트가 그 글에
            답합니다.
          </p>
        </div>
        {manager && (
          <AutomationDialog>
            <Button ref={createButton} type="button" size="sm">
              <PlusIcon />
              만들기
            </Button>
          </AutomationDialog>
        )}
      </header>
      {manager ? (
        <AutomationList createButton={createButton} />
      ) : (
        <p className="text-sm text-muted-foreground">권한이 없습니다 — 자동화는 관리자만 볼 수 있습니다.</p>
      )}
    </section>
  );
}

/**
 * 목록과 삭제 확인(공용 `ConfirmDialog` 하나를 목록이 든다). 지운 줄은 「삭제」 단추와 함께 사라져 초점을 돌려줄 자리가 없다 — 다음
 * 줄의 「삭제」, 없으면 앞 줄의 것, 그것도 없으면 `createButton`(「만들기」)으로 옮긴다(연결 페이지 `TokenList` 와 같은 규칙).
 * 목록이 비어도 대화상자는 그린다 — 마지막 줄을 지울 때도 다른 줄처럼 닫히는 애니메이션을 거친다
 */
function AutomationList({ createButton }: { createButton: RefObject<HTMLButtonElement | null> }) {
  const automations = useAutomations();
  const remove = useDeleteAutomation();
  const [target, setTarget] = useState<AutomationSummary>();
  // 닫히는 동안에도 문구가 비지 않게 `target` 은 남겨 두고 열림만 따로 든다
  const [deleting, setDeleting] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const ops = useOpsStatus();
  const timeZone = ops.data?.timeZone;
  // 운영 상태를 못 받으면 시각을 「…」(받는 중)로 두지 않고 모른다고 말한다
  const zoneUnknown = timeZone === undefined && ops.isError;
  const channels = useChannels().data;
  // 보관된 채널은 사이드바 목록에 없다 — 그런 줄이 있을 때만 보관 목록에서 이름을 찾는다
  const needsArchived =
    channels !== undefined &&
    (automations.data ?? []).some((a) => !channels.some((c) => c.id === a.channelId));
  const archived = useArchivedChannels({ enabled: needsArchived }).data;
  const channelName = useMemo(
    () => new Map([...(channels ?? []), ...(archived ?? [])].map((c) => [c.id, c.name])),
    [channels, archived],
  );

  function startDelete(a: AutomationSummary, button: HTMLButtonElement) {
    returnFocus.current = button;
    setTarget(a);
    setDeleting(true);
  }

  // 실패하면 대화상자는 열린 채다(전역 토스트) — 다시 누를 수 있다
  function confirmDelete() {
    if (!target) return;
    const rows = automations.data ?? [];
    const i = rows.findIndex((a) => a.id === target.id);
    const neighbor = rows[i + 1] ?? rows[i - 1];
    remove.mutate(target.id, {
      onSuccess: () => {
        returnFocus.current = (neighbor && deleteButtons.current.get(neighbor.id)) ?? createButton.current;
        setDeleting(false);
      },
    });
  }

  if (!automations.data) {
    return automations.isError ? (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">자동화 목록을 불러오지 못했습니다</p>
        <Button
          variant="outline"
          size="sm"
          disabled={automations.isFetching}
          onClick={() => void automations.refetch()}
        >
          다시 시도
        </Button>
      </div>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  return (
    <>
      {automations.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 자동화가 없습니다. 「만들기」로 시작합니다.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {timeZone && (
            <p className="text-xs text-muted-foreground">
              시각은 워크스페이스 시간대 {timeZone} 기준입니다 — 운영 화면에서 바꿉니다.
            </p>
          )}
          <ul aria-label="자동화" className="flex flex-col divide-y rounded-lg border">
            {automations.data.map((a) => (
              <AutomationRow
                key={a.id}
                automation={a}
                channel={channelName.get(a.channelId)}
                {...(timeZone ? { timeZone } : {})}
                zoneUnknown={zoneUnknown}
                deleteRef={(el) => {
                  if (el) deleteButtons.current.set(a.id, el);
                  else deleteButtons.current.delete(a.id);
                }}
                onDelete={(button) => startDelete(a, button)}
              />
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="자동화 삭제"
        description={`「${target?.name ?? ""}」 자동화를 삭제합니다. 이미 게시한 메시지는 남고 「⚙ 지운 자동화」로 보입니다.`}
        confirmLabel="삭제"
        pendingLabel="삭제하는 중…"
        pending={remove.isPending}
        destructive
        returnFocus={returnFocus}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function AutomationRow({
  automation: a,
  channel,
  timeZone,
  zoneUnknown = false,
  deleteRef,
  onDelete,
}: {
  automation: AutomationSummary;
  channel: string | undefined;
  timeZone?: string;
  /** 운영 상태 조회가 실패해 시간대를 모른다 — 시각 자리에 「알 수 없음」 */
  zoneUnknown?: boolean;
  deleteRef: Ref<HTMLButtonElement>;
  /** 누른 「삭제」 단추 — 확인을 닫으면 초점이 그리로 돌아온다 */
  onDelete: (button: HTMLButtonElement) => void;
}) {
  const nameId = useId();
  const run = useRunAutomation();
  const toggle = useUpdateAutomation();
  const at = (iso: string) => (timeZone ? formatAt(iso, timeZone) : zoneUnknown ? "알 수 없음" : "…");
  return (
    <li aria-labelledby={nameId} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span id={nameId} className="font-medium break-all">
          {a.name}
        </span>
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          {a.kind === "schedule" ? "예약" : "웹훅"}
        </Badge>
        {!a.enabled && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-muted-foreground">
            꺼짐
          </Badge>
        )}
        <span className="text-sm text-muted-foreground">#{channel ?? "…"}</span>
      </div>
      <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        {a.kind === "schedule" && a.schedule ? (
          <p>
            {describeSchedule(a.schedule)}
            {a.enabled && a.nextRunAt && ` · 다음 실행 ${at(a.nextRunAt)}`}
          </p>
        ) : (
          <p>
            주소 <code className="font-mono text-xs">…/hooks/whk_{a.tokenPrefix ?? ""}…</code>
          </p>
        )}
        <p>
          {a.lastRunAt
            ? `마지막 실행 ${at(a.lastRunAt)}${a.lastStatus ? ` · ${STATUS_LABEL[a.lastStatus]}` : ""}`
            : "아직 실행하지 않았습니다"}
        </p>
      </div>
      {a.warnings.length > 0 && (
        <ul aria-label="경고" className="flex flex-col gap-1">
          {a.warnings.map((w) => (
            <li
              key={`${w.kind}:${w.handle ?? ""}`}
              className="flex items-start gap-1.5 text-sm text-destructive"
            >
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {warningText(w)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* 잠금은 `disabled` 가 아니라 `aria-disabled` + 누름 무시 — `disabled` 가 되면 브라우저가 초점을 버려
            키보드로 누른 사람이 자리를 잃는다(보관 채널 반응 칩과 같은 꼴) */}
        <Switch
          aria-label={`${a.name} 켜기`}
          checked={a.enabled}
          aria-disabled={toggle.isPending || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onCheckedChange={(enabled) => {
            if (!toggle.isPending) toggle.mutate({ id: a.id, patch: { enabled } });
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-disabled={run.isPending || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!run.isPending) run.run(a);
          }}
        >
          {run.isPending ? "게시하는 중…" : "지금 실행"}
        </Button>
        <AutomationDialog automation={a}>
          <Button type="button" size="sm" variant="ghost">
            수정
          </Button>
        </AutomationDialog>
        <Button
          ref={deleteRef}
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={(e) => onDelete(e.currentTarget)}
        >
          삭제
        </Button>
      </div>
    </li>
  );
}
