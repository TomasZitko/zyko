import { and, desc, eq } from "drizzle-orm";
import { renderDocument, renderHtmlDocument, buildRobots, buildSitemap } from "@zyko/renderer";
import { walk, type PageDocument, type PageSeo, type SiteSettings } from "@zyko/contracts";
import { db, schema } from "../db/client.js";
import { env, sitesBaseUrl } from "../env.js";
import { randomLabel, sha256 } from "../lib/crypto.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { enqueue, registerJob } from "../lib/jobs.js";
import { storage } from "../lib/storage.js";
import { notify, audit } from "../lib/platform.js";
import { designRegistry } from "../registry.js";
import { projectAssets, toResolved } from "./assets.js";
import { assertDeploymentAllowed } from "./entitlements.js";
import { listPages, validateDocumentFor } from "./websites.js";
import { emitPlatformEvent } from "./modules.js";

/**
 * Publishing model: a deployment is an immutable set of static files rendered from a snapshot of
 * the drafts by platform-reviewed component renderers. Nothing user-supplied is executed. The
 * sites server (separate process / domain) only serves files from storage.
 */
type Website = typeof schema.websites.$inferSelect;

export const previewUrl = (token: string) => `${env.SITES_PUBLIC_SCHEME}://p-${token}.${env.SITES_DOMAIN}${env.SITES_PUBLIC_PORT}/`;
export const productionUrl = (w: { subdomain: string }) => sitesBaseUrl(w.subdomain) + "/";

export async function requestDeployment(website: Website, kind: "preview" | "production", userId: string | null) {
  await assertDeploymentAllowed(website.orgId);
  const [d] = await db.insert(schema.deployments).values({
    orgId: website.orgId, websiteId: website.id, kind, createdBy: userId, previewToken: kind === "preview" ? randomLabel(26) : null,
  }).returning();
  await enqueue("deployment.build", { deploymentId: d.id });
  await audit({ orgId: website.orgId, actorUserId: userId, action: `deployment.${kind}.requested`, targetType: "deployment", targetId: d.id });
  return d;
}

const ANALYTICS_JS = `(()=>{try{if(navigator.doNotTrack==="1")return;const d=JSON.stringify({p:location.pathname,r:document.referrer||null,w:innerWidth});navigator.sendBeacon?navigator.sendBeacon("/__zyko/collect",d):fetch("/__zyko/collect",{method:"POST",body:d,keepalive:true})}catch(e){}})();`;

const pageFile = (path: string) => (path === "/" ? "index.html" : `${path.slice(1)}/index.html`);

