import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Label } from "@/ui/label";
import { handleFrom } from "./handleFrom";
import { AgentFields, ManualAgentForm, handleProblem, nameProblem } from "./ManualAgentForm";
import { type DiscoveredAgent, formError, useCreateAgent, useDiscover } from "./mutations";

/** 스펙 6.1: 503 은 Gateway 끊김, 403 은 agents.list 권한 없음 — 어느 쪽이든 직접 입력으로 안내한다 */
function discoverErrorText(e: Error): string {
  if (e instanceof NetworkError) return "서버에 연결할 수 없습니다";
  if (e instanceof ApiRequestError) {
    if (e.code === "ADAPTER_UNAVAILABLE") return "Gateway 에 연결되지 않았습니다";
    if (e.code === "FORBIDDEN") return "Gateway 권한(agents.list)이 없습니다";
  }
  return "Gateway 에서 목록을 가져오지 못했습니다";
}

/**
 * 「Gateway 에서 가져오기」 버튼과 대화상자. 열 때마다 discover 를 새로 부르고, 실패하면 직접 입력 폼을 보인다.
 * 등록된 목록은 페이지가 넘긴다 — 여기서 `useAgents()` 를 새로 붙이면 열 때마다 목록을 다시 불러오고,
 * 그 응답이 등록(POST) 응답보다 늦게 오면 방금 넣은 에이전트를 옛 목록으로 덮는다
 */
export function DiscoverDialog({ registeredIds }: { registeredIds: ReadonlySet<string> }) {
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const discover = useDiscover(open);

  function onOpenChange(next: boolean) {
    setOpen(next);
    // 닫을 때가 아니라 열 때 되돌린다 — 닫히는 애니메이션 동안 목록 화면이 비치지 않게
    if (next) setManual(false);
  }
  const close = () => onOpenChange(false);

  let body: ReactNode = null;
  if (manual) {
    body = (
      <div className="flex flex-col gap-4">
        <ManualAgentForm registeredIds={registeredIds} onCreated={close} />
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setManual(false)}>
          Gateway 목록으로
        </Button>
      </div>
    );
  } else if (discover.isFetching) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        Gateway 에서 불러오는 중…
      </p>
    );
  } else if (discover.isError) {
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertDescription>{discoverErrorText(discover.error)}</AlertDescription>
        </Alert>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">OpenClaw id 를 직접 입력해 등록할 수 있습니다.</p>
          <Button variant="outline" size="sm" onClick={() => void discover.refetch()}>
            다시 시도
          </Button>
        </div>
        <ManualAgentForm registeredIds={registeredIds} onCreated={close} />
      </div>
    );
  } else if (discover.data) {
    body = (
      <DiscoverList
        discovered={discover.data}
        registeredIds={registeredIds}
        onDone={close}
        onManual={() => setManual(true)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>Gateway 에서 가져오기</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Gateway 에서 가져오기</DialogTitle>
          <DialogDescription>
            OpenClaw Gateway 의 에이전트 중 아직 등록하지 않은 것을 고릅니다.
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** 고른 항목의 핸들·이름. error 는 그 항목 등록이 받은 폼 오류(VALIDATION·CONFLICT) */
type Draft = { handle: string; name: string; error?: string };

/**
 * 등록 안 된 것(같은 providerAgentId 가 없는 것)만 체크 목록으로. 고른 것을 하나씩 POST 하고, 등록된 것은 목록에서 빠진다.
 * 폼 오류는 그 항목 핸들 칸 아래에 두고 다음 항목을 계속한다. 그 밖의 오류는 전역 토스트가 알리니 거기서 멈춘다.
 * 모두 등록되면 닫는다
 */
function DiscoverList({
  discovered,
  registeredIds,
  onDone,
  onManual,
}: {
  discovered: DiscoveredAgent[];
  registeredIds: ReadonlySet<string>;
  onDone: () => void;
  onManual: () => void;
}) {
  const create = useCreateAgent();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const baseId = useId();

  const candidates = discovered.filter((d) => !registeredIds.has(d.providerAgentId));
  const chosen = candidates.flatMap((c) => {
    const draft = drafts[c.providerAgentId];
    return draft ? [{ agent: c, draft }] : [];
  });
  const ready =
    chosen.length > 0 &&
    chosen.every(({ draft }) => !handleProblem(draft.handle) && !nameProblem(draft.name));

  function choose(c: DiscoveredAgent, on: boolean) {
    setDrafts((prev) => {
      const next = { ...prev };
      if (on)
        next[c.providerAgentId] = {
          handle: handleFrom(c.providerAgentId),
          name: c.name ?? c.providerAgentId,
        };
      else delete next[c.providerAgentId];
      return next;
    });
  }

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => {
      const current = prev[key];
      return current ? { ...prev, [key]: { ...current, ...patch } } : prev;
    });
  }

  async function register(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    let failed = false;
    for (const { agent, draft } of chosen) {
      try {
        await create.mutateAsync({
          providerAgentId: agent.providerAgentId,
          handle: draft.handle,
          name: draft.name.trim(),
        });
      } catch (err) {
        failed = true;
        const message = formError(err);
        if (message === undefined) break;
        update(agent.providerAgentId, { error: message });
      }
    }
    setBusy(false);
    if (!failed) onDone();
  }

  return (
    <form onSubmit={(e) => void register(e)} className="flex flex-col gap-4">
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {discovered.length === 0 ? "Gateway 에 에이전트가 없습니다" : "새로 등록할 에이전트가 없습니다"}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {candidates.map((c, i) => {
            const label = c.name ?? c.providerAgentId;
            const draft = drafts[c.providerAgentId];
            const checkboxId = `${baseId}-${i}`;
            return (
              <li key={c.providerAgentId} className="rounded-md border p-3">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id={checkboxId}
                    checked={draft !== undefined}
                    onCheckedChange={(checked) => choose(c, checked === true)}
                    disabled={busy}
                  />
                  <Label htmlFor={checkboxId} className="min-w-0 flex-1 truncate">
                    {label}
                  </Label>
                  {label !== c.providerAgentId && (
                    <code className="truncate font-mono text-xs text-muted-foreground">
                      {c.providerAgentId}
                    </code>
                  )}
                </div>
                {draft && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <AgentFields
                      labelPrefix={label}
                      handle={draft.handle}
                      name={draft.name}
                      onHandle={(handle) => update(c.providerAgentId, { handle, error: undefined })}
                      onName={(name) => update(c.providerAgentId, { name, error: undefined })}
                      handleError={draft.error ?? handleProblem(draft.handle)}
                      nameError={nameProblem(draft.name)}
                      disabled={busy}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onManual} disabled={busy}>
          직접 입력
        </Button>
        {candidates.length > 0 && (
          <Button type="submit" disabled={!ready || busy}>
            {busy ? "등록 중…" : chosen.length > 0 ? `${chosen.length}개 등록` : "등록"}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
