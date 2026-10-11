import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { PagePathSchema, PageSeoSchema, ProjectBriefSchema, newNodeId, type PageNode } from "@zyko/contracts";
import { body, clientIp, requireUser, router } from "../http.js";
import { db, schema } from "../db/client.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { randomLabel } from "../lib/crypto.js";
import { audit } from "../lib/platform.js";
import { requireOrg, requirePage, requireProject, requireWebsiteForProject } from "../services/access.js";
import { assertCanCreateProject } from "../services/entitlements.js";
import { applyPageOps, createPage, createWebsite, listPages, listRevisions, restoreRevision, slugify, updateSiteSettings } from "../services/websites.js";
import { designRegistry } from "../registry.js";
import { productionUrl } from "../services/publishing.js";

export const projectRoutes = router();

const projectView = (p: typeof schema.projects.$inferSelect, w?: typeof schema.websites.$inferSelect | null) => ({
  ...p, website: w ? { id: w.id, subdomain: w.subdomain, liveDeploymentId: w.liveDeploymentId, designSystem: { id: w.designSystemId, version: w.designSystemVersion }, url: productionUrl(w), settings: w.settings } : null,
});

projectRoutes.get("/orgs/:orgId/projects", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"));
  const status = c.req.query("status") === "archived" ? "archived" : "active";
  const rows = await db.select({ p: schema.projects, w: schema.websites }).from(schema.projects)
    .leftJoin(schema.websites, eq(schema.websites.projectId, schema.projects.id))
    .where(and(eq(schema.projects.orgId, org.id), eq(schema.projects.status, status))).orderBy(desc(schema.projects.updatedAt));
  return c.json({ projects: rows.map((r) => projectView(r.p, r.w)) });
});

projectRoutes.post("/orgs/:orgId/projects", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "editor");
  const input = await body(c, z.object({ name: z.string().min(1).max(120), clientId: z.string().uuid().nullable().optional(), brief: ProjectBriefSchema.optional(), starter: z.enum(["blank", "fixture-template"]).default("fixture-template") }));
  await assertCanCreateProject(org.id);
  if (input.clientId) {
    const [cl] = await db.select().from(schema.clients).where(and(eq(schema.clients.id, input.clientId), eq(schema.clients.orgId, org.id)));
    if (!cl) throw notFound("Client");
  }
  const { project, website } = await db.transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ orgId: org.id, name: input.name, slug: `${slugify(input.name)}-${randomLabel(4)}`, clientId: input.clientId ?? null, brief: input.brief ?? {}, createdBy: u.id }).returning();
    const website = await createWebsite(tx, project);
    return { project, website };
  });
  const ds = designRegistry.get(website.designSystemId, website.designSystemVersion);
  const tpl = input.starter === "fixture-template" ? ds.templates?.[0]?.build() : null;
  await createPage(website, { path: "/", title: tpl?.title ?? "Home", document: { schemaVersion: 1, root: tpl?.root ?? [] } }, { userId: u.id, source: "system" });
  await audit({ orgId: org.id, actorUserId: u.id, action: "project.created", targetType: "project", targetId: project.id, ip: clientIp(c) });
  return c.json({ project: projectView(project, website) }, 201);
});

projectRoutes.get("/projects/:projectId", async (c) => {
  const u = requireUser(c);
  const { project, role } = await requireProject(u.id, c.req.param("projectId"));
  const website = await requireWebsiteForProject(project.id);
  return c.json({ project: projectView(project, website), role });
});

projectRoutes.patch("/projects/:projectId", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  const input = await body(c, z.object({ name: z.string().min(1).max(120).optional(), brief: ProjectBriefSchema.optional(), clientId: z.string().uuid().nullable().optional(), status: z.enum(["active", "archived"]).optional() }));
  if (input.status === "active" && project.status === "archived") await assertCanCreateProject(project.orgId);
  if (input.clientId) {
    const [cl] = await db.select().from(schema.clients).where(and(eq(schema.clients.id, input.clientId), eq(schema.clients.orgId, project.orgId)));
    if (!cl) throw notFound("Client");
  }
  const [p] = await db.update(schema.projects).set({ ...input, updatedAt: new Date() }).where(eq(schema.projects.id, project.id)).returning();
  return c.json({ project: p });
});

projectRoutes.delete("/projects/:projectId", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "admin");
  await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  await audit({ orgId: project.orgId, actorUserId: u.id, action: "project.deleted", targetType: "project", targetId: project.id });
  return c.json({ ok: true });
});

// ── Website settings ──
projectRoutes.patch("/projects/:projectId/website", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  const w = await updateSiteSettings(await requireWebsiteForProject(project.id), await c.req.json().catch(() => ({})));
  return c.json({ website: projectView(project, w).website });
});

// ── Pages ──
projectRoutes.get("/projects/:projectId/pages", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  const w = await requireWebsiteForProject(project.id);
  const pages = await listPages(w.id);
  return c.json({ pages: pages.map(({ document, ...p }) => p) });
});

projectRoutes.post("/projects/:projectId/pages", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  const w = await requireWebsiteForProject(project.id);
  const input = await body(c, z.object({ path: PagePathSchema, title: z.string().min(1).max(120), templateId: z.string().optional() }));
  let root: PageNode[] = [];
  if (input.templateId) {
    const tpl = designRegistry.get(w.designSystemId, w.designSystemVersion).templates?.find((t) => t.id === input.templateId);
    if (!tpl) throw notFound("Template");
    root = tpl.build().root;
  }
  const page = await createPage(w, { path: input.path, title: input.title, document: { schemaVersion: 1, root } }, { userId: u.id, source: "user" });
  return c.json({ page }, 201);
});

