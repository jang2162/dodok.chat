import { Id, RunnerModelOption } from "@dodok/shared";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProgramDriver } from "../../driver";
import { resolveClaudeConfigDir } from "./config-dir";
import {
  type ClaudeExecutable,
  type IsExecutable,
  isExecutableFile,
  type ReadVersion,
  readClaudeVersion,
  resolveClaudeExecutable,
} from "./executable";
import { CLAUDE_CODE_LABEL, type ClaudeRunSpec, cliEnv, runOnce } from "./run";
import type { SdkModelInfo, SdkPort } from "./sdk";

// Claude Code 드라이버 — Claude Agent SDK 로 머신에 설치된 claude(없으면 SDK 번들 CLI)를 띄운다(런 하나 = query() 하나). 동작은 Claude 러너 스펙
// 「구현과 맞춘 것」 장 그대로이고, 이 파일은 드라이버 계약에 맞춰 묶기만 한다

export type ClaudeDriverOptions = {
  sdk: SdkPort;
  /** 번들 CLI 판본 — 빌드가 굽는다(main.ts). 설치본을 고르면 그 실행 파일의 --version 을 쓴다 */
  claudeCodeVersion: string;
  /** 시험이 바꿔 끼운다 — 기본은 실제 파일 검사·`--version` 실행 */
  isExecutable?: IsExecutable;
  readVersion?: ReadVersion;
  baseEnv?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  /** 시험이 줄인다 — 기본 MODELS_TIMEOUT_MS */
  modelsTimeoutMs?: number;
  /** 세션을 연 길(새로·resume·거절 뒤 resume)을 남기는 줄 */
  logger?: { info(msg: string): void };
  /** 모델 목록을 받는 query 의 cwd — 러너의 첫 루트(작성기 칩 스펙 C10). 없으면 러너 프로세스의 cwd */
  modelsCwd?: string;
};

/** 모델 목록 받기 상한 — 넘으면 목록 없이 hello 를 보낸다(웹은 고정 목록으로 — 작성기 칩 스펙 C4) */
export const MODELS_TIMEOUT_MS = 10_000;
const MODELS_MAX = 32;

/**
 * SDK supportedModels() 를 계약 모양으로 — value "default" 줄도 싣는다(웹이 「기본」에 합친다 — C9), 32개까지. 표시 이름은 80자로
 * 자르고, 계약에 맞지 않는 줄(빈 value·모르는 effort)은 그 줄만 뺀다
 */
export function toModelOptions(list: SdkModelInfo[]): RunnerModelOption[] {
  return list.slice(0, MODELS_MAX).flatMap((m) => {
    const row = RunnerModelOption.safeParse({
      value: m?.value,
      displayName: typeof m?.displayName === "string" ? m.displayName.slice(0, 80) : m?.displayName,
      efforts: [...(m?.supportedEffortLevels ?? [])],
    });
    return row.success ? [row.data] : [];
  });
}

