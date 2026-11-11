import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { loadRunnerConfig } from "../src/config";
import {
  createTerminalPrompter,
  detectClaudeForSetup,
  rootIdFromLabel,
  runSetupWizard,
  runTokenCommand,
  SetupAborted,
  tokenFileFor,
  type Prompter,
} from "../src/setup";

const TOKEN = "drn_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

/** 답을 차례로 내는 질문기 — 답이 떨어지면 EOF 처럼 SetupAborted */
function scripted(answers: string[]) {
  const asked: { question: string; hidden: boolean }[] = [];
  const printed: string[] = [];
  let closed = false;
  const prompter: Prompter = {
    ask: async (question, opts) => {
      asked.push({ question, hidden: opts?.hidden === true });
      const next = answers.shift();
      if (next === undefined) throw new SetupAborted();
      return next;
    },
    print: (line) => printed.push(line),
    close: () => {
      closed = true;
    },
  };
  return { prompter, asked, printed, isClosed: () => closed };
}

let home: string;
let work: string;
let other: string;
let configPath: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dodok-setup-home-")));
  work = join(home, "work");
  other = join(home, "other dir");
  mkdirSync(work);
  mkdirSync(other);
  configPath = join(home, ".dodok-runner", "config.json");
});

function wizard(
  answers: string[],
  extra: { confirmOverwrite?: boolean; loggedIn?: boolean; configPath?: string } = {},
) {
  const s = scripted(answers);
  const run = runSetupWizard({
    prompter: s.prompter,
    configPath: extra.configPath ?? configPath,
    home,
    cwd: work,
    env: { HOME: home },
    confirmOverwrite: extra.confirmOverwrite,
    claude: async () => ({ cli: "내장 2.1.283", loggedIn: extra.loggedIn ?? true }),
  });
  return { ...s, run };
}

