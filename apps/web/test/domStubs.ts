import { vi } from "vitest";

type Patch = [target: object, key: string, value: unknown];

/**
 * Tiptap·ProseMirror·@tiptap/suggestion(Floating UI) 가 jsdom 에서 요구하는 레이아웃 API 스텁 — 부르는 테스트 파일에서만 켠다
 * (공용 setup.ts 에 두지 않는다). jsdom 은 레이아웃이 없어 모두 0 크기로 답한다.
 * 돌려주는 함수가 원래대로 되돌린다(관찰자 전역은 `vi.unstubAllGlobals()`)
 */
export function stubEditorDom(): () => void {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);

  const patches: Patch[] = [
    [Range.prototype, "getBoundingClientRect", () => new DOMRect(0, 0, 0, 0)],
    [Range.prototype, "getClientRects", () => []],
    [Document.prototype, "elementFromPoint", () => null],
  ];
  const saved = patches.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
  for (const [target, key, value] of patches) {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
  return () => {
    patches.forEach(([target, key], i) => {
      const d = saved[i];
      if (d) Object.defineProperty(target, key, d);
      else delete (target as Record<string, unknown>)[key];
    });
  };
}

/** 스텁이 만든 알림 하나 — 테스트가 제목·본문을 읽고 클릭을 흉내 낸다 */
export type FakeNotification = {
  title: string;
  options?: NotificationOptions;
  onclick: ((this: unknown, ev: unknown) => void) | null;
  closed: boolean;
  /** 사용자가 알림을 누른 것 */
  click(): void;
  close(): void;
};

/**
 * jsdom 에는 `Notification` 이 없다 — 승인 알림을 재는 테스트가 켠다(설계 5.4).
 * `permission` 은 지금 권한, `answer()` 는 다음 `requestPermission()` 이 내놓을 답(사용자가 누른 뒤의 상태)이다.
 * 돌려주는 `restore()` 가 전역을 원래대로 되돌린다 — jsdom 에는 없던 이름이라 지운다.
 * `vi.stubGlobal` 을 쓰지 않는 것은 `vi.unstubAllGlobals()` 가 같은 파일의 다른 스텁까지 함께 벗기기 때문이다
 */
export function stubNotification(permission: NotificationPermission = "default"): {
  made: FakeNotification[];
  answer(next: NotificationPermission): void;
  asked(): number;
  restore(): void;
} {
  const made: FakeNotification[] = [];
  let current = permission;
  let answer = permission;
  let asked = 0;

  class NotificationStub {
    static get permission(): NotificationPermission {
      return current;
    }
    static async requestPermission(): Promise<NotificationPermission> {
      asked += 1;
      current = answer;
      return current;
    }
    onclick: ((this: unknown, ev: unknown) => void) | null = null;
    closed = false;
    constructor(
      readonly title: string,
      readonly options?: NotificationOptions,
    ) {
      made.push(this as unknown as FakeNotification);
    }
    click(): void {
      this.onclick?.call(this, undefined);
    }
    close(): void {
      this.closed = true;
    }
  }

  const g = globalThis as Record<string, unknown>;
  const had = Object.hasOwn(g, "Notification");
  const saved = g.Notification;
  g.Notification = NotificationStub;
  return {
    made,
    answer: (next) => {
      answer = next;
    },
    asked: () => asked,
    restore: () => {
      if (had) g.Notification = saved;
      else delete g.Notification;
    },
  };
}
