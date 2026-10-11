import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { Role } from "../db/schema.js";
import { forbidden, notFound } from "../lib/errors.js";

/**
 * Server-side authorization. Every tenant-scoped route resolves access through these helpers.
 * Non-members get 404 (not 403) so resource existence is not disclosed across tenants.
 */
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export async function membership(userId: string, orgId: string) {
  const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, orgId)));
  return m ?? null;
}

export async function requireOrg(userId: string, orgId: string, min: Role = "viewer") {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw notFound("Organization");
  const m = await membership(userId, orgId);
  if (!m) throw notFound("Organization");
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) throw forbidden();
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  return { org, role: m.role };
}

export async function requireProject(userId: string, projectId: string, min: Role = "viewer") {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw notFound("Project");
  const rows = await db
    .select({ p: schema.projects, role: schema.memberships.role })
    .from(schema.projects)
    .innerJoin(schema.memberships, and(eq(schema.memberships.orgId, schema.projects.orgId), eq(schema.memberships.userId, userId)))
    .where(eq(schema.projects.id, projectId));
  const r = rows[0];
  if (!r) throw notFound("Project");
  if (ROLE_RANK[r.role] < ROLE_RANK[min]) throw forbidden();
  return { project: r.p, role: r.role };
}

export async function requireWebsiteForProject(projectId: string) {
  const [w] = await db.select().from(schema.websites).where(eq(schema.websites.projectId, projectId));
  if (!w) throw notFound("Website");
  return w;
}

/** Resolves a page and checks project access through its website. */
export async function requirePage(userId: string, pageId: string, min: Role = "viewer") {
  if (!/^[0-9a-f-]{36}$/i.test(pageId)) throw notFound("Page");
  const rows = await db
    .select({ page: schema.pages, website: schema.websites })
    .from(schema.pages)
    .innerJoin(schema.websites, eq(schema.websites.id, schema.pages.websiteId))
    .where(and(eq(schema.pages.id, pageId), isNull(schema.pages.deletedAt)));
  const r = rows[0];
  if (!r) throw notFound("Page");
  const { project, role } = await requireProject(userId, r.website.projectId, min);
  return { ...r, project, role };
}
