/**
 * 가짜 에이전트 개발 모드 — 가짜 Gateway·가짜 플러그인·대본을 묶어 서버를 띄운다. 모델 런·실제 Gateway 없이 웹 전체를 돌린다(웹 MVP 스펙 9.2).
 * 테스트와 같은 가짜(`test/fakes/*`)를 쓴다. 운영 코드(`src/`)는 그대로 — 실제 OpenClawAdapter 가 가짜 Gateway 를 붙는다. 그 Gateway 는
 * 시작 때 DB 에 넣는다(연결 페이지 「Gateway 추가」와 같은 행, 고정 id `DEV_FAKE_GATEWAY_ID` — `--keep` 이면 주소·토큰만 이번 가짜로
 * 바꾼다) — 등록할 OpenClaw 에이전트는 이 Gateway 에 묶는다(gatewayId).
 *
 * .env 를 읽지 않는다: 토큰·비밀은 아래 개발 전용 고정값이고(로그에 찍어도 된다), loadConfig 에는 여기서 정한 값만 넘긴다.
 * 고정 member 계정(이메일 member@dodok.local·비밀번호 dev-fake-member-password·핸들 mia)도 owner 와 함께 보장한다 —
 * `--keep` 이면 이미 있을 때 그대로. 운영 `createApp` 에는 없다.
 * DB 는 <dataDir>/dev-fake.sqlite — 시작마다 새로, `--keep` 이면 유지. 실행: `PORT=0 pnpm -F @dodok/server dev:fake [--keep]`.
 * VAPID 키 <dataDir>/vapid.json 은 지우지 않는다 — 새로 만들면 브라우저의 푸시 구독이 매번 무효가 된다.
 * 웹 오리진은 APP_ORIGIN(없으면 http://localhost:5173). 5173 이 차 있으면 5180 으로:
 * `PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake` + `DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web dev --port 5180`.
 * 개발 전용 훅(owner 세션, `content-type: application/json`, 경로 정확 일치 — 운영 `createApp` 에는 없다):
 * - `POST /__devfake/plugin-token { token }` — 가짜 플러그인의 브리지 토큰을 바꿔 다시 붙인다
 * - `POST /__devfake/ops/event { kind, key, severity, detail? }` — 운영 사건을 `app.ops.record` 로 남긴다
 * - `POST /__devfake/gateway { state: "down" | "connected" }` — 가짜 Gateway 를 끊고 붙인다(어댑터 status 가 실제로 바뀐다)
 * - `POST /__devfake/disk { freeBytes, totalBytes } | { reset: true }` — 디스크 감시가 그 값을 보게 하고 곧바로 다시 잰다
 * - `POST /__devfake/plugin-capabilities { threads: boolean }` — false 면 threads 없는 hello 로 다시 붙는다(옛 플러그인 흉내), true 면 되돌린다
 * - `POST /__devfake/runner { connected: boolean, token? }` — 가짜 Claude 러너를 끊고(false) 붙인다(true, token 을 주면 그 러너 토큰으로)
 * 가짜 Claude 러너(`test/fakes/fake-runner.ts`)도 붙는다 — 고정 러너 토큰 `dev-fake-runner-token`(라벨 dev-fake) 행을 시작 때 넣고,
 * 그 러너가 알리는 에이전트 `coder`(provider claude)를 등록해 둔다(처음 붙은 러너 토큰에 묶인다). 가짜 러너는 스스로 다시 붙지 않는다 —
 * 폐기·끊기 뒤에는 훅으로 붙인다. 폐기 뒤 새 토큰으로 붙이면 coder 는 폐기된 토큰에 묶인 채라 연결 페이지 「이 러너로 묶기」로 옮긴다.
 * 끊김 사건 임계는 DODOK_DEVFAKE_DISCONNECT_MS(기본 운영과 같은 60초)로 줄인다. 종료 표지는 <dataDir>/dev-fake-run/ 에 둔다.
 */
