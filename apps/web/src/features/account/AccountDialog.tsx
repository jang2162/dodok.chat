import { DisplayName } from "@dodok/shared";
import { type FormEvent, type ReactNode, useState } from "react";
import { detailField } from "@/api/formErrors";
import { useMe } from "@/api/queries";
import {
  AuthField,
  CONFIRM_MISMATCH,
  PASSWORD_HINT,
  authErrorText,
  passwordProblem,
} from "@/features/auth/fields";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Separator } from "@/ui/separator";
import { useChangePassword, useUpdateMe } from "./mutations";

/**
 * 「내 계정」(팀 스펙 3.5·6장) — 표시 이름, 비밀번호 바꾸기. owner 는 비밀번호 칸 대신 안내만: owner 의 비밀번호는 로컬 토큰이라
 * 서버가 `POST /me/password` 를 403 으로 막는다. `children` 이 여는 버튼이다. 닫으면 칸을 버린다(다시 열면 처음부터)
 */
export function AccountDialog({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const me = useMe().data;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>내 계정</DialogTitle>
          <DialogDescription className="break-all">
            {me ? [`@${me.user.handle}`, me.user.email].filter(Boolean).join(" · ") : ""}
          </DialogDescription>
        </DialogHeader>
        {me && open && (
          <>
            <DisplayNameForm current={me.user.displayName} />
            <Separator />
            {me.role === "owner" ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">비밀번호</h3>
                <p className="text-sm text-muted-foreground">
                  owner 비밀번호는 로컬 토큰입니다 — 서버 <code>.env</code> 의 <code>LOCAL_AUTH_TOKEN</code>{" "}
                  으로 바꿉니다
                </p>
              </section>
            ) : (
              <PasswordForm />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
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
        onError: (err) =>
          setServerError({ field: detailField(err, ["current", "next"]), message: authErrorText(err) }),
        onSettled: () => change.reset(),
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">비밀번호 바꾸기</h3>
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
