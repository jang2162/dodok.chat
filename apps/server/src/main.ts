import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { dataDirErrorMessage, isBundled, unwritableDataPath } from "./runtime";

// 소스 실행(`pnpm -F @dodok/server dev`)은 cwd 가 apps/server 다 — ./data·.env 가 저장소 루트를 가리키게 옮긴다.
// 운영 번들은 이미지의 WORKDIR·환경변수(env_file)를 그대로 쓴다(.env 파일을 읽지 않는다)
if (!isBundled()) {
  process.chdir(resolve(import.meta.dirname, "../../.."));
  if (existsSync(".env")) process.loadEnvFile(".env");
}

const config = loadConfig();
// 스택 없이 한 줄로 끝낸다 — 사람이 docker compose logs 에서 바로 읽고 고치게
const unwritable = unwritableDataPath({
  dataDir: config.DATA_DIR,
  dbPath: config.dbPath,
  attachmentsDir: config.attachmentsDir,
});
if (unwritable) {
  console.error(dataDirErrorMessage(unwritable));
  process.exit(1);
}
const app = await createApp(config);
await app.fastify.listen({ host: config.HOST, port: config.PORT });
app.logger.info({ url: app.url }, "dodok server listening");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    const t = setTimeout(() => process.exit(1), 10_000);
    void app.close().then(() => {
      clearTimeout(t);
      process.exit(0);
    });
  });
}
