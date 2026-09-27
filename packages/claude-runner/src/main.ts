import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { computeBundleSha256 } from "./bundle-hash";
import { loadRunnerConfig, RunnerConfigError } from "./config";
import { startRunnerConnection, type RunnerLogger } from "./connection";
import { realSdk } from "./sdk";

// 빌드(scripts/build.mjs)가 채운다. tsx 로 소스를 돌리면 dev 로 보인다
declare const __DODOK_RUNNER_VERSION__: string;
declare const __CLAUDE_AGENT_SDK_VERSION__: string;
declare const __CLAUDE_CODE_VERSION__: string;
const RUNNER_VERSION = typeof __DODOK_RUNNER_VERSION__ === "string" ? __DODOK_RUNNER_VERSION__ : "dev";
const SDK_VERSION = typeof __CLAUDE_AGENT_SDK_VERSION__ === "string" ? __CLAUDE_AGENT_SDK_VERSION__ : "dev";
const CLAUDE_CODE_VERSION = typeof __CLAUDE_CODE_VERSION__ === "string" ? __CLAUDE_CODE_VERSION__ : "dev";
// 모듈 스코프에서 — 빌드 스크립트가 이 글자가 번들에 남았는지 확인한다
const BUNDLE_SHA256 = computeBundleSha256(import.meta.url);

const USAGE = "사용법: dodok-runner [--config <경로>]  (기본 ~/.dodok-runner/config.json)";

const stamp = () => new Date().toISOString();
const logger: RunnerLogger = {
  info: (m) => console.log(`${stamp()} ${m}`),
  warn: (m) => console.warn(`${stamp()} ${m}`),
  error: (m) => console.error(`${stamp()} ${m}`),
};

function main(): void {
  let args;
  try {
    args = parseArgs({
      options: {
        config: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    }).values;
  } catch {
    console.error(USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(
      `dodok-runner ${RUNNER_VERSION} (Claude Agent SDK ${SDK_VERSION}, Claude Code ${CLAUDE_CODE_VERSION})`,
    );
    return;
  }

  const home = process.env.HOME || homedir();
  const configPath = args.config
    ? resolve(args.config.startsWith("~/") ? resolve(home, args.config.slice(2)) : args.config)
    : resolve(home, ".dodok-runner/config.json");

  let loaded;
  try {
    loaded = loadRunnerConfig(configPath, process.env);
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
  // CLI 에 넘기는 env 는 run.ts buildQueryOptions 가 따로 만든다 — 러너 env 전부가 가지 않는다
  process.env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;

  logger.info(
    `dodok-runner ${RUNNER_VERSION} · Claude Agent SDK ${SDK_VERSION} · Claude Code ${CLAUDE_CODE_VERSION} · ` +
      `에이전트 ${config.agents.map((a) => `${a.id}(${a.workdirLabel})`).join(", ")} · 동시 ${config.maxConcurrentRuns}`,
  );

  const connection = startRunnerConnection({
    config,
    token,
    sdk: realSdk,
    versions: {
      runnerVersion: RUNNER_VERSION,
      sdkVersion: SDK_VERSION,
      claudeCodeVersion: CLAUDE_CODE_VERSION,
      bundleSha256: BUNDLE_SHA256,
    },
    logger,
    onFatal: (code) => process.exit(code),
  });

  const shutdown = (signal: string) => {
    logger.info(`dodok-runner: ${signal} — 도는 런을 멈추고 끝냅니다`);
    // stop 이 도는 런마다 interrupt 를 건다. 러너가 끝나면 CLI 의 stdin 이 닫혀 CLI 도 끝난다
    connection.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main();
