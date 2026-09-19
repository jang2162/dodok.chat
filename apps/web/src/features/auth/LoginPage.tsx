import { Navigate, type RegisteredRouter, getRouteApi } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useMe } from "@/api/queries";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useLogin } from "./mutations";

const route = getRouteApi("/login");

function loginErrorText(error: Error): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "토큰이 맞지 않습니다";
    if (error.status === 429) return "잠시 뒤 다시 시도하세요(1분 5회)";
    return error.message;
  }
  return "서버에 연결할 수 없습니다";
}

export function LoginPage() {
  const { next } = route.useSearch();
  const me = useMe();
  const login = useLogin();
  const [token, setToken] = useState("");

  // 이미 로그인했거나 방금 로그인해 me 가 풀리면 원래 가려던 곳으로 — 이동은 이 한 곳에서만.
  // next 는 검색 문자열까지 담은 앱 안 경로라 `to` 가 아니라 `href` 로 간다(제네릭은 `to` 를 선택으로 만든다)
  if (me.isSuccess) return <Navigate<RegisteredRouter, string, string> href={next ?? "/"} replace />;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (token === "" || login.isPending) return;
    login.mutate(token);
    // 토큰은 제출 뒤 들고 있지 않는다(저장 금지 — Global Constraints)
    setToken("");
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-xl font-semibold">로그인</h1>
        <div className="flex flex-col gap-2">
          <Label htmlFor="login-token">로컬 토큰</Label>
          <Input
            id="login-token"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={login.isPending}
          />
        </div>
        {login.error && (
          <Alert variant="destructive">
            <AlertDescription>{loginErrorText(login.error)}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={login.isPending || token === ""}>
          {login.isPending ? "로그인 중…" : "로그인"}
        </Button>
      </form>
    </main>
  );
}
