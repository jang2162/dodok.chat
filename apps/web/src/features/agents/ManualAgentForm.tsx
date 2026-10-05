import { type AdapterProvider, Handle } from "@dodok/shared";
import { type ComponentProps, type FormEvent, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { handleFrom } from "./handleFrom";
import { PROVIDER_ID_LABEL } from "./providerLabels";
import { AGENT_ARCHIVED_TEXT, detailField, formError, validationField } from "@/api/formErrors";
import { useCreateAgent, useRestoreAgent } from "./mutations";

const NAME_MAX = 80;
/** 에이전트 id 규칙 안내 — 서버가 shared 세션 키 헬퍼와 같은 규칙에 소문자만으로 거절한다(스레드·검색 태스크 5, 판정 R4). 러너 에이전트 id 도 같은 규칙 */
export const PROVIDER_ID_HINT = "영문 소문자·숫자로 시작, 영문 소문자·숫자·_·- (64자 이하)";

/** 클라이언트 검사 — shared 규칙(Handle·Agent.name)과 같다. 문구는 폼 안에 그린다 */
export const handleProblem = (handle: string): string | undefined =>
  Handle.safeParse(handle).success ? undefined : "영문 소문자·숫자·_·- 로 2~32자";
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "이름을 입력하세요";
  if (trimmed.length > NAME_MAX) return `이름은 ${NAME_MAX}자까지입니다`;
  return undefined;
}

/**
 * 라벨·입력·오류 한 벌. 오류는 입력의 설명(aria-describedby)으로 잇고, 오류 자리는 늘 두는 라이브 영역이다.
 * 안내(`hint`)가 있으면 칸 아래에 늘 보이고, 오류가 없을 때의 설명이다 — 오류가 나면 설명은 오류 문구가 된다
 */