import {
  type AgentAdapter,
  type ApprovalDecision,
  BridgeHello,
  type InboundDeliver,
  OpsEvent,
  OpsEventKind,
  OpsSeverity,
  type OpenClawAdapterStatus,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { statfs as fsStatfs } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { type App, type AppDeps, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { hasGateways } from "../src/adapters/types";
import { agents, bridgeTokens, gateways, runnerTokens, users } from "../src/db/schema.sqlite";
import { createAgent, providerAgentIdIs } from "../src/modules/agents/service";
import { gatewayConfig, getGatewayRow } from "../src/modules/gateways/service";
import { acceptInvite, normalizeEmail } from "../src/modules/members/accept";
import { issueInvite } from "../src/modules/members/invites";
import { DISCONNECT_EVENT_MS, startRunState } from "../src/modules/ops/health";
import { type FakeGateway, startFakeGateway } from "../test/fakes/fake-gateway";
import { FAKE_PLUGIN_HELLO, type FakePlugin, startFakePlugin } from "../test/fakes/fake-plugin";
import {
  FAKE_RUNNER_AGENT,
  type FakeRunner,
  type FakeRunnerRun,
  startFakeRunner,
} from "../test/fakes/fake-runner";
import {
  createScenario,
  type ScenarioAgent,
  type ScenarioApproval,
  type ScenarioScript,
} from "../test/fakes/scenario";
import { waitForAdapterConnected } from "../test/helpers/live-app";
import { makePng, PDF_BYTES } from "../test/helpers/png";

const DEFAULT_APP_ORIGIN = "http://localhost:5173";
/** 개발 전용 고정 로그인 토큰(= owner 비밀번호). 시크릿이 아니다 — 로그에 찍는다 */
export const DEV_FAKE_LOCAL_TOKEN = "dev-fake-local-token";
const DEV_FAKE_SECRET = "dev-fake-better-auth-secret-00000000";
/**
 * 개발 전용 고정 브리지 토큰(시크릿이 아니다). 시작 때 가짜 Gateway 에 묶인 토큰 행(라벨 dev-fake)으로 넣는다 — 실제 토큰(`dbt_` +
 * 43자)과 모양이 달라도 핸드셰이크는 해시만 본다
 */
export const DEV_FAKE_BRIDGE_TOKEN = "dev-fake-bridge-token";
/** 가짜 Gateway 의 DB 행 id(= 어댑터 연결 id) — `--keep` 으로 다시 띄워도 같은 행이다 */
export const DEV_FAKE_GATEWAY_ID = "00000000-0000-4000-8000-00000000def1";
const DEV_FAKE_GATEWAY_NAME = "가짜 Gateway";
/** 고정 member 계정(팀 스펙 태스크 7a) — 시크릿이 아닌 개발 전용 고정값이라 owner 토큰과 같이 로그에 찍는다 */
export const DEV_FAKE_MEMBER_EMAIL = "member@dodok.local";
export const DEV_FAKE_MEMBER_PASSWORD = "dev-fake-member-password";
export const DEV_FAKE_MEMBER_HANDLE = "mia";
export const DEV_FAKE_MEMBER_DISPLAY_NAME = "미아";
/** 가짜 Gateway `agents.list` 와 같다 — 이 providerAgentId 마다 대본을 건다 */
const AGENT_IDS = ["dev", "fin"] as const;
/** 실제 클라이언트는 hello 의 tickIntervalMs(30s)×2 동안 프레임이 없으면 끊는다 */
const TICK_INTERVAL_MS = 15_000;
const DELTA_PARTS = 4;
/** 「오래」 — 답 길이와 무관하게 이만큼 동안 흐른다. 채널·스레드에 연달아 불러 두 버블을 동시에 볼 틈 */
const LONG_STREAM_MS = 15_000;
const LONG_DELTA_PARTS = 15;
const QUOTE_MAX = 40;
/** 승인 대본의 TTL — 실물 plugin 승인은 120초지만, 만료까지 눈으로 볼 수 있게 줄였다 */
const APPROVAL_TTL_MS = 20_000;
/** 「짧게」 카드의 TTL — 기본 30분 대신 만료를 눈으로 볼 수 있게 줄였다(승인 대본과 같은 까닭) */
const SHORT_COMPONENTS_TTL_MS = 20_000;
/**
 * 「카드」의 https 그림·파일 주소. 바깥 네트워크를 타지 않게 이 기계(localhost:443, 보통 아무것도 안 듣는다)를 가리킨다 —
 * 브라우저 검증이 오프라인이어도 요청은 곧바로 실패하고, img 요소·alt·링크로 물러난 모습은 그대로 확인할 수 있다.
 */
const LOCAL_HTTPS = "https://localhost/dodok-dev-fake";
/**
 * 개발 전용 — `POST { token }` 이면 가짜 플러그인을 끊고 그 토큰으로 다시 붙인다(연결 페이지의 토큰 교체를 브라우저로 잴 때).
 * dev:fake 에만 있다 — 운영 `createApp` 에는 없다. owner 세션(쿠키 또는 Bearer)이 있어야 한다
 */
export const DEV_FAKE_PLUGIN_TOKEN_PATH = "/__devfake/plugin-token";
/** 개발 전용 — 운영 사건 하나를 `app.ops.record` 로 남긴다(ops_events 를 직접 쓰지 않는다 — unacked 캐시·ops.event 팬아웃이 함께 돈다) */
export const DEV_FAKE_OPS_EVENT_PATH = "/__devfake/ops/event";
/** 개발 전용 — 가짜 Gateway 를 끊고(down) 붙인다(connected). 어댑터가 실제로 끊겨 끊김 감시(watchConnections)가 돈다 */
export const DEV_FAKE_GATEWAY_PATH = "/__devfake/gateway";
/** 개발 전용 — 디스크 감시가 볼 여유·전체 바이트를 정하거나(reset 이면 실제 statfs 로) 곧바로 다시 잰다 */
export const DEV_FAKE_DISK_PATH = "/__devfake/disk";
/** 개발 전용 — 가짜 플러그인을 끊고 hello capabilities 의 threads 를 빼거나(false, 옛 플러그인) 되돌려(true) 다시 붙인다 */
export const DEV_FAKE_PLUGIN_CAPABILITIES_PATH = "/__devfake/plugin-capabilities";
/** 개발 전용 — 가짜 Claude 러너를 끊고(connected false) 붙인다(true — token 을 주면 그 러너 토큰으로 바꿔 붙는다) */
export const DEV_FAKE_RUNNER_PATH = "/__devfake/runner";
/**
 * 개발 전용 고정 러너 토큰(시크릿이 아니다 — 로그에 찍는다). 실제 토큰(`drn_` + 43자)과 모양이 달라도 핸드셰이크는 해시만 본다 —
 * 연결 페이지 목록에는 앞 6자(`dev-fa`)가 보인다
 */
export const DEV_FAKE_RUNNER_TOKEN = "dev-fake-runner-token";
/** 고정 러너 토큰의 라벨 — 등록 목록 hint 가 `dev-fake · dodok · sonnet` */
export const DEV_FAKE_RUNNER_LABEL = "dev-fake";
/** runner 훅이 어댑터의 붙은 러너 수가 바뀌기를 기다리는 상한 */
const RUNNER_HOOK_TIMEOUT_MS = 5_000;
/** 스레드를 모르는 옛 플러그인의 hello — 스레드 멘션은 PLUGIN_OUTDATED 로 끝난다 */
const OLD_PLUGIN_HELLO: BridgeHello = BridgeHello.parse({
  ...FAKE_PLUGIN_HELLO,
  capabilities: FAKE_PLUGIN_HELLO.capabilities.filter((cap) => cap !== "threads"),
});
const DEV_FAKE_BODY_MAX = 16 * 1024;
/** 새 접속이 hello 까지 됐으면 ok, 핸드셰이크·hello 가 거절되면 그 사유(`UNAUTHORIZED` 등) */
export type PluginTokenResult = { ok: true } | { ok: false; reason: string };
/** 끊김 훅 뒤 곧바로 붙게 줄인 재접속 백오프 — 운영 기본(상한 30초)이면 오래 끊긴 뒤 connected 가 30초까지 늦는다 */
const DEV_FAKE_GATEWAY_BACKOFF = { initialMs: 250, maxMs: 1_000 };
/** gateway 훅이 어댑터 status 가 바뀌기를 기다리는 상한 */
const GATEWAY_HOOK_TIMEOUT_MS = 10_000;
/** 종료 표지 자리 — 같은 data/ 를 쓰는 운영 서버(`pnpm -F @dodok/server dev`)의 run-state.json 과 섞이지 않게 따로 둔다 */
const RUN_STATE_DIR = "dev-fake-run";

export type DevFakeOptions = {
  /** 기본 3000. 0 이면 빈 포트 */
  port?: number;
  /** 기본 cwd 의 `data` */
  dataDir?: string;
  /** true 면 dev-fake.sqlite 를 지우지 않는다 */
  keep?: boolean;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  /** 웹 오리진(wire 핸드셰이크 Origin 검사). 기본 http://localhost:5173 */
  appOrigin?: string;
  /** 리슨 주소. 기본 127.0.0.1 — 컨테이너(Dockerfile.server 의 devfake 타깃)는 Caddy 가 닿게 0.0.0.0 */
  host?: string;
  /** 웹 푸시 발송기. 기본은 실제 web-push(dev:fake 로 브라우저 푸시를 본다) — 테스트는 가짜를 줘 밖으로 보내지 않는다 */
  pushSend?: AppDeps["pushSend"];
  /** 끊김 사건 임계(기본 운영과 같은 DISCONNECT_EVENT_MS) — 브라우저 검증이 60초를 기다리지 않게 줄인다 */
  disconnectEventMs?: number;
};

/** DODOK_DEVFAKE_DISCONNECT_MS — 없거나 비었으면 운영 기본, 양의 정수가 아니면 시작하지 않는다 */
function disconnectMsFromEnv(raw: string | undefined): number {
  if (!raw) return DISCONNECT_EVENT_MS;
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error(`DODOK_DEVFAKE_DISCONNECT_MS must be a positive integer (ms): ${raw}`);
  return Number(raw);
}

/**
 * 진입점이 startDevFake 에 넘길 옵션 — 포트는 PORT(기본 3000), 웹 오리진은 APP_ORIGIN(없거나 비었으면 http://localhost:5173),
 * 리슨 주소는 DEV_FAKE_HOST(없거나 비었으면 127.0.0.1), 데이터는 저장소 루트 data/, `--keep` 이면 DB 유지,
 * 끊김 사건 임계는 DODOK_DEVFAKE_DISCONNECT_MS(없으면 60초).
 * 리슨 주소가 HOST 가 아닌 까닭: HOST 는 운영 서버 설정 이름이라, 셸에 남은 값이 개발 서버를 모든 주소에 여는 일이 없게 따로 둔다
 */
export function devFakeCliOptions(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): DevFakeOptions & { appOrigin: string } {
  return {
    port: Number(env.PORT || 3000),
    host: env.DEV_FAKE_HOST || "127.0.0.1",
    appOrigin: env.APP_ORIGIN || DEFAULT_APP_ORIGIN,
    dataDir: resolve(import.meta.dirname, "../../../data"),
    keep: argv.includes("--keep"),
    disconnectEventMs: disconnectMsFromEnv(env.DODOK_DEVFAKE_DISCONNECT_MS),
  };
}
export type DevFake = { app: App; url: string; close(): Promise<void> };

/** 코드 포인트 단위로 대략 같은 길이 parts 개로 나눈다(서로게이트 쌍을 가르지 않는다) */
function splitDeltas(text: string, parts: number): string[] {
  const chars = [...text];
  const size = Math.max(1, Math.ceil(chars.length / parts));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

/** dev:fake 승인 카드 하나 — 실물 claude-cli 승인과 같은 제목·툴 모양 */
function devApproval(
  toolName: string,
  ttlMs: number,
  allowedDecisions: ApprovalDecision[] = ["allow-once", "deny"],
): ScenarioApproval {
  return { title: `claude-cli native tool: ${toolName}`, toolName, allowedDecisions, ttlMs };
}

/**
 * 「승인」 계열 키워드 → 승인 대본. 결정 뒤 이어갈 모양은 결정에 맡긴다 —
 * 허용이면 툴이 성공하고, 거절·만료면 툴 오류 뒤에도 답이 이어진다(승인 스파이크 4.2·4.3).
 */
function approvalScript(text: string): ScenarioApproval | ScenarioApproval[] {
  // 「승인 둘」 — 만료 시각이 다른 승인 둘이 한 런에 겹친다(앞엣것만 먼저 만료된다)
  if (text.includes("승인 둘")) {
    return [devApproval("Write", APPROVAL_TTL_MS), devApproval("Read", 3 * APPROVAL_TTL_MS)];
  }
  // 「승인 항상」 — 버튼 셋(이번만 허용·항상 허용·거절)
  if (text.includes("승인 항상")) {
    return devApproval("Write", APPROVAL_TTL_MS, ["allow-once", "allow-always", "deny"]);
  }
  return devApproval("Write", APPROVAL_TTL_MS);
}

type FakeComponents = NonNullable<ScenarioScript["components"]>;

/** 「폼」 — 모달 필드 5개(text·textarea·number·date·select). 모달 필드는 5개까지라 나머지 둘은 「폼 둘」이 낸다 */
const FORM_CARD: FakeComponents = {
  blocks: [{ type: "section", text: "**회의 잡기** — 아래 버튼으로 양식을 열어 주세요." }],
  modal: {
    id: "meeting",
    title: "회의 잡기",
    triggerLabel: "양식 열기",
    fields: [
      {
        type: "text",
        id: "topic",
        label: "주제",
        required: true,
        placeholder: "무엇을 이야기하나요",
        minLength: 2,
        maxLength: 40,
      },
      { type: "textarea", id: "agenda", label: "안건", placeholder: "한 줄에 하나씩", maxLength: 500 },
      {
        type: "number",
        id: "minutes",
        label: "길이(분)",
        required: true,
        min: 15,
        max: 120,
        step: 15,
        default: 30,
      },
      { type: "date", id: "day", label: "날짜", default: "2026-10-01" },
      {
        type: "select",
        id: "rooms",
        label: "회의실",
        multi: true,
        options: [
          { value: "a", label: "A실", description: "6인" },
          { value: "b", label: "B실", description: "10인" },
          { value: "online", label: "온라인" },
        ],
        default: ["online"],
      },
    ],
  },
};

/** 「폼 둘」 — 「폼」에 없는 checkbox·radio + 필수 text */
const FORM_TWO_CARD: FakeComponents = {
  blocks: [{ type: "section", text: "**만족도 설문** — 아래 버튼으로 답해 주세요." }],
  modal: {
    id: "survey",
    title: "만족도 설문",
    triggerLabel: "설문 열기",
    fields: [
      { type: "text", id: "name", label: "이름", required: true },
      { type: "checkbox", id: "share", label: "결과 공유에 동의", default: true },
      {
        type: "radio",
        id: "score",
        label: "만족도",
        required: true,
        options: [
          { value: "good", label: "좋음" },
          { value: "ok", label: "보통" },
          { value: "bad", label: "아쉬움" },
        ],
        default: "ok",
      },
    ],
  },
};

/**
 * 「고르기」 — 셀렉트 단일 1개 + 다중 1개. 액션 로우 하나에 셀렉트는 하나뿐이라 로우가 둘이다.
 * 다중은 옵션이 12개다 — 6개를 넘으면 스크롤 상자(`OptionList`, 최대 224px)가 되는데, 한 줄이 25px 꼴(브라우저 검증 c2-t9
 * 실측: 8개 = 200px)이라 12개면 약 300px 로 상자를 실제로 넘친다. 8개로는 상자만 생기고 스크롤은 안 생겼다
 */
const PICK_CARD: FakeComponents = {
  blocks: [
    {
      type: "actions",
      items: [
        {
          type: "select",
          id: "lunch",
          placeholder: "점심 메뉴",
          options: [
            { value: "kimchi", label: "김치찌개", emoji: "🍲" },
            { value: "ramen", label: "라멘", description: "돈코츠" },
            { value: "salad", label: "샐러드" },
          ],
        },
      ],
    },
    {
      type: "actions",
      items: [
        {
          type: "select",
          id: "team",
          placeholder: "함께 갈 사람(2~3명)",
          multi: true,
          minValues: 2,
          maxValues: 3,
          options: [
            { value: "mina", label: "미나" },
            { value: "jun", label: "준" },
            { value: "sora", label: "소라" },
            { value: "hoon", label: "훈" },
            { value: "yuna", label: "유나" },
            { value: "jiho", label: "지호" },
            { value: "seoyeon", label: "서연" },
            { value: "doyun", label: "도윤" },
            { value: "haeun", label: "하은" },
            { value: "minjae", label: "민재" },
            { value: "yerin", label: "예린" },
            { value: "taeo", label: "태오" },
          ],
        },
      ],
    },
  ],
};

/**
 * 「카드」 — 블록 5종이 다 든 카드. media·file 은 https 하나 + artifact 하나(artifact 는 Phase 2 ③ 까지 자리표시).
 * 링크 버튼도 artifact 하나를 둔다 — `artifact://` 가 링크 버튼·media·file **셋에서 같은 문구**인지 한 카드에서 본다
 */
const BLOCKS_CARD: FakeComponents = {
  blocks: [
    { type: "section", text: "**배포 요약** — `v1.2.0` 을 올렸어요.\n\n- 새 기능 셋\n- 고친 것 둘" },
    { type: "separator" },
    {
      type: "actions",
      id: "review",
      items: [
        { type: "button", id: "like", label: "좋아요", style: "primary", emoji: "👍" },
        { type: "button", id: "later", label: "나중에" },
        { type: "button", id: "rollback", label: "되돌리기", style: "danger" },
        { type: "button", id: "open_screen", label: "스크린숏 열기", url: "artifact://dev-fake/screen.png" },
      ],
    },
    {
      type: "media",
      items: [
        { url: `${LOCAL_HTTPS}/error-rate.png`, alt: "배포 뒤 오류율 그래프" },
        { url: "artifact://dev-fake/screen.png", alt: "새 화면 스크린숏" },
      ],
    },
    { type: "file", url: `${LOCAL_HTTPS}/release-notes.pdf`, name: "release-notes.pdf", size: 48_213 },
    { type: "file", url: "artifact://dev-fake/build.log", name: "build.log" },
  ],
};

/**
 * 「재사용」 — 몇 번이든 누를 수 있는 버튼 + 모달 카드(결과 줄이 누를 때마다 는다).
 * 모달이 함께 있어야 결과 줄 상한(「최근 20건」)과 모달 제출 뒤 초점(결과 줄로)을 한 카드에서 본다
 */
const REUSABLE_CARD: FakeComponents = {
  reusable: true,
  blocks: [
    { type: "section", text: "몇 번이든 누를 수 있어요." },
    {
      type: "actions",
      items: [
        { type: "button", id: "plus_one", label: "+1", style: "success" },
        { type: "button", id: "ping", label: "다시 알려 주세요" },
      ],
    },
  ],
  modal: {
    id: "note",
    title: "한마디 남기기",
    triggerLabel: "한마디 쓰기",
    fields: [{ type: "text", id: "note_text", label: "한마디", required: true, maxLength: 100 }],
  },
};

/** 「짧게」 — 버튼·셀렉트·모달이 한 카드에 있어, 만료되면 셋이 함께 잠기는 것을 본다 */
const SHORT_CARD: FakeComponents = {
  blocks: [
    { type: "section", text: "20초 뒤에 만료돼요." },
    {
      type: "actions",
      items: [
        { type: "button", id: "ok", label: "확인", style: "primary" },
        { type: "button", id: "skip", label: "건너뛰기" },
      ],
    },
    {
      type: "actions",
      items: [
        {
          type: "select",
          id: "when",
          placeholder: "언제 할까요",
          options: [
            { value: "now", label: "지금" },
            { value: "tomorrow", label: "내일" },
          ],
        },
      ],
    },
  ],
  modal: {
    id: "memo",
    title: "메모 남기기",
    triggerLabel: "메모 쓰기",
    fields: [{ type: "textarea", id: "memo_text", label: "메모" }],
  },
};

/**
 * 「카드에 이미지」 — 같은 메시지 첨부를 `artifact://<파일 이름>` 으로 가리키는 카드(첨부 스펙 6.3).
 * media 는 찾는 이름 하나 + 없는 이름 하나(「첨부를 찾을 수 없습니다」), file·링크 버튼은 공백·한국어 이름.
 * 공백은 SafeUrl(`\S+`)을 못 지나 `%20` 으로 적는다 — 웹이 디코드한 이름으로도 찾는다
 */
const ARTIFACT_CARD: FakeComponents = {
  blocks: [
    { type: "section", text: "**월간 추이** — 그래프와 원본 파일이에요." },
    {
      type: "media",
      items: [
        { url: "artifact://chart.png", alt: "월간 추이 그래프" },
        { url: "artifact://없음.png", alt: "빠진 그림" },
      ],
    },
    { type: "file", url: "artifact://월간%20보고서.pdf", name: "월간 보고서" },
    {
      type: "actions",
      items: [{ type: "button", id: "open_pdf", label: "원본 열기", url: "artifact://월간%20보고서.pdf" }],
    },
  ],
};

/**
 * components 키워드 → 카드, 앞에 있을수록 먼저 고른다(「폼 둘」이 「폼」보다, 「카드에 이미지」가 「카드」보다 앞). 라벨·옵션·제목에는 키워드를 쓰지 않는다 —
 * 누른 상호작용 글이 다음 런의 받은 글이 되므로, 거기에 키워드가 있으면 카드가 또 나온다.
 */
const COMPONENT_CARDS: ReadonlyArray<readonly [keyword: string, card: FakeComponents]> = [
  ["폼 둘", FORM_TWO_CARD],
  ["폼", FORM_CARD],
  ["고르기", PICK_CARD],
  ["카드에 이미지", ARTIFACT_CARD],
  ["카드", BLOCKS_CARD],
  ["재사용", REUSABLE_CARD],
  ["짧게", SHORT_CARD],
];

/** 받은 글의 components 키워드 → 카드. 「짧게」가 다른 키워드와 함께 오면 그 카드의 TTL 만 줄인다 */
function componentsScript(text: string): FakeComponents | undefined {
  const card = COMPONENT_CARDS.find(([keyword]) => text.includes(keyword))?.[1];
  if (card === undefined) return undefined;
  return text.includes("짧게") ? { ...card, ttlMs: SHORT_COMPONENTS_TTL_MS } : card;
}

type FakeFile = NonNullable<ScenarioScript["attachments"]>[number];

/** 대본 그림 — 480×320, 파랑 바탕에 밝은 대각선 줄무늬(단색이면 브라우저 검증에서 그려졌는지 가리기 어렵다) */
const CHART_PNG: FakeFile = {
  name: "chart.png",
  mime: "image/png",
  bytes: makePng(480, 320, [30, 120, 200], { rgb: [240, 200, 60], every: 24 }),
};
const pdfFile = (name: string): FakeFile => ({ name, mime: "application/pdf", bytes: PDF_BYTES });

/**
 * 첨부 키워드 → 정본 글·첨부(첨부 스펙 8.4). 앞에 있을수록 먼저 고른다. 대본 글은 받은 글을 되받지 않는 고정 문구다 —
 * 어떤 키워드(`DEV_FAKE_KEYWORDS`)도 담지 않아, 채널의 다른 에이전트가 받아도 대본이 또 나오지 않는다.
 * 「카드에 이미지」의 카드는 `COMPONENT_CARDS` 가 고른다(「카드」보다 앞).
 */
const ATTACHMENT_REPLIES: ReadonlyArray<readonly [keyword: string, reply: string, files: FakeFile[]]> = [
  ["카드에 이미지", "첨부를 가리킨 안내입니다", [CHART_PNG, pdfFile("월간 보고서.pdf")]],
  ["이미지 보여줘", "그래프입니다", [CHART_PNG]],
  ["보고서 줘", "보고서입니다", [pdfFile("report.pdf")]],
  ["미디어만", "", [CHART_PNG]],
];

/**
 * 「나 불러」 — 부른 사람을 평문 `@핸들` 로 부르는 고정 답(인용·릴레이 꼬리 없음). 서버가 채널 참여자로 토큰화해
 * `mentions.users` 에 넣으므로 푸시 「멘션」 트리거가 선다. 에이전트가 보냈으면 채널의 첫 사람을 부른다
 */
const CALL_ME = "나 불러";

function callMeReply(d: InboundDeliver): string {
  const { author } = d.message;
  const human =
    author.type === "user" ? author.handle : d.context.participants.find((p) => p.type === "user")?.handle;
  return `@${human ?? "owner"} 확인해 주세요`;
}

/** 대본을 바꾸는 키워드 전부 — 대본이 내는 글·라벨·파일 이름에는 이 중 무엇도 넣지 않는다(「승인 둘」·「승인 항상」은 「승인」이 덮는다) */
export const DEV_FAKE_KEYWORDS: readonly string[] = [
  "드롭",
  "실패",
  "느리게",
  "오래",
  "도구",
  "승인",
  "게시",
  "구독",
  CALL_ME,
  ...COMPONENT_CARDS.map(([keyword]) => keyword),
  ...ATTACHMENT_REPLIES.map(([keyword]) => keyword),
];

/** 사람이 첨부를 붙여 불렀으면 대본 앞에 붙이는 한 줄 — 받은 첨부 수와 첫 이미지 크기(인바운드 `message.attachments`) */
function receivedLine(d: InboundDeliver): string | undefined {
  const { attachments, author } = d.message;
  if (author.type !== "user" || attachments.length === 0) return undefined;
  const image = attachments.find((a) => a.kind === "image");
  const size = image ? `${image.width ?? "?"}×${image.height ?? "?"}` : "없음";
  return `받은 첨부 ${attachments.length}개, 첫 이미지 ${size}`;
}

/**
 * 받은 글로 대본을 고른다 — 키워드: 드롭·실패·느리게·오래·도구·승인(승인 둘·승인 항상)·나 불러·폼(폼 둘)·고르기·카드·재사용·짧게,
 * 첨부 키워드 이미지 보여줘·보고서 줘·카드에 이미지·미디어만. 사람 첨부가 있으면 답 앞에 받은 첨부 줄을 붙인다.
 * 받은 글을 `@` 없이 인용해(멘션을 새로 만들지 않는다) 되받고,
 * 글이 부른 채널의 다른 에이전트와 보낸 에이전트를 끝의 「@핸들 이어서 부탁해요」로만 불러 릴레이를 만든다.
 * 핸들은 채널 참여자(`context.participants`)에서 읽는다 — 등록한 핸들이 providerAgentId 와 달라도 된다.
 */
export function fakeAgentScript(self: string, d: InboundDeliver): ScenarioScript {
  const { text, author } = d.message;
  if (text.includes("드롭")) return { drop: "bot-loop-protection", reply: "" };
  const others = new Set(
    d.context.participants.filter((p) => p.type === "agent" && !p.isSelf).map((p) => p.handle),
  );
  const calls = new Set(
    [...text.matchAll(/@([a-z0-9_-]{2,32})/g)].map((m) => m[1] ?? "").filter((h) => others.has(h)),
  );
  if (author.type === "agent" && others.has(author.handle)) calls.add(author.handle);
  const quote = [...text.replaceAll("@", "").replace(/\s+/g, " ").trim()].slice(0, QUOTE_MAX).join("");
  const tail = calls.size > 0 ? ` ${[...calls].map((h) => `@${h}`).join(" ")} 이어서 부탁해요.` : "";
  const media = ATTACHMENT_REPLIES.find(([keyword]) => text.includes(keyword));
  const body = media
    ? media[1]
    : text.includes(CALL_ME)
      ? callMeReply(d)
      : `**${self}**: 「${quote}」 잘 받았어요.${tail}`;
  const received = receivedLine(d);
  const reply = [received, body].filter(Boolean).join("\n\n");
  const components = componentsScript(text);
  const long = text.includes("오래");
  const deltas = splitDeltas(reply, long ? LONG_DELTA_PARTS : DELTA_PARTS);
  return {
    reply,
    deltas,
    deltaDelayMs: long
      ? Math.round(LONG_STREAM_MS / Math.max(1, deltas.length))
      : text.includes("느리게")
        ? 1_500
        : 150,
    ...(text.includes("실패") ? { fail: "fake failure" } : {}),
    ...(text.includes("도구") ? { tool: { name: "Read", args: { path: "README.md" }, result: "ok" } } : {}),
    ...(text.includes("승인") ? { approval: approvalScript(text) } : {}),
    ...(components ? { components } : {}),
    ...(media ? { attachments: media[2] } : {}),
  };
}

/** 러너 대본 「승인」의 요약 — 실제 러너처럼 작업 디렉터리 상대 경로만 싣고, 승인 카드가 코드 글꼴로 줄바꿈해 전부 보이는지 볼 만큼 길다 */
export const RUNNER_APPROVAL_COMMAND =
  "pnpm -F @dodok/server test -- --run test/integration/runner.scenarios.test.ts && git status --porcelain";
/** 러너 대본 「게시」 — `post` 로 올리는 글과 카드. 누른 상호작용 글이 coder 의 다음 런이 되므로 라벨에 키워드를 쓰지 않는다 */
export const RUNNER_POST_TEXT = "작업 요약을 채널에 올립니다.";
const RUNNER_POST_CARD: FakeComponents = {
  blocks: [
    { type: "section", text: "**작업 요약** — 테스트 12개 통과, 바뀐 파일 3개." },
    {
      type: "actions",
      items: [
        { type: "button", id: "looks_good", label: "좋아요", style: "primary" },
        { type: "button", id: "explain", label: "더 설명해 주세요" },
      ],
    },
  ],
};
/** 러너 대본의 사용량 — 운영 화면이 Claude 런의 토큰·비용을 더한다(「구독」이면 공시 단가 환산값) */
const RUNNER_USAGE = { inputTokens: 1_200, outputTokens: 80 };
const RUNNER_COST_USD = 0.02;

/** ms 만큼 쉰다 — 런이 중지되면 곧바로 풀린다 */
const pauseOrAbort = (run: FakeRunnerRun, ms: number) =>
  Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms)), run.aborted]);

