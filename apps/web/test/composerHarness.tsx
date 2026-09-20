import type { Agent, ChannelMember, Message, Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor, JSONContent } from "@tiptap/core";
import { act, render, screen } from "@testing-library/react";
import { qk } from "@/api/queries";
import { Composer } from "@/features/composer/Composer";
import { AGENT, CH, CH2, USER, msg, uid } from "./fixtures";

/** 작성기 테스트 공용 — 채널 둘(CH·CH2), 에이전트 dev(켜짐)·fin(꺼짐), 사람 owner */

const W = uid(900);
const TS = "2026-09-19T00:00:00.000Z";

export const DEV: Agent = {
  id: AGENT,
  workspaceId: W,
  provider: "openclaw",
  providerAgentId: "dev",
  handle: "dev",
  name: "개발봇",
  enabled: true,
  createdAt: TS,
};
export const FIN: Agent = {
  ...DEV,
  id: uid(12),
  providerAgentId: "fin",
  handle: "fin",
  name: "Finance",
  enabled: false,
};
export const ME = { user: { id: USER, handle: "owner", displayName: "주인" }, workspaceId: W };

export const memberOf = (memberId: string, aliases: string[] = []): ChannelMember => ({
  id: `m-${memberId}`,
  channelId: CH,
  memberType: "agent",
  memberId,
  autoRespond: false,
  aliases,
  joinedAt: TS,
});

/** Tiptap 문서 조각 */
export const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
export const t = (text: string): JSONContent => ({ type: "text", text });
export const mention = (id: string, label: string): JSONContent => ({
  type: "mention",
  attrs: { id, label },
});
export const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

/** 캐시를 채운 채 띄운다(조회 없음). 편집기는 ProseMirror 요소에 붙은 Tiptap 인스턴스 */
export function renderComposer(channelId = CH) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.me, ME);
  qc.setQueryData(qk.agents, [DEV, FIN]);
  qc.setQueryData(qk.members(CH), [memberOf(DEV.id, ["coder"]), memberOf(FIN.id)]);
  qc.setQueryData(qk.members(CH2), []);
  const view = render(
    <QueryClientProvider client={qc}>
      <Composer channelId={channelId} />
    </QueryClientProvider>,
  );
  const box = screen.getByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: Editor }).editor;
  const rerender = (ch: string) =>
    view.rerender(
      <QueryClientProvider client={qc}>
        <Composer channelId={ch} />
      </QueryClientProvider>,
    );
  return { box, editor, rerender, qc };
}

/** 문서를 넣고 커서를 둔다(기본 끝). 코드 블록·목록 뒤에는 trailingNode 의 빈 문단이 붙으므로 그 안은 위치로 짚는다 */
export const setDoc = (editor: Editor, content: JSONContent, at: "end" | number = "end") =>
  act(() => {
    editor.commands.setContent(content);
    editor.commands.focus(at);
  });

/**
 * Tiptap 의 `focus()` 는 ProseMirror 의 `view.focus()` 를 다음 프레임으로 미룬다. 그 프레임이 돌기 전에는
 * jsdom 에 선택 영역이 없어(`getSelection().rangeCount === 0`) 멘션 확정이 부르는 `collapseToEnd()` 가
 * 「There is no selection to collapse」로 던지고, 프레임이 화면을 내린 뒤에 돌아도 같은 예외가 난다.
 * 둘 다 jsdom 이 리스너 예외를 삼켜 uncaughtException 으로 올리므로 단언은 통과한 채 실행만 실패한다.
 * 그래서 시각(20ms)이 아니라 프레임 자체를 기다린다 — 부하로 프레임이 밀려도 결과가 같다.
 * 프레임 안에서 다시 예약하는 몫(focus → scrollIntoView)까지 걷으려고 두 번 돌린다.
 * 테스트 끝에서는 Testing Library 의 cleanup 보다 먼저 돌아야 하므로 테스트 파일에서 afterEach 로 등록한다
 */
export const flushEditorFrames = () =>
  act(async () => {
    for (let i = 0; i < 2; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });

/** 가짜 ack 은 마이크로태스크로만 돈다 — 매크로태스크 한 번을 기다리면 `.catch` 의 토스트까지 끝나 있다 */
export const settleAcks = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** message.send ack — 보낸 그대로 확정한다 */
export const confirmed = (payload: unknown): Result<{ message: Message }> => {
  const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
  return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd }) } };
};
