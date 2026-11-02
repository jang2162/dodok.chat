/**
 * 가짜 에이전트 개발 모드 — 가짜 Gateway·가짜 플러그인·대본을 묶어 서버를 띄운다. 모델 런·실제 Gateway 없이 웹 전체를 돌린다(웹 MVP 스펙 9.2).
 * 테스트와 같은 가짜(`test/fakes/*`)를 쓴다. 운영 코드(`src/`)는 그대로 — 실제 OpenClawAdapter 가 가짜 Gateway 를 붙는다.
 * 가짜 Gateway 는 둘이다(멀티 Gateway 스펙 「테스트·검증」 절, `DEV_FAKE_GATEWAYS`): 「사무실」(에이전트 dev·fin)·「집」(main·dev — dev 가 일부러 겹친다).
 * 시작 때 둘을 DB 에 넣고(연결 페이지 「Gateway 추가」와 같은 행, 고정 id — `--keep` 이면 주소·토큰만 이번 가짜로 바꾼다) Gateway 마다
 * 고정 브리지 토큰 행·가짜 플러그인·대본을 하나씩 둔다. OpenClaw 에이전트도 시작 때 등록한다 — 핸들 dev·fin(사무실)·main·dev-home(집),
 * 그 핸들이 이미 있거나 그 Gateway 에 같은 id 가 있으면 그대로 둔다. DB 에 넣지 않은 셋째 가짜 Gateway 를 하나 더 열어 그 주소·토큰을
 * 시작 로그(`spareGateway`)에 찍는다 — 화면의 「Gateway 추가」로 붙여 본다.
 *
 * .env 를 읽지 않는다: 토큰·비밀은 아래 개발 전용 고정값이고(로그에 찍어도 된다), loadConfig 에는 여기서 정한 값만 넘긴다.
 * 고정 member 계정(이메일 member@dodok.local·비밀번호 dev-fake-member-password·핸들 mia)도 owner 와 함께 보장한다 —
 * `--keep` 이면 이미 있을 때 그대로. 운영 `createApp` 에는 없다.
 * DB 는 <dataDir>/dev-fake.sqlite — 시작마다 새로, `--keep` 이면 유지. 실행: `PORT=0 pnpm -F @dodok/server dev:fake [--keep]`.
 * VAPID 키 <dataDir>/vapid.json 은 지우지 않는다 — 새로 만들면 브라우저의 푸시 구독이 매번 무효가 된다.
 * 웹 오리진은 APP_ORIGIN(없으면 http://localhost:5173). 5173 이 차 있으면 5180 으로:
 * `PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake` + `DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web dev --port 5180`.
 * 개발 전용 훅(owner 세션, `content-type: application/json`, 경로 정확 일치 — 운영 `createApp` 에는 없다). Gateway 를 고르는 훅은
 * `gatewayId`(사무실·집의 고정 id)가 없거나 그 둘이 아니면 400:
 * - `POST /__devfake/plugin-token { gatewayId, token }` — 그 Gateway 가짜 플러그인의 브리지 토큰을 바꿔 다시 붙인다(다른 Gateway 의
 *   토큰이면 400 — 짝이 섞이지 않게. DB 에 없는 토큰은 받아 UNAUTHORIZED 를 돌려준다)
 * - `POST /__devfake/ops/event { kind, key, severity, detail? }` — 운영 사건을 `app.ops.record` 로 남긴다
 * - `POST /__devfake/gateway { gatewayId, state: "down" | "connected" }` — 그 가짜 Gateway 를 끊고 붙인다(어댑터 status 가 실제로 바뀐다)
 * - `POST /__devfake/disk { freeBytes, totalBytes } | { reset: true }` — 디스크 감시가 그 값을 보게 하고 곧바로 다시 잰다
 * - `POST /__devfake/plugin-capabilities { gatewayId, threads: boolean }` — false 면 그 Gateway 플러그인이 threads 없는 hello 로 다시
 *   붙는다(옛 플러그인 흉내), true 면 되돌린다
 * - `POST /__devfake/runner { connected: boolean, token?, runner?: "main" | "limited", maxPermissionMode?, roots? }` — 가짜 러너를
 *   끊고(false) 붙인다(true, token 을 주면 그 러너 토큰으로). runner 는 기본 main. roots(그 러너의 고정 루트 id 가운데 알릴 것)·
 *   maxPermissionMode(Claude Code 상한)를 주면 그 hello 로 다시 붙는다 — 머신 주인이 설정을 바꾼 것처럼(다음 바꿈까지 남는다)
 * 가짜 러너(`test/fakes/fake-runner.ts`) 둘도 붙는다(`DEV_FAKE_RUNNERS`). 「dev-fake」(고정 토큰 `dev-fake-runner-token`)는 루트
 * src·work, Claude Code(상한 acceptEdits)와 「설치되지 않음」 Codex 를 알리고 둘러보기에 고정 나무(`devFakeRunnerTree`)를 낸다 —
 * 그 러너의 프로젝트 `src/dodok` 와 러너 에이전트 `coder`(프로그램 claude)를 만들어 둔다. 「dev-fake 제한」(`dev-fake-runner-token-limited`)
 * 은 루트 sandbox·src(첫 러너와 같은 자리 dodok·notes — 옮기기), Claude Code 상한 plan·둘러보기 꺼짐이고 프로젝트 `sandbox/demo` 만 둔다. 두 러너 모두 실제 러너처럼 런마다 천장을
 * 본다(걸리면 RUNNER_CEILING 카드). 토큰 행은 고정 id 로 찾는다 — 연결 페이지에서 「다시 발급」하면 그 자리에서는 새 원문을 훅 token
 * 으로 주어 붙이고, `--keep` 으로 다시 띄우면 고정 토큰으로 되돌아 붙는다(프로젝트·coder 는 그 러너에 남는다). 가짜 러너는 스스로 다시
 * 붙지 않는다 — 끊기 뒤에는 훅으로 붙인다. 폐기한 러너 토큰은 되살리지 않는다(그 러너의 런은 ADAPTER_UNAVAILABLE).
 * 끊김 사건 임계는 DODOK_DEVFAKE_DISCONNECT_MS(기본 운영과 같은 60초)로 줄인다. 종료 표지는 <dataDir>/dev-fake-run/ 에 둔다.
 * 보관하지 않은 채널이 하나도 없으면(새 DB) 씨앗 채널 `DEV_FAKE_CHANNEL_NAME`(에이전트 dev·coder)을 만들고 그 채널에만 세션 둘을 넣는다
 * (채널 세션 계획 태스크 8) — 마이그레이션이 만드는 꼴의 「이전 대화」(id = 채널 id)와 새 세션 하나(`DEV_FAKE_SESSION_TITLE`), owner 글 하나씩.
 * `--keep` 으로 이어받은 채널(씨앗·UI 로 만든 것·보관한 것)은 건드리지 않는다 — 실제 서버에서도 0025 뒤 만든 채널에는 「이전 대화」가 없다.
 * 사무실 에이전트 dev 는 처음 등록할 때 dmAccess `everyone`(member mia 도 DM 을 연다), 나머지는 기본(admins). 씨앗 채널을 만든 시작에서만
 * mia ↔ dev DM 에 세션 하나를 둔다 — mia 글 하나(`DEV_FAKE_DM_TEXT`)를 서버 저장·라우터 경로로 보내고 가짜 대본의 답이 올 때까지 기다린다.
 * 인바운드 로그 줄(`dev:fake inbound reactions`)은 DM 런이면 헤더의 DM 줄(`dm`)과 세션 줄(`session`)도 싣는다.
 */
