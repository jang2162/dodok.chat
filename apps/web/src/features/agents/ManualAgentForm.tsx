import { Handle } from "@dodok/shared";
import { type ComponentProps, type FormEvent, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { handleFrom } from "./handleFrom";
import { formError, useCreateAgent } from "./mutations";

const NAME_MAX = 80;

/** 클라이언트 검사 — shared 규칙(Handle·Agent.name)과 같다. 문구는 폼 안에 그린다 */
export const handleProblem = (handle: string): string | undefined =>
  Handle.safeParse(handle).success ? undefined : "영문 소문자·숫자·_·- 로 2~32자";
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "이름을 입력하세요";
  if (trimmed.length > NAME_MAX) return `이름은 ${NAME_MAX}자까지입니다`;
  return undefined;
}

/** 라벨·입력·오류 한 벌. 오류는 입력의 설명(aria-describedby)으로 잇는다 */
function Field({
  label,
  error,
  ...input
}: { label: string; error?: string } & Omit<ComponentProps<"input">, "id">) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        {...input}
      />
      {error !== undefined && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
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
 * OpenClaw id·핸들·이름을 직접 넣어 등록. 핸들·이름은 손대기 전까지 OpenClaw id 를 따라간다(핸들은 handleFrom).
 * 서버 CONFLICT 는 핸들 칸 아래, VALIDATION 은 폼 아래 — 그 밖은 전역 토스트가 알린다
 */
export function ManualAgentForm({
  registeredIds,
  onCreated,
}: {
  /** 이미 등록된 providerAgentId — 요청 전에 막는다 */
  registeredIds: ReadonlySet<string>;
  onCreated: () => void;
}) {
  const create = useCreateAgent();
  const [rawId, setRawId] = useState("");
  const [handle, setHandle] = useState<string>(); // undefined 면 OpenClaw id 를 따른다
  const [name, setName] = useState<string>();
  const [serverError, setServerError] = useState<{ field: "handle" | "form"; message: string }>();

  const providerAgentId = rawId.trim();
  const started = providerAgentId !== "";
  const currentHandle = handle ?? (started ? handleFrom(providerAgentId) : "");
  const currentName = name ?? providerAgentId;
  const idError = registeredIds.has(providerAgentId) ? "이미 등록된 OpenClaw id 입니다" : undefined;
  const handleError =
    serverError?.field === "handle"
      ? serverError.message
      : started
        ? handleProblem(currentHandle)
        : undefined;
  const nameError = started ? nameProblem(currentName) : undefined;
  const ready =
    started &&
    idError === undefined &&
    handleProblem(currentHandle) === undefined &&
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
      { providerAgentId, handle: currentHandle, name: currentName.trim() },
      {
        onSuccess: onCreated,
        onError: (err) => {
          const message = formError(err);
          if (message === undefined) return;
          const field = err instanceof ApiRequestError && err.code === "CONFLICT" ? "handle" : "form";
          setServerError({ field, message });
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field
        label="OpenClaw id"
        value={rawId}
        onChange={(e) => edit(setRawId)(e.target.value)}
        error={idError}
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
