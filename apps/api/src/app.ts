import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { env } from "./env.js";
import type { AppEnv } from "./http.js";
import { AppError, forbidden } from "./lib/errors.js";
import { log, metrics, reportError } from "./lib/logger.js";
import { resolveSession } from "./services/auth.js";
import { authRoutes, readSessionToken } from "./routes/auth.js";
import { inviteRoutes, orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";
import { assetRoutes } from "./routes/assets.js";
import { aiRoutes } from "./routes/ai.js";
import { hostingRoutes } from "./routes/hosting.js";
import { hookRoutes, moduleRoutes } from "./routes/modules.js";
import { adminRoutes, billingRoutes, notificationRoutes } from "./routes/platform.js";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const id = c.req.header("x-request-id")?.slice(0, 64) || crypto.randomUUID();
    c.set("requestId", id);
    const t = performance.now();
    await next();
    const ms = performance.now() - t;
    c.header("X-Request-Id", id);
    const route = c.req.routePath ?? "unknown";
    metrics.inc("zyko_http_requests_total", { method: c.req.method, status: String(c.res.status) });
    metrics.observe("zyko_http_request_ms", ms);
    if (ms > 1000) log.warn("slow request", { route, method: c.req.method, ms: Math.round(ms), requestId: id });
  });
  app.use("*", secureHeaders({ crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));

  // CSRF: cookie auth + SameSite=Lax, plus Origin verification on state-changing requests.
  app.use("/api/*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.path.startsWith("/api/billing/webhook")) {
      const origin = c.req.header("origin");
      const allowed = new URL(env.APP_ORIGIN).origin;
      if (origin && origin !== allowed) throw forbidden("Cross-origin request rejected");
      if (!origin && c.req.header("sec-fetch-site") === "cross-site") throw forbidden("Cross-site request rejected");
    }
    const token = readSessionToken(c);
    const s = token ? await resolveSession(token) : null;
    c.set("user", s?.user ?? null);
    c.set("sessionId", s?.sessionId ?? null);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  });
  app.get("/metrics", (c) => c.text(metrics.render()));

  app.route("/api/auth", authRoutes);
  app.route("/api/orgs", orgRoutes);
  app.route("/api/invitations", inviteRoutes);
  app.route("/api", projectRoutes);
  app.route("/api", assetRoutes);
  app.route("/api", aiRoutes);
  app.route("/api", hostingRoutes);
  app.route("/api", moduleRoutes);
  app.route("/api/billing", billingRoutes);
  app.route("/api/notifications", notificationRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/hooks", hookRoutes);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such endpoint" } }, 404));

  if (env.SERVE_WEB_DIST) {
    app.use("/assets/*", serveStatic({ root: env.SERVE_WEB_DIST, onFound: (_p, c) => { c.header("Cache-Control", "public, max-age=31536000, immutable"); } }));
    app.use("*", serveStatic({ root: env.SERVE_WEB_DIST }));
    app.get("*", serveStatic({ path: `${env.SERVE_WEB_DIST}/index.html` }));
  }

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
    }
    reportError(err, { path: c.req.path, requestId: c.get("requestId") });
    return c.json({ error: { code: "internal", message: "Something went wrong", requestId: c.get("requestId") } }, 500);
  });
  return app;
}
