import {
  type Agent,
  AGENT_RUN_TIMEOUT_MINUTES_MAX,
  AGENT_RUN_TIMEOUT_MINUTES_MIN,
  AgentRunTimeoutMinutes,
  type DmAccess,
  type SessionDefaults,
} from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { type FormEvent, type Ref, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { formError } from "@/api/formErrors";
import { useRole } from "@/api/queries";
import { canOpenDm } from "@/features/dms/queries";
import { FieldError } from "@/ui/field-error";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { EFFORT_LABEL } from "@/features/conversations/agentSettings";
import { josa } from "@/lib/josa";
import { AvatarPicker } from "@/features/account/AvatarPicker";
import { useAgentAvatar, useArchiveAgent, usePatchAgent } from "./mutations";
import { DEFAULT_LABEL, SessionDefaultsForm } from "./RunnerAgentForm";

const PROMPT_MAX = 20_000;

/**
 * 에이전트 상세(「연결」 탭 — 연결 재설계 스펙 목표 3)가 카드에 나눠 담는 칸들. 머리의 켜기 스위치(`AgentEnabledSwitch`)·「DM 보내기」
 * (`AgentDmLink`), 「실행」 카드의 새 세션 시작값(`RunnerSessionDefaults`)·지시(`BasePromptEditor` — OpenClaw 에서는 「프로필」 카드의 메모),
 * 「프로필」 카드의 사진(`AgentAvatarField`), 「DM 허용」 카드(`DmAccessField`), 「런 상한」 카드(`RunTimeoutField`), 「관리」 카드의 삭제(`ArchiveAgentButton`).
 * 토글·저장은 낙관적 갱신 없이 요청 중에만 잠근다(실패는 전역 토스트). `readOnly`(그 연결의 주인도 admin 이상도 아님)면 값만 보인다
 */

/** 켜기 스위치 — 보이는 이름표 「켜짐」/「꺼짐」, 접근 이름은 「에이전트 켜짐」(상태는 aria-checked 가 말한다) */
export function AgentEnabledSwitch({
  agent,
  readOnly,
  focusRef,
}: {
  agent: Agent;
  readOnly: boolean;
  focusRef?: Ref<HTMLButtonElement>;
}) {
  const toggle = usePatchAgent();
  return (
    <span className="inline-flex items-center gap-2 rounded-md border px-2 py-1">
      <Switch
        ref={focusRef}
        aria-label="에이전트 켜짐"
        checked={agent.enabled}
        disabled={toggle.isPending || readOnly}
        onCheckedChange={(enabled) => toggle.mutate({ id: agent.id, patch: { enabled } })}
      />
      <span aria-hidden className="text-sm">
        {agent.enabled ? "켜짐" : "꺼짐"}
      </span>
    </span>
  );
}

/** 「DM 보내기」 — 지금 내 역할로 이 에이전트와 DM 을 열 수 있을 때만(에이전트 DM 스펙 3.1) */
export function AgentDmLink({ agent }: { agent: Agent }) {
  const role = useRole();
  if (!canOpenDm(agent, role)) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/dm/$agentId" params={{ agentId: agent.id }} aria-label={`@${agent.handle} DM 보내기`}>
        <MessageCircleIcon />
        DM 보내기
      </Link>
    </Button>
  );
}

/** 에이전트 사진(프로필 스펙 3.6) — admin 이상(읽기 전용이면 없다) */
export function AgentAvatarField({ agent }: { agent: Agent }) {
  const avatar = useAgentAvatar(agent.id);
  return (
    <AvatarPicker
      kind="agent"
      id={agent.id}
      handle={agent.handle}
      name={agent.name}
      currentUrl={agent.avatarUrl}
      upload={(image) => avatar.upload.mutateAsync(image)}
      remove={() => avatar.remove.mutateAsync()}
    />
  );
}

