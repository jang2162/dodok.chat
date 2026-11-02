import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandHome,
  LEGACY_AGENTS_MESSAGE,
  loadRunnerConfig,
  resolveConfigPath,
  RunnerConfigError,
  type FsLike,
} from "../src/config";

const HOME = "/home/u";
const TOKEN = "drn_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function memFs(
  files: Record<string, { content?: string; mode?: number; dir?: boolean; realpath?: string }>,
): FsLike {
  return {
    realpath: (p) => files[p]?.realpath ?? p,
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
  roots: [{ id: "src", path: "~/src" }],
  programs: { claude: { configDir: "~/.dodok-runner/claude" } },
};

function load(config: unknown, opts: { env?: NodeJS.ProcessEnv; extra?: Parameters<typeof memFs>[0] } = {}) {
  const fs = memFs({
    "/cfg/config.json": { content: typeof config === "string" ? config : JSON.stringify(config) },
    "/home/u/src": { dir: true },
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
    expect(config.maxConcurrentRuns).toBe(3);
    expect(config.browse).toBe(true);
    expect(config.roots).toEqual([{ id: "src", path: "/home/u/src", label: "src" }]);
    expect(config.programs).toEqual({
      claude: {
        configDir: "/home/u/.dodok-runner/claude",
        maxPermissionMode: "default",
        disallowedTools: [],
        allowedToolsCeiling: null,
      },
    });
  });

  it("스펙 2장 예시 설정이 그대로 풀린다", () => {
    const { config } = load(
      {
        serverUrl: "https://chat.example.com",
        tokenFile: "~/.dodok-runner/token",
        maxConcurrentRuns: 3,
        roots: [{ id: "src", path: "~/src", label: "내 저장소들" }],
        browse: true,
        programs: {
          claude: {
            configDir: "~/.dodok-runner/claude",
            maxPermissionMode: "acceptEdits",
            disallowedTools: [],
            allowedToolsCeiling: null,
          },
        },
      },
      { env: {}, extra: { "/home/u/.dodok-runner/token": { content: TOKEN, mode: 0o100600 } } },
    );
    expect(config.roots).toEqual([{ id: "src", path: "/home/u/src", label: "내 저장소들" }]);
    expect(config.programs.claude?.maxPermissionMode).toBe("acceptEdits");
  });

  it("루트 path 는 realpath 로 쥔다 — 천장 검사가 풀린 경로끼리 견준다", () => {
    const { config } = load(baseConfig, {
      extra: { "/home/u/src": { dir: true, realpath: "/Volumes/data/src" } },
    });
    expect(config.roots[0]!.path).toBe("/Volumes/data/src");
  });

  it("옛 설정의 agents 키 — 정해진 문구로 거절한다(다른 오류보다 먼저)", () => {
    const e = errorOf(() =>
      load({
        serverUrl: "https://chat.example.com",
        claudeConfigDir: "~/.dodok-runner/claude",
        agents: [{ id: "coder", name: "코더", workdir: "~/src/my-repo", model: "sonnet" }],
      }),
    );
    expect(e.message).toBe("에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요");
    expect(LEGACY_AGENTS_MESSAGE).toBe(e.message);
  });

  it("programs.claude.configDir 이 없어도 받는다 — 해석된 값에도 없다", () => {
    const { config } = load({ ...baseConfig, programs: { claude: {} } });
    expect(config.programs.claude).toBeDefined();
    expect(config.programs.claude?.configDir).toBeUndefined();
    expect(config.programs.claude && "configDir" in config.programs.claude).toBe(false);
  });

  it("configDir 빈 문자열은 거절", () => {
    const e = errorOf(() => load({ ...baseConfig, programs: { claude: { configDir: "" } } }));
    expect(e.message).toContain("programs.claude.configDir");
  });

  it("권한 상한에 bypassPermissions 는 받지 않는다", () => {
    const e = errorOf(() =>
      load({
        ...baseConfig,
        programs: { claude: { configDir: "~/c", maxPermissionMode: "bypassPermissions" } },
      }),
    );
    expect(e.message).toContain("programs.claude.maxPermissionMode");
  });

  it("programs 에 적지 않은 프로그램은 꺼진 것이다 — 모르는 프로그램 키는 거절", () => {
    const { config } = load({ ...baseConfig, programs: {} });
    expect(config.programs).toEqual({});
    const e = errorOf(() => load({ ...baseConfig, programs: { gemini: { configDir: "~/g" } } }));
    expect(e.message).toContain("programs");
  });

  it("상한 도구 목록·늘 막는 도구를 받는다", () => {
    const { config } = load({
      ...baseConfig,
      programs: {
        claude: { configDir: "~/c", disallowedTools: ["WebFetch"], allowedToolsCeiling: ["Read", "Grep"] },
      },
    });
    expect(config.programs.claude).toMatchObject({
      disallowedTools: ["WebFetch"],
      allowedToolsCeiling: ["Read", "Grep"],
    });
  });

  it("roots 가 비면 거절한다", () => {
    expect(errorOf(() => load({ ...baseConfig, roots: [] })).message).toContain("roots");
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

  it("대문자 루트 id — 키 경로가 든 한 줄, 토큰 값은 싣지 않는다", () => {
    const e = errorOf(() => load({ ...baseConfig, roots: [{ ...baseConfig.roots[0], id: "Src" }] }));
    expect(e.message).toContain("roots[0].id");
    expect(e.message).not.toContain("\n");
    expect(e.message).not.toContain(TOKEN);
  });

  it("스키마 오류가 여럿이면 한 줄에 모두 싣는다", () => {
    const e = errorOf(() => load({ ...baseConfig, serverUrl: "nope", maxConcurrentRuns: 99 }));
    expect(e.message).toContain("serverUrl");
    expect(e.message).toContain("maxConcurrentRuns");
    expect(e.message).not.toContain("\n");
  });

  it("없는 루트 path — 키 경로와 라벨만, 경로 원문은 싣지 않는다", () => {
    const e = errorOf(() =>
      load({ ...baseConfig, roots: [{ id: "src", path: "~/src/gone", label: "gone-repo" }] }),
    );
    expect(e.message).toContain("roots[0].path");
    expect(e.message).toContain("gone-repo");
    expect(e.message).not.toContain("/home/u");
    expect(e.message).not.toContain("~/src/gone");
  });

  it("루트 path 가 파일이면 디렉터리가 아니라고 알린다", () => {
    const e = errorOf(() =>
      load(
        { ...baseConfig, roots: [{ id: "src", path: "/srv/file.txt" }] },
        { extra: { "/srv/file.txt": { content: "x" } } },
      ),
    );
    expect(e.message).toContain("roots[0].path");
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

  it("같은 루트 id 가 둘이면 거절한다", () => {
    const e = errorOf(() => load({ ...baseConfig, roots: [baseConfig.roots[0], baseConfig.roots[0]] }));
    expect(e.message).toContain("roots[1].id");
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

describe("expandHome — --config 인자와 설정 파일 안 경로가 함께 쓴다(리뷰 M6)", () => {
  it("`~` 하나·`~/…`·상대·절대", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/.dodok-runner/config.json", "/home/u")).toBe("/home/u/.dodok-runner/config.json");
    expect(expandHome("/etc/x.json", "/home/u")).toBe("/etc/x.json");
    expect(expandHome("rel/x.json", "/home/u")).toBe(resolve("rel/x.json"));
    expect(expandHome("~other/x", "/home/u")).toBe(resolve("~other/x"));
  });

  it("--config 인자 — 없으면 ~/.dodok-runner/config.json, 있으면 `~` 를 푼다(main 이 쓴다)", () => {
    expect(resolveConfigPath(undefined, "/home/u")).toBe("/home/u/.dodok-runner/config.json");
    expect(resolveConfigPath("~/alt.json", "/home/u")).toBe("/home/u/alt.json");
    expect(resolveConfigPath("~", "/home/u")).toBe("/home/u");
  });
});