/**
 * 가짜 Claude 러너(에이전트 coder)의 대본. 답 글·델타·간격·릴레이 꼬리는 `fakeAgentScript` 와 같다(「오래」·「느리게」도 그대로) —
 * 늘 도구 하나(Read)를 먼저 부르고, 러너 키워드: 승인(도구 승인 카드 — 허용이면 Bash 도구가 돈다)·게시(post 로 글 + 카드)·
 * 구독(비용을 subscription_estimate 로)·실패(run.error). 그 밖의 키워드(카드·첨부·드롭 등)는 OpenClaw 가짜 에이전트 몫이다.
 * 중지되면 더 보내지 않는다 — 가짜 러너가 `stopReason: "aborted"` 로 끝낸다
 */
export async function fakeRunnerScript(run: FakeRunnerRun): Promise<void> {
  const d = run.start.deliver;
  const { text } = d.message;
  const script = fakeAgentScript(FAKE_RUNNER_AGENT.id, d);
  run.tool("Read", { file_path: "README.md" }, "# dodok");
  if (text.includes("실패")) {
    run.error("INTERNAL", "fake runner failure");
    return;
  }
  const lines: string[] = [];
  if (text.includes("승인")) {
    const resolved = await run.approval({ toolName: "Bash", summary: `Bash: ${RUNNER_APPROVAL_COMMAND}` });
    if (resolved === null) return;
    if (resolved.decision === "deny") {
      lines.push(
        resolved.reason === "expired" ? "기한이 지나 실행하지 않았습니다." : "거절받아 실행하지 않았습니다.",
      );
    } else {
      run.tool("Bash", { command: RUNNER_APPROVAL_COMMAND }, "exit 0");
      lines.push("허용받아 실행했습니다.");
    }
  }
  if (text.includes("게시")) {
    const ack = await run.post({ text: RUNNER_POST_TEXT, components: RUNNER_POST_CARD });
    lines.push(ack.ok ? "요약을 채널에 올렸습니다." : `요약을 올리지 못했습니다(${ack.code}).`);
  }
  const deltas = [...lines.map((line) => `${line}\n\n`), ...(script.deltas ?? [script.reply])];
  for (const delta of deltas) {
    if (run.isAborted) return;
    run.text(delta);
    await pauseOrAbort(run, script.deltaDelayMs ?? 150);
  }
  if (run.isAborted) return;
  run.final(deltas.join(""), {
    usage: RUNNER_USAGE,
    costUsd: RUNNER_COST_USD,
    costKind: text.includes("구독") ? "subscription_estimate" : "api",
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= DEV_FAKE_BODY_MAX) chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(size <= DEV_FAKE_BODY_MAX ? Buffer.concat(chunks).toString("utf8") : undefined),
    );
    req.on("error", reject);
  });
}

