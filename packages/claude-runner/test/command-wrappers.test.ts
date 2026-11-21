import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandWrappers } from "../src/drivers/claude/command-wrappers";

/** 디렉터리 나무의 상대 경로·크기·수정 시각 — 사람 폴더가 바뀌지 않았는지 견준다 */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      out.push(`${relative(dir, p)} ${st.isDirectory() ? "d" : st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

describe("createCommandWrappers(에이전트 명령 C14 — 스파이크 꼴)", () => {
  let base: string;
  let cfg: string;
  let proj: string;
  let tmp: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-wrappers-")));
    cfg = join(base, "cfg");
    proj = join(base, "proj");
    tmp = join(base, "tmp");
    mkdirSync(tmp);
    mkdirSync(join(cfg, "commands"), { recursive: true });
    mkdirSync(join(cfg, "skills", "user-skill"), { recursive: true });
    writeFileSync(join(cfg, "commands", "user-cmd.md"), "---\ndescription: d\n---\nbody");
    writeFileSync(join(cfg, "skills", "user-skill", "SKILL.md"), "---\nname: user-skill\n---\nbody");
    writeFileSync(join(cfg, "settings.json"), '{"permissions":{"allow":["Bash(*)"]}}');
    mkdirSync(join(proj, ".claude", "commands"), { recursive: true });
    writeFileSync(join(proj, ".claude", "commands", "proj-cmd.md"), "body");
    writeFileSync(join(proj, ".claude", "settings.json"), "{}");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("두 감싸개 — plugin.json 이름, commands·skills 링크 대상, skipMcpDiscovery", async () => {
    const w = await createCommandWrappers({ configDir: cfg, cwd: proj, tmpRoot: tmp });
    expect(w.plugins).toHaveLength(2);
    const [user, project] = w.plugins;
    expect(user).toMatchObject({ type: "local", skipMcpDiscovery: true });
    expect(project).toMatchObject({ type: "local", skipMcpDiscovery: true });
    expect(JSON.parse(readFileSync(join(user!.path, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "user",
    });
    expect(JSON.parse(readFileSync(join(project!.path, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "project",
    });
    expect(readlinkSync(join(user!.path, "commands"))).toBe(join(cfg, "commands"));
    expect(readlinkSync(join(user!.path, "skills"))).toBe(join(cfg, "skills"));
    expect(readlinkSync(join(project!.path, "commands"))).toBe(join(proj, ".claude", "commands"));
    // 원본이 없는 링크는 만들지 않는다 — 프로젝트에 skills 가 없다
    expect(existsSync(join(project!.path, "skills"))).toBe(false);
    // 설정 파일은 들이지 않는다 — 감싸개에는 plugin.json·링크뿐
    expect(readdirSync(user!.path).sort()).toEqual([".claude-plugin", "commands", "skills"]);
    await w.dispose();
  });

  it("원본이 둘 다 없으면 그 감싸개를 만들지 않는다 — 다 없으면 임시 디렉터리도 없다", async () => {
    rmSync(join(proj, ".claude", "commands"), { recursive: true });
    const w = await createCommandWrappers({ configDir: cfg, cwd: proj, tmpRoot: tmp });
    expect(w.plugins).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(w.plugins[0]!.path, ".claude-plugin", "plugin.json"), "utf8")).name,
    ).toBe("user");
    await w.dispose();
    const none = await createCommandWrappers({
      configDir: join(base, "nope"),
      cwd: join(base, "nope2"),
      tmpRoot: tmp,
    });
    expect(none.plugins).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
    await none.dispose();
  });

  it("dispose 뒤 감싸개는 없고, 사람 폴더는 한 글자도 바뀌지 않는다", async () => {
    const before = [snapshot(cfg), snapshot(proj)];
    const w = await createCommandWrappers({ configDir: cfg, cwd: proj, tmpRoot: tmp });
    const paths = w.plugins.map((p) => p.path);
    expect(paths.every((p) => statSync(p).isDirectory())).toBe(true);
    await w.dispose();
    await w.dispose(); // 두 번 불러도 된다
    expect(paths.some((p) => existsSync(p))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
    expect([snapshot(cfg), snapshot(proj)]).toEqual(before);
  });
});
