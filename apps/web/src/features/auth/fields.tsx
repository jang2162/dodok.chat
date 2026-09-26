import { Password } from "@dodok/shared";
import { type ComponentProps, useId } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * 로그인 전 폼(로그인·가입·재설정)과 「내 계정」의 칸 하나 — 라벨·입력·오류. 오류는 입력의 설명(aria-describedby)이고
 * 오류 자리는 늘 두는 라이브 영역이다(FieldError). 안내(`hint`)는 오류가 없을 때의 설명이다
 */
export function AuthField({
  label,
  error,
  hint,
  ref,
  ...input
}: { label: string; error?: string; hint?: string } & Omit<ComponentProps<"input">, "id">) {
  const id = useId();
  const describedBy = error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} ref={ref} aria-invalid={error !== undefined} aria-describedby={describedBy} {...input} />
      {hint !== undefined && error === undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

export const PASSWORD_HINT = "12자 이상";
export const CONFIRM_MISMATCH = "비밀번호가 서로 다릅니다";

/** 새 비밀번호 규칙(shared Password — 12~256자). 서버도 같은 스키마로 막는다 */
export function passwordProblem(password: string): string | undefined {
  if (Password.safeParse(password).success) return undefined;
  return password.length < 12 ? "비밀번호는 12자 이상입니다" : "비밀번호는 256자까지입니다";
}

/**
 * 로그인 전 경로 공통 문구. 이 경로들은 로그인과 IP 버킷 하나를 같이 쓴다(서버 `createLoginLimit`) — 429 문구의 「1분 5회」는
 * 그 버킷이다. 그 밖의 서버 오류는 서버 message 그대로
 */
export function authErrorText(error: unknown): string {
  if (error instanceof NetworkError) return "서버에 연결할 수 없습니다";
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return "잠시 뒤 다시 시도하세요(1분 5회)";
    return error.message;
  }
  return "요청을 처리하지 못했습니다";
}

/**
 * 서버 문구를 그대로 내지 않는 알려진 칸 오류(o1) — `code:field` 로 고정 문구를 고른다.
 * 가입의 핸들 409(CONFLICT)·이메일 409·핸들 400(예약 `left-`, VALIDATION), 「내 계정」의 현재 비밀번호 400.
 * 모르는 조합은 authErrorText 그대로(서버 message)
 */
const KNOWN_FIELD_ERRORS: Record<string, string> = {
  "CONFLICT:handle": "이 핸들은 이미 쓰이고 있습니다",
  "CONFLICT:email": "이 이메일은 이미 가입돼 있습니다",
  "VALIDATION:handle": "이 핸들은 쓸 수 없습니다",
  "VALIDATION:current": "현재 비밀번호가 맞지 않습니다",
};

export function fieldErrorText(error: unknown, field: string | undefined): string {
  if (field !== undefined && error instanceof ApiRequestError) {
    const known = KNOWN_FIELD_ERRORS[`${error.code}:${field}`];
    if (known !== undefined) return known;
  }
  return authErrorText(error);
}
