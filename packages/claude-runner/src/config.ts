import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { isRegistrableAgentId } from "@dodok/shared";
import { z } from "zod";

// 설정 파일(러너 스펙 4.1). 오류 문구는 러너 터미널·로그에 그대로 찍히므로 토큰 값과 호스트 경로 원문을 싣지 않는다 —
// workdir 는 라벨로, 파일은 키 이름으로 가리킨다

const Agent = z.strictObject({
  // 대소문자를 가리지 않는 isOpenClawAgentId 로는 서버 hello 에서야 거절된다 — 등록 검사와 같은 소문자 규칙
  id: z.string().refine(isRegistrableAgentId, "소문자 OpenClaw agentId 여야 합니다"),
  name: z.string().min(1).max(64),
  workdir: z.string().min(1),
  workdirLabel: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(64),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk"]).default("default"),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
});

// strict — 설정 파일 본문에 token 같은 키를 두면 거절한다(토큰은 tokenFile·env 에만)
export const RunnerConfig = z.strictObject({
  serverUrl: z.url({ protocol: /^https?$/ }),
  tokenFile: z.string().min(1).optional(),
  claudeConfigDir: z.string().min(1),
  maxConcurrentRuns: z.int().min(1).max(16).default(3),
  agents: z.array(Agent).min(1).max(32),
});
export type RunnerConfig = z.infer<typeof RunnerConfig>;

export type ResolvedAgent = z.infer<typeof Agent> & { workdirLabel: string };
export type ResolvedRunnerConfig = Omit<RunnerConfig, "agents"> & { agents: ResolvedAgent[] };

export type FsLike = {
  readFile(path: string): string;
  stat(path: string): { isDirectory(): boolean; mode: number } | undefined;
};

export const nodeFs: FsLike = {
  readFile: (p) => readFileSync(p, "utf8"),
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

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/** 라벨이 없으면 디렉터리 이름(hello 의 RunnerAgent.workdirLabel 은 1~64자) */
function labelOf(workdirLabel: string | undefined, workdir: string): string {
  return (workdirLabel ?? basename(workdir) ?? "").slice(0, 64) || "workdir";
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
  const parsed = RunnerConfig.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${keyPath(i.path) || "(최상위)"}: ${i.message}`);
    throw new RunnerConfigError(`설정 파일 오류 — ${issues.join("; ")}`.replace(/\s*\n\s*/g, " "));
  }
  const raw = parsed.data;

  const seen = new Set<string>();
  const agents = raw.agents.map((a, i): ResolvedAgent => {
    if (seen.has(a.id))
      throw new RunnerConfigError(`설정 파일 오류 — agents[${i}].id: 같은 id 가 이미 있습니다`);
    seen.add(a.id);
    const workdir = expandHome(a.workdir, home);
    const workdirLabel = labelOf(a.workdirLabel, workdir);
    const st = fs.stat(workdir);
    if (!st?.isDirectory()) {
      throw new RunnerConfigError(
        `설정 파일 오류 — agents[${i}].workdir: 디렉터리가 없습니다(라벨 ${workdirLabel})`,
      );
    }
    return { ...a, workdir, workdirLabel };
  });

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
    config: { ...raw, tokenFile, claudeConfigDir: expandHome(raw.claudeConfigDir, home), agents },
    token,
    warnings,
  };
}
