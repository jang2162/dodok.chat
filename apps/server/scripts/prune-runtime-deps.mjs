// apps/server/scripts/prune-runtime-deps.mjs — 운영 배치의 node_modules 를 번들이 런타임에 찾는 패키지의 닫힘만으로 줄인다.
// 사용: node scripts/prune-runtime-deps.mjs <deploy 디렉터리> <대상 node_modules> <runtime-deps.json>
//   <deploy 디렉터리>   `pnpm deploy --prod` 산출물 — 버전은 거기서(= lockfile) 온다. 손으로 버전을 풀지 않는다
//   <runtime-deps.json> build.mjs 가 dist/ 에 쓰는 이름 목록(정본은 build.mjs 의 runtimeDeps)
// 쓰는 곳은 둘이고 같은 명령이다: infra/Dockerfile.server 의 deploy 단계, bundle-smoke.mjs. 스모크가 가지치기된 배치에서 번들을
// 띄우므로 목록이 모자라면(런타임에 찾는 것이 목록에 없으면) 스모크가 빨개진다.
// 까닭: deploy 산출물을 통째로 실으면 번들에 이미 든 의존성과, better-auth 의 optional peer 가 lockfile 스냅숏에 워크스페이스 것으로
// 묶여 따라온 개발 도구(vitest·vite·drizzle-kit·jsdom…)·@dodok/* 의 TS 원본까지 실린다 — 이미지 node_modules 234 MB 대 이 닫힘 27 MB
// (docker run --rm <runtime 이미지> du -sh /app/node_modules 로 잰다).
//
// 닫힘: 이름마다 deploy 디렉터리에서 찾은 실제 디렉터리 + 그 dependencies·optionalDependencies·peerDependencies 를 그 패키지 자리에서
// Node 처럼(위로 올라가며 node_modules/<이름>) 다시 찾은 것. 설치되지 않은 optional·peer 는 건너뛰고, dependencies 가 없으면 멈춘다.
// 결과는 평평하다(<대상>/<이름>) — 같은 이름이 두 버전이면 한 자리에 둘 수 없어 멈춘다(그때는 중첩 배치가 필요하다)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function findPackage(fromDir, name, root) {
  for (let d = fromDir; ; d = dirname(d)) {
    const manifest = join(d, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      const dir = realpathSync(dirname(manifest));
      // deploy 디렉터리 밖(호스트·워크스페이스의 node_modules)에서 찾은 것을 실으면 lockfile 이 아닌 버전이 섞인다
      if (dir !== root && !dir.startsWith(root + sep))
        throw new Error(`deploy 디렉터리 밖에서 찾았다: ${name} → ${dir}`);
      return dir;
    }
    if (d === root || dirname(d) === d) return null;
  }
}

/** 닫힘을 { name, version, dir } 목록으로 — 이름순 */
export function runtimeClosure(deployDir, names) {
  const root = realpathSync(resolve(deployDir));
  const found = new Map();
  const visit = (fromDir, name, required, parent) => {
    const dir = findPackage(fromDir, name, root);
    if (!dir) {
      if (required) throw new Error(`deploy 디렉터리에 없다: ${name} (${parent} 의 의존성)`);
      return;
    }
    const seen = found.get(name);
    if (seen) {
      if (seen.dir !== dir) throw new Error(`같은 이름이 두 버전이다: ${name} — ${seen.dir} · ${dir}`);
      return;
    }
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    found.set(name, { name, version: manifest.version, dir });
    const label = `${name}@${manifest.version}`;
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dir, dep, true, label);
    for (const dep of Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies }))
      visit(dir, dep, false, label);
  };
  for (const name of names) visit(root, name, true, "runtime-deps.json");
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 닫힘을 <outDir>/<이름> 으로 복사한다(심볼릭 링크는 따라가 실제 파일로). outDir 은 없거나 비어 있어야 한다 */
export function pruneRuntimeDeps(deployDir, outDir, names) {
  if (existsSync(outDir) && readdirSync(outDir).length > 0)
    throw new Error(`대상이 비어 있지 않다: ${outDir}`);
  const closure = runtimeClosure(deployDir, names);
  for (const pkg of closure) {
    const dest = join(outDir, pkg.name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(pkg.dir, dest, { recursive: true, dereference: true });
  }
  return closure;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [deployDir, outDir, listPath] = process.argv.slice(2);
  if (!deployDir || !outDir || !listPath) {
    console.error(
      "사용: node prune-runtime-deps.mjs <deploy 디렉터리> <대상 node_modules> <runtime-deps.json>",
    );
    process.exit(2);
  }
  try {
    const names = JSON.parse(readFileSync(listPath, "utf8"));
    const closure = pruneRuntimeDeps(deployDir, outDir, names);
    console.log(`runtime deps: ${closure.map((p) => `${p.name}@${p.version}`).join(", ")} → ${outDir}`);
  } catch (e) {
    console.error(`runtime deps 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