describe("runSetupWizard", () => {
  it("기본값 Enter·루트 둘·acceptEdits — 로더를 통과하고 토큰은 0600 파일에만", async () => {
    const w = wizard([
      "https://chat.example.com",
      `  ${TOKEN}  `,
      "", // 루트 경로 — 지금 디렉터리
      "", // 라벨 — 디렉터리 이름
      "y",
      "~/other dir",
      "Other Dir!",
      "n",
      "2", // acceptEdits
      "", // 저장 — 기본 Y
    ]);
    const result = await w.run;
    expect(result.status).toBe("saved");
    expect(w.isClosed()).toBe(true);
    expect(w.asked.map((a) => a.question)).toEqual([
      "서버 주소: ",
      "러너 토큰: ",
      `루트 경로 [${work}]: `,
      "라벨 [work]: ",
      "루트를 더 추가할까요? (y/N) ",
      `루트 경로 [${work}]: `,
      "라벨 [other dir]: ",
      "루트를 더 추가할까요? (y/N) ",
      "선택 [1]: ",
      "저장하고 시작할까요? (Y/n) ",
    ]);
    expect(w.asked.filter((a) => a.hidden).map((a) => a.question)).toEqual(["러너 토큰: "]);

    const text = readFileSync(configPath, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(w.printed.join("\n")).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({
      serverUrl: "https://chat.example.com",
      tokenFile: "~/.dodok-runner/token",
      maxConcurrentRuns: 3,
      roots: [
        { id: "work", path: work, label: "work" },
        { id: "other-dir", path: other, label: "Other Dir!" },
      ],
      browse: true,
      programs: {
        claude: { maxPermissionMode: "acceptEdits", disallowedTools: [], allowedToolsCeiling: null },
      },
    });
    const tokenPath = join(home, ".dodok-runner", "token");
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(TOKEN);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".dodok-runner")).mode & 0o777).toBe(0o700);

    // 러너가 실제로 읽는 길 — 마법사가 돌려준 것과 같다
    const loaded = loadRunnerConfig(configPath, { HOME: home });
    expect(loaded.token).toBe(TOKEN);
    expect(loaded.warnings).toEqual([]);
    expect(result.status === "saved" && result.loaded.config).toEqual(loaded.config);
  });

  it("권한을 고르지 않으면 default — 로그인이 없으면 /login 안내", async () => {
    const w = wizard(["http://localhost:3000", TOKEN, "", "", "", "", ""], { loggedIn: false });
    expect((await w.run).status).toBe("saved");
    expect(JSON.parse(readFileSync(configPath, "utf8")).programs.claude.maxPermissionMode).toBe("default");
    expect(w.printed).toContain("Claude Code: 내장 2.1.283");
    expect(w.printed).toContain("로그인: 없음 — claude 를 열어 /login 하세요");
  });

  it("틀린 URL·빈 토큰·없는 디렉터리·틀린 선택은 다시 묻는다", async () => {
    const w = wizard([
      "chat.example.com",
      "ftp://chat.example.com",
      "https://chat.example.com",
      "   ",
      TOKEN,
      join(home, "nope"),
      work,
      "",
      "",
      "9",
      "bypassPermissions",
      "plan",
      "y",
    ]);
    expect((await w.run).status).toBe("saved");
    const questions = w.asked.map((a) => a.question);
    expect(questions.filter((q) => q === "서버 주소: ")).toHaveLength(3);
    expect(questions.filter((q) => q === "러너 토큰: ")).toHaveLength(2);
    expect(questions.filter((q) => q.startsWith("루트 경로"))).toHaveLength(2);
    expect(questions.filter((q) => q === "선택 [1]: ")).toHaveLength(3);
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.roots).toEqual([{ id: "work", path: work, label: "work" }]);
    expect(saved.programs.claude.maxPermissionMode).toBe("plan");
  });

  it("EOF(Ctrl-C) 면 아무 파일도 쓰지 않는다 — 마지막 확인 직전이라도", async () => {
    const w = wizard(["https://chat.example.com", TOKEN, "", "", "", "1"]);
    expect((await w.run).status).toBe("aborted");
    expect(w.isClosed()).toBe(true);
    expect(existsSync(join(home, ".dodok-runner"))).toBe(false);
  });

  it("마지막에 n 이면 쓰지 않는다", async () => {
    const w = wizard(["https://chat.example.com", TOKEN, "", "", "", "1", "n"]);
    expect((await w.run).status).toBe("declined");
    expect(existsSync(join(home, ".dodok-runner"))).toBe(false);
  });

  it("setup — 설정이 있으면 덮기 전에 묻고, 덮으면 옛 파일을 .bak 으로", async () => {
    mkdirSync(join(home, ".dodok-runner"));
    writeFileSync(configPath, '{"old":true}\n');

    const keep = wizard(["", "https://x.example"], { confirmOverwrite: true });
    expect((await keep.run).status).toBe("kept");
    expect(keep.asked.map((a) => a.question)).toEqual(["설정 파일이 이미 있습니다. 덮어쓸까요? (y/N) "]);
    expect(readFileSync(configPath, "utf8")).toBe('{"old":true}\n');
    expect(existsSync(`${configPath}.bak`)).toBe(false);

    const overwrite = wizard(["y", "https://chat.example.com", TOKEN, "", "", "", "", ""], {
      confirmOverwrite: true,
    });
    expect((await overwrite.run).status).toBe("saved");
    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe('{"old":true}\n');
    expect(JSON.parse(readFileSync(configPath, "utf8")).serverUrl).toBe("https://chat.example.com");
  });
});

