import type { JSONContent } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { PaperclipIcon, SendHorizontalIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAgents, useMe, useMembers, usePeople } from "@/api/queries";
import { useComposerAttachments } from "@/features/attachments/useComposerAttachments";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { abortErrorMessage } from "@/features/runs/abortError";
import { selectScopeRuns, TERMINAL, useRunStore } from "@/features/runs/runStore";
import { emitAck, useWireStatus, type WireSocket } from "@/realtime/wire";
import { useDmView } from "@/features/dms/context";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { AgentSettingsBar, type PendingAgentSettings } from "./AgentSettingsBar";
import { mentionCandidates } from "./mentions";
import { mentionSuggestion } from "./MentionList";
import { PendingAttachments } from "./PendingAttachments";
import { onMentionRequest } from "@/features/profile/openProfile";
import { toBodyMd } from "./serialize";
import { parseSlash } from "./slash";
import { SubmitKeys } from "./submitKeys";
import { forgetSettled, settledFromNew, useSendMessage } from "./useSendMessage";
import { useTyping } from "./useTyping";

const PLACEHOLDER = "메시지 보내기 — @로 에이전트 부르기";
const THREAD_PLACEHOLDER = "스레드에 답하기 — @로 에이전트 부르기";
/** 에이전트 DM 에는 멘션이 없다(에이전트 DM 계획 판정 PD6) — 모든 글이 그 에이전트에게 간다. 에이전트 없는 사람 DM 도 이 문구 */
const DM_PLACEHOLDER = "메시지 보내기";

/** 보내기를 막는 사유 — 우선순위 순(끊김이 먼저) */
const BLOCKED = {
  disconnected: "연결되면 보낼 수 있습니다",
  uploading: "파일을 올리는 중입니다",
  failed: "올리지 못한 파일을 빼 주세요",
} as const;

const draggingFiles = (e: { dataTransfer: DataTransfer | null }) =>
  e.dataTransfer?.types.includes("Files") ?? false;

export const DROP_FOLDER = "폴더는 보낼 수 없습니다";
const DROP_FOLDER_TOAST_ID = "drop-folder";

/**
 * 놓은 것 가운데 파일만 — 폴더도 `files` 에 `type` 빈 항목으로 들어와 올리면 오류 칩이 된다. 폴더인지는 `items` 의
 * `webkitGetAsEntry()` 만 안다(drop 처리 안에서만 읽힌다). `items` 가 없는 환경이면 `files` 그대로
 */
