# @dodok/shared 계약 + DB 스키마 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모노레포를 스캐폴드하고, 모든 경계의 계약(`@dodok/shared`)과 서버 DB 스키마, 런 상태머신·라우터·상호작용 검증 같은 순수 로직을 테스트와 함께 구현한다.

**Architecture:** `packages/shared`는 `zod`만 의존하는 계약 패키지로, 도메인·components v1·RunEvent·wire·bridge 스키마를 서브패스로 export한다. `apps/server`는 Drizzle SQLite 스키마와 I/O 없는 순수 함수(상태머신, 라우터, 상호작용 검증)를 갖는다. `packages/openclaw-plugin`은 이 단계에서 인바운드 컨텍스트 텍스트 조립 함수만 갖는다(SDK 의존은 스파이크 2에서 추가).

**Tech Stack:** pnpm 11 workspaces + Turborepo 2, TypeScript 5.9, Biome 2, Vitest 4, Zod 4.6, uuid 14(v7), Drizzle ORM 0.45 + drizzle-kit 0.31 + better-sqlite3 13.

**Spec:** `docs/superpowers/specs/2026-09-14-shared-contracts-design.md` (이하 "스펙"). 실행자는 스펙의 해당 장을 함께 읽는다.

## Global Constraints

- Node `>=22.19.0` (로컬 v22.23.1). 패키지 매니저 `pnpm@11.16.0`.
- 정확 핀: `zod@4.6.5`, `uuid@14.0.2`, `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `better-sqlite3@13.0.3`, `@types/better-sqlite3@9.6.0`, `typescript@5.9.3`, `vitest@4.1.11`, `turbo@2.10.12`, `@biomejs/biome@2.5.13`, `tsx@4.23.13`, `@types/node@^22.19.0`.
- `@dodok/shared`의 런타임 의존은 `zod` 하나. Node 전용 API 금지(tsconfig에서 `types: []`로 강제). AG-UI는 이름만 차용, `@ag-ui/core` 미사용.
- 모든 ID는 UUIDv7(`uuid`의 `v7()`), wire/bridge 시간은 ISO 8601(오프셋 포함), DB 시간은 integer ms.
- 에러 코드는 스펙 1.2의 닫힌 enum: `UNAUTHORIZED FORBIDDEN NOT_FOUND VALIDATION CONFLICT RATE_LIMITED RELAY_LIMIT ADAPTER_UNAVAILABLE PROTOCOL_MISMATCH EXPIRED CONSUMED TIMEOUT INTERNAL`.
- 멘션 토큰: `<@a:<uuid>>`(에이전트), `<@u:<uuid>>`(사람). 핸들 정규식 `^[a-z0-9_-]{2,32}$`.
- components v1 제약: 액션 로우 버튼 1~5개 또는 셀렉트 정확히 1개, 옵션 ≤25, 모달 필드 1~5, 블록 ≤10, TTL 1초~24시간(기본 30분), 모든 id 유일, URL은 `https://` 또는 `artifact://`.
- 세션 키 형식: `agent:<agentId>:dodok:channel:<channelId>`.
- 커밋: Conventional Commits, 패키지 스코프(`feat(shared): …`, `feat(server): …`). 커밋 메시지 끝에 세션 안내의 attribution 줄을 붙인다.
- TypeScript `strict`, ESM only, `verbatimModuleSyntax`. 외부 입력은 경계에서 Zod 파싱.

---

## 파일 구조

```
dodok.chat/
├─ package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  biome.json
├─ packages/shared/
│  ├─ package.json  tsconfig.json  vitest.config.ts
│  ├─ src/index.ts                 루트 re-export
│  ├─ src/common.ts                Id, IsoDateTime, ErrorCode, ApiError, Result, Ack, 프로토콜 상수
│  ├─ src/mention.ts               멘션 토큰 파싱·렌더·토큰화 (MentionSet 정의 위치)
│  ├─ src/components/index.ts      components v1 스키마 + JSON Schema 변환
│  ├─ src/domain/index.ts          엔티티 스키마
│  ├─ src/events/index.ts          RunEvent 유니온
│  ├─ src/wire/index.ts            클라이언트↔서버 이벤트 맵
│  ├─ src/bridge/index.ts          플러그인↔서버 이벤트 맵
│  └─ test/*.test.ts, test/*.test-d.ts
├─ apps/server/
│  ├─ package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts
│  ├─ drizzle/                     drizzle-kit이 생성한 SQL 마이그레이션 (커밋 대상)
│  ├─ src/db/schema.sqlite.ts      Drizzle 테이블
│  ├─ src/db/client.ts             createDb(url): 연결 + 마이그레이션
│  ├─ src/modules/messages/seq.ts  allocateSeq
│  ├─ src/modules/runs/machine.ts  transition
│  ├─ src/modules/router/decide.ts decideRuns, computeRelayHash
│  ├─ src/modules/components/interact.ts  findItem, validateInteraction, formatInteractionText
│  └─ test/**
└─ packages/openclaw-plugin/
   ├─ package.json  tsconfig.json  vitest.config.ts
   ├─ src/context.ts               formatInboundContext
   └─ test/context.test.ts
```

각 파일은 한 가지 책임만 갖는다. 서버의 순수 함수는 DB·소켓을 import하지 않는다(테스트가 이를 보장하도록 입력을 전부 인자로 받는다).

---

### Task 1: 모노레포 스캐폴드 + `@dodok/shared` 골격 + `common.ts`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/index.ts`, `packages/shared/src/common.ts`
- Test: `packages/shared/test/common.test.ts`

**Interfaces:**
- Produces: `Id`(Zod uuid), `IsoDateTime`, `ErrorCode`, `ApiError`, `Result<T>`, `Ack<T>`, `WIRE_PROTOCOL = 1`, `BRIDGE_PROTOCOL = 1` — 이후 모든 태스크가 `../common` 또는 `@dodok/shared/common`에서 import.

- [ ] **Step 1: 루트 워크스페이스 파일 작성**

`package.json`:
```json
{
  "name": "dodok.chat",
  "private": true,
  "packageManager": "pnpm@11.16.0",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.13",
    "turbo": "2.10.12",
    "typescript": "5.9.3"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "test": { "dependsOn": ["^test"], "outputs": [] },
    "typecheck": { "dependsOn": ["^typecheck"], "outputs": [] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.13/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/dist", "!**/drizzle/meta", "!**/*.sql"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
}
```

- [ ] **Step 2: `packages/shared` 패키지 파일 작성**

`packages/shared/package.json` (exports는 소스 `.ts`를 가리킨다 — 워크스페이스 내부 소비자(vitest, tsx, vite, tsc bundler 해석)가 모두 처리하므로 별도 빌드 없음):
```json
{
  "name": "@dodok/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./common": "./src/common.ts",
    "./mention": "./src/mention.ts",
    "./domain": "./src/domain/index.ts",
    "./components": "./src/components/index.ts",
    "./events": "./src/events/index.ts",
    "./wire": "./src/wire/index.ts",
    "./bridge": "./src/bridge/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": { "zod": "4.6.5" },
  "devDependencies": { "typescript": "5.9.3", "vitest": "4.1.11" }
}
```

`packages/shared/tsconfig.json` — `types: []`로 Node 타입을 차단한다(스펙 1.1 규칙 강제):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": [] },
  "include": ["src", "test"]
}
```

`packages/shared/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    typecheck: { enabled: true, include: ["test/**/*.test-d.ts"] },
  },
});
```

`packages/shared/src/index.ts` (지금은 common만; 이후 태스크에서 줄을 추가한다):
```ts
export * from "./common";
```

- [ ] **Step 3: 실패하는 테스트 작성**

`packages/shared/test/common.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ApiError, BRIDGE_PROTOCOL, ErrorCode, Id, IsoDateTime, WIRE_PROTOCOL } from "../src/common";

describe("common", () => {
  it("Id는 UUID만 허용한다", () => {
    expect(Id.safeParse("01a09fc9-d204-7551-89d6-38544d07a13a").success).toBe(true);
    expect(Id.safeParse("not-a-uuid").success).toBe(false);
  });

  it("IsoDateTime은 오프셋과 Z를 모두 받는다", () => {
    expect(IsoDateTime.safeParse("2026-09-14T09:12:00+09:00").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-09-14T00:12:00Z").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-09-14 09:12").success).toBe(false);
  });

  it("ErrorCode는 닫힌 enum이다", () => {
    expect(ErrorCode.options).toEqual([
      "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "VALIDATION", "CONFLICT", "RATE_LIMITED",
      "RELAY_LIMIT", "ADAPTER_UNAVAILABLE", "PROTOCOL_MISMATCH", "EXPIRED", "CONSUMED", "TIMEOUT", "INTERNAL",
    ]);
    expect(ErrorCode.safeParse("NOPE").success).toBe(false);
  });

  it("ApiError는 details를 선택으로 받는다", () => {
    expect(ApiError.parse({ code: "VALIDATION", message: "bad" })).toEqual({ code: "VALIDATION", message: "bad" });
    expect(ApiError.safeParse({ code: "VALIDATION" }).success).toBe(false);
  });

  it("프로토콜 상수는 1이다", () => {
    expect(WIRE_PROTOCOL).toBe(1);
    expect(BRIDGE_PROTOCOL).toBe(1);
  });
});
```

- [ ] **Step 4: 의존성 설치 후 테스트가 실패하는지 확인**

Run: `pnpm install && pnpm -F @dodok/shared test`
Expected: FAIL — `Failed to resolve import "../src/common"` (파일 없음)

- [ ] **Step 5: `common.ts` 구현**

`packages/shared/src/common.ts`:
```ts
import { z } from "zod";

/** UUIDv7 (uuid v14 `v7()`), 모든 엔티티 PK */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** wire/bridge의 시간은 ISO 8601 문자열(오프셋 또는 Z). DB는 integer ms. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
  "RELAY_LIMIT",
  "ADAPTER_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "EXPIRED",
  "CONSUMED",
  "TIMEOUT",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };
/** Socket.IO ack 콜백 시그니처 */
export type Ack<T> = (res: Result<T>) => void;

/** 핸드셰이크 협상용. wire와 bridge 각각 독립적으로 올린다. */
export const WIRE_PROTOCOL = 1 as const;
export const BRIDGE_PROTOCOL = 1 as const;

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): Result<never> {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}
```

- [ ] **Step 6: 테스트·타입체크·린트 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 5 tests PASS, tsc 오류 없음, biome 오류 없음(포맷 경고가 나오면 `pnpm lint:fix` 후 재실행)

- [ ] **Step 7: 커밋**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json biome.json packages/shared
git commit -m "chore: pnpm+turbo 모노레포 스캐폴드, @dodok/shared 골격과 common 계약"
```

---

### Task 2: 멘션 규약 `mention.ts`

**Files:**
- Create: `packages/shared/src/mention.ts`
- Modify: `packages/shared/src/index.ts` (re-export 한 줄 추가)
- Test: `packages/shared/test/mention.test.ts`

**Interfaces:**
- Consumes: `Id` from `./common`
- Produces: `MENTION_TOKEN_RE`, `PLAIN_MENTION_RE`, `MentionSet`(Zod + type, **여기서 정의**하고 Task 4의 domain이 re-export), `Participant`, `Segment`, `parseMentions(bodyMd): MentionSet`, `segment(bodyMd): Segment[]`, `renderForAgent(bodyMd, participants): string`, `tokenize(text, participants): { bodyMd; mentions }`

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/shared/test/mention.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  MENTION_TOKEN_RE,
  type Participant,
  parseMentions,
  renderForAgent,
  segment,
  tokenize,
} from "../src/mention";

const A1 = "01a09fc9-d204-7551-89d6-38544d07a13a";
const A2 = "01a09fc9-d204-7551-89d6-38544d07a13b";
const U1 = "01a09fc9-d204-7551-89d6-38544d07a13c";

const participants: Participant[] = [
  { type: "agent", id: A1, handle: "researcher", aliases: ["res"], displayName: "Researcher" },
  { type: "agent", id: A2, handle: "planner", displayName: "Planner" },
  { type: "user", id: U1, handle: "jang", displayName: "장병현" },
];

describe("parseMentions", () => {
  it("에이전트·사람 토큰을 종류별로 모으고 중복을 제거하며 등장 순서를 지킨다", () => {
    const body = `<@a:${A2}> 그리고 <@u:${U1}> 또 <@a:${A1}> 다시 <@a:${A2}>`;
    expect(parseMentions(body)).toEqual({ agents: [A2, A1], users: [U1] });
  });
  it("토큰이 없으면 빈 집합", () => {
    expect(parseMentions("hello @researcher")).toEqual({ agents: [], users: [] });
  });
  it("정규식은 전역 플래그를 가진다", () => {
    expect(MENTION_TOKEN_RE.flags).toContain("g");
  });
});

describe("segment", () => {
  it("텍스트와 멘션 세그먼트로 나눈다", () => {
    expect(segment(`안녕 <@a:${A1}>!`)).toEqual([
      { kind: "text", text: "안녕 " },
      { kind: "mention", type: "agent", id: A1 },
      { kind: "text", text: "!" },
    ]);
  });
  it("멘션만 있는 본문", () => {
    expect(segment(`<@u:${U1}>`)).toEqual([{ kind: "mention", type: "user", id: U1 }]);
  });
});

describe("renderForAgent", () => {
  it("토큰을 @handle로 치환한다", () => {
    expect(renderForAgent(`<@a:${A2}> 이거 봐줘 <@u:${U1}>`, participants)).toBe("@planner 이거 봐줘 @jang");
  });
  it("모르는 토큰은 @unknown", () => {
    expect(renderForAgent("<@a:01a09fc9-d204-7551-89d6-000000000000> hi", participants)).toBe("@unknown hi");
  });
});

