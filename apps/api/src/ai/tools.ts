import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { applyOps, EditOpsSchema, ProjectBriefSchema, PagePathSchema, type PageDocument } from "@zyko/contracts";
import { db, schema } from "../db/client.js";
import type { Role } from "../db/schema.js";
import { forbidden, notFound } from "../lib/errors.js";
import { ROLE_RANK } from "../services/access.js";
import { applyPageOps, createPage, describeSite, listPages, validateDocumentFor } from "../services/websites.js";
import { requestDeployment } from "../services/publishing.js";
import { designEngine, designRegistry } from "../registry.js";
import { projectAssets } from "../services/assets.js";

export interface ToolContext {
  userId: string;
  role: Role;
  project: typeof schema.projects.$inferSelect;
  website: typeof schema.websites.$inferSelect;
  aiTaskId: string;
}

export interface AiTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Sensitive tools never run without an explicit user approval (ai_tasks.awaiting_approval). */
  sensitive: boolean;
  minRole: Role;
  run(ctx: ToolContext, input: z.infer<S>): Promise<unknown>;
}
const tool = <S extends z.ZodType>(t: AiTool<S>) => t;

async function pageFor(ctx: ToolContext, ref: { pageId?: string; path?: string }) {
  const pages = await listPages(ctx.website.id);
  const p = pages.find((x) => (ref.pageId ? x.id === ref.pageId : x.path === ref.path));
  if (!p) throw notFound("Page");
  return p;
}
const PageRef = z.object({ pageId: z.string().optional(), path: z.string().optional() });

/**
 * Validated operations the assistant can perform on structured project data.
 * These are the same operations the future design engine will use (§5 of the integration contracts).
 */
