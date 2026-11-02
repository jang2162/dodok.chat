import { type Agent, type DmAccess, RUNNER_PROGRAM_NAME } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { type FormEvent, type Ref, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Switch } from "@/ui/switch";
import { Textarea } from "@/ui/textarea";
import { formError } from "@/api/formErrors";
import { useRole } from "@/api/queries";
import { canOpenDm } from "@/features/dms/queries";
import { FieldError } from "@/ui/field-error";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { josa } from "@/lib/josa";
import { MoveGatewayDialog } from "./MoveGatewayDialog";
import { AvatarPicker } from "@/features/account/AvatarPicker";
import { useAgentAvatar, useArchiveAgent, usePatchAgent } from "./mutations";
import { providerIdLabel } from "./providerLabels";
import { RunnerDefinitionForm } from "./RunnerAgentForm";

const PROMPT_MAX = 20_000;

/**
 * 목록 한 줄: 이름·핸들(OpenClaw 면 「@핸들 · Gateway 이름」)·제공자별 id·사용 토글·메모(OpenClaw)·지시(러너). 토글은 낙관적 갱신 없이 요청 중에만
 * 잠근다(실패는 전역 토스트). `readOnly`(admin 미만 — 팀 스펙 2장)면 토글을 잠그고 프롬프트는 미리보기만.
 * OpenClaw 에이전트의 「Gateway 옮기기」는 `moveTargets` 를 준 사람에게만(admin 이상, 또는 그 Gateway 의 주인 — 연결 탭 통합 스펙 5.2) —
 * 연결이 빈 줄뿐 아니라 어느 줄에서나 옮길 수 있다.
 * 연결이 빈 줄의 안내도 역할에 맞춘다 — 옮길 수 없는 admin·member 에게 옮기라고 권하지 않는다.
 * 「삭제」(보관, admin 이상 — 스펙 「에이전트 보관」 절)는 확인 뒤 보낸다. 보관하면 줄이 목록에서 빠지므로 `onArchived` 가 초점을 옮긴다.
 * `focusRef` 는 사용 토글에 붙는다 — 페이지가 되살린 줄로 초점을 옮기는 자리다.
 * 「DM 보내기」는 지금 내 역할로 이 에이전트와 DM 을 열 수 있을 때만(에이전트 DM 스펙 3.1), DM 허용 범위(`dmAccess`)는 admin 이상이 바꾸고
 * 아래 사람에게는 값만 보인다(스펙 결정 4)
 */
