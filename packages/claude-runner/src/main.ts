import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { computeBundleSha256 } from "./bundle-hash";
import { DEFAULT_CONFIG_PATH, loadRunnerConfig, resolveConfigPath, RunnerConfigError } from "./config";
import {
  createBackgroundHooksSlot,
  startRunnerConnection,
  STOP_WAIT_MS,
  type RunnerLogger,
} from "./connection";
import { createClaudeDriver } from "./drivers/claude";
import {
  cleanupLeftoverClis,
  createCliProcessRegistry,
  type CliProcessRegistry,
} from "./drivers/claude/cli-processes";
import { applyClaudeConfigDirEnv } from "./drivers/claude/config-dir";
import { realSdk } from "./drivers/claude/sdk";
import { selfUpdate } from "./self-update";
import {
  createTerminalPrompter,
  detectClaudeForSetup,
  planCli,
  runSetupWizard,
  runTokenCommand,
} from "./setup";

// 빌드(scripts/build.mjs)가 채운다. tsx 로 소스를 돌리면 dev 로 보인다. Claude Code 판은 SDK 번들 CLI 의 것 — 설치본을 쓰면
// 드라이버가 연결마다 그 실행 파일의 판을 읽어 로그 한 줄과 hello 에 싣는다(drivers/claude/index.ts)
declare const __DODOK_RUNNER_VERSION__: string;
declare const __CLAUDE_AGENT_SDK_VERSION__: string;
declare const __CLAUDE_CODE_VERSION__: string;
const RUNNER_VERSION = typeof __DODOK_RUNNER_VERSION__ === "string" ? __DODOK_RUNNER_VERSION__ : "dev";
const SDK_VERSION = typeof __CLAUDE_AGENT_SDK_VERSION__ === "string" ? __CLAUDE_AGENT_SDK_VERSION__ : "dev";
const CLAUDE_CODE_VERSION = typeof __CLAUDE_CODE_VERSION__ === "string" ? __CLAUDE_CODE_VERSION__ : "dev";
// 모듈 스코프에서 — 빌드 스크립트가 이 글자가 번들에 남았는지 확인한다
const BUNDLE_SHA256 = computeBundleSha256(import.meta.url);

const USAGE = [
  `사용법: dodok-runner [--config <경로>]  (기본 ${DEFAULT_CONFIG_PATH})`,
  "        dodok-runner --check-config [--config <경로>]  설정만 읽고 끝난다(이상 없으면 0)",
  "        dodok-runner setup [--config <경로>]  설정을 터미널에서 다시 만든다(지금 값이 기본값)",
  "        dodok-runner token [--config <경로>]  토큰만 바꾼다(다시 발급했을 때)",
  "설정 파일이 없으면 터미널에서 실행할 때 설정을 묻는다.",
].join("\n");

const stamp = () => new Date().toISOString();
const logger: RunnerLogger = {
  info: (m) => console.log(`${stamp()} ${m}`),
  warn: (m) => console.warn(`${stamp()} ${m}`),
  error: (m) => console.error(`${stamp()} ${m}`),
};