import {
  type AdapterStatus,
  type AgentAdapter,
  type ApprovalDecision,
  BridgeHello,
  type DmAccess,
  formatDmLine,
  formatSessionLine,
  type GatewayLinkState,
  type InboundDeliver,
  type OpenClawGatewayStatus,
  OpsEvent,
  OpsEventKind,
  OpsSeverity,
  type RunnerHello,
  RunnerPermissionMode,
  type RunnerProgramStatus,
  type RunnerProjectRef,
  RunnerRootId,
} from "@dodok/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { statfs as fsStatfs } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { type App, type AppDeps, createApp, ensureWorkspace } from "../src/app";
import { loadConfig } from "../src/config";
import { createDb, type DbOrTx } from "../src/db/client";
import {
  agents,
  bridgeTokens,
  channels,
  conversations,
  gateways,
  runnerTokens,
  users,
} from "../src/db/schema.sqlite";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createConversation } from "../src/modules/conversations/store";
import { resolveSendConversation } from "../src/modules/conversations/service";
import { findOrCreateDm } from "../src/modules/dms/service";
import { createUserMessage, sendUserMessage } from "../src/modules/messages/service";
import {
  agentNotArchived,
  createAgent,
  isAgentActive,
  providerAgentIdIs,
  updateAgent,
} from "../src/modules/agents/service";
import { hasGateways } from "../src/adapters/types";
import { getGatewayRow } from "../src/modules/gateways/service";
import { createProject, listProjects } from "../src/modules/runners/projects";
import { acceptInvite, normalizeEmail } from "../src/modules/members/accept";
import { issueInvite } from "../src/modules/members/invites";
import { DISCONNECT_EVENT_MS, startRunState } from "../src/modules/ops/health";
import { type FakeGateway, startFakeGateway } from "../test/fakes/fake-gateway";
import { FAKE_PLUGIN_HELLO, type FakePlugin, startFakePlugin } from "../test/fakes/fake-plugin";
import {
  FAKE_CLAUDE_PROGRAM,
  FAKE_RUNNER_ROOT,
  type FakeNode,
  type FakeRunner,
  type FakeRunnerRun,
  type FakeTree,
  startFakeRunner,
} from "../test/fakes/fake-runner";
import {
  createScenario,
  type ScenarioAgent,
  type ScenarioApproval,
  type ScenarioScript,
} from "../test/fakes/scenario";
import { makePng, PDF_BYTES } from "../test/helpers/png";

const DEFAULT_APP_ORIGIN = "http://localhost:5173";
/** 개발 전용 고정 로그인 토큰(= owner 비밀번호). 시크릿이 아니다 — 로그에 찍는다 */
export const DEV_FAKE_LOCAL_TOKEN = "dev-fake-local-token";
const DEV_FAKE_SECRET = "dev-fake-better-auth-secret-00000000";
/**
 * 개발 전용 고정 브리지 토큰(시크릿이 아니다) — Gateway 마다 하나. 시작 때 그 Gateway 에 묶인 토큰 행(라벨 dev-fake)으로 넣는다 —
 * 실제 토큰(`dbt_` + 43자)과 모양이 달라도 핸드셰이크는 해시만 본다
 */
export const DEV_FAKE_OFFICE_BRIDGE_TOKEN = "dev-fake-bridge-token-office";
export const DEV_FAKE_HOME_BRIDGE_TOKEN = "dev-fake-bridge-token-home";
/** 가짜 Gateway 둘의 DB 행 id(= 어댑터 연결 id) — `--keep` 으로 다시 띄워도 같은 행이다 */
export const DEV_FAKE_OFFICE_GATEWAY_ID = "00000000-0000-4000-8000-00000000def1";
export const DEV_FAKE_HOME_GATEWAY_ID = "00000000-0000-4000-8000-00000000def2";

export type DevFakeGatewaySpec = {
  id: string;
  name: string;
  bridgeToken: string;
  /** 가짜 Gateway `agents.list` 의 id 와 시작 때 등록할 핸들 — 이 id 마다 대본을 건다. dmAccess 는 처음 등록할 때만(없으면 기본) */
  agents: ReadonlyArray<{ id: string; handle: string; dmAccess?: DmAccess }>;
};

/** 「사무실」·「집」 — 같은 id dev 가 두 Gateway 에 있다(집 dev 의 핸들은 dev-home) */
export const DEV_FAKE_GATEWAYS: readonly DevFakeGatewaySpec[] = [
  {
    id: DEV_FAKE_OFFICE_GATEWAY_ID,
    name: "사무실",
    bridgeToken: DEV_FAKE_OFFICE_BRIDGE_TOKEN,
    agents: [
      { id: "dev", handle: "dev", dmAccess: "everyone" },
      { id: "fin", handle: "fin" },
    ],
  },
  {
    id: DEV_FAKE_HOME_GATEWAY_ID,
    name: "집",
    bridgeToken: DEV_FAKE_HOME_BRIDGE_TOKEN,
    agents: [
      { id: "main", handle: "main" },
      { id: "dev", handle: "dev-home" },
    ],
  },
];
/** 고정 member 계정(팀 스펙 태스크 7a) — 시크릿이 아닌 개발 전용 고정값이라 owner 토큰과 같이 로그에 찍는다 */
export const DEV_FAKE_MEMBER_EMAIL = "member@dodok.local";
export const DEV_FAKE_MEMBER_PASSWORD = "dev-fake-member-password";
export const DEV_FAKE_MEMBER_HANDLE = "mia";
export const DEV_FAKE_MEMBER_DISPLAY_NAME = "미아";
/** 새 DB 의 씨앗 채널 — 세션 둘을 들고 시작한다(`ensureDevFakeSessions`) */
export const DEV_FAKE_CHANNEL_NAME = "세션";
export const DEV_FAKE_CHANNEL_AGENTS = ["dev", "coder"] as const;
/** 마이그레이션(0025)이 기존 채널에 만든 대화와 같은 제목 */
export const DEV_FAKE_LEGACY_TITLE = "이전 대화";
export const DEV_FAKE_SESSION_TITLE = "dev:fake 새 세션";
/** 씨앗 DM(mia ↔ 사무실 dev)의 첫 글 — 키워드가 없어 대본은 기본 답(인용)을 낸다. 세션 제목은 이 글의 자동 제목 */
export const DEV_FAKE_DM_AGENT = "dev";
export const DEV_FAKE_DM_TEXT = "DM 은 처음이에요 — 이 세션은 나만 보죠?";
/** 씨앗 DM 의 답을 기다리는 상한 — 대본 답은 델타 넷(150ms 간격)이라 보통 1초 안이다 */
const DM_SEED_TIMEOUT_MS = 10_000;
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
 * 개발 전용 — `POST { gatewayId, token }` 이면 그 Gateway 의 가짜 플러그인을 끊고 그 토큰으로 다시 붙인다(연결 페이지의 토큰 교체를
 * 브라우저로 잴 때).
 * dev:fake 에만 있다 — 운영 `createApp` 에는 없다. owner 세션(쿠키 또는 Bearer)이 있어야 한다
 */
export const DEV_FAKE_PLUGIN_TOKEN_PATH = "/__devfake/plugin-token";
/** 개발 전용 — 운영 사건 하나를 `app.ops.record` 로 남긴다(ops_events 를 직접 쓰지 않는다 — unacked 캐시·ops.event 팬아웃이 함께 돈다) */
export const DEV_FAKE_OPS_EVENT_PATH = "/__devfake/ops/event";
/** 개발 전용 — 고른 가짜 Gateway 를 끊고(down) 붙인다(connected). 어댑터가 실제로 끊겨 끊김 감시(watchConnections)가 돈다 */
export const DEV_FAKE_GATEWAY_PATH = "/__devfake/gateway";
/** 개발 전용 — 디스크 감시가 볼 여유·전체 바이트를 정하거나(reset 이면 실제 statfs 로) 곧바로 다시 잰다 */
export const DEV_FAKE_DISK_PATH = "/__devfake/disk";
/** 개발 전용 — 고른 Gateway 의 가짜 플러그인을 끊고 hello capabilities 의 threads 를 빼거나(false, 옛 플러그인) 되돌려(true) 다시 붙인다 */
export const DEV_FAKE_PLUGIN_CAPABILITIES_PATH = "/__devfake/plugin-capabilities";
/** 개발 전용 — 가짜 러너를 끊고(connected false) 붙인다(true — token 을 주면 그 러너 토큰으로 바꿔 붙는다) */
export const DEV_FAKE_RUNNER_PATH = "/__devfake/runner";
/**
 * 개발 전용 고정 러너 토큰(시크릿이 아니다 — 로그에 찍는다). 실제 토큰(`drn_` + 43자)과 모양이 달라도 핸드셰이크는 해시만 본다 —
 * 연결 페이지 목록에는 앞 6자(`dev-fa`)가 보인다
 */
export const DEV_FAKE_RUNNER_TOKEN = "dev-fake-runner-token";
/** 고정 러너 토큰의 라벨 — 등록 목록 hint 가 `dev-fake · dodok · sonnet` */
export const DEV_FAKE_RUNNER_LABEL = "dev-fake";
/** 가짜 러너의 에이전트 — providerAgentId 는 서버가 짓는다(r-…). 씨앗 채널·로그는 핸들로 찾는다 */
export const DEV_FAKE_RUNNER_AGENT = { handle: "coder", name: "Coder", relPath: "dodok" } as const;
/**
 * 러너 토큰 행의 고정 id — 행은 해시가 아니라 이 id 로 찾는다. 연결 페이지에서 「다시 발급」한 뒤 `--keep` 으로 다시 띄워도 같은 행이
 * 고정 토큰으로 돌아와(해시·접두사만 되돌린다) 프로젝트·coder 가 그 러너에 남는다
 */