export function AgentRow({
  agent,
  readOnly = false,
  onArchived,
  focusRef,
  as: Root = "li",
  moveTargets,
}: {
  agent: Agent;
  readOnly?: boolean;
  /**
   * 「Gateway 옮기기」를 보일 때 옮길 수 있는 Gateway 판정 — 없으면 단추를 그리지 않는다. admin 이상은 모두, 그 Gateway 의 주인 member 는
   * 자기 Gateway 만(연결 탭 통합 스펙 5.2)
   */
  moveTargets?: (gatewayId: string) => boolean;
  onArchived?: () => void;
  focusRef?: Ref<HTMLButtonElement>;
  /** 「연결」 탭의 에이전트 상세는 목록 밖에서 그린다 — `div` */
  as?: "li" | "div";
}) {
  const toggle = usePatchAgent();
  const role = useRole();
  const handle = `@${agent.handle}`;
  const openclaw = agent.provider === "openclaw";
  return (
    <Root className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      {/* 좁은 화면(390px)에서는 버튼·스위치 묶음이 아랫줄로 감긴다 — 이름 칸이 한 글자 폭으로 눌리지 않게 최소 폭을 준다 */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 grow basis-48 items-start gap-3">
          <span
            aria-hidden
            className="mt-1.5 size-2.5 shrink-0 rounded-full"
            style={{ background: agentColorVar(agent.handle) }}
          />
          <div className={cn("min-w-0 flex-1", !agent.enabled && "opacity-60")}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{agent.name}</span>
              <span className="text-sm text-muted-foreground">
                <span>{handle}</span>
                {openclaw && agent.gateway && <> · {agent.gateway.name}</>}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {providerIdLabel(agent.provider)} <code className="font-mono">{agent.providerAgentId}</code>
            </p>
            {agent.provider === "runner" && <RunnerLine agent={agent} />}
            {openclaw && agent.gateway === null && (
              <p className="text-xs font-medium text-destructive">
                {moveTargets
                  ? "Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요"
                  : "Gateway 가 삭제됨 — admin 이 다른 Gateway 로 옮길 때까지 답하지 못합니다"}
              </p>
            )}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {canOpenDm(agent, role) && (
            <Button asChild variant="outline" size="sm">
              <Link to="/dm/$agentId" params={{ agentId: agent.id }} aria-label={`${handle} DM 보내기`}>
                <MessageCircleIcon />
                DM 보내기
              </Link>
            </Button>
          )}
          {openclaw && moveTargets && <MoveGatewayDialog agent={agent} allowed={moveTargets} />}
          {!readOnly && <ArchiveAgentButton agent={agent} onArchived={onArchived} />}
          <Switch
            ref={focusRef}
            aria-label={`${handle} 사용`}
            checked={agent.enabled}
            disabled={toggle.isPending || readOnly}
            onCheckedChange={(enabled) => toggle.mutate({ id: agent.id, patch: { enabled } })}
          />
        </div>
      </div>
      {!readOnly && agent.runnerAgent && <RunnerDefinition agent={agent} definition={agent.runnerAgent} />}
      <BasePromptEditor agent={agent} readOnly={readOnly} />
      <DmAccessField agent={agent} readOnly={readOnly} />
      {!readOnly && <AgentAvatarField agent={agent} />}
    </Root>
  );
}

/** 에이전트 사진(프로필 스펙 3.6) — admin 이상(읽기 전용이면 없다) */
export function AgentAvatarField({ agent }: { agent: Agent }) {
  const avatar = useAgentAvatar(agent.id);
  return (
    <AvatarPicker
      name={agent.name}
      currentUrl={agent.avatarUrl}
      upload={(image) => avatar.upload.mutateAsync(image)}
      remove={() => avatar.remove.mutateAsync()}
    />
  );
}

/** `dmAccess` 선택지(에이전트 DM 계획 Global Constraints — 글자 그대로) */
const DM_ACCESS_LABEL: Record<DmAccess, string> = { off: "끔", admins: "admin 이상", everyone: "모두" };
/** 「모두」 아래 설명 — 「모두」는 member 가 이 에이전트의 도구 승인을 스스로 한다는 뜻이다(에이전트 DM 스펙 결정 5) */
export const DM_ACCESS_EVERYONE_NOTE =
  "member 도 이 에이전트와 DM 을 열고, 그 DM 의 도구 승인을 스스로 결정합니다.";

/**
 * DM 허용 범위(에이전트 DM 스펙 결정 4) — 누가 이 에이전트와 새 DM 을 여나. 고르는 즉시 저장한다(채널의 세션 정책과 같은 방식). 좁히면 그
 * 범위 밖 사람의 DM 은 읽기 전용이 된다(서버가 판정 — wire `agents.changed` 로 그 사람의 화면이 바뀐다). `readOnly`(admin 미만)면 값만 보인다.
 * 「모두」의 설명은 고르기 전에도 늘 보인다 — 무엇을 허락하는지 알고 고르게
 */
function DmAccessField({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
  const save = usePatchAgent();
  const [error, setError] = useState<string>();
  const id = useId();
  const handle = `@${agent.handle}`;
  const value = agent.dmAccess;

  function choose(next: string) {
    if (readOnly || save.isPending || next === value || !(next in DM_ACCESS_LABEL)) return;
    setError(undefined);
    save.mutate(
      { id: agent.id, patch: { dmAccess: next as DmAccess } },
      { onError: (err) => setError(formError(err)) },
    );
  }

  if (readOnly)
    return (
      <p className="text-sm text-muted-foreground">
        DM 허용: <span className="text-foreground">{DM_ACCESS_LABEL[value]}</span>
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p aria-hidden className="text-sm font-medium">
        DM 허용
      </p>
      <RadioGroup
        aria-label={`${handle} DM 허용`}
        aria-describedby={error ? `${id}-error` : undefined}
        value={value}
        onValueChange={choose}
        disabled={save.isPending}
        className="flex flex-col gap-2"
      >
        {(["off", "admins", "everyone"] as const).map((option) => (
          <div key={option} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <RadioGroupItem
                id={`${id}-${option}`}
                value={option}
                aria-describedby={option === "everyone" ? `${id}-everyone-note` : undefined}
              />
              <Label htmlFor={`${id}-${option}`} className="font-normal">
                {DM_ACCESS_LABEL[option]}
              </Label>
            </div>
            {option === "everyone" && (
              <p id={`${id}-everyone-note`} className="pl-6 text-xs text-muted-foreground">
                {DM_ACCESS_EVERYONE_NOTE}
              </p>
            )}
          </div>
        ))}
      </RadioGroup>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

/**
 * 「삭제」와 확인 대화상자. 확인을 같은 틱에 두 번 눌러도 한 번만 보낸다 — `isPending` 은 다시 그린 뒤에야 참이라 그 사이 두 번째 클릭이
 * 지나간다. 실패는 전역 토스트(대화상자는 열린 채 다시 누를 수 있다)
 */
function ArchiveAgentButton({ agent, onArchived }: { agent: Agent; onArchived?: () => void }) {
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
        description={`${handle} ${josa(agent.handle, "을", "를")} 삭제합니다. 채팅 기록은 남고, 되살리면 채널·대화가 그대로 돌아옵니다.`}
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
 * 러너 에이전트의 프로그램과 맡은 러너(묶인 러너 토큰의 라벨) — 누구나 본다. 토큰이 폐기됐으면 맡을 러너가 없다: 그 프로젝트를
 * 러너 상세(「연결」 탭)에서 다른 러너로 옮긴다(러너 일반화 계획 판정 PR8)
 */
function RunnerLine({ agent }: { agent: Agent }) {
  const program = agent.program ? `${RUNNER_PROGRAM_NAME[agent.program]} · ` : "";
  const runner = agent.runner;
  if (!runner) return <p className="text-xs text-muted-foreground">{program}맡을 러너가 없습니다</p>;
  if (!runner.revoked)
    return (
      <p className="text-xs text-muted-foreground">
        {program}러너 {runner.label}
      </p>
    );
  return (
    <p className="text-xs font-medium text-destructive">
      {program}러너 {runner.label} — 토큰이 폐기돼 맡을 러너가 없습니다.{" "}
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

/**
 * 러너 에이전트의 정의(admin 이상 — 서버가 아래 역할에는 `runnerAgent` 를 싣지 않는다, 러너 일반화 계획 판정 PR11): 요약 한 줄과
 * 「러너 설정 고치기」. 고치기는 만들기와 같은 칸이고 프로그램·프로젝트는 읽기만(`RunnerDefinitionForm`)
 */
function RunnerDefinition({
  agent,
  definition,
}: {
  agent: Agent;
  definition: NonNullable<Agent["runnerAgent"]>;
}) {
  const save = usePatchAgent();
  const [editing, setEditing] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const handle = `@${agent.handle}`;
  const tools = definition.allowedTools;

  if (editing)
    return (
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <p className="text-sm font-medium">러너 설정</p>
        <RunnerDefinitionForm
          agent={agent}
          definition={definition}
          pending={save.isPending}
          serverError={save.error ?? undefined}
          onCancel={() => {
            save.reset();
            setEditing(false);
            setRefocus(true);
          }}
          onSave={(patch) => {
            if (Object.keys(patch).length === 0) {
              setEditing(false);
              setRefocus(true);
              return;
            }
            save.mutate(
              { id: agent.id, patch },
              {
                onSuccess: () => {
                  setEditing(false);
                  setRefocus(true);
                },
              },
            );
          }}
        />
      </div>
    );
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 text-sm break-words text-muted-foreground">
        권한 <code className="font-mono text-xs">{definition.permissionMode}</code> · 모델{" "}
        {definition.model ?? "기본"} · 허용 도구{" "}
        {tools === null || tools.length === 0 ? "없음" : tools.join(", ")}
      </p>
      <Button
        variant="outline"
        size="sm"
        aria-label={`${handle} 러너 설정 고치기`}
        autoFocus={refocus}
        onClick={() => {
          save.reset();
          setEditing(true);
        }}
      >
        러너 설정 고치기
      </Button>
    </div>
  );
}

/**
 * 같은 `basePrompt` 칸을 제공자에 맞는 이름으로 부른다. 러너 에이전트에게는 매 런 지시로 가므로 만들 때와 같은 「지시」,
 * OpenClaw 에이전트에게는 인바운드에 실리지 않아(서버 코어 스펙 에이전트 항목 — 의도) 규칙을 적는 자리로 읽히지 않게 「메모」다
 */
function promptCopy(agent: Pick<Agent, "provider">) {
  return agent.provider === "runner"
    ? { name: "지시", empty: "지시 없음", note: undefined }
    : { name: "메모", empty: "메모 없음", note: "에이전트에게 전달되지 않음" };
}

/** 접힌 채로는 미리보기, 펼치면 편집. 비워 저장하면 null(지움). VALIDATION·CONFLICT 만 폼 안에 — 그 밖은 전역 토스트 */
function BasePromptEditor({ agent, readOnly }: { agent: Agent; readOnly: boolean }) {
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
              {copy.name}({copy.note})
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
