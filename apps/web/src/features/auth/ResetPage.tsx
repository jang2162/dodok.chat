import type { InviteLookup } from "@dodok/shared";
import { getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { AuthField, CONFIRM_MISMATCH, PASSWORD_HINT, authErrorText, passwordProblem } from "./fields";
import { AuthScreen, InviteGate, InviteInvalid } from "./invite";
import { useFinishInvite, useResetPassword } from "./mutations";

const route = getRouteApi("/reset/$token");

/** `/reset/<token>`(팀 스펙 6장) — 가입과 같은 꼴에 비밀번호 두 칸만. 성공하면 서버가 그 사용자의 다른 세션을 끊고 새로 로그인시킨다 */
export function ResetPage() {
  const { token } = route.useParams();
  return (
    <InviteGate token={token} kind="reset">
      {(lookup) => <ResetForm token={token} lookup={lookup} />}
    </InviteGate>
  );
}

/** 칸 오류를 보이는 때·404 처리는 가입 폼(JoinPage `JoinForm`)과 같다 */
function ResetForm({ token, lookup }: { token: string; lookup: InviteLookup }) {
  const reset = useResetPassword();
  const finish = useFinishInvite();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState({ password: false, confirm: false });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [gone, setGone] = useState(false);

  if (gone) return <InviteInvalid kind="reset" />;

  const passwordError = passwordProblem(password);
  const confirmError = confirm === password ? undefined : CONFIRM_MISMATCH;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (reset.isPending) return;
    setSubmitted(true);
    if (passwordError !== undefined || confirmError !== undefined) return;
    setError(undefined);
    reset.mutate(
      { token, password },
      {
        onSuccess: finish,
        onError: (err) => {
          if (err instanceof ApiRequestError && err.status === 404) setGone(true);
          else setError(authErrorText(err));
        },
        onSettled: () => reset.reset(),
      },
    );
  }

  return (
    <AuthScreen>
      <form onSubmit={submit} noValidate className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-xl font-semibold break-words">{lookup.workspaceName} 비밀번호 재설정</h1>
        <AuthField
          label="새 비밀번호"
          type="password"
          autoComplete="new-password"
          autoFocus
          hint={PASSWORD_HINT}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          error={submitted || touched.password ? passwordError : undefined}
          disabled={reset.isPending}
        />
        <AuthField
          label="비밀번호 확인"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
          error={submitted || touched.confirm ? confirmError : undefined}
          disabled={reset.isPending}
        />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={reset.isPending}>
          {reset.isPending ? "바꾸는 중…" : "비밀번호 바꾸기"}
        </Button>
      </form>
    </AuthScreen>
  );
}
