import { QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, NetworkError } from "@/api/http";
import { createQueryClient } from "@/app/queryClient";
import { ResetSessionDialog } from "./ResetSessionDialog";
import { resetErrorMessage, useResetSession } from "./resetSession";
import { json } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("resetErrorMessage: 권한 없음(409 ADAPTER_CAPABILITY_MISSING)·Gateway 끊김(503)·네트워크·그 밖은 서버 message", () => {
  expect(
    resetErrorMessage(
      new ApiRequestError(409, "CONFLICT", "ADAPTER_CAPABILITY_MISSING: sessions.reset 권한 없음"),
    ),
  ).toBe("Gateway 권한(operator.admin)이 없어 새 대화를 시작할 수 없습니다");
  expect(resetErrorMessage(new ApiRequestError(503, "ADAPTER_UNAVAILABLE", "adapter down"))).toBe(
    "Gateway 에 연결되지 않았습니다",
  );
  expect(resetErrorMessage(new NetworkError(new TypeError("fetch failed")))).toBe(
    "서버에 연결할 수 없습니다",
  );
  expect(resetErrorMessage(new ApiRequestError(404, "NOT_FOUND", "agent member not found"))).toBe(
    "agent member not found",
  );
  expect(resetErrorMessage(new ApiRequestError(409, "CONFLICT", "다른 충돌"))).toBe("다른 충돌");
  expect(resetErrorMessage(new Error("x"))).toBe("새 대화를 시작하지 못했습니다");
});

function setup(res: () => Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => res());
  vi.stubGlobal("fetch", fetch);
  const toastError = vi.spyOn(toast, "error");
  const qc = createQueryClient(() => {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useResetSession("ch-1"), { wrapper });
  return { fetch, toastError, result };
}

it("POST /channels/:id/agents/:agentId/reset", async () => {
  const { fetch, result } = setup(() => json(200, { ok: true }));
  result.current.mutate("ag-1");
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/channels/ch-1/agents/ag-1/reset");
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(result.current.data).toBeUndefined();
});

it("실패는 전역 토스트 없이(대화상자가 그린다) — 503 도, 409 도", async () => {
  const { toastError, result } = setup(() =>
    json(503, { code: "ADAPTER_UNAVAILABLE", message: "adapter down" }),
  );
  result.current.mutate("ag-1");
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.error).toBeInstanceOf(ApiRequestError);
  expect(toastError).not.toHaveBeenCalled();
});

describe("ResetSessionDialog", () => {
  /** 부르는 쪽처럼 열림 상태를 쥔다. onOpenChange 호출을 기록한다 */
  function renderDialog(res: () => Response | Promise<Response>) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => res());
    vi.stubGlobal("fetch", fetch);
    const toastError = vi.spyOn(toast, "error");
    const changes: boolean[] = [];
    const qc = createQueryClient(() => {});
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            다시 열기
          </button>
          <ResetSessionDialog
            channelId="ch-1"
            agentId="ag-1"
            handle="dev"
            open={open}
            onOpenChange={(o) => {
              changes.push(o);
              setOpen(o);
            }}
          />
        </>
      );
    }
    render(
      <QueryClientProvider client={qc}>
        <Host />
      </QueryClientProvider>,
    );
    return { fetch, toastError, changes };
  }

  it("확인 문구 → 「새 대화 시작」 → POST reset → 토스트 없이 닫힘", async () => {
    const { fetch, toastError, changes } = renderDialog(() => json(200, { ok: true }));
    const dialog = screen.getByRole("dialog", { name: "새 대화" });
    expect(
      within(dialog).getByText("@dev 와의 대화 기록을 새로 시작합니다. 진행 중인 실행은 중지됩니다"),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/v1/channels/ch-1/agents/ag-1/reset"]);
    expect(changes).toEqual([false]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("실패(409 권한 없음)는 대화상자 안에, 열린 채로 — 다시 열면 지난 오류는 지워진다", async () => {
    const { toastError } = renderDialog(() =>
      json(409, { code: "CONFLICT", message: "ADAPTER_CAPABILITY_MISSING: sessions.reset 권한 없음" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "새 대화 시작" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Gateway 권한(operator.admin)이 없어 새 대화를 시작할 수 없습니다",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "다시 열기" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("시작하는 중에는 닫히지 않고 버튼이 잠긴다", async () => {
    let release!: (r: Response) => void;
    const { changes } = renderDialog(() => new Promise<Response>((r) => (release = r)));
    await userEvent.click(screen.getByRole("button", { name: "새 대화 시작" }));
    expect(await screen.findByRole("button", { name: "시작하는 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(changes).toEqual([]);

    release(json(200, { ok: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(changes).toEqual([false]);
  });
});
