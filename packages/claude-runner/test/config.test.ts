import { describe, expect, it } from "vitest";
import { loadRunnerConfig, RunnerConfigError, type FsLike } from "../src/config";

const HOME = "/home/u";
const TOKEN = "drn_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function memFs(files: Record<string, { content?: string; mode?: number; dir?: boolean }>): FsLike {
  return {
    readFile: (p) => {
      const f = files[p];
      if (!f || f.dir || f.content === undefined)
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return f.content;
    },
    stat: (p) => {
      const f = files[p];
      return f ? { isDirectory: () => Boolean(f.dir), mode: f.mode ?? 0o100600 } : undefined;
    },
  };
}

const baseConfig = {
  serverUrl: "https://chat.example.com",
  claudeConfigDir: "~/.dodok-runner/claude",
  agents: [{ id: "coder", name: "코더", workdir: "~/src/my-repo", model: "sonnet" }],
};

function load(config: unknown, opts: { env?: NodeJS.ProcessEnv; extra?: Parameters<typeof memFs>[0] } = {}) {
  const fs = memFs({
    "/cfg/config.json": { content: typeof config === "string" ? config : JSON.stringify(config) },
    "/home/u/src/my-repo": { dir: true },
    ...opts.extra,
  });
  return loadRunnerConfig("/cfg/config.json", { HOME, ...(opts.env ?? { DODOK_RUNNER_TOKEN: TOKEN }) }, fs);
}

function errorOf(fn: () => unknown): RunnerConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RunnerConfigError) return e;
    throw e;
  }
  throw new Error("오류가 나지 않았다");
}

describe("loadRunnerConfig", () => {
  it("~ 를 풀고 기본값을 채운다 — 라벨은 디렉터리 이름, 토큰은 env", () => {
    const { config, token, warnings } = load(baseConfig);
    expect(token).toBe(TOKEN);
    expect(warnings).toEqual([]);
    expect(config.claudeConfigDir).toBe("/home/u/.dodok-runner/claude");
    expect(config.maxConcurrentRuns).toBe(3);
    expect(config.agents[0]).toMatchObject({
      id: "coder",
      workdir: "/home/u/src/my-repo",
      workdirLabel: "my-repo",
      permissionMode: "default",
      allowedTools: [],
      disallowedTools: [],
    });
  });

  it("tokenFile 이 있으면 그 파일에서 읽고 끝 줄바꿈을 걷는다", () => {
    const { token } = load(
      { ...baseConfig, tokenFile: "~/.dodok-runner/token" },
      { env: {}, extra: { "/home/u/.dodok-runner/token": { content: `${TOKEN}\n`, mode: 0o100600 } } },
    );
    expect(token).toBe(TOKEN);
  });

  it("tokenFile 권한이 0600 이 아니면 경고한다 — 경고에 토큰이 없다", () => {
    const { warnings } = load(
      { ...baseConfig, tokenFile: "~/.dodok-runner/token" },
      { env: {}, extra: { "/home/u/.dodok-runner/token": { content: TOKEN, mode: 0o100644 } } },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tokenFile/);
    expect(warnings[0]).toMatch(/0600/);
    expect(warnings[0]).toMatch(/0644/);
    expect(warnings[0]).not.toContain(TOKEN);
  });

  it("틀린 JSON — 한 줄로 알린다", () => {
    const e = errorOf(() => load("{ serverUrl: "));
    expect(e.message).toMatch(/JSON/);
    expect(e.message).not.toContain("\n");
  });

  it("대문자 에이전트 id — 키 경로가 든 한 줄, 토큰 값은 싣지 않는다", () => {
    const e = errorOf(() => load({ ...baseConfig, agents: [{ ...baseConfig.agents[0], id: "Coder" }] }));
    expect(e.message).toContain("agents[0].id");
    expect(e.message).not.toContain("\n");
    expect(e.message).not.toContain(TOKEN);
  });

  it("스키마 오류가 여럿이면 한 줄에 모두 싣는다", () => {
    const e = errorOf(() => load({ ...baseConfig, serverUrl: "nope", maxConcurrentRuns: 99 }));
    expect(e.message).toContain("serverUrl");
    expect(e.message).toContain("maxConcurrentRuns");
    expect(e.message).not.toContain("\n");
  });

  it("없는 workdir — 키 경로와 라벨만, 경로 원문은 싣지 않는다", () => {
    const e = errorOf(() =>
      load({
        ...baseConfig,
        agents: [{ ...baseConfig.agents[0], workdir: "~/src/gone", workdirLabel: "gone-repo" }],
      }),
    );
    expect(e.message).toContain("agents[0].workdir");
    expect(e.message).toContain("gone-repo");
    expect(e.message).not.toContain("/home/u");
    expect(e.message).not.toContain("~/src/gone");
  });

  it("workdir 가 파일이면 디렉터리가 아니라고 알린다", () => {
    const e = errorOf(() =>
      load(
        { ...baseConfig, agents: [{ ...baseConfig.agents[0], workdir: "/srv/file.txt" }] },
        { extra: { "/srv/file.txt": { content: "x" } } },
      ),
    );
    expect(e.message).toContain("agents[0].workdir");
    expect(e.message).not.toContain("/srv");
  });

  it("토큰이 어디에도 없으면 두 자리를 모두 가리킨다", () => {
    const e = errorOf(() => load(baseConfig, { env: {} }));
    expect(e.message).toContain("tokenFile");
    expect(e.message).toContain("DODOK_RUNNER_TOKEN");
  });

  it("tokenFile 을 읽을 수 없으면 env 로 넘어가지 않고 멈춘다 — 경로 원문 없음", () => {
    const e = errorOf(() => load({ ...baseConfig, tokenFile: "~/.dodok-runner/token" }));
    expect(e.message).toContain("tokenFile");
    expect(e.message).not.toContain("/home/u");
  });

  it("같은 에이전트 id 가 둘이면 거절한다", () => {
    const e = errorOf(() => load({ ...baseConfig, agents: [baseConfig.agents[0], baseConfig.agents[0]] }));
    expect(e.message).toContain("agents[1].id");
  });

  it("설정 파일 본문에 토큰 키를 두면 거절한다 — 토큰은 tokenFile·env 에만", () => {
    const e = errorOf(() => load({ ...baseConfig, token: TOKEN }));
    expect(e.message).toContain("token");
    expect(e.message).not.toContain(TOKEN);
  });

  it("설정 파일이 없으면 --config 를 가리킨다", () => {
    const e = errorOf(() =>
      loadRunnerConfig("/nope/config.json", { HOME, DODOK_RUNNER_TOKEN: TOKEN }, memFs({})),
    );
    expect(e.message).toMatch(/--config/);
    expect(e.message).not.toContain("/nope");
  });
});