describe("tokenize", () => {
  it("참여자 핸들·별칭을 토큰으로 바꾸고 mentions를 파생한다", () => {
    const r = tokenize("@planner 와 @res 확인해줘. @nobody 는 무시", participants);
    expect(r.bodyMd).toBe(`<@a:${A2}> 와 <@a:${A1}> 확인해줘. @nobody 는 무시`);
    expect(r.mentions).toEqual({ agents: [A2, A1], users: [] });
  });
  it("대소문자를 무시한다", () => {
    expect(tokenize("@Planner", participants).bodyMd).toBe(`<@a:${A2}>`);
  });
  it("이메일 주소의 @는 건드리지 않는다", () => {
    expect(tokenize("메일은 a@planner.com", participants).bodyMd).toBe("메일은 a@planner.com");
  });
  it("코드 블록·인라인 코드 안은 건드리지 않는다", () => {
    const text = "```\n@planner\n```\n그리고 `@jang` 그러나 @jang";
    expect(tokenize(text, participants).bodyMd).toBe("```\n@planner\n```\n그리고 `@jang` 그러나 <@u:" + U1 + ">");
  });
  it("renderForAgent와 왕복한다", () => {
    const body = `<@a:${A1}> 다음 <@u:${U1}> 끝`;
    expect(tokenize(renderForAgent(body, participants), participants).bodyMd).toBe(body);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- mention`
Expected: FAIL — `Failed to resolve import "../src/mention"`

- [ ] **Step 3: 구현**

`packages/shared/src/mention.ts`:
```ts
import { z } from "zod";
import { Id } from "./common";

/** 저장 본문의 멘션 토큰. 그룹1: a|u, 그룹2: uuid */
export const MENTION_TOKEN_RE =
  /<@(a|u):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** 평문 멘션. 그룹1: 앞 문맥(문장 시작/공백/구두점), 그룹2: 핸들. 뒤는 단어 경계. 대소문자 무시. */
export const PLAIN_MENTION_RE = /(^|[^\w@])@([a-z0-9_-]{2,32})(?![\w-])/gi;

export const MentionSet = z.object({ agents: z.array(Id), users: z.array(Id) });
export type MentionSet = z.infer<typeof MentionSet>;

export type Participant = {
  type: "agent" | "user";
  id: string;
  handle: string;
  aliases?: string[];
  displayName: string;
};

export type Segment = { kind: "text"; text: string } | { kind: "mention"; type: "agent" | "user"; id: string };

export function parseMentions(bodyMd: string): MentionSet {
  const agents: string[] = [];
  const users: string[] = [];
  for (const m of bodyMd.matchAll(MENTION_TOKEN_RE)) {
    const kind = m[1];
    const id = m[2] as string;
    const list = kind === "a" ? agents : users;
    if (!list.includes(id)) list.push(id);
  }
  return { agents, users };
}

export function segment(bodyMd: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of bodyMd.matchAll(MENTION_TOKEN_RE)) {
    const idx = m.index as number;
    if (idx > last) out.push({ kind: "text", text: bodyMd.slice(last, idx) });
    out.push({ kind: "mention", type: m[1] === "a" ? "agent" : "user", id: m[2] as string });
    last = idx + m[0].length;
  }
  if (last < bodyMd.length) out.push({ kind: "text", text: bodyMd.slice(last) });
  return out;
}

export function renderForAgent(bodyMd: string, participants: Participant[]): string {
  const byKey = new Map(participants.map((p) => [`${p.type === "agent" ? "a" : "u"}:${p.id}`, p]));
  return bodyMd.replace(MENTION_TOKEN_RE, (_whole, kind: string, id: string) => {
    const p = byKey.get(`${kind}:${id}`);
    return p ? `@${p.handle}` : "@unknown";
  });
}

export function tokenize(text: string, participants: Participant[]): { bodyMd: string; mentions: MentionSet } {
  const byHandle = new Map<string, Participant>();
  for (const p of participants) {
    byHandle.set(p.handle.toLowerCase(), p);
    for (const a of p.aliases ?? []) byHandle.set(a.toLowerCase(), p);
  }
  const bodyMd = splitCode(text)
    .map((part) =>
      part.code
        ? part.text
        : part.text.replace(PLAIN_MENTION_RE, (whole: string, pre: string, handle: string) => {
            const p = byHandle.get(handle.toLowerCase());
            if (!p) return whole;
            return `${pre}<@${p.type === "agent" ? "a" : "u"}:${p.id}>`;
          }),
    )
    .join("");
  return { bodyMd, mentions: parseMentions(bodyMd) };
}

/** 펜스 코드 블록(```...```)과 인라인 코드(`...`)를 분리한다. */
function splitCode(text: string): Array<{ text: string; code: boolean }> {
  const re = /```[\s\S]*?```|`[^`\n]*`/g;
  const out: Array<{ text: string; code: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index as number;
    if (idx > last) out.push({ text: text.slice(last, idx), code: false });
    out.push({ text: m[0], code: true });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false });
  return out;
}
```

`packages/shared/src/index.ts`에 추가:
```ts
export * from "./mention";
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/mention.ts packages/shared/src/index.ts packages/shared/test/mention.test.ts
git commit -m "feat(shared): 멘션 토큰 파싱·렌더·토큰화"
```

---

### Task 3: components v1 스키마

**Files:**
- Create: `packages/shared/src/components/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/components.test.ts`

**Interfaces:**
- Consumes: `Id`, `IsoDateTime` from `../common`
- Produces: `ItemId`, `SafeUrl`, `Button`, `Select`, `SelectOption`, `Block`, `Field`, `Modal`, `ComponentsV1Base`(refine 없는 객체), `ComponentsV1`(id 유일성 refine 포함), `ComponentsV1` 타입, `ComponentState`, `collectIds(c): string[]`, `componentsToolJsonSchema(): Record<string, unknown>`

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/shared/test/components.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ComponentState, ComponentsV1, collectIds, componentsToolJsonSchema } from "../src/components";

const U1 = "01a09fc9-d204-7551-89d6-38544d07a13c";

const sample = {
  text: "어떤 방식으로 진행할까요?",
  blocks: [
    { type: "section", text: "**옵션을 선택하세요**" },
    { type: "separator" },
    {
      type: "actions",
      items: [
        { type: "button", id: "go_fast", label: "빠르게", style: "primary", emoji: "⚡" },
        { type: "button", id: "go_safe", label: "안전하게", style: "success" },
        { type: "button", id: "cancel", label: "취소", style: "danger", allowedUsers: [U1] },
      ],
    },
    {
      type: "actions",
      items: [
        {
          type: "select",
          id: "target",
          placeholder: "대상 선택",
          options: [
            { value: "web", label: "웹" },
            { value: "api", label: "API" },
          ],
        },
      ],
    },
    { type: "media", items: [{ url: "artifact://img_1", alt: "미리보기" }] },
    { type: "file", url: "artifact://report.pdf", name: "report.pdf" },
  ],
  modal: {
    id: "details",
    title: "세부 정보",
    triggerLabel: "입력하기",
    fields: [
      { type: "text", id: "title", label: "제목", required: true },
      { type: "textarea", id: "desc", label: "설명" },
      { type: "select", id: "priority", label: "우선순위", options: [{ value: "p1", label: "높음" }, { value: "p2", label: "보통" }] },
      { type: "checkbox", id: "notify", label: "완료 시 알림" },
    ],
  },
};

const buttons = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: "button", id: `b${i}`, label: `B${i}` }));

describe("ComponentsV1", () => {
  it("스펙 5.4 예시를 파싱하고 기본값을 채운다", () => {
    const c = ComponentsV1.parse(sample);
    expect(c.reusable).toBe(false);
    expect(c.ttlMs).toBe(1_800_000);
    const actions = c.blocks[2];
    if (actions?.type !== "actions") throw new Error("expected actions");
    expect(actions.items[0]).toMatchObject({ style: "primary" });
    expect(actions.items[1]).toMatchObject({ style: "success" });
    const sel = c.blocks[3];
    if (sel?.type !== "actions" || sel.items[0]?.type !== "select") throw new Error("expected select");
    expect(sel.items[0].multi).toBe(false);
  });

  it("액션 로우: 버튼 6개 거부", () => {
    expect(ComponentsV1.safeParse({ blocks: [{ type: "actions", items: buttons(6) }] }).success).toBe(false);
  });
  it("액션 로우: 버튼 5개 허용", () => {
    expect(ComponentsV1.safeParse({ blocks: [{ type: "actions", items: buttons(5) }] }).success).toBe(true);
  });
  it("액션 로우: 셀렉트 + 버튼 혼합 거부", () => {
    const r = ComponentsV1.safeParse({
      blocks: [{ type: "actions", items: [{ type: "select", id: "s", options: [{ value: "a", label: "A" }] }, ...buttons(1)] }],
    });
    expect(r.success).toBe(false);
  });
  it("셀렉트 옵션 26개 거부", () => {
    const options = Array.from({ length: 26 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    expect(ComponentsV1.safeParse({ blocks: [{ type: "actions", items: [{ type: "select", id: "s", options }] }] }).success).toBe(false);
  });
  it("모달 필드 6개 거부, 5개 허용", () => {
    const fields = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "text", id: `f${i}`, label: `F${i}` }));
    const modal = (n: number) => ({ modal: { id: "m", title: "t", triggerLabel: "open", fields: fields(n) } });
    expect(ComponentsV1.safeParse(modal(6)).success).toBe(false);
    expect(ComponentsV1.safeParse(modal(5)).success).toBe(true);
  });
  it("TTL 범위 밖 거부", () => {
    expect(ComponentsV1.safeParse({ ttlMs: 500 }).success).toBe(false);
    expect(ComponentsV1.safeParse({ ttlMs: 86_400_001 }).success).toBe(false);
  });
  it("id 중복 거부 (블록·아이템·모달·필드 통틀어)", () => {
    const r = ComponentsV1.safeParse({
      blocks: [{ type: "actions", items: buttons(1) }],
      modal: { id: "b0", title: "t", triggerLabel: "o", fields: [{ type: "text", id: "x", label: "X" }] },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["blocks"]);
  });
  it("http:// URL 거부, https://와 artifact:// 허용", () => {
    expect(ComponentsV1.safeParse({ blocks: [{ type: "file", url: "http://x/y", name: "f" }] }).success).toBe(false);
    expect(ComponentsV1.safeParse({ blocks: [{ type: "file", url: "https://x/y", name: "f" }] }).success).toBe(true);
    expect(ComponentsV1.safeParse({ blocks: [{ type: "file", url: "artifact://abc", name: "f" }] }).success).toBe(true);
  });
  it("블록 11개 거부", () => {
    const blocks = Array.from({ length: 11 }, () => ({ type: "separator" }));
    expect(ComponentsV1.safeParse({ blocks }).success).toBe(false);
  });
});

describe("collectIds", () => {
  it("모든 id를 모은다", () => {
    expect(collectIds(ComponentsV1.parse(sample))).toEqual(["go_fast", "go_safe", "cancel", "target", "details", "title", "desc", "priority", "notify"]);
  });
});

describe("ComponentState", () => {
  it("만료 시각과 소비 목록", () => {
    expect(ComponentState.parse({ expiresAt: "2026-09-14T00:00:00Z", consumed: ["go_fast"] }).consumed).toEqual(["go_fast"]);
  });
});

describe("componentsToolJsonSchema", () => {
  it("에이전트용 JSON Schema에는 blocks/modal이 있고 서버 부여 id는 없다", () => {
    const js = componentsToolJsonSchema() as { properties: Record<string, unknown> };
    expect(js.properties.blocks).toBeDefined();
    expect(js.properties.modal).toBeDefined();
    expect(js.properties.id).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- components`
Expected: FAIL — `Failed to resolve import "../src/components"`

- [ ] **Step 3: 구현**

`packages/shared/src/components/index.ts`:
```ts
import { z } from "zod";
import { Id, IsoDateTime } from "../common";

export const ItemId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
export const SafeUrl = z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/);
const AllowedUsers = z.array(Id).max(50).optional();

export const Button = z.object({
  type: z.literal("button"),
  id: ItemId,
  label: z.string().min(1).max(80),
  style: z.enum(["primary", "secondary", "success", "danger"]).default("secondary"),
  emoji: z.string().max(8).optional(),
  url: SafeUrl.optional(), // 링크 버튼: 상호작용 없음
  allowedUsers: AllowedUsers,
});
export type Button = z.infer<typeof Button>;

export const SelectOption = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
  description: z.string().max(100).optional(),
  emoji: z.string().max(8).optional(),
});
export type SelectOption = z.infer<typeof SelectOption>;

export const Select = z.object({
  type: z.literal("select"),
  id: ItemId,
  placeholder: z.string().max(150).optional(),
  multi: z.boolean().default(false),
  minValues: z.int().min(0).max(25).optional(),
  maxValues: z.int().min(1).max(25).optional(),
  options: z.array(SelectOption).min(1).max(25),
  allowedUsers: AllowedUsers,
});
export type Select = z.infer<typeof Select>;

export const SectionBlock = z.object({ type: z.literal("section"), text: z.string().min(1).max(2000) });
export const SeparatorBlock = z.object({ type: z.literal("separator") });
export const ActionsBlock = z
  .object({
    type: z.literal("actions"),
    id: ItemId.optional(),
    items: z.array(z.union([Button, Select])).min(1).max(5),
  })
  .refine(
    (b) => b.items.every((i) => i.type === "button") || (b.items.length === 1 && b.items[0]?.type === "select"),
    { message: "actions: 버튼 1~5개 또는 셀렉트 정확히 1개", path: ["items"] },
  );
export const MediaBlock = z.object({
  type: z.literal("media"),
  items: z.array(z.object({ url: SafeUrl, alt: z.string().max(200).optional() })).min(1).max(10),
});
export const FileBlock = z.object({
  type: z.literal("file"),
  url: SafeUrl,
  name: z.string().min(1).max(255),
  size: z.int().optional(),
});

export const Block = z.discriminatedUnion("type", [SectionBlock, SeparatorBlock, ActionsBlock, MediaBlock, FileBlock]);
export type Block = z.infer<typeof Block>;

const FieldBase = { id: ItemId, label: z.string().min(1).max(45), required: z.boolean().default(false) };
export const Field = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    ...FieldBase,
    placeholder: z.string().max(100).optional(),
    minLength: z.int().optional(),
    maxLength: z.int().max(4000).optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("textarea"),
    ...FieldBase,
    placeholder: z.string().max(100).optional(),
    maxLength: z.int().max(4000).optional(),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("number"),
    ...FieldBase,
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({ type: z.literal("date"), ...FieldBase, default: z.iso.date().optional() }),
  z.object({
    type: z.literal("select"),
    ...FieldBase,
    multi: z.boolean().default(false),
    options: z.array(SelectOption).min(1).max(25),
    default: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("checkbox"), ...FieldBase, default: z.boolean().optional() }),
  z.object({
    type: z.literal("radio"),
    ...FieldBase,
    options: z.array(SelectOption).min(2).max(10),
    default: z.string().optional(),
  }),
]);
export type Field = z.infer<typeof Field>;

export const Modal = z.object({
  id: ItemId,
  title: z.string().min(1).max(45),
  triggerLabel: z.string().min(1).max(80),
  fields: z.array(Field).min(1).max(5),
  allowedUsers: AllowedUsers,
});
export type Modal = z.infer<typeof Modal>;

/** refine 없는 객체. JSON Schema 변환과 파생(omit/pick)에 쓴다. */
export const ComponentsV1Base = z.object({
  id: z.string().optional(), // 서버가 저장 시 부여 (cmp_<uuid>)
  reusable: z.boolean().default(false),
  ttlMs: z.int().min(1_000).max(86_400_000).default(1_800_000),
  text: z.string().max(2000).optional(), // 컴포넌트를 못 그리는 곳의 대체 텍스트
  blocks: z.array(Block).max(10).default([]),
  modal: Modal.optional(),
});

export function collectIds(c: z.infer<typeof ComponentsV1Base>): string[] {
  const ids: string[] = [];
  for (const b of c.blocks) {
    if (b.type !== "actions") continue;
    if (b.id) ids.push(b.id);
    for (const item of b.items) ids.push(item.id);
  }
  if (c.modal) {
    ids.push(c.modal.id);
    for (const f of c.modal.fields) ids.push(f.id);
  }
  return ids;
}

export const ComponentsV1 = ComponentsV1Base.refine(
  (c) => {
    const ids = collectIds(c);
    return new Set(ids).size === ids.length;
  },
  { message: "components: 모든 id는 유일해야 함", path: ["blocks"] },
);
export type ComponentsV1 = z.infer<typeof ComponentsV1>;

export const ComponentState = z.object({ expiresAt: IsoDateTime, consumed: z.array(ItemId) });
export type ComponentState = z.infer<typeof ComponentState>;