describe("runSetupWizard — 설정이 이미 있을 때(setup)", () => {
  const tokenPath = () => join(home, ".dodok-runner", "token");
  function existing(extra: Record<string, unknown> = {}) {
    mkdirSync(join(home, ".dodok-runner"), { recursive: true });
    writeFileSync(tokenPath(), `${TOKEN}\n`, { mode: 0o600 });
    const prev = {
      serverUrl: "https://old.example",
      tokenFile: "~/.dodok-runner/token",
      maxConcurrentRuns: 5,
      roots: [
        { id: "proj-a", path: "~/work", label: "작업" },
        { id: "gone", path: "~/gone", label: "gone" },
        { id: "proj-b", path: other },
      ],
      browse: false,
      programs: {
        claude: {
          configDir: "~/.claude-alt",
          executable: "/opt/claude",
          maxPermissionMode: "plan",
          disallowedTools: ["Bash"],
          allowedToolsCeiling: ["Read"],
        },
      },
      ...extra,
    };
    writeFileSync(configPath, `${JSON.stringify(prev)}\n`);
    return prev;
  }

  it("Enter 만 치면 지금 값 그대로 — 루트 id 유지, 없는 루트는 빼고, 묻지 않는 키 보존, 토큰 파일은 안 건드린다", async () => {
    const prev = existing();
    const before = statSync(tokenPath()).mtimeMs;
    const seen: unknown[] = [];
    const s = scripted(["y", "", "", "", "", "", "", ""]);
    const result = await runSetupWizard({
      prompter: s.prompter,
      configPath,
      home,
      cwd: work,
      env: { HOME: home },
      confirmOverwrite: true,
      claude: async (ceiling) => {
        seen.push(ceiling);
        return { cli: "설치본 2.1.322 (/opt/claude)", loggedIn: true };
      },
    });
    expect(result.status).toBe("saved");
    expect(s.asked.map((a) => a.question)).toEqual([
      "설정 파일이 이미 있습니다. 덮어쓸까요? (y/N) ",
      "서버 주소 [https://old.example]: ",
      "러너 토큰 [그대로]: ",
      "루트 작업 (~/work) 를 그대로 둘까요? (Y/n) ",
      `루트 other dir (${other}) 를 그대로 둘까요? (Y/n) `,
      "루트를 더 추가할까요? (y/N) ",
      "선택 [3]: ",
      "저장하고 시작할까요? (Y/n) ",
    ]);
    expect(s.printed).toContain("루트 gone (~/gone): 디렉터리가 없어 뺍니다.");
    expect(s.printed).toContain("로그인: 전용 로그인(~/.claude-alt)");
    expect(seen).toEqual([{ executable: "/opt/claude", configDir: join(home, ".claude-alt") }]);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      ...prev,
      roots: [prev.roots[0], prev.roots[2]],
    });
    expect(JSON.parse(readFileSync(`${configPath}.bak`, "utf8"))).toEqual(prev);
    expect(readFileSync(tokenPath(), "utf8").trim()).toBe(TOKEN);
    expect(statSync(tokenPath()).mtimeMs).toBe(before);
  });

  it("값을 바꾸면 그 값만 — 새 루트 id 는 지금 id(뺀 것 포함)와 겹치지 않고, 새 토큰은 그 tokenFile 자리에", async () => {
    existing();
    mkdirSync(join(home, "gone2"));
    const w = wizard(
      [
        "y",
        "https://new.example",
        "drn_new_token_value",
        "n", // 작업 루트 빼기
        "", // other dir 그대로
        "y",
        "~/gone2",
        "proj-a", // 라벨이 뺀 루트 id 와 같다
        "y",
        "~/work",
        "Gone",
        "n",
        "1",
        "",
      ],
      { confirmOverwrite: true },
    );
    expect((await w.run).status).toBe("saved");
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.serverUrl).toBe("https://new.example");
    expect(saved.roots).toEqual([
      { id: "proj-b", path: other },
      { id: "proj-a-2", path: join(home, "gone2"), label: "proj-a" },
      { id: "gone-2", path: work, label: "Gone" },
    ]);
    expect(saved.programs.claude.maxPermissionMode).toBe("default");
    expect(saved.programs.claude.disallowedTools).toEqual(["Bash"]);
    expect(saved.maxConcurrentRuns).toBe(5);
    expect(readFileSync(tokenPath(), "utf8").trim()).toBe("drn_new_token_value");
  });

  it("지금 설정이 env 토큰이면 토큰을 꼭 묻고 설정 옆 token 에 둔다", async () => {
    existing({ tokenFile: undefined });
    const w = wizard(["y", "", "", "drn_env_replaced", "", "", "", "", ""], { confirmOverwrite: true });
    expect((await w.run).status).toBe("saved");
    expect(w.asked.filter((a) => a.question === "러너 토큰: ")).toHaveLength(2);
    expect(JSON.parse(readFileSync(configPath, "utf8")).tokenFile).toBe("~/.dodok-runner/token");
    expect(readFileSync(tokenPath(), "utf8").trim()).toBe("drn_env_replaced");
  });

  it("지금 설정이 깨졌으면 처음부터 묻는다", async () => {
    mkdirSync(join(home, ".dodok-runner"));
    writeFileSync(configPath, "{ nope");
    const w = wizard(["y", "https://chat.example.com", TOKEN, "", "", "", "", ""], {
      confirmOverwrite: true,
    });
    expect((await w.run).status).toBe("saved");
    expect(w.printed).toContain("지금 설정을 읽지 못해 처음부터 묻습니다.");
    expect(w.asked[1]!.question).toBe("서버 주소: ");
  });
});

