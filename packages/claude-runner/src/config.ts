import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { RunnerPermissionMode, RunnerProgram, RunnerRootId } from "@dodok/shared";
import { z } from "zod";

// 설정 파일 — 러너 머신의 「천장」만 쥔다(러너 일반화 스펙 2장): 허용 루트·프로그램별 로그인 디렉터리·권한 상한·늘 막는 도구·
// 동시 실행 수. 에이전트는 앱에서 만들고 서버가 run.start 에 싣는다. 오류 문구는 러너 터미널·로그에 그대로 찍히므로 토큰 값과
// 호스트 경로 원문을 싣지 않는다 — 루트는 라벨로, 파일은 키 이름으로 가리킨다

/** 옛 설정(에이전트를 이 파일에 적던 판)의 agents 키 — 스키마 오류보다 먼저 이 문구로 거절한다 */
export const LEGACY_AGENTS_MESSAGE =
  "에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요";

const Root = z.strictObject({
  id: RunnerRootId,
  path: z.string().min(1),
  label: z.string().min(1).max(64).optional(),
});

const ToolNames = z.array(z.string().min(1).max(200)).max(100);

const ProgramCeiling = z.strictObject({
  // 없으면 평소 claude 로그인(~/.claude 또는 셸의 CLAUDE_CONFIG_DIR), 적으면 그 디렉터리의 전용 로그인. 빈 문자열은 거절 — 평소를 쓰려면 줄을 지운다
  configDir: z.string().min(1).optional(),
  // bypassPermissions 는 받지 않는다 — 승인 카드가 아예 뜨지 않는다(스펙 2장)
  maxPermissionMode: RunnerPermissionMode.default("default"),
  disallowedTools: ToolNames.default([]),
  allowedToolsCeiling: ToolNames.nullable().default(null),
});
export type ProgramCeiling = z.infer<typeof ProgramCeiling>;

