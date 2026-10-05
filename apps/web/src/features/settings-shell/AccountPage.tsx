import { DisplayName } from "@dodok/shared";
import { LogOutIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { detailField } from "@/api/formErrors";
import { useMe } from "@/api/queries";
import { useChangePassword, useUpdateMe } from "@/features/account/mutations";
import {
  AuthField,
  CONFIRM_MISMATCH,
  PASSWORD_HINT,
  authErrorText,
  fieldErrorText,
  passwordProblem,
} from "@/features/auth/fields";
import { useLogout } from "@/features/auth/mutations";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Separator } from "@/ui/separator";

/**
 * 설정 「내 계정」 탭(`/settings/account`, 팀 스펙 3.5·6장) — 표시 이름, 비밀번호 바꾸기, 로그아웃. owner 는 비밀번호 칸 대신 안내만:
 * owner 의 비밀번호는 로컬 토큰이라 서버가 `POST /me/password` 를 403 으로 막는다. 칸은 탭에 들어올 때마다 처음부터다
 */
export function AccountPage() {
  const me = useMe().data;
  const logout = useLogout();
  return (
    <section data-testid="page-account" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">내 계정</h1>
        <p className="text-sm break-all text-muted-foreground">
          {me ? [`@${me.user.handle}`, me.user.email].filter(Boolean).join(" · ") : ""}
        </p>
      </header>
      {me && (
        <div className="flex max-w-md flex-col gap-6">
          <DisplayNameForm current={me.user.displayName} />
          <Separator />
          {me.role === "owner" ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">비밀번호</h2>
              <p className="text-sm text-muted-foreground">
                owner 비밀번호는 로컬 토큰입니다 — 서버 <code>.env</code> 의 <code>LOCAL_AUTH_TOKEN</code>{" "}
                으로 바꿉니다
              </p>
            </section>
          ) : (
            <PasswordForm />
          )}
          <Separator />
          {/* /login 이동·상태 비우기는 훅이 한다 */}
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            <LogOutIcon />
            로그아웃
          </Button>
        </div>
      )}
    </section>
  );
}

function DisplayNameForm({ current }: { current: string }) {
  const update = useUpdateMe();
  const [name, setName] = useState(current);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const trimmed = name.trim();
  const valid = DisplayName.safeParse(name).success;
  const changed = trimmed !== current;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid || !changed || update.isPending) return;
    setError(undefined);
    update.mutate(
      { displayName: trimmed },
      { onSuccess: () => setSaved(true), onError: (err) => setError(authErrorText(err)) },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <AuthField
        label="표시 이름"
        autoComplete="name"
        value={name}
        onChange={(e) => {
          setSaved(false);
          setError(undefined);
          setName(e.target.value);
        }}
        error={error ?? (name !== "" && !valid ? "표시 이름은 1~64자입니다" : undefined)}
        disabled={update.isPending}
      />
      <div className="flex items-center justify-end gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          {saved ? "저장했습니다" : ""}
        </p>
        <Button type="submit" size="sm" disabled={!valid || !changed || update.isPending}>
          {update.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </form>
  );
}

type PwField = "current" | "next" | "confirm";

/** 규칙에 어긋나면(두 칸이 다름 포함) 보내지 않는다. 칸 오류는 손댄 칸(blur)이나 제출 뒤에만 — 가입 폼(auth/JoinPage)과 같다 */
function PasswordForm() {
  const change = useChangePassword();
  const [values, setValues] = useState<Record<PwField, string>>({ current: "", next: "", confirm: "" });
  const [touched, setTouched] = useState<Partial<Record<PwField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<{ field?: "current" | "next"; message: string }>();
  const [done, setDone] = useState(false);
  // 400 필드 오류 뒤 그 칸으로 초점을 옮긴다(o2) — 커밋 뒤(잠금이 풀린 뒤)로 미룬다
  const fieldRefs = useRef<Partial<Record<PwField, HTMLInputElement | null>>>({});
  useEffect(() => {
    if (serverError?.field) fieldRefs.current[serverError.field]?.focus();
  }, [serverError]);

  const local: Record<PwField, string | undefined> = {
    current: values.current === "" ? "현재 비밀번호를 입력하세요" : undefined,
    next: passwordProblem(values.next),
    confirm: values.confirm === values.next ? undefined : CONFIRM_MISMATCH,
  };
  const errorOf = (field: PwField) =>
    serverError?.field === field
      ? serverError.message
      : submitted || touched[field]
        ? local[field]
        : undefined;
  const bind = (field: PwField) => ({
    ref: (el: HTMLInputElement | null) => {
      fieldRefs.current[field] = el;
    },
    type: "password",
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      setDone(false);
      if (serverError?.field === field) setServerError(undefined);
      setValues((prev) => ({ ...prev, [field]: e.target.value }));
    },
    onBlur: () => setTouched((prev) => ({ ...prev, [field]: true })),
    error: errorOf(field),
    disabled: change.isPending,
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (change.isPending) return;
    setSubmitted(true);
    if (Object.values(local).some((p) => p !== undefined)) return;
    setServerError(undefined);
    change.mutate(
      { current: values.current, next: values.next },
      {
        onSuccess: () => {
          setValues({ current: "", next: "", confirm: "" });
          setTouched({});
          setSubmitted(false);
          setDone(true);
        },
        onError: (err) => {
          const field = detailField(err, ["current", "next"]);
          setServerError({ field, message: fieldErrorText(err, field) });
        },
        onSettled: () => change.reset(),
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">비밀번호 바꾸기</h2>
      <AuthField label="현재 비밀번호" autoComplete="current-password" {...bind("current")} />
      <AuthField label="새 비밀번호" autoComplete="new-password" hint={PASSWORD_HINT} {...bind("next")} />
      <AuthField label="새 비밀번호 확인" autoComplete="new-password" {...bind("confirm")} />
      {serverError && serverError.field === undefined && (
        <Alert variant="destructive">
          <AlertDescription>{serverError.message}</AlertDescription>
        </Alert>
      )}
      <p role="status" className="text-sm text-muted-foreground empty:-mt-3">
        {done ? "비밀번호를 바꿨습니다 — 다른 기기의 로그인은 끊겼습니다" : ""}
      </p>
      <Button type="submit" size="sm" className="self-end" disabled={change.isPending}>
        {change.isPending ? "바꾸는 중…" : "비밀번호 바꾸기"}
      </Button>
    </form>
  );
}
