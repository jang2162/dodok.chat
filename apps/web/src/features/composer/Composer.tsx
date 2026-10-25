import type { JSONContent } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { isImageMime } from "@dodok/shared";
import { ImagePlusIcon, SendHorizontalIcon } from "lucide-react";
import { type DragEvent, useEffect, useId, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useAgents, useMe, useMembers, usePeople } from "@/api/queries";
import { ONLY_IMAGES } from "@/features/attachments/upload";
import { useComposerAttachments } from "@/features/attachments/useComposerAttachments";
import { abortErrorMessage } from "@/features/runs/abortError";
import { selectScopeRuns, TERMINAL, useRunStore } from "@/features/runs/runStore";
import { emitAck, useWireStatus, type WireSocket } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { mentionCandidates } from "./mentions";
import { mentionSuggestion } from "./MentionList";
import { PendingAttachments } from "./PendingAttachments";
import { toBodyMd } from "./serialize";
import { parseSlash } from "./slash";
import { SubmitKeys } from "./submitKeys";
import { useSendMessage } from "./useSendMessage";
import { useTyping } from "./useTyping";

const PLACEHOLDER = "메시지 보내기 — @로 에이전트 부르기";
const THREAD_PLACEHOLDER = "스레드에 답하기 — @로 에이전트 부르기";
const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

/** 보내기를 막는 사유 — 우선순위 순(끊김이 먼저) */
const BLOCKED = {
  disconnected: "연결되면 보낼 수 있습니다",
  uploading: "이미지를 올리는 중입니다",
  failed: "올리지 못한 이미지를 빼 주세요",
} as const;

const draggingFiles = (e: { dataTransfer: DataTransfer | null }) =>
  e.dataTransfer?.types.includes("Files") ?? false;

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

/**
 * 작성기(스펙 5.1·4.4·6.1): Tiptap + @멘션. Enter 전송(토큰 본문 `toBodyMd`), `/stop` 은 메시지로 보내지 않는다.
 * wire 가 connected 가 아니면 입력은 받되 전송은 막는다. 초안은 세션마다 따로 둔다 — 채널·세션을 옮겨도 이 인스턴스가 유지된다.
 * 이미지는 첨부 버튼·붙여넣기·끌어 놓기로 넣는 즉시 올린다. 올리기가 모두 끝나야(오류 칩 없이) 보낼 수 있고, 글 없이 이미지만도 된다.
 * 메시지는 그 세션으로(`conversationId` — 새 세션 창이면 첫 보내기가 세션을 만든다, `useSendMessage`), `/stop` 은 그 세션의 런만.
 * `threadRootId` 를 주면 스레드 작성기다(스레드·검색 스펙 4.2) — 메시지는 그 스레드로, `/stop` 은 그 스레드의 런만.
 * 작성 중 알림(`typing`)은 세션 단위라 스레드 작성기는 보내지 않는다 —
 * 스레드에서 쓰는 사람을 세션 작성기 아래에 「입력 중」으로 보이면 어디에 답하는지 틀리게 읽힌다
 */
