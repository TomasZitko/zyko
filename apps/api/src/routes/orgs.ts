import { z } from "zod";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { body, clientIp, requireUser, router } from "../http.js";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { ROLES } from "../db/schema.js";
import { badRequest, conflict, forbidden, notFound, paymentRequired } from "../lib/errors.js";
import { randomLabel, randomToken, sha256 } from "../lib/crypto.js";
import { audit, notify, sendEmail } from "../lib/platform.js";
import { requireOrg } from "../services/access.js";
import { assertFeature, getEntitlements, getSubscription, storageBytes, usageThisMonth } from "../services/entitlements.js";
import { slugify } from "../services/websites.js";

export const orgRoutes = router();

orgRoutes.post("/", async (c) => {
  const u = requireUser(c);
  const input = await body(c, z.object({ name: z.string().min(1).max(120), kind: z.enum(["personal", "agency"]) }));
  const owned = await db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(and(eq(schema.memberships.userId, u.id), eq(schema.memberships.role, "owner")));
  if (owned[0].n >= 10) throw badRequest("You can own at most 10 organizations");
  const org = await db.transaction(async (tx) => {
    const [o] = await tx.insert(schema.organizations).values({ name: input.name, kind: input.kind, slug: `${slugify(input.name)}-${randomLabel(6)}` }).returning();
    await tx.insert(schema.memberships).values({ orgId: o.id, userId: u.id, role: "owner" });
    await tx.insert(schema.subscriptions).values({ orgId: o.id, planId: "free" });
    return o;
  });
  await audit({ orgId: org.id, actorUserId: u.id, action: "org.created", targetType: "org", targetId: org.id, ip: clientIp(c) });
  return c.json({ org }, 201);
});

orgRoutes.get("/:orgId", async (c) => {
  const u = requireUser(c);
  const { org, role } = await requireOrg(u.id, c.req.param("orgId"));
  const { plan, entitlements } = await getEntitlements(org.id);
  const subscription = await getSubscription(org.id);
  const usage = { aiMessages: await usageThisMonth(org.id, "ai.messages"), storageBytes: await storageBytes(org.id) };
  return c.json({ org, role, plan, entitlements, subscription, usage });
});

orgRoutes.patch("/:orgId", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  const input = await body(c, z.object({ name: z.string().min(1).max(120).optional(), kind: z.enum(["personal", "agency"]).optional() }));
  if (input.kind === "agency") await assertFeature(org.id, "agencyClients").catch(() => { throw paymentRequired("Agency mode requires the Agency plan"); });
  const [o] = await db.update(schema.organizations).set({ ...input, updatedAt: new Date() }).where(eq(schema.organizations.id, org.id)).returning();
  return c.json({ org: o });
});

// ── Members ──
orgRoutes.get("/:orgId/members", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"));
  const members = await db.select({ userId: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.memberships.role, joinedAt: schema.memberships.createdAt })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId)).where(eq(schema.memberships.orgId, org.id));
  const invites = await db.select({ id: schema.invitations.id, email: schema.invitations.email, role: schema.invitations.role, expiresAt: schema.invitations.expiresAt })
    .from(schema.invitations).where(and(eq(schema.invitations.orgId, org.id), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())));
  return c.json({ members, invites });
});

orgRoutes.post("/:orgId/invitations", async (c) => {
  const u = requireUser(c);
  const { org, role } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  const input = await body(c, z.object({ email: z.string().email(), role: z.enum(ROLES) }));
  if (input.role === "owner" && role !== "owner") throw forbidden("Only owners can invite owners");
  const { entitlements } = await getEntitlements(org.id);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.orgId, org.id));
  if (n >= entitlements.maxMembers) throw paymentRequired(`Your plan allows ${entitlements.maxMembers} member(s)`, { limit: "maxMembers" });
  const token = randomToken();
  const [inv] = await db.insert(schema.invitations).values({ orgId: org.id, email: input.email.toLowerCase(), role: input.role, tokenHash: sha256(token), invitedBy: u.id, expiresAt: new Date(Date.now() + 7 * 86400_000) }).returning();
  await sendEmail({ to: input.email, subject: `You're invited to ${org.name}`, text: `${u.name} invited you to ${org.name}. Accept: ${env.APP_ORIGIN}/invite?token=${token}` });
  await audit({ orgId: org.id, actorUserId: u.id, action: "member.invited", metadata: { email: input.email, role: input.role } });
  return c.json({ invitation: { id: inv.id, email: inv.email, role: inv.role }, ...(env.NODE_ENV !== "production" ? { devToken: token } : {}) }, 201);
});