export function createClaudeDriver(opts: ClaudeDriverOptions): ProgramDriver {
  // 세션별 마지막 누적 비용 — 드라이버(러너 프로세스) 메모리에만 있다
  const costs = new Map<string, number>();
  const isExecutable = opts.isExecutable ?? isExecutableFile;
  const readVersion = opts.readVersion ?? readClaudeVersion;
  // 마지막 detect(연결마다 — hello 직전)가 고른 실행 파일. 런은 이 값을 쓴다 — 화면에 보인 판본과 실제로 띄우는 CLI 가 같게.
  // 천장 검사가 detect 의 available 을 보므로 detect 전에 런이 오지 않지만, 오면 그 자리에서 고른다
  let chosen: ClaudeExecutable | undefined;
  // 고른 CLI 가 바뀔 때만 한 줄 — 경로는 찍지 않는다(로그를 남에게 보여 줄 수 있다)
  let lastChoice = "";
  // 마지막으로 받은 모델 목록과 그때의 CLI·로그인 자리 — 같으면 재연결마다 CLI 를 다시 띄우지 않는다. 실패는 기억하지 않는다
  let models: { key: string; list: RunnerModelOption[] } | undefined;

  /** 던지지 않는다 — 실패·시간 초과·모양 어긋남이면 undefined */
  async function listModels(
    exe: Exclude<ClaudeExecutable, { cli: "unusable" }>,
    configDir: string | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<RunnerModelOption[] | undefined> {
    const key = `${exe.cli}\0${exe.cli === "installed" ? exe.path : ""}\0${configDir ?? ""}\0${lastChoice}`;
    if (models?.key === key) return models.list;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(undefined);
      }, opts.modelsTimeoutMs ?? MODELS_TIMEOUT_MS);
    });
    try {
      const raw = await Promise.race([
        opts.sdk.listModels({
          options: {
            ...(opts.modelsCwd === undefined ? {} : { cwd: opts.modelsCwd }),
            env: cliEnv(env, configDir),
            // 런과 같게 — 사람 저장소의 설정·계정 커넥터를 끌어오지 않는다(run.ts buildQueryOptions)
            settingSources: [],
            strictMcpConfig: true,
            persistSession: false,
            abortController: abort,
            ...(exe.cli === "installed" ? { pathToClaudeCodeExecutable: exe.path } : {}),
          },
        }),
        timeout,
      ]);
      if (!Array.isArray(raw)) return undefined;
      const list = toModelOptions(raw);
      models = { key, list };
      return list;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    program: "claude",
    label: CLAUDE_CODE_LABEL,
    capabilities: {
      serverSessionIds: true,
      approvals: true,
      images: true,
      interrupt: true,
      mcpTools: true,
      costs: true,
    },
    // 실행 파일은 설정 executable → 러너 PATH 의 claude → SDK 번들 CLI 차례로 고른다(executable.ts). 로그인 자격 증명은 읽지 않는다 — 유효 설정 자리(전용이면 configDir, 평소면 셸의
    // CLAUDE_CONFIG_DIR 또는 HOME/.claude)의 디렉터리가 없을 때만 missing, 그 밖은 unknown(로그인 여부는 첫 런의 PROVIDER_AUTH 로 안다).
    // 사유에는 경로 원문을 싣지 않는다
    async detect(ceiling) {
      const env = opts.baseEnv ?? process.env;
      const { login, dir } = resolveClaudeConfigDir(ceiling, env);
      chosen = resolveClaudeExecutable(ceiling, env, isExecutable);
      if (chosen.cli === "unusable")
        return { available: false, auth: "unknown", login, reason: chosen.reason };
      // 설치본 판본을 못 읽으면 비운다 — 실행은 그대로 한다
      const version =
        chosen.cli === "installed" ? await readVersion(chosen.path, env) : opts.claudeCodeVersion;
      const choice = `${chosen.cli === "installed" ? "설치본" : "내장"} ${version ?? "(판 모름)"}`;
      if (choice !== lastChoice) opts.logger?.info(`dodok-runner: Claude Code ${choice}`);
      lastChoice = choice;
      const list = await listModels(chosen, ceiling.configDir, env);
      const base = {
        available: true,
        ...(version === undefined ? {} : { version }),
        login,
        cli: chosen.cli,
        ...(list === undefined ? {} : { models: list }),
      } as const;
      if (existsSync(dir ?? join(env.HOME || homedir(), ".claude"))) return { ...base, auth: "unknown" };
      return {
        ...base,
        auth: "missing",
        reason:
          login === "dedicated"
            ? "로그인 디렉터리가 없습니다 — 러너 머신에서 그 디렉터리로 claude /login 하세요"
            : "Claude Code 로그인 디렉터리가 없습니다 — 러너 머신에서 claude 로 /login 하세요",
      };
    },
    async startRun(spec, sink, signal) {
      // 계약은 프로그램이 지은 세션 id(run.session)도 받으려고 글자 하나 이상만 본다 — Claude 는 서버가 정한 UUID 만 연다
      const sessionId = spec.start.providerSessionId;
      if (sessionId === undefined || !Id.safeParse(sessionId).success) {
        sink.error("VALIDATION", "Claude Code 런에는 서버가 정한 세션 id 가 필요합니다");
        return;
      }
      const claudeSpec: ClaudeRunSpec = { ...spec, start: { ...spec.start, providerSessionId: sessionId } };
      const env = opts.baseEnv ?? process.env;
      // detect 전이면 설정의 executable 을 모른다 — PATH·번들만 본다. 못 쓰는 실행 파일이면 천장 검사가 이미 런을 막는다
      const exe = chosen ?? resolveClaudeExecutable({}, env, isExecutable);
      if (exe.cli === "unusable") {
        sink.error("INTERNAL", exe.reason);
        return;
      }
      await runOnce(claudeSpec, {
        sdk: opts.sdk,
        sink,
        baseEnv: env,
        ...(exe.cli === "installed" ? { executable: exe.path } : {}),
        costs,
        signal,
        ...(opts.closeGraceMs === undefined ? {} : { closeGraceMs: opts.closeGraceMs }),
        ...(opts.logger ? { log: (line: string) => opts.logger?.info(line) } : {}),
      });
    },
  };
}
