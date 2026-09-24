import { ApiError, type IssueBridgeTokenResult } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, NetworkError, api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 브리지 토큰 발급(스펙 「연결 페이지」 교체 흐름 1). 원문은 발급 응답에만 있다(스펙 「보안」) — 결과를 뮤테이션 상태로 돌려주지 않고
 * `onIssued` 로 부르는 쪽 컴포넌트 상태에만 넘긴다. 그래서 뮤테이션 캐시의 `data` 는 늘 undefined 이고, 대화상자를 닫아
 * 그 상태를 버리면 원문은 어디에도 남지 않는다. 목록 캐시에는 원문 없는 줄만 들어간다(다시 받기)
 */
export function useIssueBridgeToken(onIssued: (result: IssueBridgeTokenResult) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (label: string): Promise<void> => {
      onIssued(await api<IssueBridgeTokenResult>("POST", "/setup/bridge-tokens", { label }));
    },
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bridgeTokens }),
  });
}

/** 폐기 — 서버가 그 토큰의 브리지 세션도 끊는다. 목록·상태를 다시 받는다(`setup.status` 도 따라온다) */
export function useRevokeBridgeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/setup/bridge-tokens/${id}`),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.bridgeTokens }),
        qc.invalidateQueries({ queryKey: qk.setupStatus }),
      ]),
  });
}

/** Content-Disposition 의 filename — 없으면 undefined */
const fileNameOf = (disposition: string | null): string | undefined =>
  disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;

/**
 * 서버가 품은 플러그인 tgz 를 받아 저장한다. 링크 대신 fetch 로 받는 것은 실패(404 PLUGIN_FILE_MISSING·409 PLUGIN_FILE_CHANGED)를
 * 화면에 문구로 보이기 위해서다 — 링크로 받으면 브라우저가 JSON 오류 본문을 파일로 떨군다
 */
export async function downloadPluginFile(fallbackName: string): Promise<void> {
  let res: Response;
  let blob: Blob;
  try {
    res = await fetch("/api/v1/setup/plugin.tgz", { credentials: "same-origin" });
    blob = await res.blob();
  } catch (e) {
    throw new NetworkError(e);
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = JSON.parse(await blob.text());
    } catch {
      body = undefined;
    }
    const parsed = ApiError.safeParse(body);
    if (parsed.success) throw new ApiRequestError(res.status, parsed.data.code, parsed.data.message);
    throw new ApiRequestError(res.status, "INTERNAL", `플러그인 파일을 받지 못했습니다 (${res.status})`);
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileNameOf(res.headers.get("content-disposition")) ?? fallbackName;
    a.click();
  } finally {
    // 클릭이 내려받기를 시작한 뒤에 거둔다 — 같은 틱에 거두면 브라우저가 못 읽는 수가 있다
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 오류 문구는 화면이 그린다(`silent`) — 401 은 전역이 로그인으로 보낸다 */
export const useDownloadPlugin = () =>
  useMutation({ mutationFn: downloadPluginFile, meta: { silent: true } });