/** 본문이 JSON 이 아니거나 모양이 틀렸다 — 400 */
const invalid = Symbol("invalid");

/** 훅 하나 — 본문을 input 으로 파싱해 run 에 넘기고, 돌려준 값을 200 JSON 으로 낸다. usage 는 400 응답 문구 */
type DevFakeRoute = { usage: string; handle(body: unknown): Promise<unknown> };

function route<T>(input: z.ZodType<T>, usage: string, run: (value: T) => Promise<unknown>): DevFakeRoute {
  return {
    usage,
    async handle(body) {
      const parsed = input.safeParse(body);
      return parsed.success ? run(parsed.data) : invalid;
    },
  };
}

const PluginTokenInput = z.object({ token: z.string().min(1) });
const PluginCapabilitiesInput = z.strictObject({ threads: z.boolean() });
/** key·detail 모양은 shared OpsEvent 그대로(key 는 비지 않게) — record 가 거절할 것을 여기서 400 으로 먼저 돌려준다 */
const OpsEventInput = z.strictObject({
  kind: OpsEventKind,
  key: OpsEvent.shape.key.min(1),
  severity: OpsSeverity,
  detail: OpsEvent.shape.detail.optional(),
});
const GatewayInput = z.strictObject({ state: z.enum(["down", "connected"]) });
const RunnerInput = z.strictObject({ connected: z.boolean(), token: z.string().min(1).optional() });
const Bytes = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const DiskInput = z.union([
  z.strictObject({ reset: z.literal(true) }),
  z
    .strictObject({ freeBytes: Bytes, totalBytes: Bytes.min(1) })
    .refine((d) => d.freeBytes <= d.totalBytes, "freeBytes must not exceed totalBytes"),
]);