async function main(): Promise<void> {
  let args;
  let positionals: string[];
  try {
    ({ values: args, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        // 원격 업데이트의 새 판 검사(self-update.ts CHECK_CONFIG_FLAG) — 설정만 읽고 0/1 로 끝난다
        "check-config": { type: "boolean" },
      },
    }));
  } catch {
    console.error(USAGE);
    process.exit(1);
  }
  const home = process.env.HOME || homedir();
  const configPath = resolveConfigPath(args.config, home);
  if (args["check-config"]) {
    try {
      loadRunnerConfig(configPath, process.env);
    } catch (error) {
      console.error(
        `dodok-runner: ${error instanceof RunnerConfigError ? error.message : "설정을 읽지 못했습니다"}`,
      );
      process.exit(1);
    }
    console.log(`dodok-runner ${RUNNER_VERSION}: 설정 확인 — 이상 없음`);
    return;
  }
  const plan = planCli({
    positionals,
    help: args.help,
    version: args.version,
    configExists: existsSync(configPath),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  });
  if (plan.kind === "usage") {
    console.error(USAGE);
    process.exit(1);
  }
  if (plan.kind === "help") {
    console.log(USAGE);
    return;
  }
  if (plan.kind === "version") {
    console.log(
      `dodok-runner ${RUNNER_VERSION} (Claude Agent SDK ${SDK_VERSION}, 내장 Claude Code ${CLAUDE_CODE_VERSION})`,
    );
    return;
  }
  if (plan.kind === "error") {
    console.error(`dodok-runner: ${plan.message}`);
    process.exit(1);
  }
  if (plan.kind === "token") {
    let result;
    try {
      result = await runTokenCommand({
        prompter: createTerminalPrompter(process.stdin, process.stdout),
        configPath,
        home,
      });
    } catch {
      console.error("dodok-runner: 토큰을 저장하지 못했습니다");
      process.exit(1);
    }
    if (result.status === "error") {
      console.error(`dodok-runner: ${result.message}`);
      process.exit(1);
    }
    process.exit(result.status === "aborted" ? 130 : 0);
  }

  let loaded;
  if (plan.kind === "wizard") {
    let result;
    try {
      result = await runSetupWizard({
        prompter: createTerminalPrompter(process.stdin, process.stdout),
        configPath,
        home,
        cwd: process.cwd(),
        env: process.env,
        confirmOverwrite: plan.confirmOverwrite,
        claude: (ceiling) =>
          detectClaudeForSetup({ env: process.env, bundledVersion: CLAUDE_CODE_VERSION, ceiling }),
      });
    } catch (error) {
      console.error(
        `dodok-runner: ${error instanceof RunnerConfigError ? error.message : "설정을 저장하지 못했습니다"}`,
      );
      process.exit(1);
    }
    if (result.status === "aborted") process.exit(130);
    if (result.status !== "saved") return;
    loaded = result.loaded;
  }

  try {
    loaded ??= loadRunnerConfig(configPath, process.env);
  } catch (error) {
    // 설정 오류면 연결을 시도하지 않고 끝낸다(스펙 8장)
    console.error(
      `dodok-runner: ${error instanceof RunnerConfigError ? error.message : "설정을 읽지 못했습니다"}`,
    );
    process.exit(1);
  }
  const { config, token, warnings } = loaded;
  for (const w of warnings) logger.warn(`dodok-runner: ${w}`);

  // SDK 세션 도우미(getSessionInfo)는 CLI env 가 아니라 러너 프로세스의 CLAUDE_CONFIG_DIR 을 읽는다(ADR 0007 5.2).
  // 전용(configDir)이면 그 값으로 덮고, 평소면 셸 값을 두되 빈 값은 지운다 — CLI env 는 drivers/claude/run.ts buildQueryOptions 가
  // 같은 규칙(drivers/claude/config-dir.ts)으로 따로 만든다 — 러너 env 전부가 가지 않는다
  applyClaudeConfigDirEnv(process.env, config.programs.claude);

  // 루트는 라벨만 찍는다 — 로그를 남에게 보여 줄 수 있다
  logger.info(
    `dodok-runner ${RUNNER_VERSION} · Claude Agent SDK ${SDK_VERSION} · 내장 Claude Code ${CLAUDE_CODE_VERSION} · ` +
      `루트 ${config.roots.map((r) => `${r.id}(${r.label})`).join(", ") || "없음"} · ` +
      `프로그램 ${Object.keys(config.programs).join(", ") || "없음"} · 동시 ${config.maxConcurrentRuns}`,
  );

  // 앞 러너가 강제로 죽으며 남긴 CLI(와 그 백그라운드 셸)를 서버에 붙기 전에 끈다 — 기록은 설정 파일 옆 state/. 경로·명령은 찍지
  // 않는다. Windows 는 하지 않는다(cli-processes.ts 머리 주석) — 기록도 쓰지 않고 SDK 기본 spawn 그대로
  let cliProcesses: CliProcessRegistry | undefined;
  if (process.platform !== "win32") {
    const stateDir = join(dirname(configPath), "state");
    const onError = () => logger.warn("dodok-runner: Claude Code 프로세스 기록을 쓰지 못했습니다");
    const { killed, dropped } = await cleanupLeftoverClis({ stateDir, onError });
    if (killed + dropped > 0)
      logger.info(
        `dodok-runner: 앞 러너가 남긴 Claude Code 프로세스 ${killed}개를 껐습니다` +
          (dropped > 0 ? ` — 이미 끝났거나 다른 프로세스가 된 기록 ${dropped}개는 지웠습니다` : ""),
      );
    cliProcesses = createCliProcessRegistry({ stateDir, onError });
  }

  // 백그라운드 작업(백그라운드 작업 스펙 5.2) — 드라이버가 먼저 자리를 받고 연결이 잇는다
  const background = createBackgroundHooksSlot();
  const connection = startRunnerConnection({
    config,
    token,
    background,
    drivers: [
      createClaudeDriver({
        sdk: realSdk,
        claudeCodeVersion: CLAUDE_CODE_VERSION,
        logger,
        hooks: background.hooks,
        ...(cliProcesses ? { spawnCli: cliProcesses.spawn } : {}),
        // 모델 목록을 받는 query 의 cwd — 첫 루트(작성기 칩 스펙 C10). 봇만 쓰는 러너는 루트가 없다 — 그때는 cwd 없이 묻는다
        ...(config.roots[0] ? { modelsCwd: config.roots[0].path } : {}),
      }),
    ],
    versions: {
      runnerVersion: RUNNER_VERSION,
      sdkVersion: SDK_VERSION,
      bundleSha256: BUNDLE_SHA256,
    },
    logger,
    onFatal: (code) => process.exit(code),
    // 원격 업데이트(U3) — 이 프로세스의 판·argv·env 그대로. 새 판은 같은 인자로 다시 뜬다
    selfUpdate: (request) =>
      selfUpdate({
        ...request,
        currentVersion: RUNNER_VERSION,
        argv: process.argv,
        execPath: process.execPath,
        execArgv: process.execArgv,
        env: process.env,
      }),
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    // 두 번째 신호는 기다리지 않고 끝낸다
    if (stopping) process.exit(130);
    stopping = true;
    logger.info(`dodok-runner: ${signal} — 도는 런을 멈추고 끝냅니다(최대 ${STOP_WAIT_MS / 1000}초)`);
    // stop 이 도는 런마다 interrupt 를 걸고 그 런이 final 을 낼 때까지 기다린다(리뷰 M5). 러너가 끝나면 CLI 의
    // stdin 이 닫혀 CLI 도 끝난다. 닫은 CLI 가 끝나기까지도 기다린다 — 러너가 먼저 끝나면 끝나는 중인 CLI 가 기록에 남는다(다음
    // 시작이 확인하고 지운다). CLI 는 SIGTERM 을 받으면 자기 백그라운드 셸을 정리한다(drivers/claude/cli-processes.ts)
    void connection
      .stop()
      .then(() => cliProcesses?.settle(STOP_WAIT_MS))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
