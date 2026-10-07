import type {
  AutomationCreated,
  AutomationPosted,
  AutomationSummary,
  CreateAutomationBody,
  UpdateAutomationBody,
} from "@dodok/shared";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { josa } from "@/lib/josa";

/** 응답 줄로 목록을 곧바로 고친다(없으면 끝에 붙인다) — 경고·다음 실행은 서버가 다시 센 값이다 */
function putRow(qc: QueryClient, row: AutomationSummary) {
  qc.setQueryData<AutomationSummary[]>(qk.automations, (list) =>
    list === undefined
      ? list
      : list.some((a) => a.id === row.id)
        ? list.map((a) => (a.id === row.id ? row : a))
        : [...list, row],
  );
}

/**
 * 웹훅 URL 원문을 받는 요청(만들기·토큰 재발급). 원문은 이 응답에만 있다 — 뮤테이션 결과로 돌려주지 않고 `onIssued` 로 부르는 쪽
 * 컴포넌트 상태에만 넘긴다(멤버 화면 `useIssueLink`·설정 마법사 `useIssueBridgeToken` 과 같은 규칙). 뮤테이션 캐시에 남는 것은
 * 원문 없는 자동화 줄뿐이다
 */
function useIssuing<V>(request: (v: V) => Promise<AutomationCreated>, onIssued: (url: string) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: V): Promise<AutomationSummary> => {
      const { automation, webhookUrl } = await request(v);
      if (webhookUrl !== undefined) onIssued(webhookUrl);
      return automation;
    },
    gcTime: 0,
    onSuccess: (row) => putRow(qc, row),
  });
}

/** 만들기 — 웹훅이면 주소 원문을 `onIssued` 로 한 번. 이름 겹침(409)·검증(400)은 폼이 그린다(전역 토스트에서 저절로 빠진다) */
export const useCreateAutomation = (onIssued: (url: string) => void) =>
  useIssuing(
    // 입력 꼴 — enabled 는 서버 기본값(켜짐)
    (body: z.input<typeof CreateAutomationBody>) => api<AutomationCreated>("POST", "/automations", body),
    onIssued,
  );

/** 웹훅 주소 다시 만들기 — 옛 주소는 서버가 곧바로 404 로 만든다 */
export const useReissueWebhook = (onIssued: (url: string) => void) =>
  useIssuing((id: string) => api<AutomationCreated>("POST", `/automations/${id}/token`), onIssued);

/** 고치기·켜기/끄기 — 응답 줄로 목록을 바꾼다 */
export function useUpdateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAutomationBody }) =>
      api<AutomationSummary>("PATCH", `/automations/${id}`, patch),
    onSuccess: (row) => putRow(qc, row),
  });
}

/** 삭제 — 게시한 메시지는 남고 「⚙ 지운 자동화」로 보인다 */
export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/automations/${id}`),
    onSuccess: (_void, id) =>
      qc.setQueryData<AutomationSummary[]>(qk.automations, (list) => list?.filter((a) => a.id !== id)),
  });
}

/**
 * 「지금 실행」 — 서버는 요청 하나에 게시 하나다(서버 `modules/automations/routes.ts` 의 「지금 실행」 처리기). 연타는 이 화면이 막는다: 요청이 나가 있는 동안 버튼을 잠그고
 * (`isPending`), 잠금이 그려지기 전 같은 틱의 두 번째 클릭은 ref 로 거른다(`isPending` 은 다시 그린 뒤에야 참 — 멤버 화면
 * `useSetMemberActive` 와 같다). 행마다 이 훅을 따로 써 다른 자동화의 버튼은 잠그지 않는다. 성공하면 토스트, 마지막 실행은 목록을
 * 다시 받아 보인다. 실패(보관된 채널 409 등)는 전역 토스트
 */
export function useRunAutomation() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (a: Pick<AutomationSummary, "id" | "name">) =>
      api<AutomationPosted>("POST", `/automations/${a.id}/run`),
    onSuccess: (_posted, a) => {
      toast.success(`「${a.name}」${josa(a.name, "을", "를")} 게시했습니다`);
      void qc.invalidateQueries({ queryKey: qk.automations });
    },
  });
  const sending = useRef(false);
  const { mutate } = mutation;
  const run = useCallback(
    (a: Pick<AutomationSummary, "id" | "name">) => {
      if (sending.current) return;
      sending.current = true;
      mutate(a, {
        onSettled: () => {
          sending.current = false;
        },
      });
    },
    [mutate],
  );
  return { run, isPending: mutation.isPending };
}
