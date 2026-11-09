import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import { CH, CH2 } from "../../../test/fixtures";
import { FakeXhr, pdfFile, pngFile, stubObjectUrls, uploaded } from "../../../test/fakeXhr";
import { qk } from "@/api/queries";
import { DM_READ_ONLY_TEXT } from "@/features/dms/queries";
import { TOO_BIG, TOO_BIG_FILE } from "./upload";
import { useComposerAttachments } from "./useComposerAttachments";

let urls: ReturnType<typeof stubObjectUrls>;
let toastInfo: MockInstance<typeof toast.info>;

beforeEach(() => {
  FakeXhr.reset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  urls = stubObjectUrls();
  toastInfo = vi.spyOn(toast, "info");
});
afterEach(() => {
  urls.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 파일 상한을 넘는 PDF — 칩은 곧바로 오류 */
const bigPdf = () => pdfFile("big.pdf", 20 * 1024 * 1024 + 1);
const xhrAt = (i: number) => FakeXhr.all[i] as FakeXhr;

const CONV = "01a00000-0000-7000-8000-000000003001";
const CONV2 = "01a00000-0000-7000-8000-000000003002";

function renderAttachments(channelId = CH) {
  return renderHook(({ ch, conv }) => useComposerAttachments(ch, conv), {
    initialProps: { ch: channelId, conv: CONV },
  });
}

it("add([png, 큰 pdf]) — 둘 다 칩, 큰 pdf 는 곧바로 오류(올리지 않음), png 는 올리는 중 → 진행 → done", async () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pngFile("a.png"), bigPdf()]));

  expect(FakeXhr.all).toHaveLength(1);
  expect(xhrAt(0).url).toBe(`/api/v1/attachments?channelId=${CH}`);
  expect(result.current.items.map((i) => [i.name, i.status, i.error, i.previewUrl])).toEqual([
    ["a.png", "uploading", undefined, "blob:1"],
    ["big.pdf", "error", TOO_BIG_FILE, undefined],
  ]);
  expect(result.current.uploading).toBe(true);
  expect(result.current.failed).toBe(true);

  act(() => xhrAt(0).progress(1, 4));
  expect(result.current.items[0]?.progress).toBe(0.25);

  const a = uploaded(1, "a.png");
  await act(async () => xhrAt(0).respond(200, a));
  expect(result.current.items[0]).toMatchObject({ status: "done", attachment: a, progress: 1 });
  expect(result.current.uploading).toBe(false);
  expect(result.current.ready).toEqual([a]);
});

it("5 MiB 를 넘는 png 도 올리지 않고 칩에 이유", () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pngFile("big.png", 5 * 1024 * 1024 + 1)]));
  expect(FakeXhr.all).toHaveLength(0);
  expect(result.current.items[0]).toMatchObject({ status: "error", error: TOO_BIG });
});

it("PDF — 미리보기 URL 을 만들지 않고 곧바로 올린다", () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pdfFile("report.pdf")]));
  expect(urls.create).not.toHaveBeenCalled();
  expect(result.current.items).toEqual([
    expect.objectContaining({ name: "report.pdf", status: "uploading", previewUrl: undefined }),
  ]);
  expect(FakeXhr.all).toHaveLength(1);
  expect(xhrAt(0).headers["content-type"]).toBe("application/pdf");
});

it("서버 거절도 칩에 이유", async () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pngFile()]));
  await act(async () => xhrAt(0).respond(400, { code: "VALIDATION", message: "빈 파일이다" }));
  expect(result.current.items[0]).toMatchObject({ status: "error", error: "빈 파일이다" });
  expect(result.current.failed).toBe(true);
});

it("11개째부터는 칩을 만들지 않고 한 번 알린다 — 사진·파일 합쳐서, 여러 번 넣어도 합쳐서 10", () => {
  const { result } = renderAttachments();
  act(() =>
    result.current.add(
      Array.from({ length: 7 }, (_, i) => (i % 2 ? pdfFile(`${i}.pdf`) : pngFile(`${i}.png`))),
    ),
  );
  expect(toastInfo).not.toHaveBeenCalled();
  act(() => result.current.add(Array.from({ length: 5 }, (_, i) => pngFile(`b${i}.png`))));
  expect(result.current.items).toHaveLength(10);
  expect(result.current.items.at(-1)?.name).toBe("b2.png");
  expect(FakeXhr.all).toHaveLength(10);
  expect(toastInfo).toHaveBeenCalledTimes(1);
  expect(toastInfo).toHaveBeenCalledWith("첨부는 한 번에 10개까지 보낼 수 있습니다", {
    id: "attach-limit",
  });
});

it("같은 add 안에서 넘쳐도 알림은 하나", () => {
  const { result } = renderAttachments();
  act(() => result.current.add(Array.from({ length: 13 }, (_, i) => pngFile(`${i}.png`))));
  expect(result.current.items).toHaveLength(10);
  expect(toastInfo).toHaveBeenCalledTimes(1);
});