/** content-type 의 미디어 타입(매개변수 앞)이 application/json 인가 — 아니면 415(앱 REST 와 같은 선: 단순 요청으로 못 부르게) */
function isJson(req: IncomingMessage): boolean {
  return req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * 훅 하나를 받는다. 세션은 앱의 owner 경로(`/api/v1/setup/status`)에 같은 헤더로 물어 판정한다 —
 * 그 경로의 `requireOwner` 가 401·403 을 내면 그 응답을 그대로 돌려준다. 본문은 판정 뒤에 읽는다
 */
async function handleDevFakeRoute(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  hook: DevFakeRoute,
): Promise<void> {
  const { cookie, authorization } = req.headers;
  const guard = await app.fastify.inject({
    method: "GET",
    url: "/api/v1/setup/status",
    headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  });
  if (guard.statusCode !== 200) {
    res
      .writeHead(guard.statusCode, { "content-type": String(guard.headers["content-type"]) })
      .end(guard.body);
    return;
  }
  if (!isJson(req)) {
    req.resume(); // 본문을 버린다 — 연결이 다음 요청에 쓰이게
    sendJson(res, 415, { code: "VALIDATION", message: "content-type must be application/json" });
    return;
  }
  const raw = await readBody(req);
  let body: unknown = invalid;
  try {
    if (raw !== undefined) body = JSON.parse(raw);
  } catch {
    body = invalid;
  }
  const result = body === invalid ? invalid : await hook.handle(body);
  if (result === invalid) {
    sendJson(res, 400, { code: "VALIDATION", message: `body must be ${hook.usage}` });
    return;
  }
  sendJson(res, 200, result);
}

/**
 * `createApp` 이 fastify.ready() 까지 마쳐 경로를 더할 수 없다(FST_ERR_INSTANCE_ALREADY_LISTENING) — HTTP 서버의 request 리스너를
 * 감싼다. engine.io 가 `/socket.io/` 를 가로채는 것과 같은 방식: POST 로 온 이 경로(쿼리 앞까지 정확히 일치)만 받고
 * 나머지는 원래 리스너(engine.io → Fastify)에 넘긴다
 */
function interceptDevFakeRoutes(app: App, routes: ReadonlyMap<string, DevFakeRoute>): void {
  const server: Server = app.fastify.server;
  const listeners = server.listeners("request") as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split("?")[0] ?? "";
    const hook = req.method === "POST" ? routes.get(path) : undefined;
    if (hook) {
      handleDevFakeRoute(app, req, res, hook).catch((err: unknown) => {
        app.logger.error({ err, path }, "dev:fake hook failed");
        if (!res.headersSent) sendJson(res, 500, { code: "INTERNAL", message: "dev:fake hook failed" });
      });
      return;
    }
    for (const listener of listeners) listener.call(server, req, res);
  });
}

