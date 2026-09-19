import type { JSONContent } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { SendHorizontalIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAgents, useMe, useMembers } from "@/api/queries";
import { ResetSessionDialog } from "@/features/agents/ResetSessionDialog";
import { abortErrorMessage } from "@/features/runs/abortError";
import { selectChannelRuns, TERMINAL, useRunStore } from "@/features/runs/runStore";
import { emitAck, useWireStatus, type WireSocket } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { mentionCandidates } from "./mentions";
import { mentionSuggestion } from "./MentionList";
import { toBodyMd } from "./serialize";
import { parseSlash } from "./slash";
import { SubmitKeys } from "./submitKeys";
import { useSendMessage } from "./useSendMessage";
import { useTyping } from "./useTyping";

const PLACEHOLDER = "메시지 보내기 — @로 에이전트 부르기";
const FILES_LATER = "이미지는 Phase 2 에서 지원합니다";

/** ProseMirror 요소 — 입력 영역 높이 제한, 자리표시(Placeholder 의 data-placeholder), 목록·코드·인용·멘션 모양 */
const EDITOR_CLASS = [
  "max-h-[40vh] min-h-6 overflow-y-auto py-1 text-[15px] leading-normal break-words outline-none",
  "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left",
  "[&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground",
  "[&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px]",
  "[&_pre]:my-1 [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
].join(" ");

/** 「새 대화」 대상 — 연 채널에 묶는다. 열린 채 채널이 바뀌어도 요청은 그 채널로만 간다 */
type ResetTarget = { channelId: string; agentId: string; handle: string };

/**
 * 작성기(스펙 5.1·4.4): Tiptap + @멘션. Enter 전송(토큰 본문 `toBodyMd`), `/stop`·`/new @에이전트` 는 메시지로 보내지 않는다.
 * wire 가 connected 가 아니면 입력은 받되 전송은 막는다. 초안은 채널마다 따로 둔다 — 채널을 옮겨도 이 인스턴스가 유지된다
 */