projectRoutes.get("/pages/:pageId", async (c) => {
  const u = requireUser(c);
  const { page, website, role } = await requirePage(u.id, c.req.param("pageId"));
  return c.json({ page, role, designSystem: { id: website.designSystemId, version: website.designSystemVersion } });
});

/** Editor/AI write path: ops + optimistic concurrency. Returns inverse ops for client-side undo. */
projectRoutes.post("/pages/:pageId/ops", async (c) => {
  const u = requireUser(c);
  const { page } = await requirePage(u.id, c.req.param("pageId"), "editor");
  const input = await body(c, z.object({ baseVersion: z.number().int(), ops: z.array(z.unknown()).max(200).default([]), meta: z.object({ title: z.string().min(1).max(120).optional(), seo: PageSeoSchema.optional() }).optional(), message: z.string().max(200).optional() }));
  const r = await applyPageOps(page.id, input, { userId: u.id, source: "user", message: input.message });
  return c.json({ page: r.page, inverse: r.inverse, revisionId: r.revisionId });
});

projectRoutes.patch("/pages/:pageId", async (c) => {
  const u = requireUser(c);
  const { page, website } = await requirePage(u.id, c.req.param("pageId"), "editor");
  const input = await body(c, z.object({ path: PagePathSchema.optional(), position: z.number().int().min(0).optional() }));
  if (input.path && input.path !== page.path) {
    const clash = (await listPages(website.id)).some((p) => p.path === input.path);
    if (clash) throw unprocessable("Another page already uses that path");
  }
  const [p] = await db.update(schema.pages).set({ ...input, updatedAt: new Date() }).where(eq(schema.pages.id, page.id)).returning();
  return c.json({ page: p });
});

projectRoutes.delete("/pages/:pageId", async (c) => {
  const u = requireUser(c);
  const { page } = await requirePage(u.id, c.req.param("pageId"), "editor");
  if (page.path === "/") throw unprocessable("The home page cannot be deleted");
  await db.update(schema.pages).set({ deletedAt: new Date() }).where(eq(schema.pages.id, page.id));
  return c.json({ ok: true });
});

projectRoutes.get("/pages/:pageId/revisions", async (c) => {
  const u = requireUser(c);
  const { page } = await requirePage(u.id, c.req.param("pageId"));
  const revs = await listRevisions(page.id);
  const authorIds = [...new Set(revs.map((r) => r.authorUserId).filter(Boolean))] as string[];
  const authors = authorIds.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, authorIds)) : [];
  const names = new Map(authors.map((a) => [a.id, a.name]));
  return c.json({ revisions: revs.map((r) => ({ ...r, authorName: r.authorUserId ? names.get(r.authorUserId) : null, opCount: Array.isArray(r.ops) ? r.ops.length : 0, ops: undefined })) });
});

projectRoutes.get("/pages/:pageId/revisions/:revisionId", async (c) => {
  const u = requireUser(c);
  const { page } = await requirePage(u.id, c.req.param("pageId"));
  const [rev] = await db.select().from(schema.pageRevisions).where(and(eq(schema.pageRevisions.id, c.req.param("revisionId")), eq(schema.pageRevisions.pageId, page.id)));
  if (!rev) throw notFound("Revision");
  return c.json({ revision: rev });
});

projectRoutes.post("/pages/:pageId/revisions/:revisionId/restore", async (c) => {
  const u = requireUser(c);
  const { page } = await requirePage(u.id, c.req.param("pageId"), "editor");
  const p = await restoreRevision(page.id, c.req.param("revisionId"), { userId: u.id });
  return c.json({ page: p });
});

// ── Design registry (read-only catalogue for the editor) ──
projectRoutes.get("/projects/:projectId/design-system", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  const w = await requireWebsiteForProject(project.id);
  const ds = designRegistry.get(w.designSystemId, w.designSystemVersion);
  return c.json({
    designSystem: { id: ds.id, version: ds.version, name: ds.name, status: ds.status, breakpoints: ds.breakpoints },
    components: designRegistry.catalogue(w.designSystemId, w.designSystemVersion),
    templates: (ds.templates ?? []).map((t) => ({ id: t.id, name: t.name, version: t.version })),
  });
});

// ── Design references (inputs for the future design engine) ──
projectRoutes.get("/projects/:projectId/design-references", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  return c.json({ references: await db.select().from(schema.designReferences).where(eq(schema.designReferences.projectId, project.id)).orderBy(desc(schema.designReferences.createdAt)) });
});
projectRoutes.post("/projects/:projectId/design-references", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  const input = await body(c, z.object({ kind: z.enum(["url", "asset", "note"]), url: z.string().url().startsWith("http").optional(), assetId: z.string().uuid().optional(), notes: z.string().max(4000).optional(), tags: z.array(z.string().max(40)).max(20).default([]) }));
  if (input.assetId) {
    const [a] = await db.select().from(schema.assets).where(and(eq(schema.assets.id, input.assetId), eq(schema.assets.projectId, project.id)));
    if (!a) throw notFound("Asset");
  }
  const [r] = await db.insert(schema.designReferences).values({ orgId: project.orgId, projectId: project.id, ...input }).returning();
  return c.json({ reference: r }, 201);
});
projectRoutes.delete("/projects/:projectId/design-references/:id", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "editor");
  await db.delete(schema.designReferences).where(and(eq(schema.designReferences.id, c.req.param("id")), eq(schema.designReferences.projectId, project.id)));
  return c.json({ ok: true });
});

export { newNodeId };