/** dev:fake 는 실제 OpenClaw 어댑터 하나로 뜬다 */
function openclawOf(app: App): AgentAdapter {
  const adapter = app.registry.forProvider("openclaw");
  if (!adapter) throw new Error("dev:fake app has no OpenClaw adapter");
  return adapter;
}

/** 붙은 가짜 플러그인이 통과한 브리지 토큰 id — 로그용 */
function pluginTokenId(app: App): string | null | undefined {
  const detail = openclawOf(app).setupDetail();
  return detail.provider === "openclaw" ? detail.bridge.plugin?.tokenId : undefined;
}

/** 어댑터의 Gateway 상태가 want 를 만족할 때까지 기다린다 — timeoutMs 가 지나면 false */
function waitForGateway(
  app: App,
  want: (state: OpenClawAdapterStatus["gateway"]) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const initial = openclawOf(app).status();
  if (initial.provider === "openclaw" && want(initial.gateway)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = openclawOf(app).onEvent((e) => {
      if (e.kind !== "status" || e.status.provider !== "openclaw" || !want(e.status.gateway)) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/** dev:fake 는 실제 러너 어댑터 하나로도 뜬다(`createApp` 이 만든다) */
function claudeOf(app: App): AgentAdapter {
  const adapter = app.registry.forProvider("claude");
  if (!adapter) throw new Error("dev:fake app has no Claude runner adapter");
  return adapter;
}

/** 러너 어댑터에 붙은 러너 수 */
function runnersConnected(app: App): number {
  const status = claudeOf(app).status();
  return status.provider === "claude" ? status.runners.connected : 0;
}

/** 붙은 러너 수가 want 를 만족할 때까지 기다린다 — timeoutMs 가 지나면 false */
function waitForRunners(app: App, want: (connected: number) => boolean, timeoutMs: number): Promise<boolean> {
  if (want(runnersConnected(app))) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = claudeOf(app).onEvent((e) => {
      if (e.kind !== "status" || e.status.provider !== "claude" || !want(e.status.runners.connected)) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/**
 * 고정 러너 토큰 행과 가짜 러너의 에이전트 coder 를 보장한다. 해시가 같은 행이 이미 있으면(`--keep`) 폐기됐어도 그대로 둔다 —
 * 폐기된 채로 이어받으면 가짜 러너는 못 붙고, 연결 페이지에서 새 토큰을 발급해 runner 훅의 token 으로 붙인 뒤 coder 를 그 러너에 다시
 * 묶는다
 */
function ensureDevFakeRunner(app: App): void {
  const { db, workspaceId } = app;
  const hash = createHash("sha256").update(DEV_FAKE_RUNNER_TOKEN).digest("hex");
  if (!db.select({ id: runnerTokens.id }).from(runnerTokens).where(eq(runnerTokens.hash, hash)).get()) {
    db.insert(runnerTokens)
      .values({
        id: uuidv7(),
        workspaceId,
        label: DEV_FAKE_RUNNER_LABEL,
        hash,
        prefix: DEV_FAKE_RUNNER_TOKEN.slice(0, 6),
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      })
      .run();
  }
  const agent = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), providerAgentIdIs(FAKE_RUNNER_AGENT.id)))
    .get();
  if (!agent) {
    createAgent(db, {
      workspaceId,
      provider: "claude",
      providerAgentId: FAKE_RUNNER_AGENT.id,
      handle: FAKE_RUNNER_AGENT.id,
      name: FAKE_RUNNER_AGENT.name,
    });
  }
}

/**
 * 가짜 Gateway 행과 그 Gateway 에 묶인 고정 브리지 토큰 행을 보장하고 어댑터에 넣는다. 가짜 Gateway 는 시작마다 포트가 바뀌므로
 * `--keep` 으로 이어받은 행은 주소·토큰만 이번 것으로 바꾼다(이름·켜짐은 사람이 연결 페이지에서 바꾼 대로 둔다). 고정 토큰 행이
 * 이미 있으면(폐기됐어도) 그대로 둔다 — 고정 러너 토큰과 같은 규칙
 */
function ensureDevFakeGateway(app: App, gateway: FakeGateway): void {
  const { db, workspaceId } = app;
  const now = new Date();
  if (getGatewayRow(db, workspaceId, DEV_FAKE_GATEWAY_ID)) {
    db.update(gateways)
      .set({ url: gateway.url, token: gateway.token, updatedAt: now })
      .where(eq(gateways.id, DEV_FAKE_GATEWAY_ID))
      .run();
  } else {
    db.insert(gateways)
      .values({
        id: DEV_FAKE_GATEWAY_ID,
        workspaceId,
        name: DEV_FAKE_GATEWAY_NAME,
        url: gateway.url,
        token: gateway.token,
        enabled: true,
        ownerUserId: null,
        lastVersion: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  const hash = createHash("sha256").update(DEV_FAKE_BRIDGE_TOKEN).digest("hex");
  if (!db.select({ id: bridgeTokens.id }).from(bridgeTokens).where(eq(bridgeTokens.hash, hash)).get()) {
    db.insert(bridgeTokens)
      .values({
        id: uuidv7(),
        workspaceId,
        label: "dev-fake",
        hash,
        prefix: DEV_FAKE_BRIDGE_TOKEN.slice(0, 6),
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
        gatewayId: DEV_FAKE_GATEWAY_ID,
      })
      .run();
  }
  const row = getGatewayRow(db, workspaceId, DEV_FAKE_GATEWAY_ID);
  const openclaw = app.registry.forProvider("openclaw");
  if (!row || !openclaw || !hasGateways(openclaw)) throw new Error("dev:fake could not add the fake gateway");
  openclaw.upsertGateway(gatewayConfig(row));
}

/**
 * 고정 member 계정을 보장한다(팀 스펙 태스크 7a) — 사람을 만드는 서버 경로(members/accept.ts 의 `acceptInvite`)를 그대로 쓴다:
 * 초대를 하나 내부에서 내 곧바로 그 초대로 수락한다(따로 흉내 내지 않는다). 이미 있으면(`--keep` 으로 이어받은 DB) 그대로 둔다
 */
async function ensureDevFakeMember(app: App): Promise<void> {
  const { db, workspaceId } = app;
  const email = normalizeEmail(DEV_FAKE_MEMBER_EMAIL);
  const exists = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.workspaceId, workspaceId), eq(users.email, email)))
    .get();
  if (exists) return;
  const now = new Date();
  const { token } = issueInvite(db, { workspaceId, role: "member", createdBy: app.ownerUserId, now });
  await acceptInvite(
    { db, auth: app.auth, workspaceId, ops: app.ops, logger: app.logger, now: () => now },
    {
      token,
      handle: DEV_FAKE_MEMBER_HANDLE,
      displayName: DEV_FAKE_MEMBER_DISPLAY_NAME,
      email: DEV_FAKE_MEMBER_EMAIL,
      password: DEV_FAKE_MEMBER_PASSWORD,
    },
  );
}

/** 가짜 Gateway → createApp(실제 OpenClawAdapter) → listen → 가짜 플러그인 → 대본 → 어댑터 gateway·bridge connected. 실패하면 만든 것을 닫고 던진다 */
export async function startDevFake(opts: DevFakeOptions = {}): Promise<DevFake> {
  const dataDir = opts.dataDir ?? "data";
  const port = opts.port ?? 3000;
  const host = opts.host ?? "127.0.0.1";
  const dbPath = join(dataDir, "dev-fake.sqlite");
  mkdirSync(dataDir, { recursive: true });
  if (!opts.keep) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
  const runStateDir = join(dataDir, RUN_STATE_DIR);
  mkdirSync(runStateDir, { recursive: true });
  // 디스크 훅이 값을 정하면 그 값을, 아니면 실제 statfs 를 본다
  let fakeDisk: { freeBytes: number; totalBytes: number } | undefined;
  const statfs: NonNullable<AppDeps["statfs"]> = (path) =>
    fakeDisk
      ? Promise.resolve({ bavail: fakeDisk.freeBytes, bsize: 1, blocks: fakeDisk.totalBytes })
      : fsStatfs(path, { bigint: true });

  const gateway: FakeGateway = await startFakeGateway({ tickIntervalMs: TICK_INTERVAL_MS });
  let app: App | undefined;
  let plugin: FakePlugin | undefined;
  let runner: FakeRunner | undefined;
  let runState: ReturnType<typeof startRunState> | undefined;
  let closing: Promise<void> | undefined;
  // 앱이 먼저 닫혀야 플러그인이 shutdown notice 를 받고, 어댑터가 Gateway 연결을 스스로 끊는다
  const close = () => {
    closing ??= (async () => {
      await app?.close();
      runState?.markClean(); // main.ts 처럼 닫힌 뒤에 — 강제 종료(kill -9)면 다음 시작이 unclean_shutdown 을 남긴다
      plugin?.close();
      runner?.close();
      await gateway.close();
    })();
    return closing;
  };
  try {
    app = await createApp(
      loadConfig({
        HOST: host,
        PORT: String(port),
        APP_ORIGIN: opts.appOrigin ?? DEFAULT_APP_ORIGIN,
        DATA_DIR: dataDir,
        DB_PATH: dbPath,
        LOG_LEVEL: opts.logLevel ?? "info",
        LOCAL_AUTH_TOKEN: DEV_FAKE_LOCAL_TOKEN,
        BETTER_AUTH_SECRET: DEV_FAKE_SECRET,
      }),
      {
        ...(opts.pushSend ? { pushSend: opts.pushSend } : {}),
        statfs,
        disconnectEventMs: opts.disconnectEventMs ?? DISCONNECT_EVENT_MS,
        gatewayBackoff: DEV_FAKE_GATEWAY_BACKOFF,
      },
    );
    // main.ts 와 같다 — 운영 화면 「직전 종료」가 null 로만 보이지 않게
    runState = startRunState(runStateDir, app.ops, app.logger);
    app.setPreviousClean(runState.previousClean);
    ensureDevFakeGateway(app, gateway);
    await ensureDevFakeMember(app);
    ensureDevFakeRunner(app);
    // 다시 붙이기(토큰·hello 바꾸기)는 한 번에 하나씩 — 겹치면 소켓 하나를 두 핸드셰이크가 다툰다
    let swapping: Promise<unknown> = Promise.resolve();
    const reconnectPlugin = (
      over: { token: string } | { hello: BridgeHello },
      what: string,
    ): Promise<PluginTokenResult> => {
      const run = swapping.then(async (): Promise<PluginTokenResult> => {
        if (!plugin) return { ok: false, reason: "fake plugin not started" };
        try {
          await plugin.reconnect(over);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          app?.logger.warn({ reason }, `dev:fake plugin ${what} rejected`);
          return { ok: false, reason };
        }
        app?.logger.info({ tokenId: pluginTokenId(app) }, `dev:fake plugin reconnected with ${what}`);
        return { ok: true };
      });
      swapping = run;
      return run;
    };
    const live: App = app;
    const connectRunner = (token: string) =>
      startFakeRunner({ url: live.url, token, script: fakeRunnerScript });
    // 러너 끊기·붙이기도 한 번에 하나씩
    let runnerSwapping: Promise<unknown> = Promise.resolve();
    const setRunner = (input: { connected: boolean; token?: string | undefined }): Promise<unknown> => {
      const run = runnerSwapping.then(async () => {
        if (!input.connected) {
          if (!runner?.connected) return { ok: true, status: claudeOf(live).status() };
          const before = runnersConnected(live);
          runner.disconnect();
          const reached = await waitForRunners(live, (n) => n < before, RUNNER_HOOK_TIMEOUT_MS);
          live.logger.info({ reached }, "dev:fake runner disconnected");
          return reached
            ? { ok: true, status: claudeOf(live).status() }
            : { ok: false, reason: "timeout", status: claudeOf(live).status() };
        }
        if (runner?.connected && input.token === undefined)
          return { ok: true, status: claudeOf(live).status() };
        try {
          if (runner) await runner.reconnect(input.token === undefined ? {} : { token: input.token });
          else runner = await connectRunner(input.token ?? DEV_FAKE_RUNNER_TOKEN);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          live.logger.warn({ reason }, "dev:fake runner connect rejected");
          return { ok: false, reason };
        }
        live.logger.info("dev:fake runner connected");
        return { ok: true, status: claudeOf(live).status() };
      });
      runnerSwapping = run;
      return run;
    };
    interceptDevFakeRoutes(
      live,
      new Map([
        [
          DEV_FAKE_PLUGIN_TOKEN_PATH,
          route(PluginTokenInput, "{ token: string }", ({ token }) =>
            reconnectPlugin({ token }, "swapped token"),
          ),
        ],
        [
          DEV_FAKE_PLUGIN_CAPABILITIES_PATH,
          route(PluginCapabilitiesInput, "{ threads: boolean }", async ({ threads }) => {
            const hello = threads ? FAKE_PLUGIN_HELLO : OLD_PLUGIN_HELLO;
            const result = await reconnectPlugin({ hello }, threads ? "threads hello" : "old hello");
            return result.ok ? { ok: true, capabilities: hello.capabilities } : result;
          }),
        ],
        [
          DEV_FAKE_OPS_EVENT_PATH,
          route(OpsEventInput, "{ kind, key, severity, detail? }", async (input) => {
            const event = live.ops.record(input);
            if (!event) throw new Error("app.ops.record returned null — see the ops record log line");
            return { ok: true, event };
          }),
        ],
        [
          DEV_FAKE_GATEWAY_PATH,
          route(GatewayInput, '{ state: "down" | "connected" }', async ({ state }) => {
            gateway.setAccepting(state === "connected");
            const reached = await waitForGateway(
              live,
              (g) => (state === "connected" ? g === "connected" : g !== "connected"),
              GATEWAY_HOOK_TIMEOUT_MS,
            );
            live.logger.info({ state, reached }, "dev:fake gateway hook");
            return reached
              ? { ok: true, status: openclawOf(live).status() }
              : { ok: false, reason: "timeout", status: openclawOf(live).status() };
          }),
        ],
        [DEV_FAKE_RUNNER_PATH, route(RunnerInput, "{ connected: boolean, token?: string }", setRunner)],
        [
          DEV_FAKE_DISK_PATH,
          route(DiskInput, "{ freeBytes, totalBytes } | { reset: true }", async (input) => {
            fakeDisk = "reset" in input ? undefined : input;
            return { ok: true, disk: await live.checkDisk() };
          }),
        ],
      ]),
    );
    await app.fastify.listen({ host, port });
    // app.url 은 리슨 주소와 무관하게 127.0.0.1 — 0.0.0.0 으로 들어도 가짜 플러그인은 루프백으로 붙는다
    plugin = await startFakePlugin({ bridgeUrl: app.url, token: DEV_FAKE_BRIDGE_TOKEN });
    const scenarioAgents: Record<string, ScenarioAgent> = {};
    for (const id of AGENT_IDS) scenarioAgents[id] = ({ delivery }) => fakeAgentScript(id, delivery);
    createScenario({ gateway, plugin, agents: scenarioAgents });
    try {
      runner = await connectRunner(DEV_FAKE_RUNNER_TOKEN);
    } catch (error) {
      // --keep 으로 폐기된 고정 토큰을 이어받았으면 여기 — 서버는 그대로 뜬다
      const reason = error instanceof Error ? error.message : String(error);
      app.logger.warn(
        { reason },
        "dev:fake runner could not connect — POST /__devfake/runner { connected: true, token }",
      );
    }
    // adapter.connect() 는 기다리지 않는다 — 돌려주자마자 discover·전송이 되게
    await waitForAdapterConnected(app);
    return { app, url: app.url, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opts = devFakeCliOptions(process.env, process.argv);
  const dev = await startDevFake(opts);
  dev.app.logger.info(
    {
      url: dev.url,
      web: opts.appOrigin,
      loginToken: DEV_FAKE_LOCAL_TOKEN,
      memberEmail: DEV_FAKE_MEMBER_EMAIL,
      memberPassword: DEV_FAKE_MEMBER_PASSWORD,
      runnerToken: DEV_FAKE_RUNNER_TOKEN,
      gatewayId: DEV_FAKE_GATEWAY_ID,
      runnerAgent: FAKE_RUNNER_AGENT.id,
      web5180:
        "PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake + DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web dev --port 5180",
    },
    "dev:fake 서버 — 웹은 pnpm -F @dodok/web dev(5173 이 차 있으면 web5180 처럼), 로그인 토큰·고정 member 계정(mia)은 개발 전용 고정값",
  );
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1); // 두 번째 신호는 기다리지 않는다
    stopping = true;
    void dev.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