/** 에이전트에게 노출하는 message 툴 스키마 조각 (서버 부여 id 제외) */
export function componentsToolJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ComponentsV1Base.omit({ id: true })) as Record<string, unknown>;
}
```

`packages/shared/src/index.ts`에 추가:
```ts
export * from "./components";
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/components packages/shared/src/index.ts packages/shared/test/components.test.ts
git commit -m "feat(shared): components v1 스키마와 제약 검증"
```

---

### Task 4: 도메인 스키마 `domain/index.ts`

**Files:**
- Create: `packages/shared/src/domain/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/domain.test.ts`

**Interfaces:**
- Consumes: `Id`, `IsoDateTime` from `../common`; `MentionSet` from `../mention`; `ComponentsV1` from `../components`
- Produces: `Handle`, `Workspace`, `User`, `MembershipRole`, `Membership`, `AgentProvider`, `Agent`, `RelayPair`, `RelayPolicy`, `Channel`, `ChannelMember`, `Attachment`, `SystemKind`, `SystemMeta`, `Message`, `RunStatus`, `RunTriggerKind`, `RunUsage`, `Run`, `RunState`, `ComponentInteraction`, `ApprovalKind`, `ApprovalStatus`, `Approval`, `PushSubscription` — 각각 같은 이름의 타입도 export

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/shared/test/domain.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  Approval,
  Channel,
  Handle,
  Message,
  RelayPolicy,
  Run,
  RunState,
  RunStatus,
  RunTriggerKind,
} from "../src/domain";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T09:12:00+09:00";

describe("Handle", () => {
  it("소문자·숫자·_·- 2~32자만", () => {
    expect(Handle.safeParse("researcher").success).toBe(true);
    expect(Handle.safeParse("a").success).toBe(false);
    expect(Handle.safeParse("Bob").success).toBe(false);
    expect(Handle.safeParse("x".repeat(33)).success).toBe(false);
  });
});

describe("RelayPolicy", () => {
  it("기본값 maxRelayTurns=4, allowPairs=all", () => {
    expect(RelayPolicy.parse({})).toEqual({ maxRelayTurns: 4, allowPairs: "all" });
  });
  it("허용 쌍 목록", () => {
    const p = RelayPolicy.parse({ allowPairs: [{ from: ID(1), to: ID(2) }], dailyRunLimit: 100 });
    expect(p.allowPairs).toEqual([{ from: ID(1), to: ID(2) }]);
    expect(p.dailyRunLimit).toBe(100);
  });
});

describe("Channel", () => {
  it("relayPolicy가 없으면 실패한다 (서버가 기본값을 채워 저장)", () => {
    expect(Channel.safeParse({ id: ID(1), workspaceId: ID(2), name: "general", visibility: "public", createdBy: ID(3), createdAt: NOW }).success).toBe(false);
    expect(Channel.safeParse({ id: ID(1), workspaceId: ID(2), name: "general", relayPolicy: {}, visibility: "public", createdBy: ID(3), createdAt: NOW }).success).toBe(true);
  });
});

describe("Message", () => {
  const base = {
    id: ID(1), channelId: ID(2), seq: 1, kind: "normal", authorType: "user", authorId: ID(3),
    bodyMd: `<@a:${ID(4)}> 조사해줘`, mentions: { agents: [ID(4)], users: [] }, createdAt: NOW,
  };
  it("사용자 메시지를 파싱하고 attachments 기본값을 채운다", () => {
    const m = Message.parse(base);
    expect(m.attachments).toEqual([]);
    expect(m.components).toBeUndefined();
  });
  it("components가 있으면 스키마로 검증한다", () => {
    expect(Message.safeParse({ ...base, components: { blocks: [{ type: "actions", items: [] }] } }).success).toBe(false);
    expect(Message.safeParse({ ...base, components: { blocks: [{ type: "separator" }] } }).success).toBe(true);
  });
  it("시스템 메시지는 systemMeta를 가진다", () => {
    const m = Message.parse({
      ...base, kind: "system", authorType: "system", authorId: undefined, bodyMd: "릴레이 한도 도달",
      mentions: { agents: [], users: [] },
      systemMeta: { kind: "relay_limit", relay: { fromAgentId: ID(4), toAgentId: ID(5), sourceRunId: ID(6), rootMessageId: ID(7) } },
    });
    expect(m.systemMeta?.kind).toBe("relay_limit");
  });
});

describe("Run", () => {
  it("상태 8종, 트리거 5종", () => {
    expect(RunStatus.options).toEqual(["queued", "streaming", "tool", "awaiting_approval", "finalizing", "done", "error", "aborted"]);
    expect(RunTriggerKind.options).toEqual(["mention", "auto_respond", "relay", "interaction", "continue"]);
  });
  it("hasCanonical 기본값 false", () => {
    const r = Run.parse({
      id: ID(1), channelId: ID(2), agentId: ID(3), triggerKind: "mention", triggerMessageId: ID(4), rootMessageId: ID(4),
      relayDepth: 0, sessionKey: `agent:researcher:dodok:channel:${ID(2)}`, status: "queued", createdAt: NOW,
    });
    expect(r.hasCanonical).toBe(false);
  });
  it("RunState는 요약 키만 가진다", () => {
    expect(Object.keys(RunState.shape).sort()).toEqual(
      ["agentId", "channelId", "endedAt", "error", "finalSource", "hasCanonical", "id", "parentRunId", "relayDepth", "startedAt", "status"].sort(),
    );
  });
});

describe("Approval", () => {
  it("pending 승인을 파싱한다", () => {
    const a = Approval.parse({ id: ID(1), runId: ID(2), providerApprovalId: "ap_1", kind: "exec", summary: "rm -rf build", status: "pending", createdAt: NOW });
    expect(a.status).toBe("pending");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- domain`
Expected: FAIL — `Failed to resolve import "../src/domain"`

- [ ] **Step 3: 구현**

`packages/shared/src/domain/index.ts`:
```ts
import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ComponentsV1 } from "../components";
import { MentionSet } from "../mention"; // MentionSet은 mention.ts가 소유. 루트 index가 export하므로 여기서 재export하지 않는다(export * 충돌 방지).

export const Handle = z.string().regex(/^[a-z0-9_-]{2,32}$/);
export type Handle = z.infer<typeof Handle>;

export const Workspace = z.object({ id: Id, name: z.string().min(1).max(80), createdAt: IsoDateTime });
export type Workspace = z.infer<typeof Workspace>;

export const User = z.object({
  id: Id,
  workspaceId: Id,
  handle: Handle,
  displayName: z.string().min(1).max(80),
  email: z.email().optional(),
  authProvider: z.enum(["local", "email", "oidc"]),
  avatarUrl: z.url().optional(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const MembershipRole = z.enum(["owner", "admin", "member", "guest"]);
export type MembershipRole = z.infer<typeof MembershipRole>;
export const Membership = z.object({ id: Id, workspaceId: Id, userId: Id, role: MembershipRole });
export type Membership = z.infer<typeof Membership>;

export const AgentProvider = z.enum(["openclaw", "claude", "codex", "hermes"]);
export type AgentProvider = z.infer<typeof AgentProvider>;
export const Agent = z.object({
  id: Id,
  workspaceId: Id,
  provider: AgentProvider,
  providerAgentId: z.string().min(1), // OpenClaw agentId
  handle: Handle,
  name: z.string().min(1).max(80),
  avatarUrl: z.url().optional(),
  basePrompt: z.string().max(20_000).optional(),
  enabled: z.boolean(),
  createdAt: IsoDateTime,
});
export type Agent = z.infer<typeof Agent>;

export const RelayPair = z.object({ from: Id, to: Id });
export type RelayPair = z.infer<typeof RelayPair>;
export const RelayPolicy = z.object({
  maxRelayTurns: z.int().min(0).max(32).default(4),
  allowPairs: z.union([z.literal("all"), z.array(RelayPair).max(64)]).default("all"),
  dailyRunLimit: z.int().min(1).optional(),
});
export type RelayPolicy = z.infer<typeof RelayPolicy>;

export const Channel = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(80),
  topic: z.string().max(500).optional(),
  prompt: z.string().max(20_000).optional(),
  relayPolicy: RelayPolicy,
  visibility: z.enum(["public", "private"]),
  createdBy: Id,
  createdAt: IsoDateTime,
});
export type Channel = z.infer<typeof Channel>;

export const ChannelMember = z.object({
  id: Id,
  channelId: Id,
  memberType: z.enum(["user", "agent"]),
  memberId: Id,
  promptOverride: z.string().max(20_000).optional(), // agent만
  autoRespond: z.boolean().default(false), // agent만, 채널당 최대 1
  aliases: z.array(Handle).max(8).default([]), // agent만
  joinedAt: IsoDateTime,
});
export type ChannelMember = z.infer<typeof ChannelMember>;

const AttachmentUrl = z.string().regex(/^(https:\/\/|artifact:\/\/)\S+$/);
export const Attachment = z.object({
  id: Id,
  kind: z.enum(["image", "file"]),
  url: AttachmentUrl,
  name: z.string().max(255),
  mime: z.string().max(127),
  size: z.int().min(0),
  width: z.int().optional(),
  height: z.int().optional(),
  thumbUrl: AttachmentUrl.optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const SystemKind = z.enum(["relay_limit", "relay_denied", "run_error", "info"]);
export type SystemKind = z.infer<typeof SystemKind>;
export const SystemMeta = z.object({
  kind: SystemKind,
  /** relay_limit/relay_denied: 이어가기 대상 */
  relay: z.object({ fromAgentId: Id, toAgentId: Id, sourceRunId: Id, rootMessageId: Id }).optional(),
  runId: Id.optional(),
});
export type SystemMeta = z.infer<typeof SystemMeta>;

export const Message = z.object({
  id: Id,
  channelId: Id,
  seq: z.int().min(1),
  kind: z.enum(["normal", "system"]),
  authorType: z.enum(["user", "agent", "system"]),
  authorId: Id.optional(), // system이면 없음
  bodyMd: z.string().max(100_000),
  mentions: MentionSet,
  attachments: z.array(Attachment).max(10).default([]),
  components: ComponentsV1.optional(),
  systemMeta: SystemMeta.optional(), // kind === "system"일 때
  replyTo: Id.optional(),
  runId: Id.optional(), // agent 메시지: 만들어 낸 런
  clientMsgId: z.string().max(64).optional(), // 사용자 전송 멱등 키
  externalId: z.string().max(128).optional(), // 브리지 outboundId
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.optional(),
});
export type Message = z.infer<typeof Message>;

export const RunStatus = z.enum([
  "queued",
  "streaming",
  "tool",
  "awaiting_approval",
  "finalizing",
  "done",
  "error",
  "aborted",
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const RunTriggerKind = z.enum(["mention", "auto_respond", "relay", "interaction", "continue"]);
export type RunTriggerKind = z.infer<typeof RunTriggerKind>;
export const RunUsage = z.object({
  inputTokens: z.int().optional(),
  outputTokens: z.int().optional(),
  costUsd: z.number().optional(),
  model: z.string().optional(),
});
export type RunUsage = z.infer<typeof RunUsage>;

export const Run = z.object({
  id: Id,
  channelId: Id,
  agentId: Id,
  triggerKind: RunTriggerKind,
  triggerMessageId: Id.optional(), // interaction이면 없음
  triggerInteractionId: Id.optional(),
  rootMessageId: Id, // 릴레이 체인의 루트
  relayDepth: z.int().min(0),
  parentRunId: Id.optional(), // 서브에이전트 자식 런
  sessionKey: z.string(),
  providerRunId: z.string().optional(), // OpenClaw runId
  status: RunStatus,
  hasCanonical: z.boolean().default(false),
  finalSource: z.enum(["plugin", "gateway"]).optional(),
  usage: RunUsage.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
});
export type Run = z.infer<typeof Run>;

/** wire의 run.state에 실리는 요약 */
export const RunState = Run.pick({
  id: true,
  channelId: true,
  agentId: true,
  status: true,
  relayDepth: true,
  parentRunId: true,
  hasCanonical: true,
  finalSource: true,
  error: true,
  startedAt: true,
  endedAt: true,
});
export type RunState = z.infer<typeof RunState>;

export const ComponentInteraction = z.object({
  id: Id,
  messageId: Id,
  componentId: z.string(),
  userId: Id,
  blockId: z.string().optional(),
  itemId: z.string(), // 버튼/셀렉트 id 또는 모달 id
  values: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
  deliveredAt: IsoDateTime.optional(),
});
export type ComponentInteraction = z.infer<typeof ComponentInteraction>;

export const ApprovalKind = z.enum(["exec", "plugin", "generic"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
export const Approval = z.object({
  id: Id,
  runId: Id,
  providerApprovalId: z.string(),
  kind: ApprovalKind,
  summary: z.string().max(4000),
  payload: z.record(z.string(), z.unknown()).optional(),
  status: ApprovalStatus,
  decidedBy: Id.optional(),
  decidedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
});
export type Approval = z.infer<typeof Approval>;

export const PushSubscription = z.object({
  id: Id,
  userId: Id,
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  userAgent: z.string().max(255).optional(),
  createdAt: IsoDateTime,
});
export type PushSubscription = z.infer<typeof PushSubscription>;
```

`packages/shared/src/index.ts`에 추가:
```ts
export * from "./domain";
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 모든 테스트 PASS, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/domain packages/shared/src/index.ts packages/shared/test/domain.test.ts
git commit -m "feat(shared): 도메인 엔티티 Zod 스키마"
```

---

### Task 5: RunEvent 유니온 `events/index.ts`

**Files:**
- Create: `packages/shared/src/events/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/events.test.ts`

**Interfaces:**
- Consumes: `Id`, `IsoDateTime` from `../common`; `ApprovalKind`, `RunState`, `RunUsage` from `../domain`
- Produces: `RunEvent`(Zod discriminatedUnion + type), `RunEventType`(type 문자열 유니온 타입), `RUN_EVENT_TYPES`(문자열 배열)

주의: Zod 4.6에서 `z.unknown()` 속성은 **필수 키**다(키가 없으면 실패). `CUSTOM.value`는 `z.unknown().optional()`로 둔다.

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/shared/test/events.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES, RunEvent } from "../src/events";

const RUN = "01a09fc9-d204-7551-89d6-38544d07a101";
const base = { runId: RUN, seq: 1, ts: "2026-09-14T00:00:00Z" };

