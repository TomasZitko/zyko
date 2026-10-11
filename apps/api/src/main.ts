import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { env } from "./env.js";
import { log } from "./lib/logger.js";
import { runMigrations } from "./db/migrate.js";
import { startScheduler } from "./worker.js";
import { startWorker, stopWorker } from "./lib/jobs.js";
import { createSitesApp } from "./sites.js";

await runMigrations();
const api = serve({ fetch: createApp().fetch, port: env.PORT }, (i) => log.info("api listening", { port: i.port }));
// In development the sites edge runs in-process; in production run `pnpm --filter @zyko/api sites` separately.
const sites = env.NODE_ENV !== "production" ? serve({ fetch: createSitesApp().fetch, port: env.SITES_PORT }, (i) => log.info("sites edge listening", { port: i.port, domain: env.SITES_DOMAIN })) : null;
if (env.WORKER_INLINE) {
  startWorker();
  startScheduler();
}
const shutdown = () => {
  log.info("shutting down");
  stopWorker();
  api.close();
  sites?.close();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
