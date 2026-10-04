import {
  ApiError,
  type CreateGatewayBody,
  type DeleteGatewayResult,
  type GatewaySummary,
  type SetupStatus,
  type UpdateGatewayBody,
} from "@dodok/shared";
import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, NetworkError, api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 토큰 발급(스펙 「연결 페이지」 교체 흐름 1) — 브리지·러너 토큰(러너 스펙 5장)이 함께 쓴다. 원문은 발급 응답에만 있다(스펙 「보안」) — 결과를 뮤테이션
 * 상태로 돌려주지 않고 `onIssued` 로 부르는 쪽 컴포넌트 상태에만 넘긴다. 그래서 뮤테이션 캐시의 `data` 는 늘 undefined 이고,
 * 대화상자를 닫아 그 상태를 버리면 원문은 어디에도 남지 않는다. 목록 캐시에는 원문 없는 줄만 들어간다(다시 받기)
 */
export function useIssueToken<T>(path: string, listKey: QueryKey, onIssued: (result: T) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (label: string): Promise<void> => {
      onIssued(await api<T>("POST", path, { label }));
    },
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

/** 폐기 — 서버가 그 토큰의 브리지 세션도 끊는다. 목록·상태를 다시 받는다(`setup.status` 도 따라온다) */
export function useRevokeBridgeToken(gatewayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/gateways/${gatewayId}/bridge-tokens/${id}`),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.bridgeTokens }),
        qc.invalidateQueries({ queryKey: qk.setupStatus }),
      ]),
  });
}

/**
 * Gateway 를 바꾼 뒤 — 서버가 어댑터에 곧바로 반영하므로 연결 상태를 다시 받는다. 웹은 Gateway 목록을 `GET /gateways` 로
 * 따로 받지 않는다: 연결 페이지는 설정 상태, 나머지 화면은 어댑터 상태(wire `adapter.status`)에서 읽는다
 */
const gatewaysChanged = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: qk.setupStatus });

const GATEWAY_GONE = "이미 삭제된 Gateway 입니다";
const isGone = (e: unknown) => e instanceof ApiRequestError && e.code === "NOT_FOUND";

/**
 * 수정·끄기·삭제의 API 오류 토스트 — 서버 문구 대신 고정 문구. 404 는 다른 탭·사람이 먼저 지운 것이다
 * (그 카드는 `setup.status` 가 오기 전까지 남아 있다)
 */
const gatewayErrorMeta = {
  apiErrorText: (e: ApiRequestError) =>
    isGone(e) ? GATEWAY_GONE : "Gateway 를 바꾸지 못했습니다. 다시 시도해 주세요.",
};

/** 지운 Gateway 의 카드를 캐시에서 곧바로 걷는다 — 이유는 `useDeleteGateway` */
const dropGateway = (qc: ReturnType<typeof useQueryClient>, id: string) =>
  qc.setQueryData<SetupStatus>(
    qk.setupStatus,
    (s) => s && { ...s, gateways: s.gateways.filter((g) => g.id !== id) },
  );

/** Gateway 추가(멀티 Gateway 스펙 6.2) — 칸 오류(VALIDATION·CONFLICT)는 폼이 그린다 */
export function useCreateGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGatewayBody) => api<GatewaySummary>("POST", "/gateways", body),
    onSuccess: () => gatewaysChanged(qc),
  });
}

/** Gateway 수정·끄기·켜기 — 본문에 실은 칸만 바뀐다(빈 토큰은 싣지 않는다) */
export function useUpdateGateway(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateGatewayBody) => api<GatewaySummary>("PATCH", `/gateways/${id}`, body),
    meta: gatewayErrorMeta,
    onSuccess: () => gatewaysChanged(qc),
    onError: (e) => {
      if (isGone(e)) void qc.invalidateQueries({ queryKey: qk.setupStatus });
    },
  });
}

/**
 * Gateway 삭제 — 서버가 그 브리지 토큰을 지우고 에이전트의 연결을 비운다. 카드는 응답을 받자마자 캐시에서 걷는다: 다시 받기를
 * 기다리는 동안 카드가 남아 있으면 그 카드의 토큰 목록이 지워진 Gateway 를 다시 불러 404 가 전역 토스트로 뜬다. 같은 까닭으로
 * 토큰 목록은 무효화하지도 버리지도(removeQueries) 않는다 — 버리면 아직 붙은 관찰자가 새로 만들어 다시 부른다. 쓰는 곳이 사라진
 * 캐시는 gcTime 뒤에 걷힌다. 에이전트 목록(Gateway 이름·「Gateway 가 삭제됨」)은 다시 받는다.
 * 카드가 먼저 사라지므로 부르는 쪽은 `mutate` 의 콜백이 아니라 `mutateAsync` 로 결과를 받는다(언마운트된 관찰자의 콜백은 불리지 않는다)
 */
export function useDeleteGateway(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<DeleteGatewayResult>("DELETE", `/gateways/${id}`),
    meta: gatewayErrorMeta,
    onSuccess: () => {
      dropGateway(qc, id);
      return Promise.all([gatewaysChanged(qc), qc.invalidateQueries({ queryKey: qk.agents })]);
    },
    // 먼저 지운 쪽과 결과가 같다 — 카드를 걷고 에이전트(「Gateway 가 삭제됨」)를 다시 받는다
    onError: (e) => {
      if (!isGone(e)) return;
      dropGateway(qc, id);
      return Promise.all([gatewaysChanged(qc), qc.invalidateQueries({ queryKey: qk.agents })]);
    },
  });
}

/** 러너 토큰 폐기 — 서버가 그 토큰의 러너 연결을 곧바로 끊는다(러너 스펙 5장). 목록·상태를 다시 받는다 */
export function useRevokeRunnerToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/setup/runner-tokens/${id}`),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.runnerTokens }),
        qc.invalidateQueries({ queryKey: qk.setupStatus }),
      ]),
  });
}