describe("토큰 파일 자리", () => {
  it("설정 파일과 같은 디렉터리의 token — --config 가 다르면 토큰도 갈린다", async () => {
    expect(tokenFileFor(join(home, ".dodok-runner", "config.json"), home)).toBe("~/.dodok-runner/token");
    expect(tokenFileFor("/etc/dodok/b.json", home)).toBe("/etc/dodok/token");
    const second = join(home, "runner-b", "config.json");
    const w = wizard(["https://chat.example.com", TOKEN, "", "", "", "", ""], { configPath: second });
    expect((await w.run).status).toBe("saved");
    expect(JSON.parse(readFileSync(second, "utf8")).tokenFile).toBe("~/runner-b/token");
    expect(readFileSync(join(home, "runner-b", "token"), "utf8").trim()).toBe(TOKEN);
    expect(existsSync(join(home, ".dodok-runner"))).toBe(false);
  });
});

describe("runTokenCommand", () => {
  function run(answers: string[]) {
    const s = scripted(answers);
    return { ...s, result: runTokenCommand({ prompter: s.prompter, configPath, home }) };
  }

  it("토큰만 그 tokenFile 자리에 0600 으로 쓰고 설정 파일은 건드리지 않는다", async () => {
    mkdirSync(join(home, "rb"));
    const cfg = `${JSON.stringify({ serverUrl: "https://x.example", tokenFile: "~/rb/tok", roots: [{ id: "w", path: work }], programs: {} })}\n`;
    mkdirSync(join(home, ".dodok-runner"));
    writeFileSync(configPath, cfg);
    const t = run(["  ", " drn_reissued "]);
    expect(await t.result).toEqual({ status: "saved" });
    expect(t.asked.map((a) => [a.question, a.hidden])).toEqual([
      ["새 러너 토큰: ", true],
      ["새 러너 토큰: ", true],
    ]);
    expect(readFileSync(join(home, "rb", "tok"), "utf8")).toBe("drn_reissued\n");
    expect(statSync(join(home, "rb", "tok")).mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, "utf8")).toBe(cfg);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
    expect(t.printed.join("\n")).not.toContain("drn_reissued");
    expect(t.isClosed()).toBe(true);
  });

  it("설정이 없거나 깨졌거나 tokenFile 이 없으면 묻지 않고 한 줄로 알린다", async () => {
    const none = run([TOKEN]);
    expect(await none.result).toEqual({
      status: "error",
      message: "설정 파일이 없습니다 — 터미널에서 dodok-runner 를 실행해 설정을 만드세요",
    });
    expect(none.asked).toEqual([]);

    mkdirSync(join(home, ".dodok-runner"));
    writeFileSync(configPath, "{ nope");
    expect((await run([TOKEN]).result).status).toBe("error");

    writeFileSync(
      configPath,
      JSON.stringify({ serverUrl: "https://x.example", roots: [{ id: "w", path: work }], programs: {} }),
    );
    const env = run([TOKEN]);
    expect(await env.result).toEqual({
      status: "error",
      message: "이 설정은 tokenFile 을 쓰지 않습니다 — 토큰을 둔 env DODOK_RUNNER_TOKEN 을 바꾸세요",
    });
    expect(env.asked).toEqual([]);
    expect(existsSync(join(home, ".dodok-runner", "token"))).toBe(false);
  });

  it("Ctrl-C·EOF 면 쓰지 않는다", async () => {
    mkdirSync(join(home, ".dodok-runner"));
    writeFileSync(
      configPath,
      JSON.stringify({
        serverUrl: "https://x.example",
        tokenFile: "~/.dodok-runner/token",
        roots: [{ id: "w", path: work }],
        programs: {},
      }),
    );
    expect(await run([]).result).toEqual({ status: "aborted" });
    expect(existsSync(join(home, ".dodok-runner", "token"))).toBe(false);
  });
});

