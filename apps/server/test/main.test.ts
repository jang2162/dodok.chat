import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// 진입점을 가짜 의존성으로 한 번 돌린다 — 소스 실행 cwd 옮기기는 번들인 척(isBundled true)으로 건너뛰고 아래에서 함수로 직접 잰다
const fake = vi.hoisted(() => {
  const setPreviousClean = vi.fn();
  const listen = vi.fn(async () => undefined);
  const app = {
    ops: {},
    logger: { info: vi.fn(), warn: vi.fn() },
    url: "http://127.0.0.1:0",
    fastify: { listen },
    setPreviousClean,
  };
  return { app, setPreviousClean, listen, installProcessHandlers: vi.fn() };
});
vi.mock("../src/runtime", () => ({
  isBundled: () => true,
  unwritableDataPath: () => null,
  dataDirErrorMessage: () => "",
}));
vi.mock("../src/config", () => ({
  loadConfig: () => ({
    DATA_DIR: "/nowhere",
    dbPath: "/nowhere/db",
    attachmentsDir: "/nowhere/a",
    HOST: "127.0.0.1",
    PORT: 0,
  }),
}));
vi.mock("../src/app", () => ({ createApp: async () => fake.app }));
vi.mock("../src/modules/ops/health", () => ({
  startRunState: () => ({ previousClean: false, markClean: () => undefined }),
}));
vi.mock("../src/process-handlers", () => ({ installProcessHandlers: fake.installProcessHandlers }));

const { enterSourceRoot } = await import("../src/main");

describe("main 진입점", () => {
  it("직전 종료 표지(startRunState 의 previousClean)를 앱에 넘기고 listen 한다(ops/status 의 previousClean)", () => {
    expect(fake.setPreviousClean).toHaveBeenCalledWith(false);
    expect(fake.installProcessHandlers).toHaveBeenCalledTimes(1);
    expect(fake.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 0 });
  });
});

describe("enterSourceRoot — 소스 실행의 cwd 옮기기", () => {
  function tree(withEnv: boolean) {
    const root = mkdtempSync(join(tmpdir(), "dodok-main-cwd-"));
    const src = join(root, "apps", "server", "src");
    mkdirSync(src, { recursive: true });
    if (withEnv) writeFileSync(join(root, ".env"), "X=1\n");
    return { root, src };
  }
  const proc = () => ({ chdir: vi.fn(), loadEnvFile: vi.fn() });

  it("소스 실행이면 src 의 세 단계 위(저장소 루트)로 옮기고 루트 .env 를 읽는다", () => {
    const { root, src } = tree(true);
    try {
      const p = proc();
      enterSourceRoot(false, src, p);
      expect(p.chdir).toHaveBeenCalledWith(root);
      expect(p.loadEnvFile).toHaveBeenCalledWith(join(root, ".env"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("루트에 .env 가 없으면 옮기기만 한다", () => {
    const { root, src } = tree(false);
    try {
      const p = proc();
      enterSourceRoot(false, src, p);
      expect(p.chdir).toHaveBeenCalledWith(root);
      expect(p.loadEnvFile).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("번들이면 cwd 를 옮기지도 .env 를 읽지도 않는다", () => {
    const { root, src } = tree(true);
    try {
      const p = proc();
      enterSourceRoot(true, src, p);
      expect(p.chdir).not.toHaveBeenCalled();
      expect(p.loadEnvFile).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("기본 here 는 실제 src 디렉터리 — 이 저장소의 루트를 가리킨다", () => {
    const p = proc();
    enterSourceRoot(false, undefined, p);
    expect(p.chdir).toHaveBeenCalledWith(join(import.meta.dirname, "../../.."));
  });
});