function Field({
  label,
  error,
  hint,
  ...input
}: { label: string; error?: string; hint?: string } & Omit<ComponentProps<"input">, "id">) {
  const id = useId();
  const describedBy = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        {...input}
      />
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

type AgentFieldsProps = {
  /** 목록 항목처럼 한 화면에 여러 벌이면 접근 이름 앞에 붙인다(「Fin 핸들」) */
  labelPrefix?: string;
  handle: string;
  name: string;
  onHandle: (value: string) => void;
  onName: (value: string) => void;
  handleError?: string;
  nameError?: string;
  disabled?: boolean;
};

/** 핸들·이름 입력 — 직접 입력 폼과 Gateway 목록 항목이 함께 쓴다 */
export function AgentFields(props: AgentFieldsProps) {
  const prefixed = (label: string) => (props.labelPrefix ? `${props.labelPrefix} ${label}` : undefined);
  return (
    <>
      <Field
        label="핸들"
        aria-label={prefixed("핸들")}
        value={props.handle}
        onChange={(e) => props.onHandle(e.target.value)}
        error={props.handleError}
        disabled={props.disabled}
      />
      <Field
        label="이름"
        aria-label={prefixed("이름")}
        value={props.name}
        onChange={(e) => props.onName(e.target.value)}
        error={props.nameError}
        disabled={props.disabled}
      />
    </>
  );
}

/**
 * 409 의 details.field 가 providerAgentId — OpenClaw 는 같은 Gateway 안에서, 러너 에이전트는 워크스페이스에서 id 가 하나다(멀티 Gateway
 * 스펙 「바뀌는 표」 절). 서버 문구 대신 이것을 보인다
 */
export const ID_TAKEN: Record<AdapterProvider, string> = {
  openclaw: "이 Gateway 에 이미 등록된 id 입니다",
  claude: "이미 등록된 러너 에이전트 id 입니다",
};
/** 핸들 겹침 — 클라이언트가 아는 에이전트 핸들과 겹치거나 서버가 409 로 막을 때(멀티 Gateway 스펙 「웹」 절). 서버 문구는 보이지 않는다 */
export const HANDLE_TAKEN = "이미 쓰이는 핸들입니다 — 다른 핸들을 입력하세요";

/** 등록 오류가 id 중복(409 details.field providerAgentId)이면 고정 문구, 아니면 undefined */
export const idTaken = (err: unknown, provider: AdapterProvider): string | undefined =>
  err instanceof ApiRequestError && err.code === "CONFLICT" && detailField(err, ["providerAgentId"])
    ? ID_TAKEN[provider]
    : undefined;

/** 핸들 칸의 문제 — 규칙 밖이거나, 이미 등록된 에이전트의 핸들(사람 핸들은 모른다 — 서버 409 가 같은 문구로 알린다) */
export const handleIssue = (handle: string, taken: ReadonlySet<string>): string | undefined =>
  handleProblem(handle) ?? (taken.has(handle) ? HANDLE_TAKEN : undefined);

/**
 * 제공자의 에이전트 id·핸들·이름을 직접 넣어 등록(서버는 목록 검사를 하지 않는다 — 러너 계획 판정 P9). OpenClaw 는 대화상자가 고른
 * Gateway 로 등록한다. 핸들·이름은 손대기 전까지 id 를 따라간다(핸들은 handleFrom).
 * 서버 CONFLICT 는 핸들 칸 아래 고정 문구(id 중복이면 id 칸 아래 고정 문구), providerAgentId 를 가리킨 VALIDATION 은 id 칸 아래,
 * 그 밖의 VALIDATION 은 폼 아래 — 그 밖은 전역 토스트가 알린다.
 * 같은 자리의 보관(삭제)한 에이전트면(이 화면이 알거나 서버 409 AGENT_ARCHIVED 의 details.agentId) id 칸에 「삭제된 에이전트입니다」와
 * 「되살리기」 — 등록 대신 되살린다(스펙 「오류」 절)
 */
export function ManualAgentForm({
  provider,
  gatewayId,
  registeredIds,
  archivedIds = new Map(),
  takenHandles,
  onCreated,
}: {
  provider: AdapterProvider;
  /** OpenClaw 면 등록할 Gateway */
  gatewayId?: string;
  /** 이미 등록된(살아 있는) providerAgentId(OpenClaw 는 그 Gateway 의 것) — 요청 전에 막는다 */
  registeredIds: ReadonlySet<string>;
  /** 같은 자리의 보관한 에이전트 — providerAgentId → 에이전트 id */
  archivedIds?: ReadonlyMap<string, string>;
  /** 이미 등록된 에이전트들의 핸들 — 요청 전에 막는다 */
  takenHandles: ReadonlySet<string>;
  onCreated: () => void;
}) {
  const create = useCreateAgent();
  const { restore, isPending: restoring } = useRestoreAgent();
  const [rawId, setRawId] = useState("");
  const [handle, setHandle] = useState<string>(); // undefined 면 id 를 따른다
  const [name, setName] = useState<string>();
  const [serverError, setServerError] = useState<{
    field: "id" | "handle" | "form";
    message: string;
    /** 409 AGENT_ARCHIVED 가 알린 보관한 에이전트 */
    archivedId?: string;
  }>();

  const providerAgentId = rawId.trim();
  const started = providerAgentId !== "";
  const currentHandle = handle ?? (started ? handleFrom(providerAgentId) : "");
  const currentName = name ?? providerAgentId;
  const archivedId = serverError?.archivedId ?? archivedIds.get(providerAgentId);
  const idError =
    serverError?.field === "id"
      ? serverError.message
      : archivedId !== undefined
        ? AGENT_ARCHIVED_TEXT
        : registeredIds.has(providerAgentId)
          ? `이미 등록된 ${PROVIDER_ID_LABEL[provider]} 입니다`
          : undefined;
  const handleError =
    serverError?.field === "handle"
      ? serverError.message
      : started
        ? handleIssue(currentHandle, takenHandles)
        : undefined;
  const nameError = started ? nameProblem(currentName) : undefined;
  const ready =
    started &&
    idError === undefined &&
    handleIssue(currentHandle, takenHandles) === undefined &&
    nameProblem(currentName) === undefined;

  /** 칸을 고치면 지난 서버 오류는 지운다 */
  const edit = (set: (value: string) => void) => (value: string) => {
    setServerError(undefined);
    set(value);
  };

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || create.isPending) return;
    setServerError(undefined);
    create.mutate(
      {
        provider,
        ...(provider === "openclaw" ? { gatewayId } : {}),
        providerAgentId,
        handle: currentHandle,
        name: currentName.trim(),
      },
      {
        onSuccess: onCreated,
        onError: (err) => {
          const message = formError(err);
          if (message === undefined) return;
          if (err instanceof ApiRequestError && err.code === "AGENT_ARCHIVED") {
            const agentId = err.details?.agentId;
            setServerError({
              field: "id",
              message,
              ...(typeof agentId === "string" ? { archivedId: agentId } : {}),
            });
            return;
          }
          const taken = idTaken(err, provider);
          if (taken !== undefined) {
            setServerError({ field: "id", message: taken });
            return;
          }
          if (err instanceof ApiRequestError && err.code === "CONFLICT") {
            setServerError({ field: "handle", message: HANDLE_TAKEN });
            return;
          }
          const field = validationField(message, ["providerAgentId"]) ? "id" : "form";
          setServerError({ field, message });
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field
        label={PROVIDER_ID_LABEL[provider]}
        value={rawId}
        onChange={(e) => edit(setRawId)(e.target.value)}
        error={idError}
        hint={PROVIDER_ID_HINT}
        disabled={create.isPending}
      />
      <AgentFields
        handle={currentHandle}
        name={currentName}
        onHandle={edit(setHandle)}
        onName={edit(setName)}
        handleError={handleError}
        nameError={nameError}
        disabled={create.isPending}
      />
      {archivedId !== undefined && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={restoring || create.isPending}
          onClick={() => restore(archivedId, onCreated)}
        >
          {restoring ? "되살리는 중…" : "되살리기"}
        </Button>
      )}
      {serverError?.field === "form" && (
        <Alert variant="destructive">
          <AlertDescription>{serverError.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="self-end" disabled={!ready || create.isPending}>
        {create.isPending ? "등록 중…" : "등록"}
      </Button>
    </form>
  );
}
