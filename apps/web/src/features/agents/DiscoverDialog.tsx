import type { AdapterProvider } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { qk, useIsOwner } from "@/api/queries";
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
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { handleFrom } from "./handleFrom";
import { AgentFields, ManualAgentForm, handleProblem, idTaken, nameProblem } from "./ManualAgentForm";
import { formError } from "@/api/formErrors";
import { PROVIDER_ID_LABEL } from "./providerLabels";
import { type DiscoveredAgent, useCreateAgent, useDiscover } from "./mutations";

/** 제공자 고르기의 이름(러너 스펙 7장) */
const PROVIDER_LABEL: Record<AdapterProvider, string> = { openclaw: "OpenClaw", claude: "Claude 러너" };

/**
 * 목록을 못 받았을 때의 문구 — 서버 문구는 보이지 않는다. OpenClaw(스펙 6.1): 503 은 Gateway 끊김, 403 은 agents.list 권한 없음.
 * 어느 쪽이든 직접 입력으로 안내한다
 */
function discoverErrorText(e: Error, provider: AdapterProvider): string {
  if (e instanceof NetworkError) return "서버에 연결할 수 없습니다";
  if (provider === "claude") return "러너 목록을 가져오지 못했습니다";
  if (e instanceof ApiRequestError) {
    if (e.code === "ADAPTER_UNAVAILABLE") return "Gateway 에 연결되지 않았습니다";
    if (e.code === "FORBIDDEN") return "Gateway 권한(agents.list)이 없습니다";
  }
  return "Gateway 에서 목록을 가져오지 못했습니다";
}

/** Claude 러너 목록이 비었을 때 — 러너를 붙이는 곳은 연결 페이지(owner 만 본다), owner 에게만 링크 */
function NoRunners() {
  const owner = useIsOwner();
  return (
    <p className="text-sm text-muted-foreground">
      연결된 러너가 없습니다 —{" "}
      {owner ? (
        <Link to="/settings/connection" className="underline underline-offset-4">
          연결 페이지
        </Link>
      ) : (
        "연결 페이지"
      )}
      에서 러너를 붙이세요{owner ? "." : "(워크스페이스 owner 가 할 수 있습니다)."}
    </p>
  );
}

/**
 * 「에이전트 가져오기」 버튼과 대화상자(러너 스펙 7장) — 제공자(OpenClaw · Claude 러너)를 고르고 그 목록에서 고른다. 열 때마다 OpenClaw 부터,
 * 목록은 열 때·제공자를 바꿀 때마다 새로 부르고, 실패하면 직접 입력 폼을 보인다.
 * 등록된 목록은 페이지가 넘긴다 — 여기서 `useAgents()` 를 새로 붙이면 열 때마다 목록을 다시 불러오고,
 * 그 응답이 등록(POST) 응답보다 늦게 오면 방금 넣은 에이전트를 옛 목록으로 덮는다.
 * 페이지가 목록을 받기 전엔 `disabled` — 등록된 것을 가를 수 없고, 등록한 것을 넣을 캐시도 없다
 */