// strict — 설정 파일 본문에 token 같은 키를 두면 거절한다(토큰은 tokenFile·env 에만)
export const RunnerConfig = z.strictObject({
  serverUrl: z.url({ protocol: /^https?$/ }),
  tokenFile: z.string().min(1).optional(),
  maxConcurrentRuns: z.int().min(1).max(16).default(3),
  roots: z.array(Root).min(1).max(16),
  browse: z.boolean().default(true),
  // 적지 않은 프로그램은 꺼진 것이다
  programs: z.strictObject(
    Object.fromEntries(RunnerProgram.options.map((p) => [p, ProgramCeiling.optional()])) as Record<
      RunnerProgram,
      z.ZodOptional<typeof ProgramCeiling>
    >,
  ),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

/** path 는 realpath — 천장 검사·둘러보기가 이 값과 견준다. label 은 hello 로 서버에 가는 유일한 루트 정보 */
export type ResolvedRoot = { id: string; path: string; label: string };
export type ResolvedRunnerConfig = Omit<RunnerConfig, "roots"> & { roots: ResolvedRoot[] };

export type FsLike = {
  readFile(path: string): string;
  stat(path: string): { isDirectory(): boolean; mode: number } | undefined;
  realpath(path: string): string;
};

export const nodeFs: FsLike = {
  readFile: (p) => readFileSync(p, "utf8"),
  // native — 대소문자만 다른 경로(macOS 의 대소문자 무시 볼륨)를 디스크의 이름으로 바로잡는다. JS 판은 적은 글자 그대로 둔다
  realpath: (p) => realpathSync.native(p),
  stat: (p) => {
    try {
      return statSync(p);
    } catch {
      return undefined;
    }
  },
};

export class RunnerConfigError extends Error {}

function keyPath(path: readonly PropertyKey[]): string {
  return path
    .map((k, i) => (typeof k === "number" ? `[${k}]` : `${i === 0 ? "" : "."}${String(k)}`))
    .join("");
}

export const DEFAULT_CONFIG_PATH = "~/.dodok-runner/config.json";

/** `~`·`~/…` 를 홈으로 풀고 상대 경로는 절대로 — --config 인자와 설정 파일 안 경로가 함께 쓴다 */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/** --config 인자(없으면 기본 자리)를 절대 경로로 */
export function resolveConfigPath(arg: string | undefined, home: string): string {
  return expandHome(arg ?? DEFAULT_CONFIG_PATH, home);
}

/** 라벨이 없으면 디렉터리 이름(hello 의 루트 label 은 1~64자) */
function labelOf(label: string | undefined, path: string): string {
  return (label ?? basename(path) ?? "").slice(0, 64) || "root";
}

export function loadRunnerConfig(
  path: string,
  env: NodeJS.ProcessEnv,
  fs: FsLike = nodeFs,
): { config: ResolvedRunnerConfig; token: string; warnings: string[] } {
  const home = env.HOME || homedir();
  let text: string;
  try {
    text = fs.readFile(path);
  } catch {
    throw new RunnerConfigError("설정 파일을 읽을 수 없습니다 — --config 경로를 확인하세요");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RunnerConfigError("설정 파일이 JSON 형식이 아닙니다");
  }
  if (json !== null && typeof json === "object" && "agents" in json) {
    throw new RunnerConfigError(LEGACY_AGENTS_MESSAGE);
  }
  const parsed = RunnerConfig.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${keyPath(i.path) || "(최상위)"}: ${i.message}`);
    throw new RunnerConfigError(`설정 파일 오류 — ${issues.join("; ")}`.replace(/\s*\n\s*/g, " "));
  }
  const raw = parsed.data;

  const seen = new Set<string>();
  const roots = raw.roots.map((r, i): ResolvedRoot => {
    if (seen.has(r.id))
      throw new RunnerConfigError(`설정 파일 오류 — roots[${i}].id: 같은 id 가 이미 있습니다`);
    seen.add(r.id);
    const path = expandHome(r.path, home);
    const label = labelOf(r.label, path);
    const st = fs.stat(path);
    if (!st?.isDirectory()) {
      throw new RunnerConfigError(`설정 파일 오류 — roots[${i}].path: 디렉터리가 없습니다(라벨 ${label})`);
    }
    // 링크를 푼 자리로 쥔다 — 천장 검사가 realpath 끼리 견주어야 루트를 가리키는 링크가 「루트 밖」으로 오판되지 않는다
    return { id: r.id, path: fs.realpath(path), label };
  });
  const programs = Object.fromEntries(
    Object.entries(raw.programs).flatMap(([program, ceiling]) =>
      ceiling
        ? [
            [
              program,
              {
                ...ceiling,
                ...(ceiling.configDir === undefined
                  ? {}
                  : { configDir: expandHome(ceiling.configDir, home) }),
              },
            ],
          ]
        : [],
    ),
  ) as RunnerConfig["programs"];

  const warnings: string[] = [];
  let token: string;
  const tokenFile = raw.tokenFile === undefined ? undefined : expandHome(raw.tokenFile, home);
  if (tokenFile !== undefined) {
    // tokenFile 을 적었는데 못 읽으면 env 로 넘어가지 않는다 — 어느 토큰으로 붙었는지 사람이 헷갈리지 않게
    try {
      token = fs.readFile(tokenFile).trim();
    } catch {
      throw new RunnerConfigError("tokenFile 을 읽을 수 없습니다");
    }
    const mode = (fs.stat(tokenFile)?.mode ?? 0) & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(`tokenFile 권한이 0600 이 아닙니다(지금 0${mode.toString(8)}) — chmod 600 을 권합니다`);
    }
  } else {
    token = (env.DODOK_RUNNER_TOKEN ?? "").trim();
  }
  if (!token)
    throw new RunnerConfigError("러너 토큰이 없습니다 — tokenFile 또는 env DODOK_RUNNER_TOKEN 에 두세요");

  return {
    config: { ...raw, tokenFile, roots, programs },
    token,
    warnings,
  };
}
