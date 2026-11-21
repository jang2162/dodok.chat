import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 사람의 명령·스킬만 골라 들이는 플러그인 감싸개(에이전트 명령 스펙 C14, 스파이크 보고 1절). settingSources 는 [] 그대로 두고 — 그래서
// settings.json 의 권한·훅·env 와 CLAUDE.md 는 들어오지 않는다 — 임시 디렉터리에 플러그인 둘을 만들어 명령·스킬 폴더만 심볼릭
// 링크로 잇는다: user(<configDir>/commands·skills)와 project(<cwd>/.claude/commands·skills). CLI 는 링크를 따라간다. 명령 이름은
// `user:이름`·`project:이름` 이 된다(C16). 사람 폴더에는 아무것도 쓰지 않는다

export type CommandWrapperPlugin = { type: "local"; path: string; skipMcpDiscovery: true };

export type CommandWrappers = {
  plugins: CommandWrapperPlugin[];
  /** 임시 디렉터리를 지운다 — 링크만 지우고 사람 폴더는 따라가지 않는다. 두 번 불러도 된다 */
  dispose(): Promise<void>;
};

const FOLDERS = ["commands", "skills"] as const;

const isDirectory = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * configDir 는 그 런의 Claude 설정 자리(전용 로그인이면 그 디렉터리, 평소면 CLAUDE_CONFIG_DIR 또는 ~/.claude). 원본 폴더가 없으면 그
 * 링크를 만들지 않고, 둘 다 없으면 그 감싸개를 만들지 않는다. 만들다 실패하면 만든 것을 지우고 던진다
 */
export async function createCommandWrappers(opts: {
  configDir: string;
  cwd: string;
  tmpRoot?: string;
}): Promise<CommandWrappers> {
  const sources: Array<{ name: "user" | "project"; base: string }> = [
    { name: "user", base: opts.configDir },
    { name: "project", base: join(opts.cwd, ".claude") },
  ];
  const wanted = sources
    .map(({ name, base }) => ({
      name,
      links: FOLDERS.filter((folder) => isDirectory(join(base, folder))).map((folder) => ({
        folder,
        target: join(base, folder),
      })),
    }))
    .filter((s) => s.links.length > 0);
  if (wanted.length === 0) return { plugins: [], dispose: async () => {} };

  const root = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), "dodok-runner-commands-"));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const plugins: CommandWrapperPlugin[] = [];
    for (const { name, links } of wanted) {
      const dir = join(root, name);
      await mkdir(join(dir, ".claude-plugin"), { recursive: true });
      await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
      for (const { folder, target } of links) await symlink(target, join(dir, folder), "dir");
      plugins.push({ type: "local", path: dir, skipMcpDiscovery: true });
    }
    return { plugins, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