/**
 * 다시 묶기 — 그 claude 에이전트를 이 러너 토큰에 묶는다(토큰을 폐기했거나 머신을 바꿨을 때). 다음 런부터 이 러너가 맡는다.
 * 연결 페이지 충돌 표시(setup.status)와 에이전트 목록의 러너 라벨을 다시 받는다
 */
export function useBindRunnerAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tokenId, agentId }: { tokenId: string; agentId: string }) =>
      api<unknown>("PUT", `/setup/runner-tokens/${tokenId}/agents/${encodeURIComponent(agentId)}`),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.setupStatus }),
        qc.invalidateQueries({ queryKey: qk.agents }),
      ]),
  });
}

/** Content-Disposition 의 filename — 없으면 undefined */
const fileNameOf = (disposition: string | null): string | undefined =>
  disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;

/**
 * 서버가 품은 tgz(플러그인·러너)를 받아 저장한다. 링크 대신 fetch 로 받는 것은 실패(404 …_FILE_MISSING·409 …_FILE_CHANGED)를
 * 화면에 문구로 보이기 위해서다 — 링크로 받으면 브라우저가 JSON 오류 본문을 파일로 떨군다
 */
async function downloadPackedFile(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  let blob: Blob;
  try {
    res = await fetch(`/api/v1${path}`, { credentials: "same-origin" });
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
    throw new ApiRequestError(res.status, "INTERNAL", `파일을 받지 못했습니다 (${res.status})`);
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

export const downloadPluginFile = (fallbackName: string) =>
  downloadPackedFile("/setup/plugin.tgz", fallbackName);

/** 오류 문구는 화면이 그린다(`silent`) — 401 은 전역이 로그인으로 보낸다 */
export const useDownloadPlugin = () =>
  useMutation({ mutationFn: downloadPluginFile, meta: { silent: true } });

/** 서버가 품은 러너 tgz(러너 스펙 5장 「같은 빌드」) — 플러그인 받기와 같은 규칙 */
export const useDownloadRunner = () =>
  useMutation({
    mutationFn: (fallbackName: string) => downloadPackedFile("/setup/runner.tgz", fallbackName),
    meta: { silent: true },
  });
