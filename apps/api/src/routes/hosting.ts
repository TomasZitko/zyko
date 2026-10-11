import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import { seoIssues } from "@zyko/renderer";
import type { PageSeo, SiteSettings } from "@zyko/contracts";
import { body, requireUser, router } from "../http.js";
import { db, schema } from "../db/client.js";
import { notFound } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { audit } from "../lib/platform.js";
import { requireProject, requireWebsiteForProject } from "../services/access.js";
import { listDeployments, previewUrl, productionUrl, requestDeployment, rollback, unpublish } from "../services/publishing.js";
import { addDomain, dnsInstructions, verifyDomain } from "../services/domains.js";
import { listPages } from "../services/websites.js";

export const hostingRoutes = router();

const deploymentView = (d: typeof schema.deployments.$inferSelect, live: string | null) => ({
  id: d.id, kind: d.kind, status: d.status, error: d.error, log: d.log, createdAt: d.createdAt, finishedAt: d.finishedAt,
  isLive: d.id === live, url: d.kind === "preview" && d.previewToken && d.status === "ready" ? previewUrl(d.previewToken) : null,
  pages: (d.manifest as any)?.pages ?? [], fileCount: (d.manifest as any)?.files?.length ?? 0,
});

async function ctx(c: any, min: "viewer" | "editor" | "admin" = "viewer") {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), min);
  return { u, project, website: await requireWebsiteForProject(project.id) };
}

hostingRoutes.get("/projects/:projectId/deployments", async (c) => {
  const { website } = await ctx(c);
  const rows = await listDeployments(website.id);
  return c.json({ liveUrl: website.liveDeploymentId ? productionUrl(website) : null, siteUrl: productionUrl(website), deployments: rows.map((d) => deploymentView(d, website.liveDeploymentId)) });
});

hostingRoutes.post("/projects/:projectId/deployments", rateLimit("deploy", 30, 60_000), async (c) => {
  const { u, website } = await ctx(c, "editor");
  const { kind } = await body(c, z.object({ kind: z.enum(["preview", "production"]) }));
  const d = await requestDeployment(website, kind, u.id);
  return c.json({ deployment: deploymentView(d, website.liveDeploymentId) }, 202);
});

hostingRoutes.get("/projects/:projectId/deployments/:id", async (c) => {
  const { website } = await ctx(c);
  const [d] = await db.select().from(schema.deployments).where(and(eq(schema.deployments.id, c.req.param("id")), eq(schema.deployments.websiteId, website.id)));
  if (!d) throw notFound("Deployment");
  const [w] = await db.select().from(schema.websites).where(eq(schema.websites.id, website.id));
  return c.json({ deployment: deploymentView(d, w.liveDeploymentId) });
});

hostingRoutes.post("/projects/:projectId/deployments/:id/rollback", async (c) => {
  const { u, website } = await ctx(c, "editor");
  await rollback(website, c.req.param("id"), u.id);
  return c.json({ ok: true });
});

hostingRoutes.post("/projects/:projectId/unpublish", async (c) => {
  const { u, website } = await ctx(c, "admin");
  await unpublish(website, u.id);
  return c.json({ ok: true });
});

hostingRoutes.get("/projects/:projectId/seo", async (c) => {
  const { website } = await ctx(c);
  const pages = await listPages(website.id);
  return c.json({ issues: seoIssues(website.settings as SiteSettings, pages.map((p) => ({ path: p.path, title: p.title, seo: p.seo as PageSeo }))) });
});

// ── Domains ──
hostingRoutes.get("/projects/:projectId/domains", async (c) => {
  const { website } = await ctx(c);
  const rows = await db.select().from(schema.domains).where(eq(schema.domains.websiteId, website.id));
  return c.json({ domains: rows.map((d) => ({ ...d, verificationToken: undefined, dns: dnsInstructions(d, website.subdomain) })) });
});
hostingRoutes.post("/projects/:projectId/domains", async (c) => {
  const { u, website } = await ctx(c, "admin");
  const { hostname } = await body(c, z.object({ hostname: z.string().min(3).max(253) }));
  const d = await addDomain(website, hostname, u.id);
  return c.json({ domain: { ...d, verificationToken: undefined, dns: dnsInstructions(d, website.subdomain) } }, 201);
});
hostingRoutes.post("/projects/:projectId/domains/:id/verify", rateLimit("domain-verify", 20, 60_000), async (c) => {
  const { website } = await ctx(c, "editor");
  const [d] = await db.select().from(schema.domains).where(and(eq(schema.domains.id, c.req.param("id")), eq(schema.domains.websiteId, website.id)));
  if (!d) throw notFound("Domain");
  const r = await verifyDomain(d.id);
  return c.json({ domain: { ...r, verificationToken: undefined } });
});
hostingRoutes.delete("/projects/:projectId/domains/:id", async (c) => {
  const { u, website } = await ctx(c, "admin");
  const del = await db.delete(schema.domains).where(and(eq(schema.domains.id, c.req.param("id")), eq(schema.domains.websiteId, website.id))).returning();
  if (!del.length) throw notFound("Domain");
  await audit({ orgId: website.orgId, actorUserId: u.id, action: "domain.removed", metadata: { hostname: del[0].hostname } });
  return c.json({ ok: true });
});

// ── Analytics reporting ──
hostingRoutes.get("/projects/:projectId/analytics", async (c) => {
  const { website } = await ctx(c);
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const since = new Date(Date.now() - days * 86400_000);
  const scope = and(eq(schema.analyticsEvents.websiteId, website.id), gte(schema.analyticsEvents.createdAt, since));
  const daily = await db.select({ day: sql<string>`to_char(date_trunc('day', ${schema.analyticsEvents.createdAt}), 'YYYY-MM-DD')`, views: sql<number>`count(*)::int`, visitors: sql<number>`count(distinct ${schema.analyticsEvents.visitorHash})::int` })
    .from(schema.analyticsEvents).where(scope).groupBy(sql`1`).orderBy(sql`1`);
  const topPages = await db.select({ path: schema.analyticsEvents.path, views: sql<number>`count(*)::int` }).from(schema.analyticsEvents).where(scope).groupBy(schema.analyticsEvents.path).orderBy(sql`2 desc`).limit(10);
  const referrers = await db.select({ referrer: schema.analyticsEvents.referrer, views: sql<number>`count(*)::int` }).from(schema.analyticsEvents).where(and(scope, sql`${schema.analyticsEvents.referrer} is not null`)).groupBy(schema.analyticsEvents.referrer).orderBy(sql`2 desc`).limit(10);
  const devices = await db.select({ device: schema.analyticsEvents.device, views: sql<number>`count(*)::int` }).from(schema.analyticsEvents).where(scope).groupBy(schema.analyticsEvents.device);
  const totals = daily.reduce((a, d) => ({ views: a.views + d.views }), { views: 0 });
  const [{ visitors }] = await db.select({ visitors: sql<number>`count(distinct ${schema.analyticsEvents.visitorHash})::int` }).from(schema.analyticsEvents).where(scope);
  return c.json({ days, totals: { ...totals, visitors }, daily, topPages, referrers, devices });
});