export async function buildDeployment(deploymentId: string) {
  const [d] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
  if (!d || d.status === "ready") return;
  const logLines: string[] = [];
  const logLine = (m: string) => logLines.push(`${new Date().toISOString()} ${m}`);
  await db.update(schema.deployments).set({ status: "building", startedAt: new Date() }).where(eq(schema.deployments.id, d.id));
  const prefix = `deployments/${d.id}/`;
  try {
    const [website] = await db.select().from(schema.websites).where(eq(schema.websites.id, d.websiteId));
    const settings = website.settings as SiteSettings;
    const pages = await listPages(website.id);
    if (!pages.length) throw new Error("Website has no pages");
    logLine(`Building ${pages.length} page(s) with ${website.designSystemId}@${website.designSystemVersion}`);

    // Collect + copy referenced assets into the deployment (content-addressed, immutable).
    const assetIds = new Set<string>();
    for (const p of pages) {
      walk((p.document as PageDocument).root, (n) => {
        for (const v of Object.values(n.props)) if (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) assetIds.add(v);
      });
      const og = (p.seo as PageSeo).ogImageAssetId;
      if (og) assetIds.add(og);
    }
    const assets = await projectAssets(website.projectId, [...assetIds]);
    const assetUrls = new Map<string, string>();
    const files: { path: string; size: number; sha256: string; contentType: string }[] = [];
    const write = async (path: string, data: Buffer | string, contentType: string) => {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      await storage.put(prefix + path, buf);
      files.push({ path, size: buf.length, sha256: sha256(buf), contentType });
    };
    for (const a of assets) {
      const data = await storage.get(a.storageKey);
      if (!data) { logLine(`WARN asset ${a.id} missing from storage`); continue; }
      const p = `_assets/${a.sha256.slice(0, 16)}.${a.storageKey.split(".").pop()}`;
      await write(p, data, a.mime);
      assetUrls.set(a.id, "/" + p);
    }
    logLine(`Copied ${assetUrls.size} asset(s)`);

    const base = d.kind === "production" ? productionUrl(website) : null;
    const nav = pages.map((p) => ({ path: p.path, title: p.title }));
    const assetMap = new Map(assets.map((a) => [a.id, a]));
    for (const p of pages) {
      const issues = await validateDocumentFor(website, p.document);
      if (issues.length) throw new Error(`Page ${p.path} is invalid: ${issues[0].message}`);
      const rendered = renderDocument(p.document as PageDocument, {
        registry: designRegistry, designSystem: { id: website.designSystemId, version: website.designSystemVersion },
        target: d.kind === "production" ? "production" : "preview", site: settings, pages: nav,
        resolveAsset: (id) => { const a = assetMap.get(id); const u = assetUrls.get(id); return a && u ? toResolved(a, u) : null; },
      });
      const seo = p.seo as PageSeo;
      const htmlDoc = renderHtmlDocument({
        rendered, site: settings, page: { path: p.path, title: p.title, seo }, canonicalBase: base,
        ogImageUrl: seo.ogImageAssetId && assetUrls.get(seo.ogImageAssetId) && base ? base.replace(/\/$/, "") + assetUrls.get(seo.ogImageAssetId) : null,
        forceNoindex: d.kind === "preview",
        bodyExtra: d.kind === "production" && settings.analytics?.enabled !== false ? `<script src="/__zyko/a.js" defer></script>` : "",
      });
      await write(pageFile(p.path), htmlDoc, "text/html; charset=utf-8");
    }
    logLine(`Rendered ${pages.length} page(s)`);
    await write("404.html", `<!doctype html><meta charset="utf-8"><title>Not found</title><meta name="robots" content="noindex"><p style="font-family:system-ui;padding:2rem">Page not found.</p>`, "text/html; charset=utf-8");
    await write("sitemap.xml", buildSitemap(base ?? "http://preview.invalid", pages.map((p) => ({ path: p.path, updatedAt: p.updatedAt, noindex: (p.seo as PageSeo).noindex }))), "application/xml");
    await write("robots.txt", buildRobots(base, d.kind === "production"), "text/plain");
    if (d.kind === "production") await write("__zyko/a.js", ANALYTICS_JS, "text/javascript");

    const manifest = { files, pages: pages.map((p) => ({ pageId: p.id, path: p.path, version: p.version })) };
    logLine(`Wrote ${files.length} file(s)`);
    await db.transaction(async (tx) => {
      await tx.update(schema.deployments).set({ status: "ready", manifest, log: logLines, finishedAt: new Date() }).where(eq(schema.deployments.id, d.id));
      if (d.kind === "production") await tx.update(schema.websites).set({ liveDeploymentId: d.id, updatedAt: new Date() }).where(eq(schema.websites.id, website.id));
    });
    if (d.createdBy) {
      await notify({ userId: d.createdBy, orgId: d.orgId, kind: `deployment.${d.kind}.ready`, title: d.kind === "production" ? "Website published" : "Preview ready", link: `/app/p/${website.projectId}/publish` });
    }
    await emitPlatformEvent(d.orgId, website.projectId, "deployment.ready", { deploymentId: d.id, kind: d.kind });
    if (d.kind === "production") await emitPlatformEvent(d.orgId, website.projectId, "page.published", { deploymentId: d.id, pages: manifest.pages });
  } catch (err) {
    logLine(`ERROR ${(err as Error).message}`);
    await db.update(schema.deployments).set({ status: "failed", error: (err as Error).message, log: logLines, finishedAt: new Date() }).where(eq(schema.deployments.id, d.id));
    await storage.deletePrefix(prefix).catch(() => {});
    if (d.createdBy) await notify({ userId: d.createdBy, orgId: d.orgId, kind: "deployment.failed", title: "Deployment failed", body: (err as Error).message });
    const [w] = await db.select().from(schema.websites).where(eq(schema.websites.id, d.websiteId));
    if (w) await emitPlatformEvent(d.orgId, w.projectId, "deployment.failed", { deploymentId: d.id, error: (err as Error).message });
    // Build errors are deterministic (invalid content); don't retry.
  }
}

registerJob("deployment.build", async ({ deploymentId }: { deploymentId: string }) => buildDeployment(deploymentId));

export async function rollback(website: Website, deploymentId: string, userId: string) {
  const [d] = await db.select().from(schema.deployments).where(and(eq(schema.deployments.id, deploymentId), eq(schema.deployments.websiteId, website.id)));
  if (!d) throw notFound("Deployment");
  if (d.kind !== "production" || d.status !== "ready") throw unprocessable("Only successful production deployments can be restored");
  await db.update(schema.websites).set({ liveDeploymentId: d.id, updatedAt: new Date() }).where(eq(schema.websites.id, website.id));
  await audit({ orgId: website.orgId, actorUserId: userId, action: "deployment.rollback", targetType: "deployment", targetId: d.id });
}

export async function unpublish(website: Website, userId: string) {
  await db.update(schema.websites).set({ liveDeploymentId: null }).where(eq(schema.websites.id, website.id));
  await audit({ orgId: website.orgId, actorUserId: userId, action: "website.unpublished", targetType: "website", targetId: website.id });
}

export async function listDeployments(websiteId: string) {
  return db.select().from(schema.deployments).where(eq(schema.deployments.websiteId, websiteId)).orderBy(desc(schema.deployments.createdAt)).limit(50);
}

/** Removes files of old non-live deployments (keeps the newest N production builds for rollback). */
export async function pruneDeployments(websiteId: string, keep = 10) {
  const [w] = await db.select().from(schema.websites).where(eq(schema.websites.id, websiteId));
  const all = await listDeployments(websiteId);
  const prod = all.filter((d) => d.kind === "production" && d.status === "ready");
  const stale = [...prod.slice(keep), ...all.filter((d) => d.kind === "preview" && d.createdAt.getTime() < Date.now() - 7 * 86400_000)];
  for (const d of stale) if (d.id !== w?.liveDeploymentId) await storage.deletePrefix(`deployments/${d.id}/`);
  return stale.length;
}