/** `dmAccess` 선택지(에이전트 DM 계획 Global Constraints — 글자 그대로) */
const DM_ACCESS_LABEL: Record<DmAccess, string> = { off: "끔", admins: "admin 이상", everyone: "모두" };

/**
 * DM 허용 범위(에이전트 DM 스펙 결정 4) — 누가 이 에이전트와 새 DM 을 여나. 세그먼트(끔 / admin 이상 / 모두), 고르는 즉시 저장한다(채널의
 * 세션 정책과 같은 방식). 좁히면 그 범위 밖 사람의 DM 은 읽기 전용이 된다(서버가 판정 — wire `agents.changed` 로 그 사람의 화면이 바뀐다).
 * `readOnly`(admin 미만)면 값만 보인다.
 */
export function DmAccessField({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const save = usePatchAgent();
  const [error, setError] = useState<string>();
  const id = useId();
  const value = agent.dmAccess;

  function choose(next: DmAccess) {
    if (readOnly || save.isPending || next === value) return;
    setError(undefined);
    save.mutate({ id: agent.id, patch: { dmAccess: next } }, { onError: (err) => setError(formError(err)) });
  }

  if (readOnly)
    return (
      <p className="text-sm text-muted-foreground">
        DM 허용: <span className="text-foreground">{DM_ACCESS_LABEL[value]}</span>
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label="DM 을 열 수 있는 사람"
        aria-describedby={error ? `${id}-error` : undefined}
        className="inline-flex w-fit rounded-md border p-0.5"
      >
        {(["off", "admins", "everyone"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            disabled={save.isPending}
            onClick={() => choose(option)}
            className={cn(
              "rounded px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
              value === option
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            {DM_ACCESS_LABEL[option]}
          </button>
        ))}
      </div>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

const RUN_TIMEOUT_RANGE_ERROR = `${AGENT_RUN_TIMEOUT_MINUTES_MIN}~${AGENT_RUN_TIMEOUT_MINUTES_MAX} 분 사이의 정수로 넣으세요`;

/**
 * 런 상한(분) — 이 시간이 지나도 끝나지 않은 런을 서버가 닫는다. 기본은 비어 있음(상한 없음 — 몇 시간 도는 런이 있다), 비워 저장하면
 * null. 새로 시작하는 런부터 적용된다. `readOnly` 면 값만 보인다
 */
export function RunTimeoutField({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const save = usePatchAgent();
  const current = agent.runTimeoutMinutes;
  const [draft, setDraft] = useState(current === null ? "" : String(current));
  const [error, setError] = useState<string>();
  const id = useId();
  const label = current === null ? "없음" : `${current}분`;

  if (readOnly)
    return (
      <p className="text-sm text-muted-foreground">
        런 상한: <span className="text-foreground">{label}</span>
      </p>
    );

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (save.isPending) return;
    const text = draft.trim();
    let next: number | null = null;
    if (text !== "") {
      const parsed = AgentRunTimeoutMinutes.safeParse(Number(text));
      if (!parsed.success) return setError(RUN_TIMEOUT_RANGE_ERROR);
      next = parsed.data;
    }
    setError(undefined);
    save.mutate(
      { id: agent.id, patch: { runTimeoutMinutes: next } },
      { onError: (err) => setError(formError(err)) },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <Label htmlFor={id}>런 상한(분)</Label>
      <p id={`${id}-note`} className="-mt-1 text-xs text-muted-foreground">
        비우면 상한 없음 — 끝나지 않는 런은 「중지」로 멈춥니다. 새로 시작하는 런부터 적용됩니다
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={AGENT_RUN_TIMEOUT_MINUTES_MIN}
          max={AGENT_RUN_TIMEOUT_MINUTES_MAX}
          step={1}
          placeholder="없음"
          className="w-32"
          aria-describedby={[`${id}-note`, error && `${id}-error`].filter(Boolean).join(" ")}
          aria-invalid={error !== undefined}
          value={draft}
          disabled={save.isPending}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          aria-label={`@${agent.handle} 런 상한 저장`}
          disabled={save.isPending}
        >
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </form>
  );
}

/**
 * 「삭제」와 확인 대화상자. 확인을 같은 틱에 두 번 눌러도 한 번만 보낸다 — `isPending` 은 다시 그린 뒤에야 참이라 그 사이 두 번째 클릭이
 * 지나간다. 실패는 전역 토스트(대화상자는 열린 채 다시 누를 수 있다)
 */
export function ArchiveAgentButton({ agent, onArchived }: { agent: Agent; onArchived?: () => void }) {
  const archive = useArchiveAgent();
  const [open, setOpen] = useState(false);
  const sending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const handle = `@${agent.handle}`;

  function confirm() {
    if (sending.current) return;
    sending.current = true;
    archive.mutate(agent.id, {
      onSuccess: () => {
        setOpen(false);
        onArchived?.();
      },
      onSettled: () => {
        sending.current = false;
      },
    });
  }

  return (
    <>
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        aria-label={`${handle} 삭제`}
        onClick={() => setOpen(true)}
      >
        삭제
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="에이전트 삭제"
        description={`${handle} ${josa(agent.handle, "을", "를")} 삭제합니다.`}
        confirmLabel="삭제"
        pendingLabel="삭제하는 중…"
        pending={archive.isPending}
        destructive
        returnFocus={trigger}
        onConfirm={confirm}
      />
    </>
  );
}

/**
 * 러너 에이전트가 맡을 러너가 없을 때의 경고 — 러너가 없거나 토큰이 폐기됐다: 그 프로젝트를 러너 상세(「연결」 탭)에서 다른 러너로 옮긴다
 * (러너 일반화 계획 판정 PR8). 맡을 러너가 있으면 그리지 않는다(머리의 칩 줄이 러너를 보인다)
 */
export function RunnerWarning({ agent }: { agent: Agent }) {
  const runner = agent.runner;
  if (agent.provider !== "runner") return null;
  if (!runner) return <p className="text-xs font-medium text-destructive">맡을 러너가 없습니다</p>;
  if (!runner.revoked) return null;
  return (
    <p className="text-xs font-medium text-destructive">
      러너 {runner.label} — 토큰이 폐기돼 맡을 러너가 없습니다.{" "}
      <Link
        to="/settings/connection/runner/$runnerId"
        params={{ runnerId: runner.tokenId }}
        className="underline underline-offset-4"
      >
        그 러너 화면
      </Link>
      에서 프로젝트를 다른 러너로 옮기세요
    </p>
  );
}

/** 「기본」 또는 값 — 상태 줄과 같은 표기 */
const orDefault = (v: string | null) => v ?? DEFAULT_LABEL;

/**
 * 러너 에이전트의 「새 세션 시작값」(세션 설정 스펙 S10 — 그 연결의 주인·admin 이상, 읽기 전용이면 그리지 않는다): 요약 한 줄과
 * 「시작값 고치기」. 고치면 그 뒤 새 세션부터 — 이미 있는 대화는 그 대화의 설정을 따른다
 */
export function RunnerSessionDefaults({
  agent,
  defaults,
  projectId,
}: {
  agent: Agent;
  defaults: SessionDefaults;
  projectId: string | null;
}) {
  const save = usePatchAgent();
  const [editing, setEditing] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const handle = `@${agent.handle}`;
  const close = () => {
    setEditing(false);
    setRefocus(true);
  };

  if (editing)
    return (
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <p className="text-sm font-medium">새 세션 시작값</p>
        <SessionDefaultsForm
          agent={agent}
          defaults={defaults}
          projectId={projectId}
          pending={save.isPending}
          serverError={save.error ?? undefined}
          onCancel={() => {
            save.reset();
            close();
          }}
          onSave={(sessionDefaults) => {
            if (Object.keys(sessionDefaults).length === 0) return close();
            save.mutate({ id: agent.id, patch: { sessionDefaults } }, { onSuccess: close });
          }}
        />
      </div>
    );
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 text-sm break-words text-muted-foreground">
        새 세션 시작값 · 모델 {orDefault(defaults.model)} · 노력{" "}
        {defaults.effort === null ? DEFAULT_LABEL : EFFORT_LABEL[defaults.effort]} · 권한{" "}
        {orDefault(defaults.permissionMode)}
      </p>
      <Button
        variant="outline"
        size="sm"
        aria-label={`${handle} 시작값 고치기`}
        autoFocus={refocus}
        onClick={() => {
          save.reset();
          setEditing(true);
        }}
      >
        시작값 고치기
      </Button>
    </div>
  );
}

/**
 * 같은 `basePrompt` 칸을 제공자에 맞는 이름으로 부른다. 러너 에이전트에게는 매 런 지시로 가므로 만들 때와 같은 「지시」,
 * OpenClaw 에이전트에게는 인바운드에 실리지 않아(서버 코어 스펙 에이전트 항목 — 의도) 규칙을 적는 자리로 읽히지 않게 「메모」다
 */
export function promptCopy(agent: Pick<Agent, "provider">) {
  return agent.provider === "runner"
    ? { name: "지시", empty: "지시 없음", note: undefined }
    : { name: "메모", empty: "메모 없음", note: "에이전트에게 전달되지 않음" };
}

/** 접힌 채로는 미리보기, 펼치면 편집. 비워 저장하면 null(지움). VALIDATION·CONFLICT 만 폼 안에 — 그 밖은 전역 토스트 */
export function BasePromptEditor({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const copy = promptCopy(agent);
  const save = usePatchAgent();
  const [draft, setDraft] = useState<string>(); // undefined 면 접힘
  const [error, setError] = useState<string>();
  // 편집을 닫으면(저장·취소) 다시 그려지는 편집 버튼에 초점 — 편집칸이 사라져 body 로 떨어지지 않게
  const [refocus, setRefocus] = useState(false);
  const id = useId();
  const handle = `@${agent.handle}`;

  if (draft === undefined || readOnly) {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          {copy.note && (
            <p className="text-xs text-muted-foreground">
              {copy.name} — {copy.note}
            </p>
          )}
          <p
            className={cn(
              "line-clamp-2 min-w-0 text-sm whitespace-pre-wrap",
              agent.basePrompt === undefined && "text-muted-foreground",
            )}
          >
            {agent.basePrompt ?? copy.empty}
          </p>
        </div>
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            aria-label={`${handle} ${copy.name} 편집`}
            autoFocus={refocus}
            onClick={() => setDraft(agent.basePrompt ?? "")}
          >
            {copy.name} 편집
          </Button>
        )}
      </div>
    );
  }

  function close() {
    setDraft(undefined);
    setError(undefined);
    setRefocus(true);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending) return;
    setError(undefined);
    save.mutate(
      { id: agent.id, patch: { basePrompt: draft.trim() === "" ? null : draft } },
      { onSuccess: close, onError: (err) => setError(formError(err)) },
    );
  }

  const describedBy = [copy.note && `${id}-note`, `${id}-count`, error && `${id}-error`]
    .filter(Boolean)
    .join(" ");
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor={id}>{copy.name}</Label>
      {copy.note && (
        <p id={`${id}-note`} className="-mt-1 text-xs text-muted-foreground">
          {copy.note}
        </p>
      )}
      <Textarea
        id={id}
        aria-label={`${handle} ${copy.name}`}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined}
        value={draft}
        maxLength={PROMPT_MAX}
        rows={6}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        disabled={save.isPending}
      />
      <p id={`${id}-count`} className="text-xs text-muted-foreground">
        {(PROMPT_MAX - draft.length).toLocaleString("ko-KR")}자 남음
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close} disabled={save.isPending}>
          취소
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}
