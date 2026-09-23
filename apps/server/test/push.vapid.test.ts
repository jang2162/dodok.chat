import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadVapidKeys } from "../src/modules/push/vapid";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("loadVapidKeys", () => {
  it("환경변수 둘이 다 있으면 그것을 쓰고 파일을 만들지 않는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vapid-"));
    dirs.push(dir);
    const k = loadVapidKeys({ dataDir: dir, publicKey: "PUB", privateKey: "PRIV" });
    expect(k).toEqual({ publicKey: "PUB", privateKey: "PRIV" });
    await expect(stat(join(dir, "vapid.json"))).rejects.toThrow();
  });
  it("하나만 있으면 무시하고 파일로 간다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vapid-"));
    dirs.push(dir);
    const k = loadVapidKeys({ dataDir: dir, publicKey: "PUB" });
    expect(k.publicKey).not.toBe("PUB");
    const k2 = loadVapidKeys({ dataDir: dir, privateKey: "PRIV" });
    expect(k2.privateKey).not.toBe("PRIV");
    expect(k2).toEqual(k);
  });
  it("파일이 없으면 만들고(0600) 다음에는 같은 키를 읽는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vapid-"));
    dirs.push(dir);
    const a = loadVapidKeys({ dataDir: dir });
    expect((await stat(join(dir, "vapid.json"))).mode & 0o777).toBe(0o600);
    expect(loadVapidKeys({ dataDir: dir })).toEqual(a);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,100}$/);
  });
  it("파일이 망가졌으면 던진다(조용히 덮어써 모든 구독을 무효로 만들지 않는다)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vapid-"));
    dirs.push(dir);
    await writeFile(join(dir, "vapid.json"), "{bad");
    expect(() => loadVapidKeys({ dataDir: dir })).toThrow(/vapid\.json/);
    expect(await readFile(join(dir, "vapid.json"), "utf8")).toBe("{bad");
  });
});
