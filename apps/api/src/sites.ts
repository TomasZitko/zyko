import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { db, schema } from "./db/client.js";
import { env } from "./env.js";
import { storage } from "./lib/storage.js";
import { checkRate } from "./lib/rate-limit.js";
import { hmac } from "./lib/crypto.js";
import { metrics, reportError } from "./lib/logger.js";

/**
 * Public hosting edge for customer websites. Runs as a separate process on a separate domain
 * (SITES_DOMAIN) so customer pages never share an origin or cookies with the SaaS app.
 * It only reads immutable deployment files from storage; it never renders or executes anything.
 * Host routing:
 *   p-<token>.<SITES_DOMAIN>   → preview deployment (noindex)
 *   <subdomain>.<SITES_DOMAIN> → website's live deployment
 *   <custom hostname>          → verified custom domain's live deployment
 */
type Target = { deploymentId: string; websiteId: string; orgId: string; preview: boolean; files: Map<string, { sha256: string; contentType: string }> };
const cache = new Map<string, { at: number; target: Target | null }>();
const TTL = 5000;
export const clearSitesCache = () => cache.clear();

async function resolveHost(hostHeader: string): Promise<Target | null> {
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL) return hit.target;
  let deployment: typeof schema.deployments.$inferSelect | undefined;
  let preview = false;
  const suffix = "." + env.SITES_DOMAIN;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    if (label.startsWith("p-")) {
      [deployment] = await db.select().from(schema.deployments).where(and(eq(schema.deployments.previewToken, label.slice(2)), eq(schema.deployments.status, "ready")));
      preview = true;
    } else if (/^[a-z0-9-]{1,63}$/.test(label)) {
      const [w] = await db.select().from(schema.websites).where(eq(schema.websites.subdomain, label));
      if (w?.liveDeploymentId) [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, w.liveDeploymentId));
    }
  } else {
    const [d] = await db.select({ w: schema.websites }).from(schema.domains).innerJoin(schema.websites, eq(schema.websites.id, schema.domains.websiteId))
      .where(and(eq(schema.domains.hostname, host), eq(schema.domains.status, "verified")));
    if (d?.w.liveDeploymentId) [deployment] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, d.w.liveDeploymentId));
  }
  const target = deployment && deployment.status === "ready"
    ? { deploymentId: deployment.id, websiteId: deployment.websiteId, orgId: deployment.orgId, preview, files: new Map(((deployment.manifest as any)?.files ?? []).map((f: any) => [f.path, f])) as Target["files"] }
    : null;
  cache.set(host, { at: Date.now(), target });
  if (cache.size > 10_000) cache.clear();
  return target;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https:",
};

function deviceOf(width: unknown) {
  const w = Number(width);
  return !w ? null : w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop";
}

export function createSitesApp() {
  const app = new Hono();

  app.get("/__zyko/health", (c) => c.json({ ok: true }));

  /** Caddy on-demand TLS "ask" endpoint: certificates only for verified custom domains and existing subdomains. */
  app.get("/__zyko/tls-ask", async (c) => {
    const domain = (c.req.query("domain") ?? "").toLowerCase();
    if (!domain) return c.text("missing", 400);
    const suffix = "." + env.SITES_DOMAIN;
    if (domain.endsWith(suffix)) {
      const label = domain.slice(0, -suffix.length);
      if (label.startsWith("p-")) return c.text("ok"); // covered by wildcard cert in production; allowed for completeness
      const [w] = await db.select({ id: schema.websites.id }).from(schema.websites).where(eq(schema.websites.subdomain, label));
      return w ? c.text("ok") : c.text("unknown", 404);
    }
    const [d] = await db.select({ id: schema.domains.id }).from(schema.domains).where(and(eq(schema.domains.hostname, domain), eq(schema.domains.status, "verified")));
    return d ? c.text("ok") : c.text("unknown", 404);
  });

  app.post("/__zyko/collect", async (c) => {
    const target = await resolveHost(c.req.header("host") ?? "");
    if (!target || target.preview) return c.body(null, 204);
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || ((c.env as any)?.incoming?.socket?.remoteAddress as string) || "0";
    try {
      checkRate(`collect:${ip}`, 120, 60_000);
      const raw = (await c.req.text()).slice(0, 2000);
      const data = JSON.parse(raw);
      const path = typeof data.p === "string" ? data.p.slice(0, 300) : "/";
      let referrer: string | null = null;
      try { referrer = data.r ? new URL(String(data.r)).hostname.slice(0, 200) : null; } catch { /* ignore */ }
      const day = new Date().toISOString().slice(0, 10);
      // Daily-rotating salted hash: counts unique visitors per day without cookies or stored IPs.
      const visitorHash = hmac(`${day}:${target.websiteId}:${ip}:${c.req.header("user-agent") ?? ""}`).slice(0, 32);
      const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
      if (referrer === host) referrer = null;
      await db.insert(schema.analyticsEvents).values({ orgId: target.orgId, websiteId: target.websiteId, type: "pageview", path, referrer, visitorHash, device: deviceOf(data.w) });
    } catch (e) {
      if ((e as any)?.status !== 429) reportError(e, { where: "collect" });
    }
    return c.body(null, 204);
  });

  app.on(["GET", "HEAD"], "*", async (c) => {
    const target = await resolveHost(c.req.header("host") ?? "");
    if (!target) return c.html("<!doctype html><title>Site not found</title><p style='font-family:system-ui;padding:2rem'>No website is published at this address.</p>", 404, { "Cache-Control": "no-store" });
    let path = decodeURIComponent(new URL(c.req.url).pathname);
    if (path.includes("..") || path.includes("\0")) return c.text("Bad request", 400);
    path = path.replace(/^\/+/, "");
    const candidates = path === "" ? ["index.html"] : [path, `${path.replace(/\/$/, "")}/index.html`];
    let file = candidates.map((p) => [p, target.files.get(p)] as const).find(([, f]) => f);
    let status = 200;
    if (!file) {
      file = ["404.html", target.files.get("404.html")] as const;
      status = 404;
      if (!file[1]) return c.text("Not found", 404);
    }
    const [p, meta] = file as [string, { sha256: string; contentType: string }];
    const etag = `"${meta.sha256.slice(0, 32)}"`;
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS, "Content-Type": meta.contentType, ETag: etag,
      "Cache-Control": p.startsWith("_assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    };
    if (target.preview) { headers["X-Robots-Tag"] = "noindex, nofollow"; headers["Cache-Control"] = "private, no-store"; }
    if (status === 200 && c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    const data = await storage.get(`deployments/${target.deploymentId}/${p}`);
    if (!data) {
      reportError(new Error("deployment file missing"), { deployment: target.deploymentId, path: p });
      return c.text("Not found", 404);
    }
    metrics.inc("zyko_sites_requests_total", { status: String(status) });
    if (c.req.method === "HEAD") return c.body(null, status as any, headers);
    return c.body(new Uint8Array(data), status as any, headers);
  });

  app.onError((err, c) => {
    reportError(err, { where: "sites" });
    return c.text("Server error", 500);
  });
  return app;
}