orgRoutes.delete("/:orgId/invitations/:id", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  await db.delete(schema.invitations).where(and(eq(schema.invitations.id, c.req.param("id")), eq(schema.invitations.orgId, org.id)));
  return c.json({ ok: true });
});

orgRoutes.patch("/:orgId/members/:userId", async (c) => {
  const u = requireUser(c);
  const { org, role } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  const { role: newRole } = await body(c, z.object({ role: z.enum(ROLES) }));
  const target = c.req.param("userId");
  const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, target)));
  if (!m) throw notFound("Member");
  if ((m.role === "owner" || newRole === "owner") && role !== "owner") throw forbidden("Only owners can change owner roles");
  if (m.role === "owner" && newRole !== "owner") await assertAnotherOwner(org.id, target);
  await db.update(schema.memberships).set({ role: newRole }).where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, target)));
  await audit({ orgId: org.id, actorUserId: u.id, action: "member.role_changed", targetType: "user", targetId: target, metadata: { role: newRole } });
  return c.json({ ok: true });
});

orgRoutes.delete("/:orgId/members/:userId", async (c) => {
  const u = requireUser(c);
  const target = c.req.param("userId");
  const { org, role } = await requireOrg(u.id, c.req.param("orgId"), target === u.id ? "viewer" : "admin");
  const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, target)));
  if (!m) throw notFound("Member");
  if (m.role === "owner" && role !== "owner") throw forbidden();
  if (m.role === "owner") await assertAnotherOwner(org.id, target);
  await db.delete(schema.memberships).where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, target)));
  await audit({ orgId: org.id, actorUserId: u.id, action: "member.removed", targetType: "user", targetId: target });
  return c.json({ ok: true });
});

async function assertAnotherOwner(orgId: string, except: string) {
  const owners = await db.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.role, "owner")));
  if (!owners.some((o) => o.userId !== except)) throw conflict("An organization must keep at least one owner");
}

// ── Clients (agency mode) ──
orgRoutes.get("/:orgId/clients", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"));
  return c.json({ clients: await db.select().from(schema.clients).where(eq(schema.clients.orgId, org.id)).orderBy(schema.clients.name) });
});
orgRoutes.post("/:orgId/clients", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "editor");
  await assertFeature(org.id, "agencyClients");
  const input = await body(c, z.object({ name: z.string().min(1).max(200), email: z.string().email().optional(), notes: z.string().max(4000).optional() }));
  const [cl] = await db.insert(schema.clients).values({ orgId: org.id, ...input }).returning();
  return c.json({ client: cl }, 201);
});
orgRoutes.delete("/:orgId/clients/:id", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  await db.delete(schema.clients).where(and(eq(schema.clients.id, c.req.param("id")), eq(schema.clients.orgId, org.id)));
  return c.json({ ok: true });
});

orgRoutes.get("/:orgId/audit", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  return c.json({ events: await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.orgId, org.id)).orderBy(desc(schema.auditEvents.createdAt)).limit(200) });
});

// ── Invitation acceptance (token holder must be signed in with the invited email) ──
export const inviteRoutes = router();
inviteRoutes.post("/accept", async (c) => {
  const u = requireUser(c);
  const { token } = await body(c, z.object({ token: z.string().min(10) }));
  const [inv] = await db.select().from(schema.invitations).where(and(eq(schema.invitations.tokenHash, sha256(token)), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, new Date())));
  if (!inv) throw badRequest("Invitation is invalid or expired");
  if (inv.email.toLowerCase() !== u.email.toLowerCase()) throw forbidden("This invitation was sent to a different email address");
  await db.transaction(async (tx) => {
    await tx.insert(schema.memberships).values({ orgId: inv.orgId, userId: u.id, role: inv.role }).onConflictDoNothing();
    await tx.update(schema.invitations).set({ acceptedAt: new Date() }).where(eq(schema.invitations.id, inv.id));
  });
  if (inv.invitedBy) await notify({ userId: inv.invitedBy, orgId: inv.orgId, kind: "member.joined", title: `${u.name} joined your organization` });
  await audit({ orgId: inv.orgId, actorUserId: u.id, action: "member.joined" });
  return c.json({ orgId: inv.orgId });
});
