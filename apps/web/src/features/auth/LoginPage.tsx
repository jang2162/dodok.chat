import { Navigate, type RegisteredRouter, getRouteApi } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useMe } from "@/api/queries";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { AuthField, authErrorText } from "./fields";
import { useLogin } from "./mutations";

const route = getRouteApi("/login");

/** 토큰 모양의 401 은 서버 문구(「토큰이 맞지 않는다」) 대신 화면 말투로 */
function tokenErrorText(error: Error): string {
  if (error instanceof ApiRequestError && error.status === 401) return "토큰이 맞지 않습니다";
  return authErrorText(error);
}

/** 이메일 모양의 401 도 서버 문구(해라체) 대신 화면 말투로(o1) — 코드는 토큰과 같은 UNAUTHORIZED/401 이라 폼별로 가른다 */
function emailErrorText(error: Error): string {
  if (error instanceof ApiRequestError && error.status === 401) return "이메일 또는 비밀번호가 맞지 않습니다";
  return authErrorText(error);
}

/** me 가 풀렸으면 LoginPage 가 이미 이동한다 — 성공했는데 폼이 남았다면 쿠키가 안 구워진 것(http 에서 secureCookie 등) */
const NO_SESSION = "로그인했지만 세션을 확인하지 못했습니다";

/**
 * 실패 문구가 뜨면 비워진 칸(비밀번호·토큰)으로 초점을 옮긴다(가입·「내 계정」의 오류 칸 초점과 같다) — 제출한 버튼이
 * 비활성으로 바뀌며 초점이 body 로 떨어지지 않게. 문구가 뜨는 렌더에서는 이미 제출 중이 꺼져 칸이 잠기지 않는다
 */
function useFocusOnError(error: string | undefined, field: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    if (error !== undefined) field.current?.focus();
  }, [error, field]);
}

function FormError({ error }: { error?: string }) {
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;
}

/**
 * 로그인(팀 스펙 6장): 이메일·비밀번호가 기본, 아래 접힌 「owner 로컬 토큰으로 로그인」. 두 폼은 뮤테이션을 따로 쥔다 —
 * 제출 중 표시·오류가 서로 섞이지 않게
 */
export function LoginPage() {
  const { next } = route.useSearch();
  const me = useMe();
  const [tokenOpen, setTokenOpen] = useState(false);

  // 이미 로그인했거나 방금 로그인해 me 가 풀리면 원래 가려던 곳으로 — 이동은 이 한 곳에서만.
  // next 는 검색 문자열까지 담은 앱 안 경로라 `to` 가 아니라 `href` 로 간다(제네릭은 `to` 를 선택으로 만든다)
  if (me.isSuccess) return <Navigate<RegisteredRouter, string, string> href={next ?? "/"} replace />;

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <EmailForm />
        <div className="flex flex-col gap-3 border-t pt-4">
          <button
            type="button"
            aria-expanded={tokenOpen}
            aria-controls={tokenOpen ? "login-token-form" : undefined}
            onClick={() => setTokenOpen((open) => !open)}
            className="flex items-center gap-1 self-start rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-4 transition-transform", tokenOpen ? "rotate-0" : "-rotate-90")}
            />
            owner 로컬 토큰으로 로그인
          </button>
          {tokenOpen && <TokenForm />}
        </div>
      </div>
    </main>
  );
}

/** 멤버 로그인 — 실패하면 비밀번호 칸만 비운다(이메일은 고쳐 쓰게 남긴다). 비밀번호는 제출 뒤 들고 있지 않는다 */
function EmailForm() {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // 문구는 뮤테이션 상태가 아니라 여기 둔다 — 뮤테이션은 끝나자마자 비운다(비밀번호가 variables 로 남지 않게)
  const [error, setError] = useState<string>();
  const passwordRef = useRef<HTMLInputElement>(null);
  useFocusOnError(error, passwordRef);
  const ready = email.trim() !== "" && password !== "";

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || login.isPending) return;
    setError(undefined);
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => setError(NO_SESSION),
        onError: (err) => setError(emailErrorText(err)),
        onSettled: () => login.reset(),
      },
    );
    setPassword("");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">로그인</h1>
      <AuthField
        label="이메일"
        type="email"
        autoComplete="username"
        autoCapitalize="none"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={login.isPending}
      />
      <AuthField
        label="비밀번호"
        type="password"
        autoComplete="current-password"
        ref={passwordRef}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={login.isPending}
      />
      <FormError error={error} />
      <Button type="submit" disabled={login.isPending || !ready}>
        {login.isPending ? "로그인 중…" : "로그인"}
      </Button>
    </form>
  );
}

/** owner 로그인(OWNER_EMAIL + 로컬 토큰). 펼치면 토큰 칸에 초점. 토큰은 제출 뒤 들고 있지 않는다(저장 금지 — Global Constraints) */
function TokenForm() {
  const login = useLogin();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const tokenRef = useRef<HTMLInputElement>(null);
  useFocusOnError(error, tokenRef);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (token === "" || login.isPending) return;
    setError(undefined);
    login.mutate(
      { token },
      {
        onSuccess: () => setError(NO_SESSION),
        onError: (err) => setError(tokenErrorText(err)),
        onSettled: () => login.reset(),
      },
    );
    setToken("");
  }

  return (
    <form id="login-token-form" onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="login-token">로컬 토큰</Label>
        <Input
          id="login-token"
          ref={tokenRef}
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={login.isPending}
        />
      </div>
      <FormError error={error} />
      <Button type="submit" variant="outline" disabled={login.isPending || token === ""}>
        {login.isPending ? "로그인 중…" : "토큰으로 로그인"}
      </Button>
    </form>
  );
}