describe("rootIdFromLabel", () => {
  it("RunnerRootId 꼴로 줄이고 겹치면 번호를 붙인다", () => {
    expect(rootIdFromLabel("My Project!", new Set())).toBe("my-project");
    expect(rootIdFromLabel("작업", new Set())).toBe("root");
    expect(rootIdFromLabel("src", new Set(["src"]))).toBe("src-2");
    expect(rootIdFromLabel("a".repeat(40), new Set(["a".repeat(32)]))).toBe(`${"a".repeat(30)}-2`);
  });
});

describe("detectClaudeForSetup", () => {
  it("PATH 의 설치본은 판·경로, 없으면 내장 판 — 로그인은 디렉터리 유무", async () => {
    const installed = await detectClaudeForSetup({
      env: { HOME: "/h", PATH: "/opt/bin" },
      bundledVersion: "2.1.283",
      isExecutable: (p) => p === "/opt/bin/claude",
      readVersion: async () => "2.1.322",
      exists: (p) => p === "/h/.claude",
    });
    expect(installed).toEqual({ cli: "설치본 2.1.322 (/opt/bin/claude)", loggedIn: true });
    const bundled = await detectClaudeForSetup({
      env: { HOME: "/h", PATH: "/opt/bin", CLAUDE_CONFIG_DIR: "/elsewhere" },
      bundledVersion: "2.1.283",
      isExecutable: () => false,
      exists: (p) => p === "/h/.claude",
    });
    expect(bundled).toEqual({ cli: "내장 2.1.283", loggedIn: false });
  });
});

describe("createTerminalPrompter", () => {
  it("빨리 들어온 여러 줄을 잃지 않고, 숨김 입력은 찍지 않고, EOF 면 SetupAborted", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const p = createTerminalPrompter(input, output);
    input.write(`https://a.example\n${TOKEN}\n`);
    await new Promise((r) => setImmediate(r));
    expect(await p.ask("서버 주소: ")).toBe("https://a.example");
    expect(await p.ask("러너 토큰: ", { hidden: true })).toBe(TOKEN);
    const pending = p.ask("루트 경로: ");
    input.end();
    await expect(pending).rejects.toBeInstanceOf(SetupAborted);
    await expect(p.ask("다음: ")).rejects.toBeInstanceOf(SetupAborted);
    expect(shown).toContain("서버 주소: ");
    expect(shown).not.toContain(TOKEN);
  });

  it("터미널이면 숨김 입력 중에 친 글자를 되찍지 않는다", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const p = createTerminalPrompter(input, output);
    const pending = p.ask("러너 토큰: ", { hidden: true });
    input.write(`${TOKEN}\r`);
    expect(await pending).toBe(TOKEN);
    expect(shown).toContain("러너 토큰: ");
    expect(shown).not.toContain(TOKEN.slice(0, 8));
    p.close();
  });

  it("터미널 — 서버 주소 칸에 주소와 토큰을 한꺼번에 붙여 넣어도 토큰은 찍히지 않는다", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const p = createTerminalPrompter(input, output);
    const url = p.ask("서버 주소: ");
    input.write(`https://a.example\r${TOKEN}\r`);
    expect(await url).toBe("https://a.example");
    expect(await p.ask("러너 토큰: ", { hidden: true })).toBe(TOKEN);
    expect(shown).toContain("https://a.example");
    expect(shown).not.toContain(TOKEN.slice(0, 8));
    // 같이 붙여 넣은 다음 보이는 답은 질문 뒤에 보인다
    input.write("~/src\r");
    await new Promise((r) => setImmediate(r));
    expect(await p.ask("루트 경로: ")).toBe("~/src");
    expect(shown).toContain("루트 경로: ~/src\n");
    p.close();
  });

  it("터미널 — 줄바꿈 없이 미리 친 토큰도 숨김 질문이 다시 그리지 않는다", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const p = createTerminalPrompter(input, output);
    const url = p.ask("서버 주소: ");
    input.write(`https://a.example\r${TOKEN}`);
    expect(await url).toBe("https://a.example");
    const pending = p.ask("러너 토큰: ", { hidden: true });
    input.write("\r");
    expect(await pending).toBe(TOKEN);
    expect(shown).not.toContain(TOKEN.slice(0, 8));
    p.close();
  });
});
