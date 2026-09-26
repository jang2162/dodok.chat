import { AcceptInviteBody, DisplayName, Handle, type InviteLookup } from "@dodok/shared";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { detailField } from "@/api/formErrors";
import { ApiRequestError } from "@/api/http";
import { useCachedMe } from "@/api/queries";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { AuthField, CONFIRM_MISMATCH, PASSWORD_HINT, fieldErrorText, passwordProblem } from "./fields";
import { AuthScreen, InviteGate, InviteInvalid } from "./invite";
import { useAcceptInvite, useFinishInvite } from "./mutations";

const route = getRouteApi("/join/$token");

const ROLE_TEXT = { admin: "관리자로 초대받았습니다", member: "멤버로 초대받았습니다" } as const;

type Field = "handle" | "displayName" | "email" | "password" | "confirm";
type Values = Record<Field, string>;
const EMPTY: Values = { handle: "", displayName: "", email: "", password: "", confirm: "" };

/** 클라이언트 검사 — shared AcceptInviteBody 의 칸 규칙과 같다. 서버가 다시 막는다 */
function problems(v: Values): Partial<Record<Field, string>> {
  return {
    handle: Handle.safeParse(v.handle).success ? undefined : "영문 소문자·숫자·_·- 로 2~32자",
    displayName: DisplayName.safeParse(v.displayName).success ? undefined : "표시 이름은 1~64자입니다",
    email: AcceptInviteBody.shape.email.safeParse(v.email.trim()).success
      ? undefined
      : "이메일 모양이 아닙니다",
    password: passwordProblem(v.password),
    confirm: v.confirm === v.password ? undefined : CONFIRM_MISMATCH,
  };
}

/** `/join/<token>`(팀 스펙 6장) — 로그인 가드 밖. 조회로 워크스페이스·역할을 보인 뒤 가입 폼 */
export function JoinPage() {
  const { token } = route.useParams();
  return (
    <InviteGate key={token} token={token} kind="invite">
      {(lookup) => <JoinForm token={token} lookup={lookup} />}
    </InviteGate>
  );
}

/**
 * 칸 오류는 손댄 칸(blur)이나 제출을 한 번 누른 뒤에만 보인다 — 치는 중에 「이메일 모양이 아닙니다」가 깜빡이지 않게.
 * 규칙에 어긋나면(두 비밀번호가 다름 포함) 보내지 않는다. 서버 409 는 `details.field` 가 가리킨 칸 아래, 그 칸을 고치면 지운다.
 * 수락 404(그 사이 다른 쪽이 씀·만료)는 무효 화면으로 바꾼다
 */
function JoinForm({ token, lookup }: { token: string; lookup: InviteLookup }) {
  // 이미 로그인한 브라우저면 가입이 그 로그인을 바꾼다(useFinishInvite) — 폼 위에 한 줄로 알린다
  const signedInAs = useCachedMe()?.user.handle;
  const accept = useAcceptInvite();
  const finish = useFinishInvite();
  const [values, setValues] = useState<Values>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<{ field?: "handle" | "email"; message: string }>();
  const [gone, setGone] = useState(false);
  // 409·400 필드 오류 뒤 그 칸으로 초점을 옮긴다(o2) — 제출 버튼이 비활성으로 바뀌며 초점을 잃는 대신.
  // 이 오류가 뜨는 렌더에서는 이미 accept.isPending 이 꺼져 칸이 잠기지 않는다 — useEffect 로 커밋 뒤에 옮긴다
  const fieldRefs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  useEffect(() => {
    if (serverError?.field) fieldRefs.current[serverError.field]?.focus();
  }, [serverError]);

  if (gone) return <InviteInvalid kind="invite" />;

  const local = problems(values);
  const errorOf = (field: Field) =>
    serverError?.field === field
      ? serverError.message
      : submitted || touched[field]
        ? local[field]
        : undefined;

  const bind = (field: Field) => ({
    ref: (el: HTMLInputElement | null) => {
      fieldRefs.current[field] = el;
    },
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      if (serverError?.field === field) setServerError(undefined);
      setValues((prev) => ({ ...prev, [field]: e.target.value }));
    },
    onBlur: () => setTouched((prev) => ({ ...prev, [field]: true })),
    error: errorOf(field),
    disabled: accept.isPending,
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (accept.isPending) return;
    setSubmitted(true);
    if (Object.values(local).some((p) => p !== undefined)) return;
    setServerError(undefined);
    accept.mutate(
      {
        token,
        handle: values.handle,
        displayName: values.displayName.trim(),
        email: values.email.trim(),
        password: values.password,
      },
      {
        onSuccess: finish,
        onError: (err) => {
          if (err instanceof ApiRequestError && err.status === 404) setGone(true);
          else {
            const field = detailField(err, ["handle", "email"]);
            setServerError({ field, message: fieldErrorText(err, field, "invite") });
          }
        },
        onSettled: () => accept.reset(),
      },
    );
  }

  return (
    <AuthScreen>
      <form onSubmit={submit} noValidate className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold break-words">{lookup.workspaceName}에 가입</h1>
          {lookup.role && <p className="text-sm text-muted-foreground">{ROLE_TEXT[lookup.role]}</p>}
        </div>
        {signedInAs && (
          <p className="rounded-lg border px-4 py-3 text-sm break-words text-muted-foreground">
            지금 @{signedInAs} 로 로그인돼 있습니다 — 가입하면 이 브라우저는 새 계정으로 바뀝니다
          </p>
        )}
        <AuthField
          label="핸들"
          hint="@멘션에 쓰는 이름 — 영문 소문자·숫자·_·-"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          {...bind("handle")}
        />
        <AuthField label="표시 이름" autoComplete="name" {...bind("displayName")} />
        <AuthField
          label="이메일"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          {...bind("email")}
        />
        <AuthField
          label="비밀번호"
          type="password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          {...bind("password")}
        />
        <AuthField label="비밀번호 확인" type="password" autoComplete="new-password" {...bind("confirm")} />
        {serverError && serverError.field === undefined && (
          <Alert variant="destructive">
            <AlertDescription>{serverError.message}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={accept.isPending}>
          {accept.isPending ? "가입 중…" : "가입"}
        </Button>
      </form>
    </AuthScreen>
  );
}
