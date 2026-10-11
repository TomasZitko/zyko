import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { log } from "./lib/logger.js";
import { createSitesApp } from "./sites.js";
serve({ fetch: createSitesApp().fetch, port: env.SITES_PORT }, (i) => log.info("sites edge listening", { port: i.port }));