it("remove(key) — 올리는 중이면 끊고 미리보기 URL 을 놓는다, 늦게 온 결과는 무시", async () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pngFile("a.png"), pngFile("b.png")]));
  const [a, b] = result.current.items;
  act(() => result.current.remove(a?.key ?? ""));
  expect(xhrAt(0).aborted).toBe(true);
  expect(xhrAt(1).aborted).toBe(false);
  expect(urls.revoke).toHaveBeenCalledWith("blob:1");
  expect(result.current.items.map((i) => i.key)).toEqual([b?.key]);
  // 끊긴 요청은 AbortError — 오류 칩이 되지 않는다
  await act(async () => {});
  expect(result.current.failed).toBe(false);
});

it("remove — 끝난 칩은 끊을 것 없이 빠지고 ready 에서도 빠진다", async () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pngFile("a.png"), pngFile("b.png")]));
  const a1 = uploaded(1, "a.png");
  const a2 = uploaded(2, "b.png");
  // 늦게 넣은 것이 먼저 끝나도 ready 는 넣은 순서
  await act(async () => xhrAt(1).respond(200, a2));
  await act(async () => xhrAt(0).respond(200, a1));
  expect(result.current.ready).toEqual([a1, a2]);
  act(() => result.current.remove(result.current.items[0]?.key ?? ""));
  expect(result.current.ready).toEqual([a2]);
  expect(urls.revoke).toHaveBeenCalledWith("blob:1");
});

it("오류 칩을 빼면 failed 가 풀린다", () => {
  const { result } = renderAttachments();
  act(() => result.current.add([bigPdf()]));
  expect(result.current.failed).toBe(true);
  act(() => result.current.remove(result.current.items[0]?.key ?? ""));
  expect(result.current.failed).toBe(false);
  expect(result.current.items).toEqual([]);
});

it("clear — 모두 비우고 URL 을 놓는다(파일 칩은 놓을 URL 이 없다)", async () => {
  const { result } = renderAttachments();
  act(() => result.current.add([pngFile("a.png"), bigPdf(), pngFile("b.png")]));
  await act(async () => xhrAt(0).respond(200, uploaded(1)));
  act(() => result.current.clear());
  expect(result.current.items).toEqual([]);
  expect(result.current.ready).toEqual([]);
  expect(urls.revoke.mock.calls.map(([u]) => u).sort()).toEqual(["blob:1", "blob:2"]);
});

it("채널이 바뀌면 모두 끊고 놓고 비운다 — 새 채널로 올린다", async () => {
  const { result, rerender } = renderAttachments();
  act(() => result.current.add([pngFile("a.png")]));
  rerender({ ch: CH2, conv: CONV });
  expect(xhrAt(0).aborted).toBe(true);
  expect(urls.revoke).toHaveBeenCalledWith("blob:1");
  expect(result.current.items).toEqual([]);
  await act(async () => {});
  expect(result.current.items).toEqual([]);

  act(() => result.current.add([pngFile("b.png")]));
  expect(xhrAt(1).url).toBe(`/api/v1/attachments?channelId=${CH2}`);
});

it("[t5-review M2] 같은 채널의 다른 세션으로 옮기면 모두 끊고 놓고 비운다 — 세션 A 에 올린 이미지가 세션 B 로 나가지 않게", async () => {
  const { result, rerender } = renderAttachments();
  act(() => result.current.add([pngFile("a.png"), pngFile("b.png")]));
  await act(async () => xhrAt(0).respond(200, uploaded(1, "a.png")));
  expect(result.current.ready).toHaveLength(1);

  rerender({ ch: CH, conv: CONV2 });
  expect(xhrAt(1).aborted).toBe(true);
  expect(urls.revoke.mock.calls.map(([u]) => u).sort()).toEqual(["blob:1", "blob:2"]);
  expect(result.current.items).toEqual([]);
  expect(result.current.ready).toEqual([]);
});

it("언마운트 때 모두 끊고 놓는다", () => {
  const { result, unmount } = renderAttachments();
  act(() => result.current.add([pngFile("a.png"), pdfFile("b.pdf")]));
  unmount();
  expect(xhrAt(0).aborted).toBe(true);
  expect(xhrAt(1).aborted).toBe(true);
  expect(urls.revoke.mock.calls.map(([u]) => u)).toEqual(["blob:1"]);
});

it("409 DM_READ_ONLY — 칩은 그 사유 문구로 오류, DM 목록을 다시 받는다(에이전트 DM 리뷰 L3)", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.dms, []);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(() => useComposerAttachments(CH, CONV), { wrapper });
  act(() => result.current.add([pngFile("a.png")]));
  await act(async () =>
    xhrAt(0).respond(409, {
      code: "DM_READ_ONLY",
      message: "dm is read-only",
      details: { reason: "dm_not_allowed" },
    }),
  );
  expect(result.current.items[0]).toMatchObject({ status: "error", error: DM_READ_ONLY_TEXT.dm_not_allowed });
  expect(qc.getQueryState(qk.dms)?.isInvalidated).toBe(true);
});
