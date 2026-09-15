import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";

// `pnpm -F @dodok/server dev` 는 cwd 가 apps/server 다. ./data·.env 가 저장소 루트를 가리키게 옮긴다.
process.chdir(resolve(import.meta.dirname, "../../.."));
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
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
