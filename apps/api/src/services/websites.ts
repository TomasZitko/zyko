import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  applyOps, emptyDocument, EditOpsSchema, PageSeoSchema, SiteSettingsSchema, walk, DocumentOpError,
  type EditOp, type PageDocument, type SiteSettings,
} from "@zyko/contracts";
import { db, schema, type Tx } from "../db/client.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { randomLabel } from "../lib/crypto.js";
import { DEFAULT_DESIGN_SYSTEM, designRegistry, widgetOwners } from "../registry.js";

type Website = typeof schema.websites.$inferSelect;
type Page = typeof schema.pages.$inferSelect;

export function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";
}

export async function createWebsite(tx: Tx, project: { id: string; orgId: string; name: string; slug: string }) {
  const settings: SiteSettings = SiteSettingsSchema.parse({ name: project.name });
  const subdomain = `${project.slug.slice(0, 40)}-${randomLabel(5)}`;
  const [w] = await tx.insert(schema.websites).values({
    orgId: project.orgId, projectId: project.id, subdomain, settings,
    designSystemId: DEFAULT_DESIGN_SYSTEM.id, designSystemVersion: DEFAULT_DESIGN_SYSTEM.version,
  }).returning();
  return w;
}

/** Installed module ids for a project (to gate module widgets). */
async function installedModules(projectId: string, tx: Tx | typeof db = db) {
  const rows = await tx.select({ m: schema.moduleInstallations.moduleId }).from(schema.moduleInstallations)
    .where(and(eq(schema.moduleInstallations.projectId, projectId), eq(schema.moduleInstallations.status, "active")));
  return new Set(rows.map((r) => r.m));
}

export async function validateDocumentFor(website: Website, doc: unknown, tx: Tx | typeof db = db) {
  const issues = designRegistry.validateDocument(website.designSystemId, website.designSystemVersion, doc);
  const installed = await installedModules(website.projectId, tx);
  if (!issues.length) {
    const assetRefs = new Map<string, string>();
    walk((doc as PageDocument).root, (n) => {
      const owner = widgetOwners.get(n.type);
      if (owner && !installed.has(owner)) issues.push({ nodeId: n.id, path: n.id, message: `${n.type} requires module ${owner} to be installed` });
      const def = designRegistry.component(website.designSystemId, website.designSystemVersion, n.type);
      for (const [k, f] of Object.entries(def?.fields ?? {})) if (f.type === "asset" && typeof n.props[k] === "string") assetRefs.set(n.props[k] as string, n.id);
    });
    if (assetRefs.size) {
      // Asset references must belong to this project (tenant isolation at write time).
      const ids = [...assetRefs.keys()].filter((i) => /^[0-9a-f-]{36}$/i.test(i));
      const owned = ids.length ? await tx.select({ id: schema.assets.id }).from(schema.assets).where(and(eq(schema.assets.projectId, website.projectId), inArray(schema.assets.id, ids))) : [];
      const ok = new Set(owned.map((r) => r.id));
      for (const [id, nodeId] of assetRefs) if (!ok.has(id)) issues.push({ nodeId, path: nodeId, message: `Asset ${id} does not exist in this project` });
    }
  }
  return issues;
}

export async function createPage(website: Website, input: { path: string; title: string; document?: PageDocument; seo?: unknown }, actor: { userId: string | null; source: "user" | "ai" | "system" }) {
  const document = input.document ?? emptyDocument();
  const issues = await validateDocumentFor(website, document);
  if (issues.length) throw unprocessable("Page document is invalid", issues);
  const seo = PageSeoSchema.parse(input.seo ?? {});
  return db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.pages).where(and(eq(schema.pages.websiteId, website.id), isNull(schema.pages.deletedAt)));
    if (n >= 100) throw unprocessable("A website can have at most 100 pages");
    const existing = await tx.select({ id: schema.pages.id }).from(schema.pages).where(and(eq(schema.pages.websiteId, website.id), eq(schema.pages.path, input.path), isNull(schema.pages.deletedAt)));
    if (existing.length) throw conflict(`A page with path ${input.path} already exists`);
    const [page] = await tx.insert(schema.pages).values({ orgId: website.orgId, websiteId: website.id, path: input.path, title: input.title, seo, document, version: 1, position: n }).returning();
    await tx.insert(schema.pageRevisions).values({ orgId: website.orgId, pageId: page.id, version: 1, document, title: page.title, seo, ops: null, source: actor.source, authorUserId: actor.userId, message: "Page created" });
    return page;
  });
}

export interface ApplyResult { page: Page; inverse: EditOp[]; revisionId: string }

/**
 * The single write path for page content (editor autosave, AI tools, modules).
 * Optimistic concurrency via baseVersion; ops are validated against the design registry;
 * each change is stored as a revision carrying the op list (change tracking).
 */
