import type { Attachment } from "@dodok/shared";
import { vi } from "vitest";

/**
 * 업로드 테스트용 가짜 XMLHttpRequest — 만든 것은 `FakeXhr.all` 에 쌓인다. 테스트가 `progress`·`respond`·`fail` 로 몬다.
 * 전역에 넣을 때는 `vi.stubGlobal("XMLHttpRequest", FakeXhr)`, 되돌리기는 `vi.unstubAllGlobals()` + `FakeXhr.reset()`
 */
export class FakeXhr {
  static all: FakeXhr[] = [];
  static reset() {
    FakeXhr.all = [];
  }

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  sent = false;
  aborted = false;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.all.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    this.body = body;
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}

export const makeFakeXhr = () => new FakeXhr() as unknown as XMLHttpRequest;

/** 서버가 돌려줄 법한 이미지 첨부 — id 는 uuid 꼴 */
export const uploaded = (n: number, name = `img${n}.png`): Attachment => {
  const id = `01a0cc16-22ee-7018-826c-${String(n).padStart(12, "0")}`;
  return {
    id,
    kind: "image",
    url: `artifact://${id}`,
    name,
    mime: "image/png",
    size: 10,
    width: 4,
    height: 3,
  };
};

export const pngFile = (name = "a.png", size = 3) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

/**
 * jsdom 에는 `URL.createObjectURL`·`revokeObjectURL` 이 없다 — `blob:1`, `blob:2`… 를 주는 가짜를 넣는다.
 * 돌려주는 함수가 원래대로 되돌린다
 */
export function stubObjectUrls() {
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let n = 0;
  const create = vi.fn<(obj: Blob | MediaSource) => string>(() => `blob:${++n}`);
  const revoke = vi.fn<(url: string) => void>();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  return {
    create,
    revoke,
    restore() {
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    },
  };
}