export const AI_TOOLS: AiTool<any>[] = [
  tool({
    name: "get_project_context", description: "Returns the project brief, site settings and the list of pages (without page content).",
    input: z.object({}), sensitive: false, minRole: "viewer",
    run: async (ctx) => {
      const pages = await listPages(ctx.website.id);
      return { project: { name: ctx.project.name, brief: ctx.project.brief }, settings: ctx.website.settings, pages: pages.map((p) => ({ id: p.id, path: p.path, title: p.title, version: p.version })) };
    },
  }),
  tool({
    name: "update_project_brief", description: "Merges fields into the structured project brief (business name, description, audience, services, tone, contact, ...).",
    input: z.object({ patch: ProjectBriefSchema }), sensitive: false, minRole: "editor",
    run: async (ctx, { patch }) => {
      const brief = ProjectBriefSchema.parse({ ...(ctx.project.brief as object), ...patch });
      await db.update(schema.projects).set({ brief, updatedAt: new Date() }).where(eq(schema.projects.id, ctx.project.id));
      return { brief };
    },
  }),
  tool({
    name: "list_components", description: "Lists the components available in this website's design system with their editable fields and slots.",
    input: z.object({}), sensitive: false, minRole: "viewer",
    run: async (ctx) => designRegistry.catalogue(ctx.website.designSystemId, ctx.website.designSystemVersion),
  }),
  tool({
    name: "inspect_page", description: "Returns a page's full structured document and its current version (needed as baseVersion for changes).",
    input: PageRef, sensitive: false, minRole: "viewer",
    run: async (ctx, ref) => { const p = await pageFor(ctx, ref); return { id: p.id, path: p.path, title: p.title, version: p.version, seo: p.seo, document: p.document }; },
  }),
  tool({
    name: "validate_page_changes", description: "Dry-runs structured edit operations against a page without saving. Returns validation issues.",
    input: z.object({ pageId: z.string(), ops: EditOpsSchema }), sensitive: false, minRole: "viewer",
    run: async (ctx, { pageId, ops }) => {
      const p = await pageFor(ctx, { pageId });
      try {
        const { doc } = applyOps(p.document as PageDocument, ops);
        const issues = await validateDocumentFor(ctx.website, doc);
        return { valid: issues.length === 0, issues };
      } catch (e) {
        return { valid: false, issues: [{ path: "", message: (e as Error).message }] };
      }
    },
  }),
  tool({
    name: "apply_page_changes",
    description: "Applies structured edit operations (insert/remove/move/update_props/set_layout) to a page draft. Requires the page's current version as baseVersion. Creates a revision that the user can undo or restore.",
    input: z.object({ pageId: z.string(), baseVersion: z.number().int(), ops: EditOpsSchema, message: z.string().max(200).optional() }), sensitive: false, minRole: "editor",
    run: async (ctx, { pageId, baseVersion, ops, message }) => {
      await pageFor(ctx, { pageId });
      const r = await applyPageOps(pageId, { baseVersion, ops }, { userId: ctx.userId, source: "ai", aiTaskId: ctx.aiTaskId, message: message ?? "AI change" });
      return { pageId, newVersion: r.page.version, revisionId: r.revisionId };
    },
  }),
  tool({
    name: "create_page", description: "Creates a new empty page with the given path and title.",
    input: z.object({ path: PagePathSchema, title: z.string().min(1).max(120) }), sensitive: false, minRole: "editor",
    run: async (ctx, { path, title }) => {
      const p = await createPage(ctx.website, { path, title }, { userId: ctx.userId, source: "ai" });
      return { pageId: p.id, version: p.version };
    },
  }),
  tool({
    name: "generate_preview", description: "Builds a private preview of the current drafts and returns the deployment id.",
    input: z.object({}), sensitive: false, minRole: "editor",
    run: async (ctx) => { const d = await requestDeployment(ctx.website, "preview", ctx.userId); return { deploymentId: d.id, status: d.status }; },
  }),
  tool({
    name: "publish_site", description: "Publishes the current drafts to the live website. Requires explicit user approval.",
    input: z.object({ note: z.string().max(200).optional() }), sensitive: true, minRole: "editor",
    run: async (ctx) => { const d = await requestDeployment(ctx.website, "production", ctx.userId); return { deploymentId: d.id, status: d.status }; },
  }),
  tool({
    name: "request_design_generation",
    description: "Delegates to the configured design-generation engine (analyze | plan | generate). Generated pages are applied as drafts. Returns an error if no engine is configured.",
    input: z.object({ stage: z.enum(["analyze", "plan", "generate"]), instructions: z.string().max(4000).optional() }), sensitive: true, minRole: "editor",
    run: async (ctx, { stage }) => {
      const engine = designEngine();
      const pages = await listPages(ctx.website.id);
      const refs = await db.select().from(schema.designReferences).where(and(eq(schema.designReferences.orgId, ctx.project.orgId), eq(schema.designReferences.projectId, ctx.project.id)));
      const assets = await projectAssets(ctx.project.id);
      const input = {
        project: { id: ctx.project.id, name: ctx.project.name, brief: ctx.project.brief as any },
        site: { settings: ctx.website.settings as any, pages: pages.map((p) => ({ path: p.path, title: p.title })) },
        designSystem: designRegistry.get(ctx.website.designSystemId, ctx.website.designSystemVersion),
        registry: designRegistry,
        references: refs.map((r) => ({ kind: r.kind, url: r.url, notes: r.notes, assetId: r.assetId })),
        assets: assets.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, alt: a.alt, tags: a.tags })),
      };
      const analysis = await engine.analyzeRequirements(input);
      if (stage === "analyze") return analysis;
      const plan = await engine.createPlan(input, analysis);
      if (stage === "plan") return plan;
      const out = await engine.generate(input, plan);
      const applied: unknown[] = [];
      for (const pg of out.pages) {
        const issues = await validateDocumentFor(ctx.website, pg.document);
        if (issues.length) throw new Error(`Engine produced an invalid page ${pg.path}: ${issues[0].message}`);
        const existing = pages.find((p) => p.path === pg.path);
        if (existing) {
          const ops = [...(existing.document as PageDocument).root.map((n) => ({ op: "remove" as const, nodeId: n.id })), ...pg.document.root.map((node, index) => ({ op: "insert" as const, parentId: null, index, node }))];
          const r = await applyPageOps(existing.id, { baseVersion: existing.version, ops, meta: { title: pg.title } }, { userId: ctx.userId, source: "ai", aiTaskId: ctx.aiTaskId, message: `Generated by ${engine.id}` });
          applied.push({ path: pg.path, version: r.page.version });
        } else {
          const p = await createPage(ctx.website, { path: pg.path, title: pg.title, document: pg.document }, { userId: ctx.userId, source: "ai" });
          applied.push({ path: pg.path, version: p.version });
        }
      }
      return { engine: engine.id, applied, explanation: out.explanation };
    },
  }),
];

export const toolByName = new Map(AI_TOOLS.map((t) => [t.name, t]));

export function checkToolRole(t: AiTool, role: Role) {
  if (ROLE_RANK[role] < ROLE_RANK[t.minRole]) throw forbidden(`Your role cannot use ${t.name}`);
}

export function toolSpecs() {
  return AI_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input, { target: "draft-7", io: "input" }) as Record<string, unknown> }));
}

export async function describeForPrompt(ctx: Pick<ToolContext, "project" | "website">) {
  const site = await describeSite(ctx.website);
  return site;
}