function droppedFiles(dt: DataTransfer | null): { files: File[]; folders: number } {
  if (!dt) return { files: [], folders: 0 };
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === "file");
  if (items.length === 0) return { files: Array.from(dt.files), folders: 0 };
  let folders = 0;
  const files: File[] = [];
  for (const item of items) {
    if (item.webkitGetAsEntry?.()?.isDirectory) folders++;
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return { files, folders };
}

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
 * 다만 새 세션 창의 첫 보내기가 세션을 만들어 주소가 그 세션으로 바뀔 때는 세션 전환이 아니다 — ack 를 기다리는 사이 쓰던 초안·넣은 첨부
 * 칩을 그대로 들고 간다(`settledFromNew` — 채널 세션 계획 Task 6 의 ④).
 * 파일(사진 포함)은 첨부 버튼·붙여넣기·끌어 놓기로 넣는 즉시 올린다. 올리기가 모두 끝나야(오류 칩 없이) 보낼 수 있고, 글 없이 첨부만도 된다.
 * 메시지는 그 세션으로(`conversationId` — 새 세션 창이면 첫 보내기가 세션을 만든다, `useSendMessage`), `/stop` 은 그 세션의 런만.
 * `threadRootId` 를 주면 스레드 작성기다(스레드·검색 스펙 4.2) — 메시지는 그 스레드로, `/stop` 은 그 스레드의 런만.
 * 작성 중 알림(`typing`)은 세션 단위라 스레드 작성기는 보내지 않는다 —
 * 스레드에서 쓰는 사람을 세션 작성기 아래에 「입력 중」으로 보이면 어디에 답하는지 틀리게 읽힌다.
 * 에이전트 DM(`DmViewContext` 의 `dm`)에서는 @ 후보를 띄우지 않는다 — 에이전트 DM 은 멘션을 토큰으로 바꾸지 않고(서버가 토큰 꼴을 글로
 * 중화한다, 에이전트 DM 계획 판정 PD6) 모든 글이 그 에이전트에게 간다. 후보로 고른 칩이 `<@a:…>` 원문으로 남지 않게 한다. `@핸들` 을 손으로
 * 치면 그대로 글이다. 사람 DM·그룹 DM(`direct`)의 후보는 참여자(채널 멤버 행)만이다 — 서버는 참여자가 아닌 토큰을 중화한다(사람 간 DM
 * 계획 판정 PH6)
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
  const qc = useQueryClient();
  const connected = useWireStatus((s) => s.status === "connected");
  const { send } = useSendMessage(channelId, conversationId, threadRootId);
  // 작성 자리 — 채널·세션이 바뀌면 새 자리(첨부를 비운다), 새 세션 창 → 그 창이 만든 세션이면 같은 자리(`carriedFrom` 은 들고 온 초안 키)
  const [place, setPlace] = useState({
    channelId,
    conversationId,
    n: 0,
    carriedFrom: undefined as string | undefined,
  });
  if (place.channelId !== channelId || place.conversationId !== conversationId) {
    const carry =
      threadRootId === undefined &&
      place.channelId === channelId &&
      place.conversationId === NEW_CONVERSATION &&
      conversationId !== NEW_CONVERSATION &&
      settledFromNew(qc, channelId) === conversationId;
    setPlace({
      channelId,
      conversationId,
      n: carry ? place.n : place.n + 1,
      carriedFrom: carry ? `${channelId}:${NEW_CONVERSATION}` : undefined,
    });
  }
  const carriedFrom = place.carriedFrom;
  // 새 세션 창에서 바꾼 러너 에이전트 설정 — 화면에만 들고 있다가 첫 글과 함께 간다(세션 설정 스펙 S11). 자리가 바뀌면(창을 떠나면) 버린다
  const isNewWindow = conversationId === NEW_CONVERSATION && threadRootId === undefined;
  const [pendingSettings, setPendingSettings] = useState<{ n: number; byAgent: PendingAgentSettings }>({
    n: place.n,
    byAgent: {},
  });
  if (pendingSettings.n !== place.n) setPendingSettings({ n: place.n, byAgent: {} });
  const attachments = useComposerAttachments(channelId, String(place.n));
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

  const dmKind = useDmView()?.kind;
  const candidates = useMemo(() => {
    if (dmKind === "dm") return [];
    const all = mentionCandidates(members.data, agents.data, me.data, people.data);
    if (dmKind === undefined) return all;
    const participants = new Set(
      (members.data ?? []).map((m) => `${m.memberType === "agent" ? "a" : "u"}:${m.memberId}`),
    );
    return all.filter((c) => participants.has(c.id));
  }, [dmKind, members.data, agents.data, me.data, people.data]);
  // 부를 에이전트가 없는 자리(에이전트 DM·한 줄기 사람 DM)는 「@로 에이전트 부르기」를 권하지 않는다
  const plain = dmKind !== undefined && (dmKind === "dm" || !candidates.some((c) => c.kind === "agent"));
  // 편집기는 한 번만 만든다 — 바뀌는 값은 ref 로 읽는다
  const live = useRef({
    candidates,
    placeholder: threadRootId === undefined ? PLACEHOLDER : THREAD_PLACEHOLDER,
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
        // 채널 ↔ DM 을 옮겨도 이 편집기는 그대로다 — 문구는 지금 값을 읽는다(아래 effect 가 다시 그리게 한다)
        Placeholder.configure({ placeholder: () => live.current.placeholder }),
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
        // 붙여넣은 파일은 모두 칩으로(파일함 스펙 6장). 글이 함께 오면 글도 들어간다
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

  // 채널을 옮기면 지금 초안을 그 채널 몫으로 두고, 옮겨 간 채널의 초안을 꺼낸다(없으면 비움). 새 세션 창에서 그 창이 만든 세션으로 옮겨
  // 갔으면 편집기를 그대로 두고 창 몫으로 막 넣어 둔 초안만 지운다 — 다음에 새 세션 창을 열면 빈 작성기다
  useEffect(() => {
    if (carriedFrom !== undefined) drafts.delete(carriedFrom);
    else {
      const saved = drafts.get(draftKey);
      if (saved) editor.commands.setContent(saved, { emitUpdate: false });
      else if (!editor.isEmpty) editor.commands.clearContent(false);
    }
    return () => {
      if (editor.isDestroyed || editor.isEmpty) drafts.delete(draftKey);
      else drafts.set(draftKey, editor.getJSON());
    };
  }, [editor, draftKey, drafts, carriedFrom]);
  // 프로필 패널의 「멘션」(프로필 스펙 3.1) — 세션 작성기(스레드 답글 작성기 말고)에 `@핸들` 칩과 빈칸을 넣는다
  useEffect(() => {
    if (threadRootId !== undefined) return;
    return onMentionRequest(({ kind, id, handle }) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      editor
        .chain()
        .focus()
        .insertContent([
          { type: "mention", attrs: { id: `${kind}:${id}`, label: handle } },
          { type: "text", text: " " },
        ])
        .run();
    });
  }, [editor, threadRootId]);
  // 자리표시는 문서가 바뀔 때만 다시 그려진다 — 빈 작성기 그대로 채널 ↔ DM 을 옮기면 옛 문구가 남으므로 빈 트랜잭션으로 다시 그리게 한다
  useEffect(() => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr);
  }, [editor, plain]);
  // 옮겨 간 표는 새 세션 창을 떠나는 그 한 번만 쓴다(읽기는 위 렌더 중) — 그 세션으로 들고 갔든, 표가 생긴 뒤 주소가 바뀌기 전에 다른
  // 채널·화면으로 갔든 지운다(태스크 6 리뷰 L4). 남아 있으면 나중에 새 세션 창에서 같은 세션으로 갈 때 창의 초안을 잘못 들고 간다
  useEffect(() => {
    if (threadRootId !== undefined || conversationId !== NEW_CONVERSATION) return;
    return () => forgetSettled(qc, channelId);
  }, [qc, channelId, conversationId, threadRootId]);

  live.current.candidates = candidates;
  live.current.placeholder =
    threadRootId !== undefined ? THREAD_PLACEHOLDER : plain ? DM_PLACEHOLDER : PLACEHOLDER;
  live.current.notifyTyping = threadRootId === undefined ? typing.notify : () => {};
  live.current.addFiles = (files) => {
    if (files.length > 0) attachments.add(files);
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
    const agentSettings = isNewWindow
      ? Object.entries(pendingSettings.byAgent).map(([agentId, patch]) => ({ agentId, ...patch }))
      : [];
    void send(bodyMd, attachments.ready, agentSettings);
    if (agentSettings.length > 0) setPendingSettings({ n: place.n, byAgent: {} });
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
    const { files, folders } = droppedFiles(e.dataTransfer);
    if (files.length === 0 && folders === 0) return;
    e.preventDefault();
    if (folders > 0) toast.info(DROP_FOLDER, { id: DROP_FOLDER_TOAST_ID });
    live.current.addFiles(files);
  };

  return (
    <div className="px-4 pb-4">
      <AgentSettingsBar
        channelId={channelId}
        conversationId={conversationId}
        {...(threadRootId === undefined ? {} : { threadRootId })}
        pending={pendingSettings.byAgent}
        onPendingChange={(agentId, patch) =>
          setPendingSettings((p) => ({
            n: p.n,
            byAgent: { ...p.byAgent, [agentId]: { ...p.byAgent[agentId], ...patch } },
          }))
        }
      />
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
            aria-label="파일 첨부"
            ref={attachButton}
            className="-ml-2"
            onClick={() => fileInput.current?.click()}
          >
            <PaperclipIcon />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
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
