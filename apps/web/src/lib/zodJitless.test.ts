import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * CSP(`script-src 'self'`)는 문자열 코드 실행을 막는다. zod 는 jitless 가 아니면 객체 스키마를 만드는 순간 `Function("")` 으로
 * 가능 여부를 떠보고, 막혀도 삼키지만 브라우저는 그 시도를 CSP 위반으로 보고한다. 그래서 스키마보다 먼저 jitless 를 켠다
 */
it("zodJitless 를 먼저 불러오면 shared 스키마를 만들고 파싱해도 Function 을 부르지 않는다", async () => {
  const Original = globalThis.Function;
  const calls: unknown[][] = [];
  globalThis.Function = new Proxy(Original, {
    apply(target, self, args) {
      calls.push(args);
      return Reflect.apply(target, self, args);
    },
    construct(target, args, newTarget) {
      calls.push(args);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    await import("./zodJitless");
    const { PushPayload } = await import("@dodok/shared");
    const { z } = await import("zod");
    z.object({ a: z.string() }).parse({ a: "x" });
    PushPayload.safeParse({});
  } finally {
    globalThis.Function = Original;
  }
  expect(calls).toEqual([]);
});

/** 순서가 전부다 — 앱과 서비스 워커의 첫 import 여야 다른 모듈의 스키마보다 먼저 돈다 */
it.each(["../main.tsx", "../sw.ts"])("%s 의 첫 import 는 zodJitless", (file) => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const first = source.split("\n").find((line) => line.startsWith("import "));
  expect(first).toMatch(/^import "\.\/lib\/zodJitless";$/);
});
