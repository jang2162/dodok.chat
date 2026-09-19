import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

type SubmitKeysOptions = {
  onSubmit: () => void;
  /** @ 후보가 보이는 동안 참 — 그때 Enter 는 후보 선택이다. 함수로 받는다(`configure` 는 객체 옵션을 깊은 복사한다) */
  menuOpen: () => boolean;
};

/**
 * 작성기 키(스펙 5.1): Enter 전송, Shift+Enter 줄바꿈(코드 블록이면 코드 줄, 목록이면 새 항목), 한글 조합 중 Enter 는 조합 확정.
 * 우선순위는 가장 높게 둔다 — 코어 keymap·목록·코드 블록(기본 100)이 Enter 를 먼저 잡으면 전송이 되지 않는다.
 * 대신 @ 후보가 열려 있으면 양보해 Mention 제안(101)이 받게 한다
 */
export const SubmitKeys = Extension.create<SubmitKeysOptions>({
  name: "dodokSubmitKeys",
  priority: 1000,

  addOptions() {
    return { onSubmit: () => {}, menuOpen: () => false };
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (this.options.menuOpen()) return false;
        this.options.onSubmit();
        return true;
      },
      "Shift-Enter": ({ editor }) =>
        editor.commands.first(({ commands }) => [
          () => commands.newlineInCode(),
          () => commands.splitListItem("listItem"),
          () => commands.setHardBreak(),
        ]),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("dodokImeEnter"),
        props: {
          handleDOMEvents: {
            // ProseMirror 는 compositionstart 를 본 뒤에만 조합 중으로 안다. 키 이벤트가 조합 중이라고 하면(isComposing·229)
            // 전송·줄 나누기 모두 건너뛰고 기본 동작(조합 확정)에 맡긴다 — true 를 돌려도 preventDefault 하지 않는다
            keydown: (_view, event) => event.key === "Enter" && (event.isComposing || event.keyCode === 229),
          },
        },
      }),
    ];
  },
});
