import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 루트 Dockerfile·bundle-smoke 와 같게 CLI 로 부른다
const script = resolve(import.meta.dirname, "../scripts/prune-runtime-deps.mjs");

let work: string;
let deploy: string;

type Manifest = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** pnpm 배치처럼 — 실제 디렉터리는 .pnpm/<이름>@<버전>/node_modules/<이름>, 의존성은 그 옆의 심볼릭 링크 */
function pkg(name: string, m: Manifest = {}): string {
  const version = m.version ?? "1.0.0";
  const store = join(deploy, "node_modules/.pnpm", `${name.replace("/", "+")}@${version}`, "node_modules");
  const dir = join(store, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...m, version }));
  writeFileSync(join(dir, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
  return dir;
}
function link(target: string, at: string) {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at);
}
/** 최상위 node_modules/<이름> → 실제 디렉터리 */
const top = (name: string, dir: string) => link(dir, join(deploy, "node_modules", name));
/** 부모 옆에 의존성 링크 — 이름이 스코프 없는 부모만(부모의 dirname 이 .pnpm/<이름>@<버전>/node_modules) */
const sibling = (parentDir: string, name: string, depDir: string) =>
  link(depDir, join(dirname(parentDir), name));

function run(names: unknown, out = join(work, "out")) {
  const list = join(work, "runtime-deps.json");
  writeFileSync(list, JSON.stringify(names));
  const r = spawnSync(process.execPath, [script, deploy, out, list], { cwd: work, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "dodok-prune-"));
  deploy = join(work, "deploy");
  mkdirSync(join(deploy, "node_modules"), { recursive: true });
  writeFileSync(join(deploy, "package.json"), JSON.stringify({ name: "@dodok/server", type: "module" }));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("prune-runtime-deps", () => {
  it("목록의 dependencies·optional·peer 닫힘만 평평하게 실제 파일로 복사한다 — 없는 optional·peer 는 건너뛰고 목록 밖 패키지는 싣지 않는다", () => {
    const scoped = pkg("@s/leaf");
    const opt = pkg("opt-dep");
    const b = pkg("b", { version: "2.0.0", dependencies: { "@s/leaf": "1.0.0" } });
    const peer = pkg("peer-dep");
    const a = pkg("a", {
      dependencies: { b: "2.0.0" },
      optionalDependencies: { "opt-dep": "1.0.0", "missing-optional": "1.0.0" },
      peerDependencies: { "peer-dep": "*", "missing-peer": "*" },
    });
    sibling(a, "b", b);
    sibling(a, "opt-dep", opt);
    sibling(a, "peer-dep", peer);
    sibling(b, "@s/leaf", scoped);
    top("a", a);
    top("unrelated", pkg("unrelated"));

    const r = run(["a"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      `runtime deps: @s/leaf@1.0.0, a@1.0.0, b@2.0.0, opt-dep@1.0.0, peer-dep@1.0.0 → ${r.out}\n`,
    );
    expect(readdirSync(r.out).sort()).toEqual(["@s", "a", "b", "opt-dep", "peer-dep"]);
    expect(existsSync(join(r.out, "unrelated"))).toBe(false);
    // 링크가 아니라 파일 — 이미지로 복사해도 deploy 디렉터리를 가리키지 않는다
    expect(lstatSync(join(r.out, "b")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(r.out, "@s/leaf/index.js"), "utf8")).toContain('"@s/leaf"');
  });

  it("dependencies 가 deploy 디렉터리에 없으면 누가 쓰는 무엇인지 한 줄로 exit 1", () => {
    top("a", pkg("a", { dependencies: { gone: "1.0.0" } }));
    const r = run(["a"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("runtime deps 실패: deploy 디렉터리에 없다: gone (a@1.0.0 의 의존성)\n");
  });

  it("목록의 이름 자체가 없어도 exit 1 — 번들이 런타임에 찾는 것이 운영 배치에 없다", () => {
    const r = run(["ws"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("runtime deps 실패: deploy 디렉터리에 없다: ws (runtime-deps.json 의 의존성)\n");
  });

  it("같은 이름이 두 버전이면 평평한 배치에 둘 수 없어 exit 1", () => {
    const b1 = pkg("b", { version: "1.0.0" });
    const b2 = pkg("b", { version: "2.0.0" });
    const a = pkg("a", { dependencies: { b: "1.0.0" } });
    const c = pkg("c", { dependencies: { b: "2.0.0" } });
    sibling(a, "b", b1);
    sibling(c, "b", b2);
    top("a", a);
    top("c", c);
    const r = run(["a", "c"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^runtime deps 실패: 같은 이름이 두 버전이다: b — /);
  });

  it("deploy 디렉터리 밖을 가리키는 링크는 싣지 않고 exit 1 — lockfile 이 아닌 버전이 섞이지 않게", () => {
    const outside = join(work, "elsewhere/x");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "x", version: "9.9.9" }));
    top("x", outside);
    const r = run(["x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^runtime deps 실패: deploy 디렉터리 밖에서 찾았다: x → /);
  });

  it("대상 디렉터리가 비어 있지 않으면 섞지 않고 exit 1", () => {
    top("a", pkg("a"));
    const out = join(work, "out");
    mkdirSync(join(out, "stale"), { recursive: true });
    const r = run(["a"], out);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`runtime deps 실패: 대상이 비어 있지 않다: ${out}\n`);
  });
});