export async function applyPageOps(
  pageId: string,
  input: { baseVersion: number; ops: unknown; meta?: { title?: string; seo?: unknown } },
  actor: { userId: string | null; source: "user" | "ai" | "module"; aiTaskId?: string | null; message?: string },
): Promise<ApplyResult> {
  const opsParsed = input.ops === undefined || (Array.isArray(input.ops) && input.ops.length === 0) ? [] : EditOpsSchema.safeParse(input.ops);
  if (!Array.isArray(opsParsed) && !opsParsed.success) throw unprocessable("Invalid operations", opsParsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const ops: EditOp[] = Array.isArray(opsParsed) ? [] : opsParsed.data;
  const seo = input.meta?.seo !== undefined ? PageSeoSchema.parse(input.meta.seo) : undefined;
  return db.transaction(async (tx) => {
    const [page] = await tx.select().from(schema.pages).where(and(eq(schema.pages.id, pageId), isNull(schema.pages.deletedAt))).for("update");
    if (!page) throw notFound("Page");
    if (page.version !== input.baseVersion) throw conflict("The page changed since you loaded it", { currentVersion: page.version });
    const [website] = await tx.select().from(schema.websites).where(eq(schema.websites.id, page.websiteId));
    let result: { doc: PageDocument; inverse: EditOp[] };
    try {
      result = applyOps(page.document as PageDocument, ops);
    } catch (e) {
      if (e instanceof DocumentOpError) throw unprocessable(e.message);
      throw e;
    }
    const issues = await validateDocumentFor(website, result.doc, tx);
    if (issues.length) throw unprocessable("Change would produce an invalid page", issues);
    const version = page.version + 1;
    const title = input.meta?.title?.trim() || page.title;
    const [updated] = await tx.update(schema.pages)
      .set({ document: result.doc, version, title, seo: seo ?? page.seo, updatedAt: new Date() })
      .where(eq(schema.pages.id, pageId)).returning();
    const [rev] = await tx.insert(schema.pageRevisions).values({
      orgId: page.orgId, pageId, version, document: result.doc, title, seo: updated.seo, ops: ops.length ? ops : null,
      source: actor.source, authorUserId: actor.userId, aiTaskId: actor.aiTaskId ?? null, message: actor.message ?? null,
    }).returning({ id: schema.pageRevisions.id });
    await tx.update(schema.websites).set({ updatedAt: new Date() }).where(eq(schema.websites.id, website.id));
    return { page: updated, inverse: result.inverse, revisionId: rev.id };
  });
}

export async function restoreRevision(pageId: string, revisionId: string, actor: { userId: string }) {
  return db.transaction(async (tx) => {
    const [page] = await tx.select().from(schema.pages).where(eq(schema.pages.id, pageId)).for("update");
    const [rev] = await tx.select().from(schema.pageRevisions).where(and(eq(schema.pageRevisions.id, revisionId), eq(schema.pageRevisions.pageId, pageId)));
    if (!page || !rev) throw notFound("Revision");
    const [website] = await tx.select().from(schema.websites).where(eq(schema.websites.id, page.websiteId));
    const doc = designRegistry.migrateDocument(website.designSystemId, website.designSystemVersion, rev.document as PageDocument);
    const issues = await validateDocumentFor(website, doc, tx);
    if (issues.length) throw unprocessable("This revision is not valid with the current design system", issues);
    const version = page.version + 1;
    const [updated] = await tx.update(schema.pages).set({ document: doc, title: rev.title, seo: rev.seo, version, updatedAt: new Date() }).where(eq(schema.pages.id, pageId)).returning();
    await tx.insert(schema.pageRevisions).values({ orgId: page.orgId, pageId, version, document: doc, title: rev.title, seo: rev.seo, ops: null, source: "restore", authorUserId: actor.userId, message: `Restored version ${rev.version}` });
    return updated;
  });
}

export async function listRevisions(pageId: string, limit = 50) {
  return db.select({
    id: schema.pageRevisions.id, version: schema.pageRevisions.version, source: schema.pageRevisions.source, message: schema.pageRevisions.message,
    authorUserId: schema.pageRevisions.authorUserId, aiTaskId: schema.pageRevisions.aiTaskId, ops: schema.pageRevisions.ops, createdAt: schema.pageRevisions.createdAt,
  }).from(schema.pageRevisions).where(eq(schema.pageRevisions.pageId, pageId)).orderBy(desc(schema.pageRevisions.version)).limit(limit);
}

export async function listPages(websiteId: string) {
  return db.select().from(schema.pages).where(and(eq(schema.pages.websiteId, websiteId), isNull(schema.pages.deletedAt))).orderBy(asc(schema.pages.position), asc(schema.pages.createdAt));
}

export async function updateSiteSettings(website: Website, patch: unknown) {
  const merged = SiteSettingsSchema.safeParse({ ...(website.settings as object), ...(patch as object) });
  if (!merged.success) throw unprocessable("Invalid site settings", merged.error.issues);
  const [w] = await db.update(schema.websites).set({ settings: merged.data, updatedAt: new Date() }).where(eq(schema.websites.id, website.id)).returning();
  return w;
}

/** Compact, model-friendly description of the current site state (used by AI tools). */
export async function describeSite(website: Website) {
  const pageRows = await listPages(website.id);
  return {
    settings: website.settings,
    designSystem: { id: website.designSystemId, version: website.designSystemVersion },
    pages: pageRows.map((p) => ({ id: p.id, path: p.path, title: p.title, version: p.version, seo: p.seo, document: p.document })),
  };
}