export function DiscoverDialog({
  registeredIds,
  disabled = false,
}: {
  registeredIds: ReadonlySet<string>;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [provider, setProvider] = useState<AdapterProvider>("openclaw");
  // 일괄 등록 중. 이 동안엔 닫지 않는다 — 닫아도 루프는 남은 POST 를 보내고, 그 폼 오류는 보일 곳이 없다
  const [busy, setBusy] = useState(false);
  const discover = useDiscover(open, provider);
  const providerId = useId();

  function onOpenChange(next: boolean) {
    if (!next && busy) return;
    if (next) {
      // 닫을 때가 아니라 열 때 되돌린다 — 닫히는 애니메이션 동안 목록 화면이 비치지 않게
      setManual(false);
      setProvider("openclaw");
      // 지난번에 받은 목록은 버린다 — 열 때마다 「불러오는 중」부터, 목록은 이번에 받은 것만 그린다
      void qc.resetQueries({ queryKey: qk.discover });
    }
    setOpen(next);
  }
  function pick(next: AdapterProvider) {
    if (busy || next === provider) return;
    setManual(false);
    // 바꿀 때도 그 제공자의 지난 목록은 버린다 — 고른 항목·편집은 목록과 함께 새로 시작한다
    void qc.resetQueries({ queryKey: qk.discoverOf(next) });
    setProvider(next);
  }
  const close = () => setOpen(false);

  // 이번에 받은 목록이 있으면 다시 불러오는 중에도(재조회 실패여도) 목록을 둔다 — 고른 항목·편집이 사라지지 않게.
  // 로딩은 isPending — 오프라인이라 멈춘(paused) 첫 조회도 여기 든다
  let body: ReactNode = null;
  if (manual) {
    body = (
      <div className="flex flex-col gap-4">
        <ManualAgentForm provider={provider} registeredIds={registeredIds} onCreated={close} />
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setManual(false)}>
          목록으로
        </Button>
      </div>
    );
  } else if (discover.isPending) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {provider === "openclaw" ? "Gateway 에서 불러오는 중…" : "러너 목록을 불러오는 중…"}
      </p>
    );
  } else if (discover.data) {
    body = (
      <DiscoverList
        key={provider}
        provider={provider}
        discovered={discover.data}
        registeredIds={registeredIds}
        busy={busy}
        onBusy={setBusy}
        onDone={close}
        onManual={() => setManual(true)}
      />
    );
  } else if (discover.isError) {
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertDescription>{discoverErrorText(discover.error, provider)}</AlertDescription>
        </Alert>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {PROVIDER_ID_LABEL[provider]} 를 직접 입력해 등록할 수 있습니다.
          </p>
          <Button variant="outline" size="sm" onClick={() => void discover.refetch()}>
            다시 시도
          </Button>
        </div>
        <ManualAgentForm provider={provider} registeredIds={registeredIds} onCreated={close} />
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>에이전트 가져오기</Button>
      </DialogTrigger>
      {/* 등록 중엔 기본 닫기(X)를 잠근다 — Esc·바깥 클릭은 onOpenChange 가 무시 */}
      <DialogContent closeDisabled={busy} className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>에이전트 가져오기</DialogTitle>
          <DialogDescription>
            제공자를 고르고, 그 에이전트 중 아직 등록하지 않은 것을 고릅니다.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2" disabled={busy}>
          <legend className="mb-1 text-sm font-medium">제공자</legend>
          <RadioGroup
            value={provider}
            onValueChange={(v) => pick(v as AdapterProvider)}
            className="flex flex-wrap gap-4"
          >
            {(["openclaw", "claude"] as const).map((p) => (
              <div key={p} className="flex items-center gap-2">
                <RadioGroupItem id={`${providerId}-${p}`} value={p} />
                <Label htmlFor={`${providerId}-${p}`} className="font-normal">
                  {PROVIDER_LABEL[p]}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>
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
 * 모두 등록되면 닫는다. busy 는 대화상자가 든다 — 도는 동안 닫지 못하게
 */
function DiscoverList({
  provider,
  discovered,
  registeredIds,
  busy,
  onBusy,
  onDone,
  onManual,
}: {
  provider: AdapterProvider;
  discovered: DiscoveredAgent[];
  registeredIds: ReadonlySet<string>;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: () => void;
  onManual: () => void;
}) {
  const create = useCreateAgent();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
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
    onBusy(true);
    let failed = false;
    for (const { agent, draft } of chosen) {
      try {
        await create.mutateAsync({
          provider,
          providerAgentId: agent.providerAgentId,
          handle: draft.handle,
          name: draft.name.trim(),
        });
      } catch (err) {
        failed = true;
        const message = formError(err);
        if (message === undefined) break;
        update(agent.providerAgentId, { error: idTaken(err) ?? message });
      }
    }
    onBusy(false);
    if (!failed) onDone();
  }

  return (
    <form onSubmit={(e) => void register(e)} className="flex flex-col gap-4">
      {candidates.length === 0 ? (
        discovered.length === 0 && provider === "claude" ? (
          <NoRunners />
        ) : (
          <p className="text-sm text-muted-foreground">
            {discovered.length === 0 ? "Gateway 에 에이전트가 없습니다" : "새로 등록할 에이전트가 없습니다"}
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {provider === "claude" && (
            <p className="text-xs text-muted-foreground">
              등록하면 지금 그 id 를 알린 러너(줄 맨 앞 이름)에 묶여, 그 러너만 이 에이전트를 맡습니다.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {candidates.map((c, i) => {
              const label = c.name ?? c.providerAgentId;
              const draft = drafts[c.providerAgentId];
              const checkboxId = `${baseId}-${i}`;
              return (
                <li key={c.providerAgentId} className="rounded-md border bg-card p-3">
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
                  {provider === "claude" && c.hint && (
                    <p className="mt-1 pl-7 text-xs break-words text-muted-foreground">{c.hint}</p>
                  )}
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
        </div>
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