describe("RunEvent", () => {
  it("이벤트 종류 목록", () => {
    expect(RUN_EVENT_TYPES).toEqual([
      "RUN_QUEUED", "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "RUN_ABORTED", "STATE_SNAPSHOT",
      "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_REPLACE", "TEXT_MESSAGE_END",
      "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT",
      "STEP_STARTED", "STEP_FINISHED", "SUBAGENT_STARTED", "SUBAGENT_FINISHED", "SUBAGENT_ERROR",
      "APPROVAL_REQUESTED", "APPROVAL_RESOLVED", "CUSTOM",
    ]);
  });

  it.each([
    { type: "RUN_QUEUED" },
    { type: "RUN_STARTED", threadId: "01a09fc9-d204-7551-89d6-38544d07a102", agentId: "01a09fc9-d204-7551-89d6-38544d07a103", sessionKey: "agent:x:dodok:channel:y" },
    { type: "RUN_FINISHED", messageIds: [] },
    { type: "RUN_ERROR", message: "boom" },
    { type: "RUN_ABORTED", by: "user" },
    { type: "TEXT_MESSAGE_START", messageId: "gw-1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "gw-1", delta: "안녕" },
    { type: "TEXT_MESSAGE_REPLACE", messageId: "gw-1", text: "전체" },
    { type: "TEXT_MESSAGE_END", messageId: "gw-1" },
    { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "exec" },
    { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{" },
    { type: "TOOL_CALL_END", toolCallId: "t1" },
    { type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "ok", ok: true, durationMs: 12 },
    { type: "STEP_STARTED", stepName: "compact" },
    { type: "STEP_FINISHED", stepName: "compact" },
    { type: "SUBAGENT_STARTED", subagentRunId: "01a09fc9-d204-7551-89d6-38544d07a104" },
    { type: "SUBAGENT_FINISHED", subagentRunId: "01a09fc9-d204-7551-89d6-38544d07a104" },
    { type: "SUBAGENT_ERROR", subagentRunId: "01a09fc9-d204-7551-89d6-38544d07a104", message: "x" },
    { type: "APPROVAL_REQUESTED", approvalId: "01a09fc9-d204-7551-89d6-38544d07a105", kind: "exec", summary: "rm -rf" },
    { type: "APPROVAL_RESOLVED", approvalId: "01a09fc9-d204-7551-89d6-38544d07a105", decision: "approved" },
    { type: "CUSTOM", name: "openclaw.agent.lifecycle", value: { phase: "start" } },
    { type: "CUSTOM", name: "openclaw.agent.lifecycle" },
  ])("$type 파싱", (payload) => {
    expect(RunEvent.safeParse({ ...base, ...payload }).success).toBe(true);
  });

  it("STATE_SNAPSHOT은 RunState를 담는다", () => {
    const snapshot = { id: RUN, channelId: "01a09fc9-d204-7551-89d6-38544d07a102", agentId: "01a09fc9-d204-7551-89d6-38544d07a103", status: "streaming", relayDepth: 0, hasCanonical: false };
    expect(RunEvent.safeParse({ ...base, type: "STATE_SNAPSHOT", snapshot }).success).toBe(true);
  });

  it("모르는 type, seq 0, 빈 delta는 거부", () => {
    expect(RunEvent.safeParse({ ...base, type: "NOPE" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...base, seq: 0, type: "RUN_QUEUED" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...base, type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- events`
Expected: FAIL — `Failed to resolve import "../src/events"`

- [ ] **Step 3: 구현**

`packages/shared/src/events/index.ts`:
```ts
import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ApprovalKind, RunState, RunUsage } from "../domain";

const base = { runId: Id, seq: z.int().min(1), ts: IsoDateTime };

function ev<T extends string, S extends Record<string, z.ZodType>>(type: T, shape: S) {
  return z.object({ type: z.literal(type), ...base, ...shape });
}

export const RunEvent = z.discriminatedUnion("type", [
  // 런 수명
  ev("RUN_QUEUED", { position: z.int().optional() }), // dodok 확장
  ev("RUN_STARTED", {
    threadId: Id, // channelId
    agentId: Id,
    sessionKey: z.string(),
    providerRunId: z.string().optional(),
  }),
  ev("RUN_FINISHED", { messageIds: z.array(Id), usage: RunUsage.optional(), stopReason: z.string().optional() }),
  ev("RUN_ERROR", {
    message: z.string(),
    code: z.string().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
  ev("RUN_ABORTED", { by: z.enum(["user", "gateway"]) }), // dodok 확장 (타임아웃은 RUN_ERROR code TIMEOUT)
  ev("STATE_SNAPSHOT", { snapshot: RunState }), // 상태 전이마다
  // 텍스트
  ev("TEXT_MESSAGE_START", { messageId: z.string(), role: z.literal("assistant") }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: z.string(), delta: z.string().min(1) }),
  ev("TEXT_MESSAGE_REPLACE", { messageId: z.string(), text: z.string() }), // dodok 확장
  ev("TEXT_MESSAGE_END", { messageId: z.string() }),
  // 툴
  ev("TOOL_CALL_START", {
    toolCallId: z.string(),
    toolCallName: z.string(),
    parentMessageId: z.string().optional(),
  }),
  ev("TOOL_CALL_ARGS", { toolCallId: z.string(), delta: z.string() }),
  ev("TOOL_CALL_END", { toolCallId: z.string() }),
  ev("TOOL_CALL_RESULT", {
    toolCallId: z.string(),
    content: z.string(),
    ok: z.boolean().optional(),
    durationMs: z.int().optional(),
  }),
  // 단계·서브에이전트
  ev("STEP_STARTED", { stepName: z.string() }),
  ev("STEP_FINISHED", { stepName: z.string() }),
  ev("SUBAGENT_STARTED", { subagentRunId: Id, providerRunId: z.string().optional(), label: z.string().optional() }),
  ev("SUBAGENT_FINISHED", { subagentRunId: Id }),
  ev("SUBAGENT_ERROR", { subagentRunId: Id, message: z.string() }),
  // 승인 (dodok 확장)
  ev("APPROVAL_REQUESTED", {
    approvalId: Id,
    kind: ApprovalKind,
    summary: z.string(),
    expiresAt: IsoDateTime.optional(),
  }),
  ev("APPROVAL_RESOLVED", {
    approvalId: Id,
    decision: z.enum(["approved", "denied", "expired"]),
    decidedBy: Id.optional(),
  }),
  // 미분류
  ev("CUSTOM", { name: z.string(), value: z.unknown().optional() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];

export const RUN_EVENT_TYPES = RunEvent.options.map((o) => o.shape.type.value) as RunEventType[];
```

`packages/shared/src/index.ts`에 추가:
```ts
export * from "./events";
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/events packages/shared/src/index.ts packages/shared/test/events.test.ts
git commit -m "feat(shared): RunEvent 유니온 (AG-UI 이름 + dodok 확장)"
```

---

### Task 6: wire 프로토콜 `wire/index.ts`

**Files:**
- Create: `packages/shared/src/wire/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/wire.test.ts`, `packages/shared/test/wire.test-d.ts`

**Interfaces:**
- Consumes: `Ack`, `Id` from `../common`; `AgentProvider`, `Approval`, `Channel`, `ChannelMember`, `Message`, `RunState` from `../domain`; `RunEvent` from `../events`
- Produces: Zod 스키마 `ChannelSubscribe`, `ChannelSubscribeResult`, `MessageSend`, `RunAbort`, `RunEventsReplay`, `RunEventsReplayResult`, `ComponentInteract`, `ApprovalResolve`, `Typing`, `AdapterStatus`(+ 같은 이름 타입), 인터페이스 `ClientToServerEvents`, `ServerToClientEvents`

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/shared/test/wire.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ApprovalResolve, ChannelSubscribe, ComponentInteract, MessageSend, RunEventsReplay } from "../src/wire";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";

describe("wire schemas", () => {
  it("ChannelSubscribe: lastSeq는 선택, 음수 거부", () => {
    expect(ChannelSubscribe.parse({ channelId: ID })).toEqual({ channelId: ID });
    expect(ChannelSubscribe.safeParse({ channelId: ID, lastSeq: -1 }).success).toBe(false);
  });
  it("MessageSend: 빈 본문·긴 clientMsgId 거부", () => {
    expect(MessageSend.safeParse({ channelId: ID, clientMsgId: "c1", bodyMd: "" }).success).toBe(false);
    expect(MessageSend.safeParse({ channelId: ID, clientMsgId: "x".repeat(65), bodyMd: "hi" }).success).toBe(false);
    expect(MessageSend.safeParse({ channelId: ID, clientMsgId: "c1", bodyMd: "hi", attachments: [ID] }).success).toBe(true);
  });
  it("RunEventsReplay: afterSeq 기본값 0", () => {
    expect(RunEventsReplay.parse({ runId: ID })).toEqual({ runId: ID, afterSeq: 0 });
  });
  it("ComponentInteract: values는 객체", () => {
    expect(ComponentInteract.safeParse({ messageId: ID, componentId: "cmp_1", itemId: "go", values: {} }).success).toBe(true);
    expect(ComponentInteract.safeParse({ messageId: ID, componentId: "cmp_1", itemId: "go", values: "x" }).success).toBe(false);
  });
  it("ApprovalResolve: approve|deny만", () => {
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "approve" }).success).toBe(true);
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "maybe" }).success).toBe(false);
  });
});
```

`packages/shared/test/wire.test-d.ts`:
```ts
import { describe, expectTypeOf, it } from "vitest";
import type { Ack } from "../src/common";
import type { Message } from "../src/domain";
import type { ClientToServerEvents, MessageSend, ServerToClientEvents } from "../src/wire";

describe("wire event maps", () => {
  it("클라이언트→서버 이벤트 이름", () => {
    expectTypeOf<keyof ClientToServerEvents>().toEqualTypeOf<
      | "channel.subscribe"
      | "channel.unsubscribe"
      | "message.send"
      | "run.abort"
      | "run.events.replay"
      | "component.interact"
      | "approval.resolve"
      | "typing"
    >();
  });
  it("서버→클라이언트 이벤트 이름", () => {
    expectTypeOf<keyof ServerToClientEvents>().toEqualTypeOf<
      | "message.created"
      | "message.updated"
      | "run.state"
      | "run.event"
      | "approval.requested"
      | "approval.resolved"
      | "channel.updated"
      | "channel.member.changed"
      | "typing"
      | "adapter.status"
      | "system.notice"
    >();
  });
  it("message.send의 페이로드와 ack 타입", () => {
    expectTypeOf<Parameters<ClientToServerEvents["message.send"]>[0]>().toEqualTypeOf<MessageSend>();
    expectTypeOf<Parameters<ClientToServerEvents["message.send"]>[1]>().toEqualTypeOf<Ack<{ message: Message }>>();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- wire`
Expected: FAIL — `Failed to resolve import "../src/wire"` (typecheck도 오류)

- [ ] **Step 3: 구현**

`packages/shared/src/wire/index.ts`:
```ts
import { z } from "zod";
import type { Ack } from "../common";
import { Id } from "../common";
import { AgentProvider, Approval, Channel, ChannelMember, Message, RunState } from "../domain";
import { RunEvent } from "../events";

// ── 클라이언트 → 서버 (ack 있음) ──
export const ChannelSubscribe = z.object({ channelId: Id, lastSeq: z.int().min(0).optional() });
export type ChannelSubscribe = z.infer<typeof ChannelSubscribe>;
export const ChannelSubscribeResult = z.object({
  messages: z.array(Message), // lastSeq 이후, 최대 200개
  hasMore: z.boolean(),
  activeRuns: z.array(RunState), // 종료되지 않은 런
  pendingApprovals: z.array(Approval),
});
export type ChannelSubscribeResult = z.infer<typeof ChannelSubscribeResult>;

export const MessageSend = z.object({
  channelId: Id,
  clientMsgId: z.string().min(1).max(64),
  bodyMd: z.string().min(1).max(100_000), // 토큰 본문
  attachments: z.array(Id).max(10).optional(), // 업로드 API로 먼저 올린 첨부 id
  replyTo: Id.optional(),
});
export type MessageSend = z.infer<typeof MessageSend>;

export const RunAbort = z.object({ runId: Id });
export type RunAbort = z.infer<typeof RunAbort>;

export const RunEventsReplay = z.object({ runId: Id, afterSeq: z.int().min(0).default(0) });
export type RunEventsReplay = z.infer<typeof RunEventsReplay>;
export const RunEventsReplayResult = z.object({ events: z.array(RunEvent), run: RunState });
export type RunEventsReplayResult = z.infer<typeof RunEventsReplayResult>;

export const ComponentInteract = z.object({
  messageId: Id,
  componentId: z.string(),
  blockId: z.string().optional(),
  itemId: z.string(),
  values: z.record(z.string(), z.unknown()),
});
export type ComponentInteract = z.infer<typeof ComponentInteract>;

export const ApprovalResolve = z.object({
  approvalId: Id,
  decision: z.enum(["approve", "deny"]),
  note: z.string().max(500).optional(),
});
export type ApprovalResolve = z.infer<typeof ApprovalResolve>;

export const Typing = z.object({ channelId: Id });
export type Typing = z.infer<typeof Typing>;

export interface ClientToServerEvents {
  "channel.subscribe": (p: ChannelSubscribe, ack: Ack<ChannelSubscribeResult>) => void;
  "channel.unsubscribe": (p: { channelId: Id }, ack: Ack<null>) => void;
  "message.send": (p: MessageSend, ack: Ack<{ message: Message }>) => void;
  "run.abort": (p: RunAbort, ack: Ack<null>) => void;
  "run.events.replay": (p: RunEventsReplay, ack: Ack<RunEventsReplayResult>) => void;
  "component.interact": (p: ComponentInteract, ack: Ack<{ interactionId: Id }>) => void;
  "approval.resolve": (p: ApprovalResolve, ack: Ack<null>) => void;
  typing: (p: Typing) => void; // ack 없음, 클라이언트가 3초 스로틀
}

// ── 서버 → 클라이언트 (룸 channel:<id> 또는 user:<id>) ──
export const AdapterStatus = z.object({
  provider: AgentProvider,
  gateway: z.enum(["connected", "reconnecting", "down"]),
  bridge: z.enum(["connected", "down"]),
});
export type AdapterStatus = z.infer<typeof AdapterStatus>;

export interface ServerToClientEvents {
  "message.created": (p: { message: Message }) => void;
  "message.updated": (p: { message: Message }) => void; // 수정, 컴포넌트 소비/만료
  "run.state": (p: { run: RunState; resync?: boolean }) => void;
  "run.event": (p: { event: RunEvent }) => void;
  "approval.requested": (p: { approval: Approval }) => void;
  "approval.resolved": (p: { approval: Approval }) => void;
  "channel.updated": (p: { channel: Channel }) => void;
  "channel.member.changed": (p: { channelId: Id; members: ChannelMember[] }) => void;
  typing: (p: { channelId: Id; actorType: "user" | "agent"; actorId: Id }) => void;
  "adapter.status": (p: AdapterStatus) => void; // user 룸
  "system.notice": (p: { level: "info" | "warn" | "error"; message: string }) => void;
}
```

`packages/shared/src/index.ts`에 추가:
```ts
export * from "./wire";
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 런타임 테스트와 타입 테스트 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/wire packages/shared/src/index.ts packages/shared/test/wire.test.ts packages/shared/test/wire.test-d.ts
git commit -m "feat(shared): 클라이언트↔서버 wire 이벤트 계약"
```

---

### Task 7: bridge 프로토콜 `bridge/index.ts`

**Files:**
- Create: `packages/shared/src/bridge/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/bridge.test.ts`, `packages/shared/test/bridge.test-d.ts`

**Interfaces:**
- Consumes: `Ack`, `BRIDGE_PROTOCOL`, `Id`, `IsoDateTime` from `../common`; `Attachment` from `../domain`; `ComponentsV1` from `../components`
- Produces: `BridgeHello`, `BridgeHelloResult`, `BridgeCapability`, `InboundAuthor`, `InboundContext`, `InboundDeliver`, `InboundDeliverResult`, `ConfigSet`, `ConfigSetResult`, `OutboundMessage`, `BridgeStatus`(+ 타입), 인터페이스 `BridgeClientToServerEvents`, `BridgeServerToClientEvents`

- [ ] **Step 1: 실패하는 테스트 작성**

`packages/shared/test/bridge.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { BridgeHello, InboundDeliver, OutboundMessage } from "../src/bridge";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T00:00:00Z";

describe("bridge schemas", () => {
  it("BridgeHello: pluginId는 dodok 고정, capability는 닫힌 목록", () => {
    expect(BridgeHello.safeParse({ pluginId: "dodok", version: "0.1.0", sdkVersion: "2026.9.4", capabilities: ["config.set"] }).success).toBe(true);
    expect(BridgeHello.safeParse({ pluginId: "other", version: "0.1.0", sdkVersion: "2026.9.4", capabilities: [] }).success).toBe(false);
    expect(BridgeHello.safeParse({ pluginId: "dodok", version: "0.1.0", sdkVersion: "2026.9.4", capabilities: ["nope"] }).success).toBe(false);
  });

  it("InboundDeliver: 컨텍스트 최근 메시지 최대 20개, options 기본값 {}", () => {
    const msg = (i: number) => ({ author: { type: "user", handle: "jang", displayName: "장" }, text: `m${i}`, ts: NOW });
    const deliver = (n: number) => ({
      deliveryId: ID(1), kind: "message", channelId: ID(2), agentId: "researcher",
      sessionKey: `agent:researcher:dodok:channel:${ID(2)}`, runId: ID(3),
      message: { id: ID(4), author: { type: "user", handle: "jang", displayName: "장" }, text: "@researcher 조사", attachments: [], ts: NOW },
      context: { recentMessages: Array.from({ length: n }, (_, i) => msg(i)), participants: [], relayRules: "최대 4턴" },
    });
    const ok = InboundDeliver.parse(deliver(20));
    expect(ok.options).toEqual({});
    expect(InboundDeliver.safeParse(deliver(21)).success).toBe(false);
  });

  it("OutboundMessage: attachments 기본값 [], components는 스키마 검증", () => {
    const base = { outboundId: "ob-1", channelId: ID(2), agentId: "researcher", sessionKey: "k", text: "@jang 결과입니다", ts: NOW };
    expect(OutboundMessage.parse(base).attachments).toEqual([]);
    expect(OutboundMessage.safeParse({ ...base, components: { blocks: [{ type: "actions", items: [] }] } }).success).toBe(false);
  });
});
```

`packages/shared/test/bridge.test-d.ts`:
```ts
import { describe, expectTypeOf, it } from "vitest";
import type { Ack } from "../src/common";
import type { BridgeClientToServerEvents, BridgeServerToClientEvents, InboundDeliver, InboundDeliverResult } from "../src/bridge";

describe("bridge event maps", () => {
  it("이벤트 이름", () => {
    expectTypeOf<keyof BridgeClientToServerEvents>().toEqualTypeOf<"hello" | "outbound.message" | "outbound.typing" | "status">();
    expectTypeOf<keyof BridgeServerToClientEvents>().toEqualTypeOf<"inbound.deliver" | "config.set" | "agents.list" | "system.notice">();
  });
  it("inbound.deliver 페이로드와 ack", () => {
    expectTypeOf<Parameters<BridgeServerToClientEvents["inbound.deliver"]>[0]>().toEqualTypeOf<InboundDeliver>();
    expectTypeOf<Parameters<BridgeServerToClientEvents["inbound.deliver"]>[1]>().toEqualTypeOf<Ack<InboundDeliverResult>>();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/shared test -- bridge`
Expected: FAIL — `Failed to resolve import "../src/bridge"`

- [ ] **Step 3: 구현**

`packages/shared/src/bridge/index.ts`:
```ts
import { z } from "zod";
import type { Ack } from "../common";
import { BRIDGE_PROTOCOL, Id, IsoDateTime } from "../common";
import { ComponentsV1 } from "../components";
import { Attachment } from "../domain";

export const BridgeCapability = z.enum(["agents.list", "config.set", "typing", "run_id_in_outbound"]);
export type BridgeCapability = z.infer<typeof BridgeCapability>;

export const BridgeHello = z.object({
  pluginId: z.literal("dodok"),
  version: z.string(), // 플러그인 패키지 버전
  sdkVersion: z.string(), // openclaw 패키지 버전
  gatewayVersion: z.string().optional(),
  capabilities: z.array(BridgeCapability),
});
export type BridgeHello = z.infer<typeof BridgeHello>;
export const BridgeHelloResult = z.object({ serverVersion: z.string(), protocol: z.literal(BRIDGE_PROTOCOL) });
export type BridgeHelloResult = z.infer<typeof BridgeHelloResult>;

export const InboundAuthor = z.object({
  type: z.enum(["user", "agent", "system"]),
  handle: z.string(),
  displayName: z.string(),
});
export type InboundAuthor = z.infer<typeof InboundAuthor>;

export const InboundContext = z.object({
  recentMessages: z.array(z.object({ author: InboundAuthor, text: z.string(), ts: IsoDateTime })).max(20),
  participants: z.array(
    z.object({ type: z.enum(["user", "agent"]), handle: z.string(), displayName: z.string(), isSelf: z.boolean() }),
  ),
  relayRules: z.string(), // 사람이 읽는 한 문단
  channelPrompt: z.string().optional(),
  promptOverride: z.string().optional(),
});
export type InboundContext = z.infer<typeof InboundContext>;

export const InboundDeliver = z.object({
  deliveryId: Id,
  kind: z.enum(["message", "interaction", "continue"]),
  channelId: Id,
  agentId: z.string(), // providerAgentId (OpenClaw agentId)
  sessionKey: z.string(), // agent:<agentId>:dodok:channel:<channelId>
  runId: Id, // 우리 런 id
  message: z.object({
    id: Id,
    author: InboundAuthor,
    text: z.string(), // renderForAgent 결과 (@handle 평문)
    attachments: z.array(Attachment).max(10),
    ts: IsoDateTime,
  }),
  context: InboundContext,
  options: z.object({ queueMode: z.enum(["steer", "followup", "collect", "interrupt"]).optional() }).default({}),
});
export type InboundDeliver = z.infer<typeof InboundDeliver>;
export const InboundDeliverResult = z.object({ providerRunId: z.string().optional() });
export type InboundDeliverResult = z.infer<typeof InboundDeliverResult>;

export const ConfigSet = z.object({
  channelId: Id,
  config: z.object({ requireMention: z.boolean().optional(), systemPrompt: z.string().optional() }),
});
export type ConfigSet = z.infer<typeof ConfigSet>;
export const ConfigSetResult = z.object({ applied: z.enum(["live", "restart_required"]) });
export type ConfigSetResult = z.infer<typeof ConfigSetResult>;

export const OutboundMessage = z.object({
  outboundId: z.string().min(1).max(128), // 중복 제거 키 (messages.external_id)
  channelId: Id,
  agentId: z.string(), // providerAgentId
  sessionKey: z.string(),
  runId: Id.optional(), // 인바운드에서 받은 우리 런 id
  providerRunId: z.string().optional(),
  replyToInboundId: Id.optional(), // InboundDeliver.message.id
  text: z.string().max(100_000), // 평문 (@handle) — 서버가 tokenize
  components: ComponentsV1.optional(),
  attachments: z.array(Attachment).max(10).default([]),
  ts: IsoDateTime,
});
export type OutboundMessage = z.infer<typeof OutboundMessage>;

export const BridgeStatus = z.object({
  gateway: z.enum(["connected", "reconnecting", "down"]),
  queueDepth: z.int().min(0),
});
export type BridgeStatus = z.infer<typeof BridgeStatus>;

export interface BridgeClientToServerEvents {
  // 플러그인 → 서버
  hello: (p: BridgeHello, ack: Ack<BridgeHelloResult>) => void;
  "outbound.message": (p: OutboundMessage, ack: Ack<{ messageId: Id }>) => void;
  "outbound.typing": (p: { channelId: Id; agentId: string }) => void;
  status: (p: BridgeStatus) => void;
}
export interface BridgeServerToClientEvents {
  // 서버 → 플러그인
  "inbound.deliver": (p: InboundDeliver, ack: Ack<InboundDeliverResult>) => void;
  "config.set": (p: ConfigSet, ack: Ack<ConfigSetResult>) => void;
  "agents.list": (p: Record<string, never>, ack: Ack<{ agents: Array<{ agentId: string; name?: string }> }>) => void;
  "system.notice": (p: { reason: "replaced" | "shutdown"; message: string }) => void;
}
```

`packages/shared/src/index.ts` 최종 형태:
```ts
export * from "./common";
export * from "./mention";
export * from "./components";
export * from "./domain";
export * from "./events";
export * from "./wire";
export * from "./bridge";
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/shared test && pnpm -F @dodok/shared typecheck && pnpm lint`
Expected: 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/bridge packages/shared/src/index.ts packages/shared/test/bridge.test.ts packages/shared/test/bridge.test-d.ts
git commit -m "feat(shared): 플러그인↔서버 bridge 이벤트 계약"
```

---

### Task 8: `apps/server` 골격 + Drizzle SQLite 스키마 + 마이그레이션

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/drizzle.config.ts`
- Create: `apps/server/src/db/schema.sqlite.ts`, `apps/server/src/db/client.ts`
- Create (생성물): `apps/server/drizzle/0000_*.sql`, `apps/server/drizzle/meta/*` — `drizzle-kit generate`가 만든다. 커밋 대상.
- Test: `apps/server/test/db.test.ts`

**Interfaces:**
- Consumes: 타입 `Attachment`, `ComponentsV1`, `ComponentState`, `MentionSet`, `RelayPolicy`, `RunEvent`, `RunUsage`, `SystemMeta` from `@dodok/shared`
- Produces: 테이블 `workspaces users memberships agents channels channelMembers messages runs runEvents componentInteractions approvals pushSubscriptions`; `createDb(file: string): Db`(연결 + 마이그레이션 + WAL + foreign_keys ON); 타입 `Db`, `DbOrTx`

- [ ] **Step 1: 패키지 파일 작성**

`apps/server/package.json`:
```json
{
  "name": "@dodok/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@dodok/shared": "workspace:*",
    "better-sqlite3": "13.0.3",
    "drizzle-orm": "0.45.2",
    "uuid": "14.0.2",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "^22.19.0",
    "drizzle-kit": "0.31.10",
    "tsx": "4.23.13",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "drizzle.config.ts"]
}
```

`apps/server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`apps/server/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.sqlite.ts",
  out: "./drizzle",
  dbCredentials: { url: "./data/app.db" },
});
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/server/test/db.test.ts`:
```ts
import { sql } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { type Db, createDb } from "../src/db/client";
import { channels, messages, users, workspaces } from "../src/db/schema.sqlite";

function seed(db: Db) {
  const ws = uuid();
  const user = uuid();
  const ch = uuid();
  db.insert(workspaces).values({ id: ws, name: "w", createdAt: new Date() }).run();
  db.insert(users).values({ id: user, workspaceId: ws, handle: "jang", displayName: "장", authProvider: "local", createdAt: new Date() }).run();
  db.insert(channels).values({
    id: ch, workspaceId: ws, name: "general", relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
    visibility: "public", createdBy: user, createdAt: new Date(),
  }).run();
  return { ws, user, ch };
}

const msg = (ch: string, seq: number, extra: Partial<typeof messages.$inferInsert> = {}) => ({
  id: uuid(), channelId: ch, seq, kind: "normal", authorType: "user", bodyMd: "hi",
  mentions: { agents: [], users: [] }, createdAt: new Date(), ...extra,
});

describe("db", () => {
  it("마이그레이션이 12개 테이블을 만든다", () => {
    const db = createDb(":memory:");
    const rows = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
    const names = rows.map((r) => r.name).filter((n) => !n.startsWith("__") && !n.startsWith("sqlite_")).sort();
    expect(names).toEqual([
      "agents", "approvals", "channel_members", "channels", "component_interactions", "memberships",
      "messages", "push_subscriptions", "run_events", "runs", "users", "workspaces",
    ]);
  });

  it("messages (channel_id, seq)는 UNIQUE", () => {
    const db = createDb(":memory:");
    const { ch } = seed(db);
    db.insert(messages).values(msg(ch, 1)).run();
    expect(() => db.insert(messages).values(msg(ch, 1)).run()).toThrow(/UNIQUE/);
  });

  it("client_msg_id: NULL은 여러 개, 같은 (author_id, client_msg_id)는 거부", () => {
    const db = createDb(":memory:");
    const { ch, user } = seed(db);
    db.insert(messages).values(msg(ch, 1)).run();
    db.insert(messages).values(msg(ch, 2)).run();
    db.insert(messages).values(msg(ch, 3, { authorId: user, clientMsgId: "c1" })).run();
    expect(() => db.insert(messages).values(msg(ch, 4, { authorId: user, clientMsgId: "c1" })).run()).toThrow(/UNIQUE/);
  });

  it("JSON·timestamp 컬럼이 왕복한다", () => {
    const db = createDb(":memory:");
    const { ch } = seed(db);
    const row = db.select().from(channels).get();
    expect(row?.id).toBe(ch);
    expect(row?.relayPolicy).toEqual({ maxRelayTurns: 4, allowPairs: "all" });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.lastSeq).toBe(0);
  });

  it("foreign_keys ON: 없는 채널에 메시지 삽입 거부", () => {
    const db = createDb(":memory:");
    seed(db);
    expect(() => db.insert(messages).values(msg(uuid(), 1)).run()).toThrow(/FOREIGN KEY/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm install && pnpm -F @dodok/server test`
Expected: FAIL — `Failed to resolve import "../src/db/client"`

- [ ] **Step 4: 스키마 구현**

`apps/server/src/db/schema.sqlite.ts`:
```ts
import type {
  Attachment,
  ComponentState,
  ComponentsV1,
  MentionSet,
  RelayPolicy,
  RunEvent,
  RunUsage,
  SystemMeta,
} from "@dodok/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    authProvider: text("auth_provider").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_ws_handle").on(t.workspaceId, t.handle)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role").notNull(),
  },
  (t) => [uniqueIndex("memberships_ws_user").on(t.workspaceId, t.userId)],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    provider: text("provider").notNull(),
    providerAgentId: text("provider_agent_id").notNull(),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    basePrompt: text("base_prompt"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("agents_ws_handle").on(t.workspaceId, t.handle),
    uniqueIndex("agents_ws_provider_agent").on(t.workspaceId, t.provider, t.providerAgentId),
  ],
);

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  topic: text("topic"),
  prompt: text("prompt"),
  relayPolicy: json<RelayPolicy>("relay_policy_json").notNull(),
  visibility: text("visibility").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id),
  lastSeq: integer("last_seq").notNull().default(0), // 메시지 seq 카운터
  createdAt: ts("created_at").notNull(),
});

export const channelMembers = sqliteTable(
  "channel_members",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull().references(() => channels.id),
    memberType: text("member_type").notNull(),
    memberId: text("member_id").notNull(),
    promptOverride: text("prompt_override"),
    autoRespond: integer("auto_respond", { mode: "boolean" }).notNull().default(false),
    aliases: json<string[]>("aliases_json").notNull().default([]),
    joinedAt: ts("joined_at").notNull(),
  },
  (t) => [uniqueIndex("channel_members_unique").on(t.channelId, t.memberType, t.memberId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull().references(() => channels.id),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    authorType: text("author_type").notNull(),
    authorId: text("author_id"),
    bodyMd: text("body_md").notNull(),
    mentions: json<MentionSet>("mentions_json").notNull(),
    attachments: json<Attachment[]>("attachments_json").notNull().default([]),
    components: json<ComponentsV1>("components_json"),
    componentState: json<ComponentState>("component_state_json"),
    systemMeta: json<SystemMeta>("system_meta_json"),
    replyTo: text("reply_to"),
    runId: text("run_id"),
    clientMsgId: text("client_msg_id"),
    externalId: text("external_id"),
    createdAt: ts("created_at").notNull(),
    editedAt: ts("edited_at"),
  },
  (t) => [
    uniqueIndex("messages_channel_seq").on(t.channelId, t.seq),
    uniqueIndex("messages_author_client_msg").on(t.authorId, t.clientMsgId),
    uniqueIndex("messages_external_id").on(t.externalId),
    index("messages_run").on(t.runId),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull().references(() => channels.id),
    agentId: text("agent_id").notNull().references(() => agents.id),
    triggerKind: text("trigger_kind").notNull(),
    triggerMessageId: text("trigger_message_id"),
    triggerInteractionId: text("trigger_interaction_id"),
    rootMessageId: text("root_message_id").notNull(),
    relayDepth: integer("relay_depth").notNull().default(0),
    parentRunId: text("parent_run_id"),
    sessionKey: text("session_key").notNull(),
    providerRunId: text("provider_run_id"),
    status: text("status").notNull(),
    hasCanonical: integer("has_canonical", { mode: "boolean" }).notNull().default(false),
    finalSource: text("final_source"),
    usage: json<RunUsage>("usage_json"),
    error: json<{ code: string; message: string }>("error_json"),
    relayHash: text("relay_hash"), // hash(from, to, 정규화 본문)
    createdAt: ts("created_at").notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
  },
  (t) => [
    uniqueIndex("runs_provider_run").on(t.providerRunId),
    index("runs_channel_created").on(t.channelId, t.createdAt),
    index("runs_root").on(t.rootMessageId),
    index("runs_session_status").on(t.sessionKey, t.status),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: json<RunEvent>("payload_json").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("run_events_run_seq").on(t.runId, t.seq)],
);

export const componentInteractions = sqliteTable(
  "component_interactions",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull().references(() => messages.id),
    componentId: text("component_id").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    blockId: text("block_id"),
    itemId: text("item_id").notNull(),
    values: json<Record<string, unknown>>("values_json").notNull(),
    createdAt: ts("created_at").notNull(),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [index("component_interactions_message").on(t.messageId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    providerApprovalId: text("provider_approval_id").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    payload: json<Record<string, unknown>>("payload_json"),
    status: text("status").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("approvals_provider").on(t.providerApprovalId)],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    endpoint: text("endpoint").notNull(),
    keys: json<{ p256dh: string; auth: string }>("keys_json").notNull(),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint").on(t.endpoint)],
);
```

- [ ] **Step 5: 마이그레이션 생성**

Run: `pnpm -F @dodok/server db:generate`
Expected: `apps/server/drizzle/0000_<이름>.sql`과 `drizzle/meta/_journal.json`, `0000_snapshot.json` 생성. 출력에 `12 tables`.

- [ ] **Step 6: 클라이언트 구현**

`apps/server/src/db/client.ts`:
```ts
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.sqlite";

/** 파일 경로 또는 ":memory:". 연결 후 마이그레이션까지 적용한다. */
export function createDb(file: string) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}

export type Db = ReturnType<typeof createDb>;
/** 트랜잭션 안팎 어디서나 쓰는 쿼리 함수의 첫 인자 타입 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
```

- [ ] **Step 7: 통과 확인**

Run: `pnpm -F @dodok/server test && pnpm -F @dodok/server typecheck && pnpm lint`
Expected: 5 tests PASS. (`db.all` 제네릭이 타입 오류를 내면 `db.all(sql\`...\`) as Array<{ name: string }>`로 바꾼다.)

- [ ] **Step 8: 커밋**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): Drizzle SQLite 스키마, 마이그레이션, DB 클라이언트"
```

---

### Task 9: 메시지 seq 발급 `allocateSeq`

**Files:**
- Create: `apps/server/src/modules/messages/seq.ts`
- Test: `apps/server/test/messages.seq.test.ts`

**Interfaces:**
- Consumes: `channels` 테이블, `DbOrTx` from `../../db/client`
- Produces: `allocateSeq(db: DbOrTx, channelId: string): number` — 같은 트랜잭션 안에서 호출하면 INSERT와 원자적

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/messages.seq.test.ts`:
```ts
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client";
import { channels, messages, users, workspaces } from "../src/db/schema.sqlite";
import { allocateSeq } from "../src/modules/messages/seq";

function seed() {
  const db = createDb(":memory:");
  const ws = uuid();
  const user = uuid();
  const ch = uuid();
  db.insert(workspaces).values({ id: ws, name: "w", createdAt: new Date() }).run();
  db.insert(users).values({ id: user, workspaceId: ws, handle: "jang", displayName: "장", authProvider: "local", createdAt: new Date() }).run();
  db.insert(channels).values({ id: ch, workspaceId: ws, name: "g", relayPolicy: { maxRelayTurns: 4, allowPairs: "all" }, visibility: "public", createdBy: user, createdAt: new Date() }).run();
  return { db, ch };
}

describe("allocateSeq", () => {
  it("1부터 연속으로 발급하고 INSERT와 함께 쓰인다", () => {
    const { db, ch } = seed();
    const seqs: number[] = [];
    for (let i = 0; i < 100; i++) {
      db.transaction((tx) => {
        const seq = allocateSeq(tx, ch);
        tx.insert(messages).values({ id: uuid(), channelId: ch, seq, kind: "normal", authorType: "user", bodyMd: "m", mentions: { agents: [], users: [] }, createdAt: new Date() }).run();
        seqs.push(seq);
      });
    }
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("롤백된 트랜잭션은 seq를 소비하지 않는다", () => {
    const { db, ch } = seed();
    expect(() =>
      db.transaction((tx) => {
        allocateSeq(tx, ch);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(allocateSeq(db, ch)).toBe(1);
  });

  it("없는 채널이면 throw", () => {
    const { db } = seed();
    expect(() => allocateSeq(db, uuid())).toThrow(/channel not found/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/server test -- seq`
Expected: FAIL — `Failed to resolve import "../src/modules/messages/seq"`

- [ ] **Step 3: 구현**

`apps/server/src/modules/messages/seq.ts`:
```ts
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { channels } from "../../db/schema.sqlite";

/**
 * 채널의 다음 메시지 seq를 발급한다. UPDATE ... RETURNING 이므로 호출한 트랜잭션이
 * 롤백되면 카운터도 되돌아간다. 메시지 INSERT와 같은 트랜잭션에서 호출할 것.
 */
export function allocateSeq(db: DbOrTx, channelId: string): number {
  const row = db
    .update(channels)
    .set({ lastSeq: sql`${channels.lastSeq} + 1` })
    .where(eq(channels.id, channelId))
    .returning({ seq: channels.lastSeq })
    .get();
  if (!row) throw new Error(`channel not found: ${channelId}`);
  return row.seq;
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/server test && pnpm -F @dodok/server typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/server/src/modules/messages/seq.ts apps/server/test/messages.seq.test.ts
git commit -m "feat(server): 채널별 메시지 seq 발급"
```

---

### Task 10: 런 상태머신 `transition`

**Files:**
- Create: `apps/server/src/modules/runs/machine.ts`
- Test: `apps/server/test/runs.machine.test.ts`

**Interfaces:**
- Consumes: 타입 `Run`, `RunStatus` from `@dodok/shared`
- Produces: `RunSignal`(유니온 타입), `RunPatch`, `Transition`, `TERMINAL_STATUSES`, `transition(run: Pick<Run, "status" | "hasCanonical">, s: RunSignal): Transition` — 순수 함수, 시각(`startedAt`/`endedAt`)은 호출자가 채운다

- [ ] **Step 1: 실패하는 테스트 작성 (스펙 5.1 전이 표의 모든 칸)**

`apps/server/test/runs.machine.test.ts`:
```ts
import type { RunStatus } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { type RunPatch, type RunSignal, TERMINAL_STATUSES, transition } from "../src/modules/runs/machine";

type Case = [status: RunStatus, hasCanonical: boolean, signal: RunSignal, next: RunStatus | null, patch?: RunPatch];

const cases: Case[] = [
  // gateway_started / text_delta
  ["queued", false, { kind: "gateway_started" }, "streaming"],
  ["queued", false, { kind: "text_delta" }, "streaming"],
  ["streaming", false, { kind: "text_delta" }, "streaming"],
  ["tool", false, { kind: "text_delta" }, "tool"],
  ["awaiting_approval", false, { kind: "text_delta" }, null],
  ["finalizing", false, { kind: "text_delta" }, null],
  // tool_start
  ["queued", false, { kind: "tool_start" }, "tool"],
  ["streaming", false, { kind: "tool_start" }, "tool"],
  ["tool", false, { kind: "tool_start" }, "tool"],
  ["awaiting_approval", false, { kind: "tool_start" }, null],
  ["finalizing", false, { kind: "tool_start" }, null],
  // tool_end
  ["tool", false, { kind: "tool_end", openTools: 0 }, "streaming"],
  ["tool", false, { kind: "tool_end", openTools: 1 }, "tool"],
  ["streaming", false, { kind: "tool_end", openTools: 0 }, null],
  // approval
  ["queued", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["streaming", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["tool", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["finalizing", false, { kind: "approval_requested" }, null],
  ["awaiting_approval", false, { kind: "approval_resolved" }, "streaming"],
  ["streaming", false, { kind: "approval_resolved" }, null],
  // gateway_final
  ["queued", false, { kind: "gateway_final" }, "finalizing"],
  ["streaming", false, { kind: "gateway_final" }, "finalizing"],
  ["streaming", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["tool", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["awaiting_approval", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["finalizing", false, { kind: "gateway_final" }, null],
  // canonical_received
  ["queued", false, { kind: "canonical_received" }, "queued", { hasCanonical: true }],
  ["streaming", false, { kind: "canonical_received" }, "streaming", { hasCanonical: true }],
  ["tool", false, { kind: "canonical_received" }, "tool", { hasCanonical: true }],
  ["awaiting_approval", false, { kind: "canonical_received" }, "awaiting_approval", { hasCanonical: true }],
  ["finalizing", false, { kind: "canonical_received" }, "done", { hasCanonical: true, finalSource: "plugin" }],
  // final_timeout
  ["finalizing", false, { kind: "final_timeout" }, "done", { finalSource: "gateway" }],
  ["streaming", false, { kind: "final_timeout" }, null],
  // errors
  ["streaming", false, { kind: "gateway_error", code: "provider", message: "x" }, "error", { error: { code: "provider", message: "x" } }],
  ["finalizing", false, { kind: "gateway_error", code: "provider", message: "x" }, "error", { error: { code: "provider", message: "x" } }],
  ["queued", false, { kind: "queue_timeout" }, "error", { error: { code: "TIMEOUT", message: "queued timeout" } }],
  ["streaming", false, { kind: "queue_timeout" }, null],
  ["tool", false, { kind: "run_timeout" }, "error", { error: { code: "TIMEOUT", message: "run timeout" } }],
  ["finalizing", false, { kind: "run_timeout" }, "error", { error: { code: "TIMEOUT", message: "run timeout" } }],
  // abort
  ["queued", false, { kind: "abort_requested" }, "aborted"],
  ["streaming", false, { kind: "abort_requested" }, "aborted"],
  ["finalizing", false, { kind: "gateway_aborted" }, "aborted"],
  // terminal: 모두 무시
  ["done", false, { kind: "text_delta" }, null],
  ["done", false, { kind: "canonical_received" }, null],
  ["error", false, { kind: "gateway_final" }, null],
  ["aborted", false, { kind: "gateway_error", code: "x", message: "y" }, null],
];

describe("transition", () => {
  it.each(cases)("%s (hasCanonical=%s) + %o → %s", (status, hasCanonical, signal, next, patch) => {
    const t = transition({ status, hasCanonical }, signal);
    if (next === null) {
      expect(t).toEqual({ next: null, reason: "ignored" });
    } else {
      expect(t.next).toBe(next);
      if (t.next !== null) expect(t.patch).toEqual(patch ?? {});
    }
  });

  it("종료 상태 집합", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["aborted", "done", "error"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/server test -- machine`
Expected: FAIL — `Failed to resolve import "../src/modules/runs/machine"`

- [ ] **Step 3: 구현**

`apps/server/src/modules/runs/machine.ts`:
```ts
import type { Run, RunStatus } from "@dodok/shared";

export type RunSignal =
  | { kind: "gateway_started" } // chat.send 응답 runStarted 또는 첫 agent 이벤트
  | { kind: "text_delta" }
  | { kind: "tool_start" }
  | { kind: "tool_end"; openTools: number }
  | { kind: "approval_requested" }
  | { kind: "approval_resolved" }
  | { kind: "gateway_final" } // chat state: final
  | { kind: "canonical_received" } // 브리지 outbound.message 도착
  | { kind: "final_timeout" } // finalizing 상한(기본 10s)
  | { kind: "gateway_error"; code: string; message: string }
  | { kind: "gateway_aborted" }
  | { kind: "abort_requested" }
  | { kind: "queue_timeout" }
  | { kind: "run_timeout" };

export type RunPatch = Partial<Pick<Run, "hasCanonical" | "finalSource" | "error">>;

export type Transition = { next: RunStatus; patch: RunPatch } | { next: null; reason: "ignored" | "invalid" };

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "error", "aborted"]);
const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>(["queued", "streaming", "tool", "awaiting_approval"]);
const IGNORED: Transition = { next: null, reason: "ignored" };

function go(next: RunStatus, patch: RunPatch = {}): Transition {
  return { next, patch };
}

/**
 * 스펙 5.1 전이 표. 순수 함수 — 시각(startedAt/endedAt)과 저장은 호출자가 처리한다.
 * 표에 없는 조합은 ignored.
 */
export function transition(run: Pick<Run, "status" | "hasCanonical">, s: RunSignal): Transition {
  const st = run.status;
  if (TERMINAL_STATUSES.has(st)) return IGNORED;

  switch (s.kind) {
    case "gateway_started":
    case "text_delta":
      if (st === "queued" || st === "streaming") return go("streaming");
      if (st === "tool") return go("tool");
      return IGNORED;
    case "tool_start":
      if (st === "queued" || st === "streaming" || st === "tool") return go("tool");
      return IGNORED;
    case "tool_end":
      if (st !== "tool") return IGNORED;
      return s.openTools === 0 ? go("streaming") : go("tool");
    case "approval_requested":
      if (st === "queued" || st === "streaming" || st === "tool") return go("awaiting_approval");
      return IGNORED;
    case "approval_resolved":
      return st === "awaiting_approval" ? go("streaming") : IGNORED;
    case "gateway_final":
      if (!ACTIVE.has(st)) return IGNORED;
      return run.hasCanonical ? go("done", { finalSource: "plugin" }) : go("finalizing");
    case "canonical_received":
      if (ACTIVE.has(st)) return go(st, { hasCanonical: true });
      if (st === "finalizing") return go("done", { hasCanonical: true, finalSource: "plugin" });
      return IGNORED;
    case "final_timeout":
      return st === "finalizing" ? go("done", { finalSource: "gateway" }) : IGNORED;
    case "gateway_error":
      return go("error", { error: { code: s.code, message: s.message } });
    case "queue_timeout":
      return st === "queued" ? go("error", { error: { code: "TIMEOUT", message: "queued timeout" } }) : IGNORED;
    case "run_timeout":
      return go("error", { error: { code: "TIMEOUT", message: "run timeout" } });
    case "gateway_aborted":
    case "abort_requested":
      return go("aborted");
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/server test && pnpm -F @dodok/server typecheck && pnpm lint`
Expected: 표의 46개 케이스 + 종료 상태 집합 테스트 모두 PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/server/src/modules/runs/machine.ts apps/server/test/runs.machine.test.ts
git commit -m "feat(server): 런 상태머신 transition"
```

---

### Task 11: 라우터 `decideRuns`

**Files:**
- Create: `apps/server/src/modules/router/decide.ts`
- Test: `apps/server/test/router.decide.test.ts`

**Interfaces:**
- Consumes: 타입 `Agent`, `Channel`, `ChannelMember`, `Message`, `Run`, `RunTriggerKind` from `@dodok/shared`; `node:crypto`
- Produces: `RoutingInput`, `RunPlan`, `Blocked`, `BlockedReason`, `decideRuns(input): { runs; blocked }`, `normalizeForHash(bodyMd): string`, `computeRelayHash(from, to, bodyMd): string`

해석 메모(스펙 5.2): 사람 메시지가 비활성/비소속 에이전트를 멘션하면 **조용히 제외**한다(UI가 표시). 에이전트 메시지의 경우 `disabled`를 `blocked` 사유로 돌려줘 시스템 메시지로 알린다. 일일 상한은 이번 결정에서 이미 계획된 런까지 세어 검사한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/router.decide.test.ts`:
```ts
import type { Agent, Channel, ChannelMember, Message, Run } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { type RoutingInput, computeRelayHash, decideRuns, normalizeForHash } from "../src/modules/router/decide";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T09:00:00+09:00";
const WS = ID(0);
const CH = ID(1);
const USER = ID(2);
const A = ID(10);
const B = ID(11);
const C = ID(12);

const agent = (id: string, handle: string, enabled = true): Agent => ({
  id, workspaceId: WS, provider: "openclaw", providerAgentId: handle, handle, name: handle, enabled, createdAt: NOW,
});
const member = (memberId: string, extra: Partial<ChannelMember> = {}): ChannelMember => ({
  id: ID(20), channelId: CH, memberType: "agent", memberId, autoRespond: false, aliases: [], joinedAt: NOW, ...extra,
});
const channel = (relayPolicy: Partial<Channel["relayPolicy"]> = {}): Channel => ({
  id: CH, workspaceId: WS, name: "g", relayPolicy: { maxRelayTurns: 4, allowPairs: "all", ...relayPolicy },
  visibility: "public", createdBy: USER, createdAt: NOW,
});
const userMsg = (agents: string[], bodyMd = "hi"): Message => ({
  id: ID(30), channelId: CH, seq: 1, kind: "normal", authorType: "user", authorId: USER, bodyMd,
  mentions: { agents, users: [] }, attachments: [], createdAt: NOW,
});
const agentMsg = (author: string, agents: string[], bodyMd = "reply"): Message => ({
  id: ID(31), channelId: CH, seq: 2, kind: "normal", authorType: "agent", authorId: author, bodyMd,
  mentions: { agents, users: [] }, attachments: [], runId: ID(40), createdAt: NOW,
});
const run = (agentId: string, relayDepth: number): Run => ({
  id: ID(40), channelId: CH, agentId, triggerKind: "mention", triggerMessageId: ID(30), rootMessageId: ID(30),
  relayDepth, sessionKey: "k", status: "done", hasCanonical: true, createdAt: NOW,
});
const input = (partial: Partial<RoutingInput>): RoutingInput => ({
  message: userMsg([]), channel: channel(), members: [member(A), member(B)], agents: [agent(A, "a"), agent(B, "b")],
  chainHashes: new Set(), todayRunCount: 0, now: new Date(NOW), ...partial,
});

describe("decideRuns — 사람 메시지", () => {
  it("멘션된 활성 에이전트마다 mention 런, depth 0, root = 메시지", () => {
    const r = decideRuns(input({ message: userMsg([A, B]) }));
    expect(r.blocked).toEqual([]);
    expect(r.runs).toEqual([
      { agentId: A, triggerKind: "mention", rootMessageId: ID(30), relayDepth: 0 },
      { agentId: B, triggerKind: "mention", rootMessageId: ID(30), relayDepth: 0 },
    ]);
  });
  it("비활성·비소속 에이전트는 조용히 제외", () => {
    const r = decideRuns(input({ message: userMsg([A, B, C]), agents: [agent(A, "a", false), agent(B, "b"), agent(C, "c")] }));
    expect(r.runs.map((x) => x.agentId)).toEqual([B]);
  });
  it("중복 멘션은 한 번만", () => {
    expect(decideRuns(input({ message: userMsg([A, A]) })).runs).toHaveLength(1);
  });
  it("멘션 없음 → autoRespond 에이전트 1개 (joinedAt 가장 이른 것)", () => {
    const r = decideRuns(input({
      members: [member(A, { autoRespond: true, joinedAt: "2026-09-14T10:00:00+09:00" }), member(B, { autoRespond: true, joinedAt: "2026-09-14T09:00:00+09:00" })],
    }));
    expect(r.runs).toEqual([{ agentId: B, triggerKind: "auto_respond", rootMessageId: ID(30), relayDepth: 0 }]);
  });
  it("멘션 없음 + autoRespond 없음 → 런 없음", () => {
    expect(decideRuns(input({})).runs).toEqual([]);
  });
});

describe("decideRuns — 에이전트 메시지(릴레이)", () => {
  it("sourceRun이 없으면 릴레이하지 않는다", () => {
    expect(decideRuns(input({ message: agentMsg(A, [B]) })).runs).toEqual([]);
  });
  it("자기 멘션 제외, depth+1, root는 sourceRun의 root, relayHash 포함", () => {
    const r = decideRuns(input({ message: agentMsg(A, [A, B], "B야 봐줘"), sourceRun: run(A, 0) }));
    expect(r.runs).toEqual([
      { agentId: B, triggerKind: "relay", rootMessageId: ID(30), relayDepth: 1, relayHash: computeRelayHash(A, B, "B야 봐줘") },
    ]);
  });
  it("autoRespond는 에이전트 메시지에 적용되지 않는다", () => {
    const r = decideRuns(input({ message: agentMsg(A, []), sourceRun: run(A, 0), members: [member(A), member(B, { autoRespond: true })] }));
    expect(r.runs).toEqual([]);
  });
  it("pair_not_allowed", () => {
    const r = decideRuns(input({ message: agentMsg(A, [B]), sourceRun: run(A, 0), channel: channel({ allowPairs: [{ from: B, to: A }] }) }));
    expect(r.runs).toEqual([]);
    expect(r.blocked).toEqual([{ agentId: B, reason: "pair_not_allowed" }]);
  });
  it("max_turns: depth 4에서 5로 넘어가면 차단, 3→4는 허용", () => {
    expect(decideRuns(input({ message: agentMsg(A, [B]), sourceRun: run(A, 4) })).blocked).toEqual([{ agentId: B, reason: "max_turns" }]);
    expect(decideRuns(input({ message: agentMsg(A, [B]), sourceRun: run(A, 3) })).runs[0]?.relayDepth).toBe(4);
  });
  it("repeat: 체인에 같은 해시가 있으면 차단", () => {
    const h = computeRelayHash(A, B, "reply");
    const r = decideRuns(input({ message: agentMsg(A, [B], "reply"), sourceRun: run(A, 0), chainHashes: new Set([h]) }));
    expect(r.blocked).toEqual([{ agentId: B, reason: "repeat" }]);
  });
  it("daily_limit: 오늘 런 수 + 이번 계획 수가 상한에 닿으면 차단", () => {
    const r = decideRuns(input({
      message: agentMsg(A, [B, C]), sourceRun: run(A, 0),
      members: [member(A), member(B), member(C)], agents: [agent(A, "a"), agent(B, "b"), agent(C, "c")],
      channel: channel({ dailyRunLimit: 10 }), todayRunCount: 9,
    }));
    expect(r.runs.map((x) => x.agentId)).toEqual([B]);
    expect(r.blocked).toEqual([{ agentId: C, reason: "daily_limit" }]);
  });
  it("disabled: 비활성 대상은 blocked로 알린다", () => {
    const r = decideRuns(input({ message: agentMsg(A, [B]), sourceRun: run(A, 0), agents: [agent(A, "a"), agent(B, "b", false)] }));
    expect(r.blocked).toEqual([{ agentId: B, reason: "disabled" }]);
  });
});

describe("해시", () => {
  it("normalizeForHash: 토큰 제거, 공백 축약, 소문자, 앞 300자", () => {
    expect(normalizeForHash(`  Hello   <@a:${A}>  World\n\n`)).toBe("hello world");
    expect(normalizeForHash("x".repeat(400))).toHaveLength(300);
  });
  it("computeRelayHash는 64자 hex이고 방향에 따라 다르다", () => {
    expect(computeRelayHash(A, B, "t")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRelayHash(A, B, "t")).not.toBe(computeRelayHash(B, A, "t"));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/server test -- decide`
Expected: FAIL — `Failed to resolve import "../src/modules/router/decide"`

- [ ] **Step 3: 구현**

`apps/server/src/modules/router/decide.ts`:
```ts
import { createHash } from "node:crypto";
import { type Agent, type Channel, type ChannelMember, MENTION_TOKEN_RE, type Message, type Run, type RunTriggerKind } from "@dodok/shared";

export type RoutingInput = {
  message: Message; // 방금 저장된 메시지 (user | agent | system)
  channel: Channel;
  members: ChannelMember[];
  agents: Agent[]; // 채널 소속 에이전트 (enabled 여부 포함)
  sourceRun?: Run; // message가 에이전트 메시지일 때 그 런
  chainHashes: Set<string>; // 같은 rootMessageId 체인의 relayHash 집합
  todayRunCount: number; // 채널 일일 런 수
  now: Date;
};

export type RunPlan = {
  agentId: string;
  triggerKind: RunTriggerKind;
  rootMessageId: string;
  relayDepth: number;
  relayHash?: string;
};
export type BlockedReason = "pair_not_allowed" | "max_turns" | "repeat" | "daily_limit" | "disabled";
export type Blocked = { agentId: string; reason: BlockedReason };

export function normalizeForHash(bodyMd: string): string {
  return bodyMd.replace(MENTION_TOKEN_RE, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
}

export function computeRelayHash(fromAgentId: string, toAgentId: string, bodyMd: string): string {
  return createHash("sha256").update(`${fromAgentId}\n${toAgentId}\n${normalizeForHash(bodyMd)}`).digest("hex");
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function decideRuns(input: RoutingInput): { runs: RunPlan[]; blocked: Blocked[] } {
  const { message, channel, members, agents, sourceRun } = input;
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentMembers = members.filter((m) => m.memberType === "agent");
  const memberIds = new Set(agentMembers.map((m) => m.memberId));
  const isActive = (id: string) => memberIds.has(id) && agentById.get(id)?.enabled === true;

  if (message.authorType === "user") {
    const targets = uniq(message.mentions.agents).filter(isActive);
    if (targets.length > 0) {
      return {
        runs: targets.map((agentId) => ({ agentId, triggerKind: "mention", rootMessageId: message.id, relayDepth: 0 })),
        blocked: [],
      };
    }
    const auto = agentMembers
      .filter((m) => m.autoRespond && isActive(m.memberId))
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    const first = auto[0];
    if (!first) return { runs: [], blocked: [] };
    return { runs: [{ agentId: first.memberId, triggerKind: "auto_respond", rootMessageId: message.id, relayDepth: 0 }], blocked: [] };
  }

  if (message.authorType === "agent") {
    if (!sourceRun) return { runs: [], blocked: [] };
    const policy = channel.relayPolicy;
    const runs: RunPlan[] = [];
    const blocked: Blocked[] = [];
    for (const to of uniq(message.mentions.agents).filter((id) => id !== sourceRun.agentId)) {
      if (!isActive(to)) {
        blocked.push({ agentId: to, reason: "disabled" });
        continue;
      }
      const allowed = policy.allowPairs === "all" || policy.allowPairs.some((p) => p.from === sourceRun.agentId && p.to === to);
      if (!allowed) {
        blocked.push({ agentId: to, reason: "pair_not_allowed" });
        continue;
      }
      const depth = sourceRun.relayDepth + 1;
      if (depth > policy.maxRelayTurns) {
        blocked.push({ agentId: to, reason: "max_turns" });
        continue;
      }
      const relayHash = computeRelayHash(sourceRun.agentId, to, message.bodyMd);
      if (input.chainHashes.has(relayHash)) {
        blocked.push({ agentId: to, reason: "repeat" });
        continue;
      }
      if (policy.dailyRunLimit !== undefined && input.todayRunCount + runs.length >= policy.dailyRunLimit) {
        blocked.push({ agentId: to, reason: "daily_limit" });
        continue;
      }
      runs.push({ agentId: to, triggerKind: "relay", rootMessageId: sourceRun.rootMessageId, relayDepth: depth, relayHash });
    }
    return { runs, blocked };
  }

  return { runs: [], blocked: [] }; // system 메시지는 라우팅하지 않는다
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/server test && pnpm -F @dodok/server typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add apps/server/src/modules/router/decide.ts apps/server/test/router.decide.test.ts
git commit -m "feat(server): 멘션 라우터와 릴레이 정책 decideRuns"
```

---

### Task 12: 컴포넌트 상호작용 검증과 에이전트 전달 텍스트

**Files:**
- Create: `apps/server/src/modules/components/interact.ts`
- Test: `apps/server/test/components.interact.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `Button`, `ComponentState`, `ComponentsV1`, `Message`, `Modal`, `Select`, `SelectOption` 타입 from `@dodok/shared`; `zod`
- Produces: `FoundItem`, `findItem(components, itemId)`, `valuesSchemaFor(found)`, `InteractionInput`, `InteractionResult`, `validateInteraction(input)`(스펙 9.3의 1~5단계, 순수), `formatInteractionText(args)`(스펙 9.4). 저장·브로드캐스트·인바운드 전달(6~7단계)은 후속 서버 계획에서 이 함수들을 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/server/test/components.interact.test.ts`:
```ts
import { ComponentsV1, type ComponentState } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { findItem, formatInteractionText, validateInteraction } from "../src/modules/components/interact";

const U1 = "01a09fc9-d204-7551-89d6-38544d07a1c1";
const U2 = "01a09fc9-d204-7551-89d6-38544d07a1c2";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a1d1";
const NOW = new Date("2026-09-14T00:10:00Z");

const components = ComponentsV1.parse({
  id: "cmp_1",
  blocks: [
    { type: "actions", id: "row1", items: [
      { type: "button", id: "go_fast", label: "빠르게", style: "primary" },
      { type: "button", id: "cancel", label: "취소", style: "danger", allowedUsers: [U1] },
      { type: "button", id: "docs", label: "문서", url: "https://example.com" },
    ] },
    { type: "actions", items: [
      { type: "select", id: "target", placeholder: "대상 선택", options: [{ value: "web", label: "웹" }, { value: "api", label: "API" }] },
    ] },
  ],
  modal: {
    id: "details", title: "세부 정보", triggerLabel: "입력하기",
    fields: [
      { type: "text", id: "title", label: "제목", required: true, maxLength: 20 },
      { type: "textarea", id: "desc", label: "설명" },
      { type: "select", id: "priority", label: "우선순위", options: [{ value: "p1", label: "높음" }, { value: "p2", label: "보통" }] },
      { type: "checkbox", id: "notify", label: "완료 시 알림" },
      { type: "number", id: "hours", label: "예상 시간", min: 0, max: 100 },
    ],
  },
});
const state = (over: Partial<ComponentState> = {}): ComponentState => ({ expiresAt: "2026-09-14T00:30:00Z", consumed: [], ...over });
const message = (over: { componentState?: ComponentState; reusable?: boolean } = {}) => ({
  id: MSG,
  components: over.reusable === undefined ? components : { ...components, reusable: over.reusable },
  componentState: over.componentState ?? state(),
});
const call = (itemId: string, values: Record<string, unknown>, over: Parameters<typeof message>[0] & { userId?: string; componentId?: string; now?: Date } = {}) =>
  validateInteraction({ message: message(over), componentId: over.componentId ?? "cmp_1", itemId, userId: over.userId ?? U1, values, now: over.now ?? NOW });

describe("findItem", () => {
  it("버튼·셀렉트는 블록 id와 함께, 모달은 단독으로 찾는다", () => {
    expect(findItem(components, "go_fast")).toMatchObject({ kind: "button", blockId: "row1" });
    expect(findItem(components, "target")).toMatchObject({ kind: "select", blockId: undefined });
    expect(findItem(components, "details")).toMatchObject({ kind: "modal" });
    expect(findItem(components, "nope")).toBeUndefined();
  });
});

describe("validateInteraction — 실패 순서", () => {
  it("componentId 불일치 → NOT_FOUND", () => {
    expect(call("go_fast", {}, { componentId: "cmp_9" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
  it("없는 아이템 → NOT_FOUND", () => {
    expect(call("nope", {})).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
  it("링크 버튼 → VALIDATION", () => {
    expect(call("docs", {})).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
  it("만료 → EXPIRED", () => {
    expect(call("go_fast", {}, { now: new Date("2026-09-14T00:30:00Z") })).toMatchObject({ ok: false, error: { code: "EXPIRED" } });
  });
  it("allowedUsers 밖 → FORBIDDEN", () => {
    expect(call("cancel", {}, { userId: U2 })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(call("cancel", {}, { userId: U1 })).toMatchObject({ ok: true });
  });
  it("1회용 소비됨 → CONSUMED, reusable이면 허용", () => {
    expect(call("go_fast", {}, { componentState: state({ consumed: ["go_fast"] }) })).toMatchObject({ ok: false, error: { code: "CONSUMED" } });
    expect(call("go_fast", {}, { componentState: state({ consumed: ["go_fast"] }), reusable: true })).toMatchObject({ ok: true });
  });
  it("값 검증 → VALIDATION", () => {
    expect(call("go_fast", { junk: 1 })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(call("target", { values: ["nope"] })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(call("target", { values: ["web", "api"] })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(call("details", { fields: { desc: "설명만" } })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(call("details", { fields: { title: "x".repeat(21) } })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(call("details", { fields: { title: "t", hours: 101 } })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
});

describe("validateInteraction — 성공", () => {
  it("버튼", () => {
    expect(call("go_fast", {})).toMatchObject({ ok: true, found: { kind: "button" }, values: {} });
  });
  it("셀렉트", () => {
    expect(call("target", { values: ["web"] })).toMatchObject({ ok: true, values: { values: ["web"] } });
  });
  it("모달: 필수만 있어도 통과, 선택 필드는 생략 가능", () => {
    expect(call("details", { fields: { title: "로그인 버그" } })).toMatchObject({ ok: true });
    expect(call("details", { fields: { title: "t", priority: ["p1"], notify: true, hours: 3 } })).toMatchObject({ ok: true });
  });
});

describe("formatInteractionText", () => {
  const base = { userHandle: "jang", components };
  it("버튼", () => {
    const found = findItem(components, "go_fast");
    if (!found) throw new Error("x");
    expect(formatInteractionText({ ...base, found, values: {} })).toBe(
      "[dodok interaction] user=@jang kind=button component=cmp_1 item=go_fast\n@jang 님이 \"빠르게\" 버튼을 눌렀습니다.",
    );
  });
  it("셀렉트", () => {
    const found = findItem(components, "target");
    if (!found) throw new Error("x");
    expect(formatInteractionText({ ...base, found, values: { values: ["web"] } })).toBe(
      "[dodok interaction] user=@jang kind=select component=cmp_1 item=target values=[\"web\"]\n@jang 님이 \"대상 선택\"에서 웹을 골랐습니다.",
    );
  });
  it("모달", () => {
    const found = findItem(components, "details");
    if (!found) throw new Error("x");
    expect(formatInteractionText({ ...base, found, values: { fields: { title: "로그인 버그", desc: "재현됨", priority: ["p1"], notify: true, hours: 2 } } })).toBe(
      [
        "[dodok interaction] user=@jang kind=modal component=cmp_1 item=details",
        "@jang 님이 \"세부 정보\" 양식을 제출했습니다.",
        "- 제목: 로그인 버그",
        "- 설명: 재현됨",
        "- 우선순위: 높음",
        "- 완료 시 알림: 예",
        "- 예상 시간: 2",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm -F @dodok/server test -- interact`
Expected: FAIL — `Failed to resolve import "../src/modules/components/interact"`

- [ ] **Step 3: 구현**

`apps/server/src/modules/components/interact.ts`:
```ts
import type { ApiError, Button, ComponentState, ComponentsV1, Field, Modal, Select, SelectOption } from "@dodok/shared";
import { z } from "zod";

export type FoundItem =
  | { kind: "button"; item: Button; blockId?: string }
  | { kind: "select"; item: Select; blockId?: string }
  | { kind: "modal"; item: Modal };

export function findItem(components: ComponentsV1, itemId: string): FoundItem | undefined {
  for (const b of components.blocks) {
    if (b.type !== "actions") continue;
    for (const item of b.items) {
      if (item.id !== itemId) continue;
      if (item.type === "button") return { kind: "button", item, blockId: b.id };
      return { kind: "select", item, blockId: b.id };
    }
  }
  if (components.modal?.id === itemId) return { kind: "modal", item: components.modal };
  return undefined;
}

const enumOf = (options: SelectOption[]) => z.enum(options.map((o) => o.value) as [string, ...string[]]);

function fieldSchema(f: Field): z.ZodType {
  let s: z.ZodType;
  switch (f.type) {
    case "text":
      s = z.string().min(f.minLength ?? 0).max(f.maxLength ?? 4000);
      break;
    case "textarea":
      s = z.string().max(f.maxLength ?? 4000);
      break;
    case "number": {
      let n = z.number();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      s = n;
      break;
    }
    case "date":
      s = z.iso.date();
      break;
    case "select": {
      const arr = z.array(enumOf(f.options));
      s = f.multi ? arr.min(f.required ? 1 : 0) : arr.min(f.required ? 1 : 0).max(1);
      break;
    }
    case "checkbox":
      s = z.boolean();
      break;
    case "radio":
      s = enumOf(f.options);
      break;
  }
  return f.required ? s : s.optional();
}

/** 아이템 종류별 values 스키마 (스펙 9.2) */
export function valuesSchemaFor(found: FoundItem): z.ZodType {
  switch (found.kind) {
    case "button":
      return z.strictObject({});
    case "select": {
      const { item } = found;
      const min = item.minValues ?? (item.multi ? 0 : 1);
      const max = item.multi ? (item.maxValues ?? 25) : 1;
      return z.strictObject({ values: z.array(enumOf(item.options)).min(min).max(max) });
    }
    case "modal": {
      const shape: Record<string, z.ZodType> = {};
      for (const f of found.item.fields) shape[f.id] = fieldSchema(f);
      return z.strictObject({ fields: z.strictObject(shape) });
    }
  }
}

export type InteractionInput = {
  message: { id: string; components?: ComponentsV1; componentState?: ComponentState };
  componentId: string;
  itemId: string;
  userId: string;
  values: Record<string, unknown>;
  now: Date;
};
export type InteractionResult =
  | { ok: true; found: FoundItem; values: Record<string, unknown> }
  | { ok: false; error: ApiError };

const fail = (code: ApiError["code"], message: string, details?: Record<string, unknown>): InteractionResult => ({
  ok: false,
  error: details ? { code, message, details } : { code, message },
});

/** 스펙 9.3의 1~5단계. 저장·브로드캐스트·전달은 호출자가 한다. */
export function validateInteraction(input: InteractionInput): InteractionResult {
  const c = input.message.components;
  if (!c || c.id !== input.componentId) return fail("NOT_FOUND", "component not found");
  const found = findItem(c, input.itemId);
  if (!found) return fail("NOT_FOUND", "item not found");
  if (found.kind === "button" && found.item.url) return fail("VALIDATION", "link button has no interaction");
  const state = input.message.componentState;
  if (!state) return fail("NOT_FOUND", "component state missing");
  if (new Date(state.expiresAt).getTime() <= input.now.getTime()) return fail("EXPIRED", "component expired");
  const allowed = found.item.allowedUsers;
  if (allowed && allowed.length > 0 && !allowed.includes(input.userId)) return fail("FORBIDDEN", "user not allowed");
  if (!c.reusable && state.consumed.includes(input.itemId)) return fail("CONSUMED", "item already used");
  const parsed = valuesSchemaFor(found).safeParse(input.values);
  if (!parsed.success) return fail("VALIDATION", "invalid values", { issues: parsed.error.issues });
  return { ok: true, found, values: parsed.data as Record<string, unknown> };
}

const labelOf = (options: SelectOption[], value: string) => options.find((o) => o.value === value)?.label ?? value;

function renderFieldValue(f: Field, v: unknown): string {
  if (f.type === "checkbox") return v ? "예" : "아니요";
  if (f.type === "select" && Array.isArray(v)) return v.map((x) => labelOf(f.options, String(x))).join(", ");
  if (f.type === "radio") return labelOf(f.options, String(v));
  return String(v);
}

/** 스펙 9.4: 기계가 읽는 한 줄 + 사람이 읽는 본문 */
export function formatInteractionText(args: {
  userHandle: string;
  components: ComponentsV1;
  found: FoundItem;
  values: Record<string, unknown>;
}): string {
  const { userHandle, components, found, values } = args;
  const cid = components.id ?? "?";
  const head = `[dodok interaction] user=@${userHandle} kind=${found.kind} component=${cid} item=${found.item.id}`;
  switch (found.kind) {
    case "button":
      return `${head}\n@${userHandle} 님이 "${found.item.label}" 버튼을 눌렀습니다.`;
    case "select": {
      const vals = Array.isArray(values.values) ? values.values.map(String) : [];
      const labels = vals.map((v) => labelOf(found.item.options, v)).join(", ");
      const name = found.item.placeholder ?? found.item.id;
      return `${head} values=${JSON.stringify(vals)}\n@${userHandle} 님이 "${name}"에서 ${labels}을 골랐습니다.`;
    }
    case "modal": {
      const fields = (values.fields ?? {}) as Record<string, unknown>;
      const lines = [`${head}`, `@${userHandle} 님이 "${found.item.title}" 양식을 제출했습니다.`];
      for (const f of found.item.fields) {
        if (fields[f.id] === undefined) continue;
        lines.push(`- ${f.label}: ${renderFieldValue(f, fields[f.id])}`);
      }
      return lines.join("\n");
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm -F @dodok/server test && pnpm -F @dodok/server typecheck && pnpm lint`
Expected: PASS. (`ComponentsV1.parse` 결과에 `id`를 넣기 위해 테스트 픽스처는 `id: "cmp_1"`을 직접 준다 — 서버가 부여하는 값의 형식 `cmp_<uuid>`는 저장 모듈에서 정한다.)

- [ ] **Step 5: 커밋**

```bash
git add apps/server/src/modules/components/interact.ts apps/server/test/components.interact.test.ts
git commit -m "feat(server): 컴포넌트 상호작용 검증과 에이전트 전달 텍스트"
```

---

### Task 13: 플러그인 패키지 골격 + 인바운드 컨텍스트 텍스트

**Files:**
- Create: `packages/openclaw-plugin/package.json`, `packages/openclaw-plugin/tsconfig.json`, `packages/openclaw-plugin/vitest.config.ts`
- Create: `packages/openclaw-plugin/src/context.ts`
- Test: `packages/openclaw-plugin/test/context.test.ts`

**Interfaces:**
- Consumes: `InboundDeliver` 타입 from `@dodok/shared`
- Produces: `ContextFormatOptions`, `formatInboundContext(d, opts): string`(스펙 8.3 형식의 헤더), `buildInboundText(d, opts): string`(헤더 + 본문). `openclaw` SDK 의존은 **스파이크 2에서** 추가한다.

- [ ] **Step 1: 패키지 파일 작성**

`packages/openclaw-plugin/package.json`:
```json
{
  "name": "@dodok/openclaw-plugin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@dodok/shared": "workspace:*",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/node": "^22.19.0",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

`packages/openclaw-plugin/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

`packages/openclaw-plugin/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 2: 실패하는 테스트 작성**

`packages/openclaw-plugin/test/context.test.ts`:
```ts
import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText, formatInboundContext } from "../src/context";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const deliver: InboundDeliver = {
  deliveryId: "01a09fc9-d204-7551-89d6-38544d07a101",
  kind: "message",
  channelId: CH,
  agentId: "researcher",
  sessionKey: `agent:researcher:dodok:channel:${CH}`,
  runId: "01a09fc9-d204-7551-89d6-38544d07a103",
  message: {
    id: "01a09fc9-d204-7551-89d6-38544d07a104",
    author: { type: "user", handle: "jang", displayName: "장병현" },
    text: "@researcher 이 버그 원인 찾아줘",
    attachments: [],
    ts: "2026-09-14T00:14:00Z",
  },
  context: {
    recentMessages: [
      { author: { type: "user", handle: "jang", displayName: "장병현" }, text: "로그인이 가끔 실패해", ts: "2026-09-14T00:12:00Z" },
      { author: { type: "agent", handle: "planner", displayName: "Planner" }, text: "재현 조건을 모아보죠", ts: "2026-09-14T00:13:00Z" },
    ],
    participants: [
      { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
      { type: "agent", handle: "researcher", displayName: "Researcher", isSelf: true },
      { type: "agent", handle: "planner", displayName: "Planner", isSelf: false },
    ],
    relayRules: "다른 에이전트를 @멘션하면 그 에이전트가 이어받습니다. 최대 4턴.",
    channelPrompt: "이 채널은 버그 분류용입니다.",
    promptOverride: "간결하게 답하세요.",
  },
  options: {},
};

describe("formatInboundContext", () => {
  it("스펙 8.3 형식 (Asia/Seoul 시각, channelPrompt 기본 제외)", () => {
    expect(formatInboundContext(deliver, { timeZone: "Asia/Seoul" })).toBe(
      [
        `[dodok context] channel=${CH} you=@researcher`,
        "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)",
        "릴레이 규칙: 다른 에이전트를 @멘션하면 그 에이전트가 이어받습니다. 최대 4턴.",
        "채널 지시: 간결하게 답하세요.",
        "최근 대화:",
        "[09:12] @jang: 로그인이 가끔 실패해",
        "[09:13] @planner: 재현 조건을 모아보죠",
        "---",
      ].join("\n"),
    );
  });
  it("includeChannelPrompt면 채널 프롬프트 줄이 참여자 줄 다음에 온다", () => {
    const out = formatInboundContext(deliver, { includeChannelPrompt: true });
    expect(out.split("\n")[3]).toBe("채널 프롬프트: 이 채널은 버그 분류용입니다.");
  });
  it("최근 대화가 없으면 그 절이 빠진다", () => {
    const out = formatInboundContext({ ...deliver, context: { ...deliver.context, recentMessages: [], promptOverride: undefined } });
    expect(out).not.toContain("최근 대화:");
    expect(out).not.toContain("채널 지시:");
    expect(out.endsWith("---")).toBe(true);
  });
  it("기본 시간대는 UTC", () => {
    expect(formatInboundContext(deliver)).toContain("[00:12] @jang");
  });
});

describe("buildInboundText", () => {
  it("헤더 다음 줄에 본문", () => {
    const out = buildInboundText(deliver);
    expect(out.endsWith("---\n@researcher 이 버그 원인 찾아줘")).toBe(true);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm install && pnpm -F @dodok/openclaw-plugin test`
Expected: FAIL — `Failed to resolve import "../src/context"`

- [ ] **Step 4: 구현**

`packages/openclaw-plugin/src/context.ts`:
```ts
import type { InboundDeliver } from "@dodok/shared";

export type ContextFormatOptions = {
  /** 최근 대화 시각 표기 시간대 (IANA). 기본 UTC */
  timeZone?: string;
  /** 채널 프롬프트가 Gateway 설정 경로로 못 들어갈 때만 true (스파이크 3 결과에 따라) */
  includeChannelPrompt?: boolean;
};

function hhmm(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
}

/** 스펙 8.3: 인바운드 앞에 붙는 컨텍스트 헤더 */
export function formatInboundContext(d: InboundDeliver, opts: ContextFormatOptions = {}): string {
  const tz = opts.timeZone ?? "UTC";
  const self = d.context.participants.find((p) => p.isSelf);
  const lines: string[] = [];
  lines.push(`[dodok context] channel=${d.channelId} you=@${self?.handle ?? d.agentId}`);
  lines.push(
    `참여자: ${d.context.participants
      .map((p) => `@${p.handle}(${p.type === "user" ? "사람" : "에이전트"}${p.isSelf ? ", 나" : ""})`)
      .join(", ")}`,
  );
  lines.push(`릴레이 규칙: ${d.context.relayRules}`);
  if (opts.includeChannelPrompt && d.context.channelPrompt) lines.push(`채널 프롬프트: ${d.context.channelPrompt}`);
  if (d.context.promptOverride) lines.push(`채널 지시: ${d.context.promptOverride}`);
  if (d.context.recentMessages.length > 0) {
    lines.push("최근 대화:");
    for (const m of d.context.recentMessages) lines.push(`[${hhmm(m.ts, tz)}] @${m.author.handle}: ${m.text}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** 컨텍스트 헤더 + 인바운드 본문. 플러그인이 Gateway 인바운드로 넣는 최종 텍스트 */
export function buildInboundText(d: InboundDeliver, opts: ContextFormatOptions = {}): string {
  return `${formatInboundContext(d, opts)}\n${d.message.text}`;
}
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm -F @dodok/openclaw-plugin test && pnpm -F @dodok/openclaw-plugin typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add packages/openclaw-plugin pnpm-lock.yaml
git commit -m "feat(plugin): 패키지 골격과 인바운드 컨텍스트 텍스트 조립"
```

---

### Task 14: 마무리 — 전체 검증, 스펙 정정, CLAUDE.md 갱신

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-shared-contracts-design.md` (6장 `CUSTOM.value` 한 줄)
- Modify: `CLAUDE.md` ("현재 단계" 절)

- [ ] **Step 1: 루트에서 전체 검증**

Run: `pnpm install && pnpm test && pnpm typecheck && pnpm lint`
Expected: 세 패키지(`@dodok/shared`, `@dodok/server`, `@dodok/openclaw-plugin`) 모두 PASS. 실패하면 해당 태스크로 돌아가 고친다.

- [ ] **Step 2: 스펙에서 구현과 달라진 한 줄 정정**

스펙 6장의 `ev("CUSTOM", { name: z.string(), value: z.unknown() }),` 를 다음으로 바꾼다(Zod 4.6에서 `z.unknown()` 키는 필수이므로):
```ts
  ev("CUSTOM", { name: z.string(), value: z.unknown().optional() }),
```

- [ ] **Step 3: CLAUDE.md의 "현재 단계" 절 교체**

```md
## 현재 단계
shared 계약·DB 스키마·순수 로직 구현 완료 (docs/superpowers/plans/2026-09-14-shared-contracts.md).
다음: Phase 0 스파이크 (docs/project-structure.md 5장 0·2·3·4단계). 스파이크마다 docs/adr/에 결과 기록.
```

- [ ] **Step 4: 커밋**

```bash
git add docs/superpowers/specs/2026-09-14-shared-contracts-design.md CLAUDE.md
git commit -m "docs: 스펙 CUSTOM.value 정정, CLAUDE.md 현재 단계 갱신"
```

---

## 자체 검토 결과 (계획 작성 시점)

- **스펙 커버리지**: 1장 → Task 1, 2장 → Task 2, 3장 → Task 4, 4장 → Task 8·9, 5.1 → Task 10, 5.2 → Task 11, 6장 → Task 5(매핑표 6.1은 어댑터 구현 시 픽스처와 함께), 7장 → Task 6, 8장 → Task 7·13(8.3 컨텍스트 형식), 9장 → Task 3·12(9.3의 6~7단계 저장·전달은 후속 서버 계획), 10장 → 각 태스크의 테스트, 11장 → 코드 밖(스파이크).
- **이름 일치**: `MentionSet`은 `mention.ts`에서 정의하고 `domain`이 re-export(Task 2·4). `DbOrTx`는 Task 8에서 정의하고 Task 9가 사용. `FoundItem`은 Task 12 내부. `RunPatch`/`Transition`은 Task 10.
- **스펙과 다른 점(의도적)**: `CUSTOM.value`가 `.optional()`(Task 5·14). `Transition.patch`는 항상 존재(빈 객체 허용). 사람 메시지의 비활성 대상은 조용히 제외, 에이전트 메시지의 비활성 대상은 `blocked: disabled`(Task 11 메모).