export const DEV_FAKE_RUNNER_ID = "00000000-0000-4000-8000-00000000fa01";
/**
 * 둘째 가짜 러너(「dev-fake 제한」) — Claude Code 상한 plan·허용 도구 상한 셋·둘러보기 꺼짐. 상한 아래 처음 값과 직접 입력을 본다.
 * 루트 src 에 첫 러너와 같은 자리(dodok·notes)가 있어 프로젝트 「옮기기」가 된다(coder 는 상한 plan 밖이라 dodok 은 400)
 */
export const DEV_FAKE_LIMITED_RUNNER_TOKEN = "dev-fake-runner-token-limited";
export const DEV_FAKE_LIMITED_RUNNER_LABEL = "dev-fake 제한";
export const DEV_FAKE_LIMITED_RUNNER_ID = "00000000-0000-4000-8000-00000000fa02";

/** 「설치되지 않음」 Codex 줄 — 에이전트 추가에서 흐리게 보인다 */
const DEV_FAKE_CODEX_MISSING: RunnerProgramStatus = {
  program: "codex",
  available: false,
  auth: "unknown",
  reason: "설치되지 않음",
  capabilities: [],
  ceiling: { maxPermissionMode: "default", allowedToolsCeiling: null },
};

/** 이름에 `&`·`#`·`%`·공백·`\` 가 든 디렉터리 — 둘러보기 주소 인코딩을 본다. `\` 는 relPath 규칙 밖이라 고르면 거절된다 */
export const DEV_FAKE_SPECIAL_DIRS = ["a&b", "#x", "50%", "a b", "a\\b"] as const;
/** 둘러보기 상한(500)을 넘는 디렉터리의 하위 수 — truncated 안내를 본다 */
const DEV_FAKE_MANY_DIRS = 600;

/**
 * 가짜 러너 「dev-fake」의 디렉터리 나무 — git 저장소(dodok·website·client-a)·일반 디렉터리(notes)·하위가 500 넘는 many·특수 문자
 * 이름·숨김(.config — 둘러보기에 없고 경로를 적으면 된다)·루트 밖 링크(escape — 둘러보기에 없고 확인은 outside_root)·파일(README.md)
 */
export function devFakeRunnerTree(): FakeTree {
  const many: Record<string, FakeNode> = {};
  for (let i = 1; i <= DEV_FAKE_MANY_DIRS; i++) many[`dir-${String(i).padStart(3, "0")}`] = {};
  const special: Record<string, FakeNode> = {};
  for (const name of DEV_FAKE_SPECIAL_DIRS) special[name] = { children: { inner: {} } };
  return {
    src: {
      children: {
        dodok: { git: true, children: { apps: {}, packages: {}, docs: {}, ".github": {} } },
        website: { git: true },
        notes: { children: { "2026": {}, ideas: {} } },
        many: { children: many },
        ...special,
        ".config": { children: { dodok: {} } },
        escape: "outside",
        "README.md": "file",
      },
    },
    work: {
      children: {
        "client-a": { git: true, children: { api: {}, web: {} } },
        "client-b": {},
        archive: {},
      },
    },
  };
}

/** 가짜 러너 하나 — 훅 `runner` 로 고른다 */
export type DevFakeRunnerSpec = {
  key: "main" | "limited";
  id: string;
  token: string;
  label: string;
  hello: Partial<RunnerHello>;
  tree: () => FakeTree;
  /** 행을 처음 만들 때 함께 만드는 프로젝트(에이전트 없음) — coder 의 프로젝트는 `ensureDevFakeRunner` 가 따로 */
  seedProject?: RunnerProjectRef;
};

export const DEV_FAKE_RUNNERS: readonly DevFakeRunnerSpec[] = [
  {
    key: "main",
    id: DEV_FAKE_RUNNER_ID,
    token: DEV_FAKE_RUNNER_TOKEN,
    label: DEV_FAKE_RUNNER_LABEL,
    hello: {
      roots: [{ ...FAKE_RUNNER_ROOT }, { id: "work", label: "회사" }],
      browse: true,
      // 평소 로그인 — 러너 카드의 「(평소 로그인)」을 손으로 본다. 제한 러너는 전용
      programs: [{ ...FAKE_CLAUDE_PROGRAM, login: "default" }, DEV_FAKE_CODEX_MISSING],
    },
    tree: devFakeRunnerTree,
  },
  {
    key: "limited",
    id: DEV_FAKE_LIMITED_RUNNER_ID,
    token: DEV_FAKE_LIMITED_RUNNER_TOKEN,
    label: DEV_FAKE_LIMITED_RUNNER_LABEL,
    hello: {
      roots: [
        { id: "sandbox", label: "샌드박스" },
        { id: "src", label: "내 저장소들" },
      ],
      browse: false,
      programs: [
        {
          ...FAKE_CLAUDE_PROGRAM,
          login: "dedicated",
          ceiling: { maxPermissionMode: "plan", allowedToolsCeiling: ["Read", "Grep", "Glob"] },
        },
      ],
    },
    tree: () => ({
      sandbox: { children: { demo: { git: true }, scratch: {} } },
      src: { children: { dodok: { git: true }, notes: {} } },
    }),
    seedProject: { rootId: "sandbox", relPath: "demo" },
  },
];
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
export const DEV_FAKE_GATEWAY_BACKOFF = { initialMs: 250, maxMs: 1_000 };
/** 400 응답 문구에 싣는 고를 수 있는 gatewayId */
const GATEWAY_IDS_USAGE = DEV_FAKE_GATEWAYS.map((g) => `"${g.id}"`).join(" | ");
/** 시작 때 고정 짝이 붙기를 기다리는 상한 */
const FAKE_PAIRS_TIMEOUT_MS = 5_000;
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
  logLevel?: DevFakeLogLevel;
  /** 웹 오리진(wire 핸드셰이크 Origin 검사). 기본 http://localhost:5173 */
  appOrigin?: string;
  /** 리슨 주소. 기본 127.0.0.1 — 컨테이너 안에서 띄워 바깥에서 닿게 하려면 0.0.0.0 */
  host?: string;
  /** 웹 푸시 발송기. 기본은 실제 web-push(dev:fake 로 브라우저 푸시를 본다) — 테스트는 가짜를 줘 밖으로 보내지 않는다 */
  pushSend?: AppDeps["pushSend"];
  /** 끊김 사건 임계(기본 운영과 같은 DISCONNECT_EVENT_MS) — 브라우저 검증이 60초를 기다리지 않게 줄인다 */
  disconnectEventMs?: number;
};

const DEV_FAKE_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
type DevFakeLogLevel = (typeof DEV_FAKE_LOG_LEVELS)[number];

/** LOG_LEVEL — 없거나 비었으면 info, 모르는 이름이면 시작하지 않는다(운영 설정 config.ts 와 같은 이름들) */
function logLevelFromEnv(raw: string | undefined): DevFakeLogLevel {
  if (!raw) return "info";
  const level = DEV_FAKE_LOG_LEVELS.find((l) => l === raw);
  if (level === undefined)
    throw new Error(`LOG_LEVEL must be one of ${DEV_FAKE_LOG_LEVELS.join("|")}: ${raw}`);
  return level;
}

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
 * 끊김 사건 임계는 DODOK_DEVFAKE_DISCONNECT_MS(없으면 60초), 로그 레벨은 LOG_LEVEL(없거나 비었으면 info — debug 로 푸시 건너뜀 줄을 본다).
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
    logLevel: logLevelFromEnv(env.LOG_LEVEL),
  };
}
export type DevFake = {
  app: App;
  url: string;
  /** DB 에 넣지 않은 셋째 가짜 Gateway — 연결 페이지 「Gateway 추가」에 넣을 주소·공유 토큰 */
  spareGateway: { url: string; token: string };
  close(): Promise<void>;
};

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
  "제어",
  "구독",
  "천장",
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
/** 러너 대본 「제어」가 바꾸는 채널 주제·「제어 프롬프트」가 넣는 채널 프롬프트 — 키워드를 담지 않는다(채널 설정에 남아 다음 런에 실린다) */
export const RUNNER_CONTROL_TOPIC = "dev:fake 에이전트가 바꾼 주제";
export const RUNNER_CONTROL_PROMPT = "dev:fake 에이전트가 넣은 채널 프롬프트";
/** 러너 대본의 사용량 — 운영 화면이 Claude 런의 토큰·비용을 더한다(「구독」이면 공시 단가 환산값) */
const RUNNER_USAGE = { inputTokens: 1_200, outputTokens: 80 };
const RUNNER_COST_USD = 0.02;