export function Composer({
  channelId,
  conversationId,
  threadRootId,
}: {
  channelId: string;
  conversationId: string;
  threadRootId?: string;
}) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const { send } = useSendMessage(channelId, conversationId, threadRootId);
  const attachments = useComposerAttachments(channelId, conversationId);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachButton = useRef<HTMLButtonElement>(null);
  const typing = useTyping(channelId, conversationId);
  const members = useMembers(channelId);
  const agents = useAgents();
  const me = useMe();
  const people = usePeople();
  const hintId = useId();
  // 초안은 세션마다, 스레드 작성기는 스레드마다 — 같은 패널에서 다른 스레드로 옮겨도 이 인스턴스가 유지된다
  const draftKey =
    threadRootId === undefined
      ? `${channelId}:${conversationId}`
      : `${channelId}:${conversationId}:${threadRootId}`;

  const candidates = useMemo(
    () => mentionCandidates(members.data, agents.data, me.data, people.data),
    [members.data, agents.data, me.data, people.data],
  );
  // 편집기는 한 번만 만든다 — 바뀌는 값은 ref 로 읽는다
  const live = useRef({
    candidates,
    submit: () => {},
    notifyTyping: () => {},
    addFiles: (_files: readonly File[]) => {},
  });
  const menu = useRef({ open: false }).current;
  const drafts = useRef(new Map<string, JSONContent>()).current;

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: false, horizontalRule: false, link: false, underline: false }),
        Placeholder.configure({ placeholder: threadRootId === undefined ? PLACEHOLDER : THREAD_PLACEHOLDER }),
        Mention.configure({
          HTMLAttributes: { class: "rounded bg-primary/10 px-0.5 font-medium text-primary" },
          renderText: ({ node }) => `@${String(node.attrs.label ?? "")}`,
          suggestion: mentionSuggestion(() => live.current.candidates, menu),
        }),
        SubmitKeys.configure({ onSubmit: () => live.current.submit(), menuOpen: () => menu.open }),
      ],
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": threadRootId === undefined ? "메시지 입력" : "스레드 답글 입력",
          // @ 후보 목록이 뜬다 — 열렸을 때 목록·지금 줄은 MentionList 가 가리킨다(aria-controls·aria-activedescendant)
          "aria-autocomplete": "list",
          class: EDITOR_CLASS,
        },
        // 붙여넣은 파일 중 이미지는 칩으로(스펙 6.1), 그 밖은 알린다. 글이 함께 오면 글도 들어간다
        handlePaste: (_view, event) => {
          const data = event.clipboardData;
          const files = Array.from(data?.files ?? []);
          if (files.length === 0) return false;
          live.current.addFiles(files);
          return !data?.getData("text/plain");
        },
        handleDOMEvents: {
          // 파일 끌기는 ProseMirror 가 손대지 않게 넘기고 작성기 상자(onDragOver·onDrop)가 받는다
          dragover: (_view, event) => draggingFiles(event),
          drop: (_view, event) => draggingFiles(event),
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
    const saved = drafts.get(draftKey);
    if (saved) editor.commands.setContent(saved, { emitUpdate: false });
    else if (!editor.isEmpty) editor.commands.clearContent(false);
    return () => {
      if (editor.isDestroyed || editor.isEmpty) drafts.delete(draftKey);
      else drafts.set(draftKey, editor.getJSON());
    };
  }, [editor, draftKey, drafts]);

  live.current.candidates = candidates;
  live.current.notifyTyping = threadRootId === undefined ? typing.notify : () => {};
  live.current.addFiles = (files) => {
    const images = files.filter((f) => isImageMime(f.type));
    if (images.length < files.length) toast.info(ONLY_IMAGES, { id: "attach-only-images" });
    if (images.length > 0) attachments.add(images);
  };
  const blocked = !connected
    ? BLOCKED.disconnected
    : attachments.uploading
      ? BLOCKED.uploading
      : attachments.failed
        ? BLOCKED.failed
        : undefined;
  live.current.submit = () => {
    const doc: JSONContent = editor.getJSON();
    const cmd = parseSlash(doc);
    // 메시지·/stop 은 wire 로 간다 — 붙어 있을 때만(입력은 그대로 둔다)
    if (!connected || !socket) return;
    if (cmd?.kind === "stop") {
      stopRuns(socket, channelId, conversationId, threadRootId);
      editor.commands.clearContent();
      return;
    }
    // 명령이 아니면 메시지 — 올리기가 끝나지 않았거나 오류 칩이 있으면 보내지 않는다(입력·칩은 그대로)
    if (blocked) return;
    const bodyMd = toBodyMd(doc);
    if (!bodyMd && attachments.ready.length === 0) return;
    void send(bodyMd, attachments.ready);
    attachments.clear();
    editor.commands.clearContent();
  };

  // 작성기 상자 어디에 놓아도 받는다 — 창 전역 차단(fileDrop)보다 먼저 막아 그쪽이 건드리지 않게 한다
  const onDragOver = (e: DragEvent) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    live.current.addFiles(files);
  };

  return (
    <div className="px-4 pb-4">
      <div
        className="rounded-lg border border-input bg-card px-3 py-1.5 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <PendingAttachments
          items={attachments.items}
          onRemove={attachments.remove}
          onEmptied={() => attachButton.current?.focus()}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="이미지 첨부"
            ref={attachButton}
            className="-ml-2"
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlusIcon />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={IMAGE_ACCEPT}
            className="hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              live.current.addFiles(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = ""; // 같은 파일을 다시 고를 수 있게
            }}
          />
          <EditorContent editor={editor} className="min-w-0 flex-1" />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="보내기"
            aria-describedby={blocked ? hintId : undefined}
            disabled={!!blocked || (empty && attachments.ready.length === 0)}
            onClick={() => live.current.submit()}
          >
            <SendHorizontalIcon />
          </Button>
        </div>
      </div>
      {blocked && (
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          {blocked}
        </p>
      )}
    </div>
  );
}

/**
 * `/stop`(스펙 5.1): 이 세션(스레드 작성기면 그 스레드)의 끝나지 않은 런마다 `run.abort`. 없으면 알리고,
 * ack 실패는 코드별 토스트(스펙 8장). 세션 작성기의 `/stop` 은 스레드 런·다른 세션의 런을 멈추지 않는다 — 그 버블은 거기에 있다
 */
function stopRuns(socket: WireSocket, channelId: string, conversationId: string, threadRootId?: string) {
  const running = selectScopeRuns(
    channelId,
    conversationId,
    threadRootId,
  )(useRunStore.getState()).filter((v) => !TERMINAL.has(v.state.status));
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