export function Composer({ channelId }: { channelId: string }) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const { send } = useSendMessage(channelId);
  const typing = useTyping(channelId);
  const members = useMembers(channelId);
  const agents = useAgents();
  const me = useMe();
  const hintId = useId();
  const [reset, setReset] = useState<{ target?: ResetTarget; open: boolean }>({ open: false });
  // 연 채널을 떠나면(대화상자 너머 뒤로 가기 등) 닫는다 — 되돌릴 수 없는 리셋을 옮겨 간 채널에서 묻지 않게
  if (reset.open && reset.target?.channelId !== channelId) setReset((r) => ({ ...r, open: false }));

  const candidates = useMemo(
    () => mentionCandidates(members.data, agents.data, me.data),
    [members.data, agents.data, me.data],
  );
  // 편집기는 한 번만 만든다 — 바뀌는 값은 ref 로 읽는다
  const live = useRef({ candidates, submit: () => {}, notifyTyping: () => {} });
  const menu = useRef({ open: false }).current;
  const drafts = useRef(new Map<string, JSONContent>()).current;

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: false, horizontalRule: false, link: false, underline: false }),
        Placeholder.configure({ placeholder: PLACEHOLDER }),
        Mention.configure({
          HTMLAttributes: { class: "rounded bg-accent px-0.5 font-medium text-accent-foreground" },
          renderText: ({ node }) => `@${String(node.attrs.label ?? "")}`,
          suggestion: mentionSuggestion(() => live.current.candidates, menu),
        }),
        SubmitKeys.configure({ onSubmit: () => live.current.submit(), menuOpen: () => menu.open }),
      ],
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "메시지 입력",
          class: EDITOR_CLASS,
        },
        // 텍스트만(스펙 5.1). 파일만 온 붙여넣기·끌어 놓기는 막고 알린다. 글이 함께 오면 글만 들어간다
        handlePaste: (_view, event) => {
          const data = event.clipboardData;
          if (!data?.files.length || data.getData("text/plain")) return false;
          toast.info(FILES_LATER, { id: "files-later" });
          return true;
        },
        handleDOMEvents: {
          // 파일 끌어 놓기는 ProseMirror 보다 먼저 막는다 — 놓친 자리에서는 브라우저가 파일을 열어 앱을 떠난다
          drop: (_view, event) => {
            if (!event.dataTransfer?.files.length) return false;
            event.preventDefault();
            toast.info(FILES_LATER, { id: "files-later" });
            return true;
          },
        },
      },
      onUpdate: ({ editor: ed }) => {
        if (!ed.isEmpty) live.current.notifyTyping();
      },
    },
    [],
  );
  const empty = useEditorState({ editor, selector: ({ editor: ed }) => ed.isEmpty });

  // 채널을 옮기면 지금 초안을 그 채널 몫으로 두고, 옮겨 간 채널의 초안을 꺼낸다(없으면 비움)
  useEffect(() => {
    const saved = drafts.get(channelId);
    if (saved) editor.commands.setContent(saved, { emitUpdate: false });
    else if (!editor.isEmpty) editor.commands.clearContent(false);
    return () => {
      if (editor.isDestroyed || editor.isEmpty) drafts.delete(channelId);
      else drafts.set(channelId, editor.getJSON());
    };
  }, [editor, channelId, drafts]);

  live.current.candidates = candidates;
  live.current.notifyTyping = typing.notify;
  live.current.submit = () => {
    const doc: JSONContent = editor.getJSON();
    const cmd = parseSlash(doc);
    if (cmd?.kind === "invalid") {
      toast.error(cmd.message, { id: "slash-invalid" });
      return;
    }
    if (cmd?.kind === "new") {
      const label = doc.content?.[0]?.content?.find((n) => n.attrs?.id === `a:${cmd.agentId}`)?.attrs?.label;
      const handle = agents.data?.find((a) => a.id === cmd.agentId)?.handle ?? String(label ?? "");
      setReset({ target: { channelId, agentId: cmd.agentId, handle }, open: true });
      editor.commands.clearContent();
      return;
    }
    // 메시지·/stop 은 wire 로 간다 — 붙어 있을 때만(입력은 그대로 둔다)
    if (!connected || !socket) return;
    if (cmd?.kind === "stop") {
      stopRuns(socket, channelId);
      editor.commands.clearContent();
      return;
    }
    const bodyMd = toBodyMd(doc);
    if (!bodyMd) return;
    void send(bodyMd);
    editor.commands.clearContent();
  };

  return (
    <div className="px-4 pb-4">
      <div className="flex items-end gap-2 rounded-lg border bg-background px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring/50">
        <EditorContent editor={editor} className="min-w-0 flex-1" />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="보내기"
          aria-describedby={connected ? undefined : hintId}
          disabled={!connected || empty}
          onClick={() => live.current.submit()}
        >
          <SendHorizontalIcon />
        </Button>
      </div>
      {!connected && (
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          연결되면 보낼 수 있습니다
        </p>
      )}
      {reset.target && (
        <ResetSessionDialog
          channelId={reset.target.channelId}
          agentId={reset.target.agentId}
          handle={reset.target.handle}
          open={reset.open}
          onOpenChange={(open) => {
            setReset((r) => ({ ...r, open }));
            if (!open) editor.commands.focus();
          }}
        />
      )}
    </div>
  );
}

/** `/stop`(스펙 5.1): 이 채널의 끝나지 않은 런마다 `run.abort`. 없으면 알리고, ack 실패는 코드별 토스트(스펙 8장) */
function stopRuns(socket: WireSocket, channelId: string) {
  const running = selectChannelRuns(channelId)(useRunStore.getState()).filter(
    (v) => !TERMINAL.has(v.state.status),
  );
  if (running.length === 0) {
    toast.info("진행 중인 실행이 없습니다");
    return;
  }
  for (const { state } of running) {
    void emitAck(socket, "run.abort", { runId: state.id }).catch((e: unknown) => {
      const message = abortErrorMessage(e);
      toast.error(message, { id: `run-abort:${message}` });
    });
  }
}