/** ms 만큼 쉰다 — 런이 중지되면 곧바로 풀린다 */
const pauseOrAbort = (run: FakeRunnerRun, ms: number) =>
  Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms)), run.aborted]);

/**
 * 가짜 러너(에이전트 coder)의 대본. 답 글·델타·간격·릴레이 꼬리는 `fakeAgentScript` 와 같다(「오래」·「느리게」도 그대로) —
 * 늘 도구 하나(Read)를 먼저 부르고, 러너 키워드: 천장(도구 없이 run.error RUNNER_CEILING permissionMode — 천장 카드)·
 * 승인(도구 승인 카드 — 허용이면 Bash 도구가 돈다)·게시(post 로 글 + 카드)·
 * 제어(제어 도구 update_channel 로 채널 주제를 바꾼다 — 시킨 사람에게 확인 카드, 「제어 프롬프트」면 admin 이상만 되는 set_channel_prompt)·
 * 구독(비용을 subscription_estimate 로)·실패(run.error). 그 밖의 키워드(카드·첨부·드롭 등)는 OpenClaw 가짜 에이전트 몫이다.
 * 중지되면 더 보내지 않는다 — 가짜 러너가 `stopReason: "aborted"` 로 끝낸다
 */
export async function fakeRunnerScript(run: FakeRunnerRun): Promise<void> {
  const d = run.start.deliver;
  const { text } = d.message;
  const script = fakeAgentScript(DEV_FAKE_RUNNER_AGENT.handle, d);
  // 실제 러너는 천장에 걸리면 아무것도 돌리지 않고 항목 이름만 보낸다 — 도구보다 먼저
  if (text.includes("천장")) {
    run.error("RUNNER_CEILING", "permissionMode");
    return;
  }
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
  if (text.includes("제어")) {
    // 쓰기 도구 하나 — 서버가 시킨 사람에게 확인 카드를 띄우고 결정까지 ack 를 미룬다. 서버 문구는 키워드를 담을 수 있어 인용으로 싣는다
    const prompt = text.includes("프롬프트");
    const result = prompt
      ? await run.control("set_channel_prompt", { channelId: d.channelId, prompt: RUNNER_CONTROL_PROMPT })
      : await run.control("update_channel", { channelId: d.channelId, topic: RUNNER_CONTROL_TOPIC });
    if (run.isAborted) return;
    const what = prompt ? "채널 프롬프트" : "채널 주제";
    lines.push(
      result.ok
        ? `${what}를 바꿨습니다.`
        : `${what}를 바꾸지 못했습니다(${result.error.code}) — 「${result.error.message}」`,
    );
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

/**
 * 가짜 Gateway·러너가 받은 인바운드의 반응을 한 줄로 — 「에이전트 답에 단 반응이 다음 런에 실리고 그다음 런에는 없다」를
 * 브라우저 검증이 이 줄로 본다. 반응이 없어도 찍는다(빈 배열이 「그다음 런에는 없음」의 증거다).
 * 보낸 사람(`sender` = 플러그인의 senderId 꼴 `<type>:<handle>`)도 싣는다 — 자동화 글이 `system:automation` 으로 가는지 본다
 */
function logInboundReactions(app: App, connection: string, d: InboundDeliver): void {
  app.logger.info(
    {
      connection,
      agentId: d.agentId,
      runId: d.runId,
      threadId: d.threadId,
      sender: `${d.message.author.type}:${d.message.author.handle}`,
      senderName: d.message.author.displayName,
      reactions: (d.context.reactions ?? []).map((r) => `@${r.by} ${r.emoji} ${r.messageId} "${r.excerpt}"`),
      reactionsOmitted: d.context.reactionsOmitted,
      // 헤더에 실릴 줄 — 가짜 플러그인·러너는 헤더를 만들지 않으므로 같은 shared 함수로 그 줄을 찍는다(DM 런만 dm)
      ...(d.dm ? { dm: formatDmLine(d.dm.ownerHandle) } : {}),
      session: formatSessionLine(d.conversationTitle),
      participants: d.context.participants.map((p) => p.handle),
    },
    "dev:fake inbound reactions",
  );
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
/** 모양은 맞지만 받을 수 없는 값 — 400 과 그 까닭 */
class Rejected {
  constructor(readonly message: string) {}
}

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

const GatewayIdInput = z.string().min(1);
const PluginTokenInput = z.object({ gatewayId: GatewayIdInput, token: z.string().min(1) });
const PluginCapabilitiesInput = z.strictObject({ gatewayId: GatewayIdInput, threads: z.boolean() });
/** key·detail 모양은 shared OpsEvent 그대로(key 는 비지 않게) — record 가 거절할 것을 여기서 400 으로 먼저 돌려준다 */
const OpsEventInput = z.strictObject({
  kind: OpsEventKind,
  key: OpsEvent.shape.key.min(1),
  severity: OpsSeverity,
  detail: OpsEvent.shape.detail.optional(),
});
const GatewayInput = z.strictObject({ gatewayId: GatewayIdInput, state: z.enum(["down", "connected"]) });
const RunnerInput = z.strictObject({
  connected: z.boolean(),
  token: z.string().min(1).optional(),
  runner: z.enum(["main", "limited"]).optional(),
  maxPermissionMode: RunnerPermissionMode.optional(),
  roots: z.array(RunnerRootId).optional(),
});
type RunnerInput = z.infer<typeof RunnerInput>;
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
 * 훅 하나를 받는다. 세션은 앱의 `/api/v1/auth/me` 에 같은 헤더로 물어 판정한다 — 401 이면 그 응답을 그대로, owner 가 아니면
 * 앱의 requireOwner 와 같은 403 을 돌려준다(`/setup/status` 는 멤버 누구나 걸러 받게 되어 가드로 쓸 수 없다 — 연결 탭 통합 스펙
 * 5.3). 본문은 판정 뒤에 읽는다
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
    url: "/api/v1/auth/me",
    headers: { ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  });
  if (guard.statusCode !== 200) {
    res
      .writeHead(guard.statusCode, { "content-type": String(guard.headers["content-type"]) })
      .end(guard.body);
    return;
  }
  if ((guard.json() as { role?: unknown }).role !== "owner") {
    req.resume();
    sendJson(res, 403, { code: "FORBIDDEN", message: "owner 만 쓸 수 있다" });
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
  if (result instanceof Rejected) {
    sendJson(res, 400, { code: "VALIDATION", message: result.message });
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

/** 그 토큰 원문의 브리지 토큰 행이 묶인 Gateway id(폐기된 행 포함) — 행이 없으면 undefined */
function bridgeTokenGatewayId(app: App, token: string): string | undefined {
  const hash = createHash("sha256").update(token).digest("hex");
  return app.db
    .select({ gatewayId: bridgeTokens.gatewayId })
    .from(bridgeTokens)
    .where(eq(bridgeTokens.hash, hash))
    .get()?.gatewayId;
}

/** 그 Gateway 에 붙은 가짜 플러그인이 통과한 브리지 토큰 id — 로그용 */
function pluginTokenId(app: App, gatewayId: string): string | null | undefined {
  const adapter = openclawOf(app);
  if (!hasGateways(adapter)) return undefined;
  return adapter.gatewaySetupDetails().find((g) => g.id === gatewayId)?.bridge.plugin?.tokenId;
}

/** 어댑터 상태에서 그 Gateway 의 줄 — 목록에 없으면 undefined */
function fakeGatewayLine(status: AdapterStatus, gatewayId: string): OpenClawGatewayStatus | undefined {
  return status.provider === "openclaw" ? status.gateways.find((g) => g.id === gatewayId) : undefined;
}

/** 그 Gateway 의 상태 — 목록에 없으면 undefined */
function fakeGatewayState(status: AdapterStatus, gatewayId: string): GatewayLinkState | undefined {
  return fakeGatewayLine(status, gatewayId)?.gateway;
}

/** 그 Gateway 의 상태가 want 를 만족할 때까지 기다린다 — timeoutMs 가 지나면 false */
function waitForGateway(
  app: App,
  gatewayId: string,
  want: (state: GatewayLinkState | undefined) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (want(fakeGatewayState(openclawOf(app).status(), gatewayId))) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, timeoutMs);
    const off = openclawOf(app).onEvent((e) => {
      if (e.kind !== "status" || !want(fakeGatewayState(e.status, gatewayId))) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/**
 * 가짜 플러그인이 붙은 고정 짝(사무실·집)이 gateway·bridge 모두 connected 가 될 때까지 기다린다. 사람이 더한 Gateway 는 보지
 * 않는다 — `--keep` 으로 이어받은 그 행은 지난 시작의 셋째 가짜 주소처럼 이제 닿지 않거나 플러그인이 없어, 기다리면 시작이 죽는다.
 * 플러그인이 못 붙은 짝(사람이 끈 고정 Gateway·폐기한 고정 토큰)도 부르는 쪽이 뺀다
 */
function waitForFakePairs(
  app: App,
  ids: readonly string[],
  timeoutMs = FAKE_PAIRS_TIMEOUT_MS,
): Promise<void> {
  const up = (status: AdapterStatus) =>
    ids.every((id) => {
      const line = fakeGatewayLine(status, id);
      return line?.gateway === "connected" && line.bridge === "connected";
    });
  if (up(openclawOf(app).status())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = openclawOf(app).onEvent((e) => {
      if (e.kind !== "status" || !up(e.status)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `fake Gateways not connected within ${timeoutMs}ms: ${JSON.stringify(openclawOf(app).status())}`,
        ),
      );
    }, timeoutMs);
  });
}

/** dev:fake 는 실제 러너 어댑터 하나로도 뜬다(`createApp` 이 만든다) */
function claudeOf(app: App): AgentAdapter {
  const adapter = app.registry.forProvider("runner");
  if (!adapter) throw new Error("dev:fake app has no runner adapter");
  return adapter;
}

/** 러너 어댑터에 붙은 러너 수 */
function runnersConnected(app: App): number {
  const status = claudeOf(app).status();
  return status.provider === "runner" ? status.runners.connected : 0;
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
      if (e.kind !== "status" || e.status.provider !== "runner" || !want(e.status.runners.connected)) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/**
 * 가짜 러너 하나의 토큰 행을 보장하고 그 id 를 돌려준다(폐기된 행이면 null — 가짜 러너는 못 붙고 씨앗도 만들지 않는다).
 * 행은 고정 id 로 찾고, 없으면 해시로 찾는다(고정 id 전에 만든 `--keep` DB). 「다시 발급」으로 해시가 바뀐 행은 고정 토큰으로 되돌린다 —
 * 프로젝트·에이전트가 그 러너에 남은 채 가짜 러너가 다시 붙는다(실제 러너에서 새 토큰을 넣고 다시 띄우는 것과 같은 결과)
 */
function ensureDevFakeRunnerRow(app: App, spec: DevFakeRunnerSpec): string | null {
  const { db, workspaceId } = app;
  const hash = createHash("sha256").update(spec.token).digest("hex");
  const prefix = spec.token.slice(0, 6);
  const columns = { id: runnerTokens.id, hash: runnerTokens.hash, revokedAt: runnerTokens.revokedAt };
  const row =
    db.select(columns).from(runnerTokens).where(eq(runnerTokens.id, spec.id)).get() ??
    db.select(columns).from(runnerTokens).where(eq(runnerTokens.hash, hash)).get();
  if (!row) {
    db.insert(runnerTokens)
      .values({
        id: spec.id,
        workspaceId,
        label: spec.label,
        hash,
        prefix,
        ownerUserId: app.ownerUserId,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      })
      .run();
    if (spec.seedProject) createProject(db, { workspaceId, runnerTokenId: spec.id, ...spec.seedProject });
    return spec.id;
  }
  if (row.revokedAt !== null) return null;
  if (row.hash !== hash) {
    db.update(runnerTokens).set({ hash, prefix }).where(eq(runnerTokens.id, row.id)).run();
    app.logger.warn(
      { runnerTokenId: row.id, label: spec.label },
      "dev:fake runner token was reissued — restored the fixed token so the fake runner reconnects",
    );
  }
  return row.id;
}

/**
 * 가짜 러너들의 토큰 행과, 첫 러너의 프로젝트 `src/dodok`·에이전트 coder 를 보장한다. 핸들 coder 인 에이전트가 이미 있으면(사람이
 * 바꿨거나, 0031 이 보관한 옛 러너 에이전트) 건드리지 않는다
 */
function ensureDevFakeRunner(app: App): void {
  const { db, workspaceId } = app;
  const [main, ...rest] = DEV_FAKE_RUNNERS;
  for (const spec of rest) ensureDevFakeRunnerRow(app, spec);
  if (!main) return;
  const tokenId = ensureDevFakeRunnerRow(app, main);
  if (tokenId === null) return;
  const token = { id: tokenId };
  const taken = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.handle, DEV_FAKE_RUNNER_AGENT.handle)))
    .get();
  if (taken) return;
  const project =
    listProjects(db, token.id).find(
      (p) =>
        p.archivedAt === null &&
        p.rootId === FAKE_RUNNER_ROOT.id &&
        p.relPath === DEV_FAKE_RUNNER_AGENT.relPath,
    ) ??
    createProject(db, {
      workspaceId,
      runnerTokenId: token.id,
      rootId: FAKE_RUNNER_ROOT.id,
      relPath: DEV_FAKE_RUNNER_AGENT.relPath,
    });
  createAgent(db, {
    workspaceId,
    provider: "runner",
    runnerProjectId: project.id,
    program: "claude",
    handle: DEV_FAKE_RUNNER_AGENT.handle,
    name: DEV_FAKE_RUNNER_AGENT.name,
    createdBy: app.ownerUserId,
  });
}

/**
 * 되살리는 고정 Gateway 의 이름 — 사람이 그 Gateway 를 지우고 같은 이름으로 다른 Gateway 를 만들었으면(`--keep`) 이름이 워크스페이스
 * 안에서 겹쳐 넣기가 UNIQUE 로 죽는다. 그때는 「<이름> (dev:fake)」(그것도 있으면 뒤에 번호)로 넣는다 — 건너뛰면 그 짝의 가짜
 * 플러그인이 붙을 Gateway 가 없다
 */
function freeGatewayName(db: DbOrTx, workspaceId: string, name: string): string {
  const taken = new Set(
    db
      .select({ name: gateways.name })
      .from(gateways)
      .where(eq(gateways.workspaceId, workspaceId))
      .all()
      .map((g) => g.name),
  );
  if (!taken.has(name)) return name;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name} (dev:fake)` : `${name} (dev:fake ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 가짜 Gateway 행과 그 Gateway 에 묶인 고정 브리지 토큰 행을 보장한다 — createApp 전에 Gateway 마다 부른다(부팅이 DB 의 Gateway 를
 * 어댑터에 넣으므로 첫 부팅이 「Gateway 없음」으로 시작하지 않는다). 가짜 Gateway 는 시작마다 포트가 바뀌므로 `--keep` 으로 이어받은
 * 행은 주소·토큰만 이번 것으로 바꾼다(이름·켜짐은 사람이 연결 페이지에서 바꾼 대로 둔다). 지운 Gateway 는 다시 만든다(이름이 겹치면
 * `freeGatewayName`). 고정 토큰 행이
 * 이미 있으면(폐기됐어도) 그대로 둔다 — 고정 러너 토큰과 같은 규칙
 */
function seedDevFakeGateway(
  db: DbOrTx,
  workspaceId: string,
  spec: DevFakeGatewaySpec,
  gateway: FakeGateway,
): void {
  const now = new Date();
  if (getGatewayRow(db, workspaceId, spec.id)) {
    db.update(gateways)
      .set({ url: gateway.url, token: gateway.token, updatedAt: now })
      .where(eq(gateways.id, spec.id))
      .run();
  } else {
    db.insert(gateways)
      .values({
        id: spec.id,
        workspaceId,
        name: freeGatewayName(db, workspaceId, spec.name),
        url: gateway.url,
        token: gateway.token,
        enabled: true,
        // 주인은 부팅 뒤 owner 로 채운다(claimDevFakeGateways — owner 사용자는 createApp 이 만든다). owner 가 만든 것이라 승인된 채
        ownerUserId: null,
        approvedAt: now,
        approvedBy: null,
        lastVersion: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  const hash = createHash("sha256").update(spec.bridgeToken).digest("hex");
  if (!db.select({ id: bridgeTokens.id }).from(bridgeTokens).where(eq(bridgeTokens.hash, hash)).get()) {
    db.insert(bridgeTokens)
      .values({
        id: uuidv7(),
        workspaceId,
        label: "dev-fake",
        hash,
        prefix: spec.bridgeToken.slice(0, 6),
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
        gatewayId: spec.id,
      })
      .run();
  }
}

/**
 * 고정 짝의 가짜 플러그인이 못 붙을 만한, 사람이 바꾼 것 — 고정 Gateway 를 껐거나 고정 토큰을 폐기했으면(`--keep` 으로 이어받은 것)
 * 다시 붙이는 안내를, 아니면 undefined 를 돌려준다. 시드가 시작마다 행을 되살리므로 새 DB 는 늘 undefined 다.
 * 시작 때 못 붙은 짝은 가짜 플러그인이 없어 plugin-token 훅이 「fake plugin not started」로 거절한다 — 그래서 안내는 다시 띄우기다
 * (켠 Gateway 는 `--keep` 으로 이어받아도 붙고, 폐기한 고정 토큰은 `--keep` 으로는 그대로라 새 DB 로만 붙는다)
 */
function changedByHand(db: DbOrTx, workspaceId: string, spec: DevFakeGatewaySpec): string | undefined {
  if (getGatewayRow(db, workspaceId, spec.id)?.enabled === false)
    return "enable the Gateway on the connection page, then restart dev:fake (--keep keeps the DB)";
  const hash = createHash("sha256").update(spec.bridgeToken).digest("hex");
  const token = db
    .select({ revokedAt: bridgeTokens.revokedAt })
    .from(bridgeTokens)
    .where(eq(bridgeTokens.hash, hash))
    .get();
  if (token?.revokedAt != null)
    return "the fixed bridge token is revoked — restart dev:fake without --keep (new DB); POST /__devfake/plugin-token cannot start a fake plugin";
  return undefined;
}

/** 주인 없는 가짜 Gateway 행(seedDevFakeGateway 가 owner 사용자보다 먼저 만든다)의 주인을 owner 로 — 사람이 바꾼 것은 건드리지 않는다 */
function claimDevFakeGateways(app: App): void {
  app.db
    .update(gateways)
    .set({ ownerUserId: app.ownerUserId })
    .where(
      and(
        eq(gateways.workspaceId, app.workspaceId),
        inArray(
          gateways.id,
          DEV_FAKE_GATEWAYS.map((g) => g.id),
        ),
        isNull(gateways.ownerUserId),
      ),
    )
    .run();
}

/**
 * 가짜 Gateway 둘의 OpenClaw 에이전트를 등록해 둔다(핸들은 `DEV_FAKE_GATEWAYS`). 그 핸들이 이미 쓰이거나 그 Gateway 에 같은 id 가
 * 이미 있으면(`--keep`, 사람이 바꾼 것) 건드리지 않는다 — 지운 에이전트는 다음 시작에 다시 생긴다(coder 와 같다)
 */
function ensureDevFakeAgents(app: App): void {
  const { db, workspaceId } = app;
  for (const spec of DEV_FAKE_GATEWAYS) {
    for (const agent of spec.agents) {
      const taken = db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            or(
              eq(agents.handle, agent.handle),
              and(eq(agents.gatewayId, spec.id), providerAgentIdIs(agent.id)),
            ),
          ),
        )
        .get();
      if (taken) continue;
      try {
        const created = createAgent(db, {
          workspaceId,
          provider: "openclaw",
          providerAgentId: agent.id,
          handle: agent.handle,
          name: agent.handle,
          gatewayId: spec.id,
          createdBy: app.ownerUserId,
        });
        // createAgent 는 dmAccess 를 받지 않는다(REST 등록과 같다 — 바꾸는 길은 PATCH 하나)
        if (agent.dmAccess) updateAgent(db, created.id, { dmAccess: agent.dmAccess });
      } catch (err) {
        // 사람 핸들과 겹치는 등 — 서버는 그대로 뜬다
        app.logger.warn({ err, handle: agent.handle }, "dev:fake agent not registered");
      }
    }
  }
}

/**
 * 보관하지 않은 채널이 없을 때만 씨앗 채널을 만들고, 그 채널에 「이전 대화」(id = 채널 id, 0025 가 만드는 꼴 — 옛 세션 키·옛 푸시 링크
 * `/c/<ch>/t/<root>` 가 그대로 맞는 자리)와 다른 세션 하나를 넣는다. 두 세션에 owner 글을 하나씩 남긴다(서버 저장 경로 그대로 — 멘션이
 * 없어 런은 없다). 살아 있는 채널이 있으면(`--keep`) 아무것도 더하지 않는다 — 이어받은 채널의 세션·안 읽음을 바꾸지 않게.
 * DM 은 「살아 있는 채널」로 치지 않는다 — 보관할 길이 없어, 치면 채널을 모두 보관해도 씨앗이 다시 생기지 않는다.
 * 씨앗을 만들었으면 true — 같은 시작이 DM 씨앗도 둔다(`ensureDevFakeDm`)
 */
function ensureDevFakeSessions(app: App): boolean {
  const { db, workspaceId, ownerUserId } = app;
  const live = db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.kind, "channel"), isNull(channels.archivedAt)),
    )
    .get();
  if (live) return false;
  const channel = createChannel(db, { workspaceId, createdBy: ownerUserId, name: DEV_FAKE_CHANNEL_NAME });
  for (const handle of DEV_FAKE_CHANNEL_AGENTS) {
    // 보관한 에이전트는 채널에 넣을 수 없다(addMember 가 던진다) — `--keep` 으로 이어받은 DB 에서 사람이 보관했으면 빼고 뜬다
    const agent = db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.handle, handle), agentNotArchived))
      .get();
    if (agent) addMember(db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
  }
  const seed = (conversationId: string, bodyMd: string) =>
    createUserMessage(db, app.bus, { conversationId, authorId: ownerUserId, bodyMd, clientMsgId: uuidv7() });
  db.insert(conversations)
    .values({
      id: channel.id,
      channelId: channel.id,
      title: DEV_FAKE_LEGACY_TITLE,
      titleSource: "user",
      createdByType: "user",
      createdById: ownerUserId,
      createdAt: new Date(channel.createdAt),
    })
    .run();
  seed(channel.id, "세션 기능 전에 이 채널에서 나눈 대화가 여기에 남습니다.");
  const created = createConversation(db, {
    channelId: channel.id,
    title: DEV_FAKE_SESSION_TITLE,
    titleSource: "user",
    createdBy: { type: "user", id: ownerUserId },
    createdAt: new Date(),
  });
  seed(created.id, "새 주제는 새 세션에서 — 이 세션의 에이전트는 「이전 대화」를 모릅니다.");
  return true;
}

