import { ATTACHMENT_LIMITS, type Attachment } from "@dodok/shared";
import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { toast } from "sonner";
import { invalidateDms } from "@/features/dms/queries";
import { checkImageFile, DM_READ_ONLY_ERROR, uploadImage } from "./upload";

/** 작성기 칩 하나 — 미리보기는 로컬 object URL, 끝나면 서버가 준 `attachment` */
export type ComposerAttachment = {
  key: string;
  name: string;
  previewUrl: string;
  progress: number;
  status: "uploading" | "done" | "error";
  attachment?: Attachment;
  error?: string;
};

export type ComposerAttachments = {
  items: ComposerAttachment[];
  add(files: readonly File[]): void;
  remove(key: string): void;
  clear(): void;
  /** 올리는 중인 칩이 하나라도 */
  uploading: boolean;
  /** 오류 칩이 하나라도 */
  failed: boolean;
  /** 끝난 칩들의 첨부 — 넣은 순서 */
  ready: Attachment[];
};

export const TOO_MANY = `이미지는 한 번에 ${ATTACHMENT_LIMITS.perMessage}장까지 보낼 수 있습니다`;

type Action =
  | { type: "add"; items: ComposerAttachment[] }
  | { type: "progress"; key: string; progress: number }
  | { type: "done"; key: string; attachment: Attachment }
  | { type: "error"; key: string; error: string }
  | { type: "remove"; key: string }
  | { type: "clear" };

const patch = (items: ComposerAttachment[], key: string, p: Partial<ComposerAttachment>) =>
  items.map((i) => (i.key === key && i.status === "uploading" ? { ...i, ...p } : i));

/** 모르는 key(뺀 칩·채널·세션을 옮겨 비운 뒤 늦게 온 결과)는 조용히 지나간다 */
function reducer(items: ComposerAttachment[], a: Action): ComposerAttachment[] {
  switch (a.type) {
    case "add":
      return [...items, ...a.items];
    case "progress":
      return patch(items, a.key, { progress: a.progress });
    case "done":
      return patch(items, a.key, { status: "done", progress: 1, attachment: a.attachment });
    case "error":
      return patch(items, a.key, { status: "error", error: a.error });
    case "remove":
      return items.filter((i) => i.key !== a.key);
    case "clear":
      return [];
  }
}

/** 칩마다 쥐는 것 — 미리보기 URL(놓아야 한다)과 올리는 중이면 끊는 함수 */
type Held = { url: string; abort?: () => void };

/**
 * 작성기 첨부(스펙 6.1): 넣는 즉시 올리고 칩마다 미리보기·진행·이유를 든다. 형식·크기가 틀리면 올리지 않는다.
 * 메시지당 상한을 넘는 것은 칩을 만들지 않고 한 번 알린다. 작성 자리(`place` — 채널·세션)를 옮기면 모두 끊고 비운다 —
 * 초안과 달리 첨부는 들고 다니지 않는다(계획 판정). 작성기는 세션을 옮겨도 같은 인스턴스라 세션 A 의 칩이 세션 B 로 나가지 않게 자리를
 * 본다(서버의 첨부는 채널에만 묶여 다른 세션으로 보내도 받는다). 자리는 작성기가 정한다 — 새 세션 창이 만든 세션으로 옮겨 가는 것은 같은
 * 자리다(Composer). 언마운트 때도 끊고 URL 을 놓는다
 */
export function useComposerAttachments(channelId: string, place: string): ComposerAttachments {
  const [items, dispatch] = useReducer(reducer, []);
  const held = useRef(new Map<string, Held>()).current;
  // 훅만 띄우는 테스트에는 QueryClient 가 없다 — 그때는 DM 목록을 다시 받지 않는다(`useInteract` 와 같은 수)
  const qc = useContext(QueryClientContext);

  const release = useCallback(
    (key: string) => {
      const h = held.get(key);
      if (!h) return;
      held.delete(key);
      h.abort?.();
      URL.revokeObjectURL(h.url);
    },
    [held],
  );

  const releaseAll = useCallback(() => {
    // 도는 중 지금 키를 지우는 것은 Map 순회에서 안전하다
    for (const key of held.keys()) release(key);
  }, [held, release]);

  useEffect(
    () => () => {
      releaseAll();
      dispatch({ type: "clear" });
    },
    [channelId, place, releaseAll],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      const room = Math.max(0, ATTACHMENT_LIMITS.perMessage - held.size);
      if (files.length > room) toast.info(TOO_MANY, { id: "attach-limit" });
      const added = files.slice(0, room).map((file): ComposerAttachment => {
        const key = crypto.randomUUID();
        const previewUrl = URL.createObjectURL(file);
        const h: Held = { url: previewUrl };
        held.set(key, h);
        const base = { key, name: file.name, previewUrl, progress: 0 };
        const invalid = checkImageFile(file);
        if (invalid) return { ...base, status: "error", error: invalid };

        const up = uploadImage(file, channelId, (progress) => dispatch({ type: "progress", key, progress }));
        h.abort = up.abort;
        up.promise.then(
          (attachment) => {
            h.abort = undefined;
            dispatch({ type: "done", key, attachment });
          },
          (e: unknown) => {
            h.abort = undefined;
            // 뺐거나 채널을 옮겨 끊은 것 — 이미 칩이 없다
            if (e instanceof Error && e.name === "AbortError") return;
            // 이 탭이 DM 이 읽기 전용이 된 것을 아직 모른다 — DM 목록을 다시 받으면 작성기 자리가 사유 줄로 바뀐다
            if (e instanceof Error && e.name === DM_READ_ONLY_ERROR && qc) void invalidateDms(qc);
            dispatch({ type: "error", key, error: e instanceof Error ? e.message : String(e) });
          },
        );
        return { ...base, status: "uploading" };
      });
      if (added.length > 0) dispatch({ type: "add", items: added });
    },
    [channelId, held, qc],
  );

  const remove = useCallback(
    (key: string) => {
      release(key);
      dispatch({ type: "remove", key });
    },
    [release],
  );

  const clear = useCallback(() => {
    releaseAll();
    dispatch({ type: "clear" });
  }, [releaseAll]);

  return useMemo(
    () => ({
      items,
      add,
      remove,
      clear,
      uploading: items.some((i) => i.status === "uploading"),
      failed: items.some((i) => i.status === "error"),
      ready: items.flatMap((i) => (i.status === "done" && i.attachment ? [i.attachment] : [])),
    }),
    [items, add, remove, clear],
  );
}