/**
 * mia ↔ 사무실 dev DM 에 세션 하나 — 웹이 지나는 길 그대로(`POST /dms` 의 findOrCreateDm → message.send newConversation 의
 * sendUserMessage + resolveSendConversation → 라우터)로 mia 글을 보내고 가짜 대본의 답이 저장될 때까지 기다린다. 플러그인이 붙은 뒤에
 * 부른다(앞이면 런이 ADAPTER_UNAVAILABLE 로 끝난다). 이미 세션이 있는 DM 은 건드리지 않는다.
 * `--keep`(채널을 모두 보관한 DB 도 씨앗 조건에 든다)·사무실 플러그인이 못 붙음·dev 가 보관·꺼짐이면 경고만 남기고 건너뛴다 — 사람 손이
 * 닿은 DB 는 그대로 뜬다(플러그인 갈래와 같다). 새 DB 에서 답이 안 오면 던진다 — DM 런이 안 도는 것은 회귀라 브라우저 검증이 앱 결함으로
 * 오인하지 않게
 */
async function ensureDevFakeDm(app: App, opts: { keep: boolean; officeConnected: boolean }): Promise<void> {
  const { db, workspaceId } = app;
  if (opts.keep) {
    app.logger.warn("dev:fake dm seed skipped — --keep keeps the inherited DB as it is");
    return;
  }
  if (!opts.officeConnected) {
    app.logger.warn("dev:fake dm seed skipped — the office plugin is not connected");
    return;
  }
  const mia = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.workspaceId, workspaceId), eq(users.handle, DEV_FAKE_MEMBER_HANDLE)))
    .get();
  const agent = db
    .select({ id: agents.id, enabled: agents.enabled, archivedAt: agents.archivedAt })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.handle, DEV_FAKE_DM_AGENT),
        eq(agents.gatewayId, DEV_FAKE_OFFICE_GATEWAY_ID),
      ),
    )
    .get();
  if (!mia || !agent) {
    app.logger.warn(
      { mia: !!mia, agent: !!agent },
      "dev:fake dm seed skipped — mia or office dev is missing",
    );
    return;
  }
  if (!isAgentActive({ enabled: agent.enabled, archivedAt: agent.archivedAt?.toISOString() ?? null })) {
    app.logger.warn("dev:fake dm seed skipped — office dev is archived or disabled");
    return;
  }
  const { channel } = findOrCreateDm(db, { workspaceId, ownerId: mia.id, agentId: agent.id });
  if (
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.channelId, channel.id))
      .get()
  )
    return;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const replied = new Promise<void>((resolve, reject) => {
      off = app.bus.on("message.created", ({ message }) => {
        if (message.channelId === channel.id && message.authorType === "agent") resolve();
      });
      timer = setTimeout(
        () =>
          reject(
            new Error(`dev:fake dm seed: no reply from @${DEV_FAKE_DM_AGENT} within ${DM_SEED_TIMEOUT_MS}ms`),
          ),
        DM_SEED_TIMEOUT_MS,
      );
    });
    // 라우터를 기다리는 사이 시간이 다 되면 아직 받는 쪽이 없다 — 처리 안 된 거절로 프로세스가 죽지 않게(아래 await 가 다시 던진다)
    replied.catch(() => undefined);
    const now = new Date();
    const sent = sendUserMessage(db, app.bus, {
      conversationId: (tx) =>
        resolveSendConversation(
          tx,
          {
            channelId: channel.id,
            userId: mia.id,
            role: "member",
            bodyMd: DEV_FAKE_DM_TEXT,
            newConversation: {},
          },
          now,
        ),
      authorId: mia.id,
      bodyMd: DEV_FAKE_DM_TEXT,
      clientMsgId: uuidv7(),
    }).message;
    await app.services.router.routeMessage(sent);
    await replied;
  } finally {
    off?.();
    clearTimeout(timer);
  }
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

/**
 * 가짜 Gateway 둘(+ 셋째) → createApp(실제 OpenClawAdapter) → listen → Gateway 마다 가짜 플러그인·대본 → 어댑터의 두 Gateway 가
 * gateway·bridge connected. 실패하면 만든 것을 닫고 던진다
 */
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

  /** Gateway 하나와 그 짝 — 플러그인은 listen 뒤에 붙는다. 다시 붙이기(토큰·hello 바꾸기)는 짝마다 한 번에 하나씩 */
  type Pair = {
    spec: DevFakeGatewaySpec;
    gateway: FakeGateway;
    plugin?: FakePlugin;
    swapping: Promise<unknown>;
  };
  const pairs: Pair[] = [];
  const fakeGateways: FakeGateway[] = [];
  let app: App | undefined;
  /** 가짜 러너마다 — 지금 알리는 hello 바꿈(훅 roots·maxPermissionMode)과 다시 붙이기 줄 */
  type RunnerSlot = {
    spec: DevFakeRunnerSpec;
    runner?: FakeRunner;
    hello: Partial<RunnerHello>;
    swapping: Promise<unknown>;
  };
  const runnerSlots: RunnerSlot[] = DEV_FAKE_RUNNERS.map((spec) => ({
    spec,
    hello: spec.hello,
    swapping: Promise.resolve(),
  }));
  let runState: ReturnType<typeof startRunState> | undefined;
  let closing: Promise<void> | undefined;
  // 앱이 먼저 닫혀야 플러그인이 shutdown notice 를 받고, 어댑터가 Gateway 연결을 스스로 끊는다
  const close = () => {
    closing ??= (async () => {
      await app?.close();
      runState?.markClean(); // main.ts 처럼 닫힌 뒤에 — 강제 종료(kill -9)면 다음 시작이 unclean_shutdown 을 남긴다
      for (const pair of pairs) pair.plugin?.close();
      for (const slot of runnerSlots) slot.runner?.close();
      await Promise.all(fakeGateways.map((gateway) => gateway.close()));
    })();
    return closing;
  };
  try {
    for (const spec of DEV_FAKE_GATEWAYS) {
      const gateway = await startFakeGateway({
        tickIntervalMs: TICK_INTERVAL_MS,
        agents: spec.agents.map((a) => ({ id: a.id, name: a.id })),
      });
      fakeGateways.push(gateway);
      pairs.push({ spec, gateway, swapping: Promise.resolve() });
    }
    // 셋째 — DB 에 넣지 않는다. 사람이 연결 페이지에서 붙여 본다(플러그인 없이 Gateway 줄만 connected)
    const spare = await startFakeGateway({ tickIntervalMs: TICK_INTERVAL_MS });
    fakeGateways.push(spare);
    const config = loadConfig({
      HOST: host,
      PORT: String(port),
      APP_ORIGIN: opts.appOrigin ?? DEFAULT_APP_ORIGIN,
      DATA_DIR: dataDir,
      DB_PATH: dbPath,
      LOG_LEVEL: opts.logLevel ?? "info",
      LOCAL_AUTH_TOKEN: DEV_FAKE_LOCAL_TOKEN,
      BETTER_AUTH_SECRET: DEV_FAKE_SECRET,
    });
    const seedDb = createDb(config.dbPath);
    try {
      const workspaceId = ensureWorkspace(seedDb, config.DODOK_WORKSPACE_NAME);
      for (const { spec, gateway } of pairs) seedDevFakeGateway(seedDb, workspaceId, spec, gateway);
    } finally {
      seedDb.$client.close();
    }
    app = await createApp(config, {
      ...(opts.pushSend ? { pushSend: opts.pushSend } : {}),
      statfs,
      disconnectEventMs: opts.disconnectEventMs ?? DISCONNECT_EVENT_MS,
      gatewayBackoff: DEV_FAKE_GATEWAY_BACKOFF,
    });
    // main.ts 와 같다 — 운영 화면 「직전 종료」가 null 로만 보이지 않게
    runState = startRunState(runStateDir, app.ops, app.logger);
    app.setPreviousClean(runState.previousClean);
    await ensureDevFakeMember(app);
    claimDevFakeGateways(app);
    ensureDevFakeRunner(app);
    ensureDevFakeAgents(app);
    const seeded = ensureDevFakeSessions(app);
    const live: App = app;
    /** 훅의 gatewayId 로 짝을 고른다 — 사무실·집이 아니면 undefined(400) */
    const pairOf = (gatewayId: string) => pairs.find((p) => p.spec.id === gatewayId);
    // 다시 붙이기(토큰·hello 바꾸기)는 짝마다 한 번에 하나씩 — 겹치면 소켓 하나를 두 핸드셰이크가 다툰다
    const reconnectPlugin = (
      pair: Pair,
      over: { token: string } | { hello: BridgeHello },
      what: string,
    ): Promise<PluginTokenResult> => {
      const gatewayId = pair.spec.id;
      const run = pair.swapping.then(async (): Promise<PluginTokenResult> => {
        if (!pair.plugin) return { ok: false, reason: "fake plugin not started" };
        try {
          await pair.plugin.reconnect(over);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          live.logger.warn({ reason, gatewayId }, `dev:fake plugin ${what} rejected`);
          return { ok: false, reason };
        }
        live.logger.info(
          { tokenId: pluginTokenId(live, gatewayId), gatewayId },
          `dev:fake plugin reconnected with ${what}`,
        );
        return { ok: true };
      });
      pair.swapping = run;
      return run;
    };
    const connectRunner = (spec: DevFakeRunnerSpec, hello: Partial<RunnerHello>, token: string) =>
      startFakeRunner({
        url: live.url,
        token,
        hello,
        tree: spec.tree(),
        script: (run) => {
          logInboundReactions(live, "runner", run.start.deliver);
          return fakeRunnerScript(run);
        },
      });
    /** 훅의 roots·maxPermissionMode 를 그 러너의 기본 hello 위에 — 루트는 고정 목록 안의 id 만, 상한은 Claude Code 줄에 */
    const helloFor = (slot: RunnerSlot, input: RunnerInput): Partial<RunnerHello> | Rejected => {
      const roots = slot.spec.hello.roots ?? [];
      const unknown = input.roots?.filter((id) => !roots.some((r) => r.id === id)) ?? [];
      if (unknown.length > 0)
        return new Rejected(
          `unknown root ids for ${slot.spec.key}: ${unknown.join(", ")} (fixed: ${roots.map((r) => r.id).join(", ")})`,
        );
      const current = slot.hello;
      return {
        ...current,
        ...(input.roots === undefined ? {} : { roots: roots.filter((r) => input.roots?.includes(r.id)) }),
        ...(input.maxPermissionMode === undefined
          ? {}
          : {
              programs: (current.programs ?? []).map((p) =>
                p.program === "claude"
                  ? {
                      ...p,
                      ceiling: {
                        ...p.ceiling,
                        maxPermissionMode: input.maxPermissionMode ?? p.ceiling.maxPermissionMode,
                      },
                    }
                  : p,
              ),
            }),
      };
    };
    // 러너 끊기·붙이기는 러너마다 한 번에 하나씩
    const setRunner = (input: RunnerInput): Promise<unknown> => {
      const slot = runnerSlots.find((s) => s.spec.key === (input.runner ?? "main"));
      if (!slot) return Promise.resolve(invalid);
      const changesHello = input.roots !== undefined || input.maxPermissionMode !== undefined;
      if (!input.connected && changesHello)
        return Promise.resolve(new Rejected("roots·maxPermissionMode go with connected: true"));
      const run = slot.swapping.then(async () => {
        if (!input.connected) {
          if (!slot.runner?.connected) return { ok: true, status: claudeOf(live).status() };
          const before = runnersConnected(live);
          slot.runner.disconnect();
          const reached = await waitForRunners(live, (n) => n < before, RUNNER_HOOK_TIMEOUT_MS);
          live.logger.info({ reached, runner: slot.spec.key }, "dev:fake runner disconnected");
          return reached
            ? { ok: true, status: claudeOf(live).status() }
            : { ok: false, reason: "timeout", status: claudeOf(live).status() };
        }
        const hello = helloFor(slot, input);
        if (hello instanceof Rejected) return hello;
        if (slot.runner?.connected && input.token === undefined && !changesHello)
          return { ok: true, status: claudeOf(live).status() };
        try {
          if (slot.runner)
            await slot.runner.reconnect({
              hello,
              ...(input.token === undefined ? {} : { token: input.token }),
            });
          else slot.runner = await connectRunner(slot.spec, hello, input.token ?? slot.spec.token);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          live.logger.warn({ reason, runner: slot.spec.key }, "dev:fake runner connect rejected");
          return { ok: false, reason };
        } finally {
          // 붙지 못해도 다음 붙이기는 이 hello 로 — 가짜 러너도 reconnect 에서 이미 바꿔 쥐었다
          slot.hello = hello;
        }
        live.logger.info({ runner: slot.spec.key }, "dev:fake runner connected");
        return { ok: true, status: claudeOf(live).status() };
      });
      slot.swapping = run;
      return run;
    };
    interceptDevFakeRoutes(
      live,
      new Map([
        [
          DEV_FAKE_PLUGIN_TOKEN_PATH,
          route(
            PluginTokenInput,
            `{ gatewayId: ${GATEWAY_IDS_USAGE}, token: string }`,
            async ({ gatewayId, token }) => {
              const pair = pairOf(gatewayId);
              if (!pair) return invalid;
              // 다른 Gateway 의 토큰이면 서버는 이 플러그인을 그 Gateway 로 받아 원래 플러그인을 밀어낸다 — 그 Gateway 의 런에 이
              // 짝의 대본이 답한다. 모르는 토큰은 그대로 보내 UNAUTHORIZED 를 잴 수 있게 둔다
              const owner = bridgeTokenGatewayId(live, token);
              if (owner !== undefined && owner !== gatewayId)
                return new Rejected(
                  `token belongs to another Gateway (${owner}) — use that Gateway's gatewayId`,
                );
              return reconnectPlugin(pair, { token }, "swapped token");
            },
          ),
        ],
        [
          DEV_FAKE_PLUGIN_CAPABILITIES_PATH,
          route(
            PluginCapabilitiesInput,
            `{ gatewayId: ${GATEWAY_IDS_USAGE}, threads: boolean }`,
            async ({ gatewayId, threads }) => {
              const pair = pairOf(gatewayId);
              if (!pair) return invalid;
              const hello = threads ? FAKE_PLUGIN_HELLO : OLD_PLUGIN_HELLO;
              const result = await reconnectPlugin(pair, { hello }, threads ? "threads hello" : "old hello");
              return result.ok ? { ok: true, capabilities: hello.capabilities } : result;
            },
          ),
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
          route(
            GatewayInput,
            `{ gatewayId: ${GATEWAY_IDS_USAGE}, state: "down" | "connected" }`,
            async ({ gatewayId, state }) => {
              const pair = pairOf(gatewayId);
              if (!pair) return invalid;
              pair.gateway.setAccepting(state === "connected");
              const reached = await waitForGateway(
                live,
                gatewayId,
                (g) => (state === "connected" ? g === "connected" : g !== "connected"),
                GATEWAY_HOOK_TIMEOUT_MS,
              );
              live.logger.info({ gatewayId, state, reached }, "dev:fake gateway hook");
              // status 는 그 Gateway 한 줄(어댑터 status().gateways 의 그 Gateway)
              const status = fakeGatewayLine(openclawOf(live).status(), gatewayId);
              return reached ? { ok: true, status } : { ok: false, reason: "timeout", status };
            },
          ),
        ],
        [
          DEV_FAKE_RUNNER_PATH,
          route(
            RunnerInput,
            '{ connected: boolean, token?: string, runner?: "main" | "limited", maxPermissionMode?, roots?: string[] }',
            setRunner,
          ),
        ],
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
    for (const pair of pairs) {
      const { spec } = pair;
      let plugin: FakePlugin;
      try {
        plugin = await startFakePlugin({
          bridgeUrl: app.url,
          token: spec.bridgeToken,
          agents: spec.agents.map((a) => ({ agentId: a.id })),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const changed = changedByHand(app.db, app.workspaceId, spec);
        // 사람 손이 닿지 않았는데 못 붙었으면 시딩·브리지 회귀다 — 띄우면 브라우저 검증이 그것을 앱 결함으로 오인한다
        if (!changed)
          throw new Error(`dev:fake plugin for fixed Gateway ${spec.name} could not connect: ${reason}`, {
            cause: error,
          });
        // --keep 으로 사람이 끈 고정 Gateway·폐기한 고정 토큰을 이어받았으면 서버는 그대로 뜬다(러너와 같다)
        app.logger.warn({ reason, gatewayId: spec.id }, `dev:fake plugin could not connect — ${changed}`);
        continue;
      }
      pair.plugin = plugin;
      // 대본의 이름표는 시작 때 등록한 핸들(집 dev 는 dev-home) — 답만 보고 어느 Gateway 가 답했는지 안다
      const scenarioAgents: Record<string, ScenarioAgent> = {};
      for (const { id, handle } of spec.agents)
        scenarioAgents[id] = ({ delivery }) => {
          logInboundReactions(live, spec.name, delivery);
          return fakeAgentScript(handle, delivery);
        };
      // 그 Gateway 에 없는 id(다른 Gateway 에서 옮겨 온 에이전트)도 답한다 — 「삭제 → 옮기기 → 다시 실행 → 답」을 끝까지 보게.
      // 이름표는 채널 참여자 가운데 자기 핸들
      createScenario({
        gateway: pair.gateway,
        plugin,
        agents: scenarioAgents,
        fallback: ({ delivery }) => {
          logInboundReactions(live, spec.name, delivery);
          return fakeAgentScript(
            delivery.context.participants.find((p) => p.isSelf)?.handle ?? delivery.agentId,
            delivery,
          );
        },
      });
    }
    for (const slot of runnerSlots) {
      try {
        slot.runner = await connectRunner(slot.spec, slot.hello, slot.spec.token);
      } catch (error) {
        // --keep 으로 폐기된 고정 토큰을 이어받았으면 여기 — 서버는 그대로 뜬다
        const reason = error instanceof Error ? error.message : String(error);
        app.logger.warn(
          { reason, runner: slot.spec.key },
          "dev:fake runner could not connect — POST /__devfake/runner { connected: true, token }",
        );
      }
    }
    // adapter.connect() 는 기다리지 않는다 — 돌려주자마자 discover·전송이 되게
    await waitForFakePairs(
      app,
      pairs.filter((p) => p.plugin).map((p) => p.spec.id),
    );
    if (seeded)
      await ensureDevFakeDm(app, {
        keep: opts.keep === true,
        officeConnected: pairs.some((p) => p.spec.id === DEV_FAKE_OFFICE_GATEWAY_ID && p.plugin),
      });
    return { app, url: app.url, spareGateway: { url: spare.url, token: spare.token }, close };
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
      limitedRunnerToken: DEV_FAKE_LIMITED_RUNNER_TOKEN,
      gateways: DEV_FAKE_GATEWAYS.map((g) => ({
        id: g.id,
        name: g.name,
        bridgeToken: g.bridgeToken,
        agents: g.agents.map((a) => a.handle),
      })),
      // 키 token 은 로거가 가린다 — 가짜 Gateway 는 토큰을 검사하지 않는 고정값이라 이름을 바꿔 그대로 찍는다
      spareGateway: { url: dev.spareGateway.url, gatewayToken: dev.spareGateway.token },
      runnerAgent: DEV_FAKE_RUNNER_AGENT.handle,
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
