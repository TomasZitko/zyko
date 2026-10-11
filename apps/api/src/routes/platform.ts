import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { PLANS } from "@zyko/contracts";
import { body, requireUser, router, type Ctx } from "../http.js";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/platform.js";
import { requireOrg } from "../services/access.js";
import { applyBillingEvent, billing } from "../services/billing.js";
import { getSubscription } from "../services/entitlements.js";
import { designRegistry, modules } from "../registry.js";

// ── Billing ──
export const billingRoutes = router();
billingRoutes.get("/plans", (c) => c.json({ plans: Object.values(PLANS), provider: billing.id }));

billingRoutes.post("/orgs/:orgId/checkout", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "owner");
  const { planId } = await body(c, z.object({ planId: z.enum(["pro", "agency"]) }));
  const r = await billing.createCheckout({ orgId: org.id, planId, email: u.email, successUrl: `${env.APP_ORIGIN}/app/settings?billing=success`, cancelUrl: `${env.APP_ORIGIN}/app/settings?billing=cancel` });
  return c.json(r);
});
billingRoutes.post("/orgs/:orgId/portal", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "owner");
  const sub = await getSubscription(org.id);
  if (!("providerCustomerId" in sub) || !sub.providerCustomerId) throw notFound("Billing account");
  return c.json(await billing.createPortal({ customerId: sub.providerCustomerId, returnUrl: `${env.APP_ORIGIN}/app/settings` }));
});
/** Provider webhook (Stripe) or test-checkout confirmation. Idempotent by provider event id. */
billingRoutes.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const evt = billing.parseWebhook(raw, Object.fromEntries(c.req.raw.headers));
  if (!evt) return c.json({ ignored: true });
  if (billing.id === "test") {
    // Test checkout is confirmed by a signed-in owner of the org (simulates the provider redirect).
    const u = requireUser(c);
    await requireOrg(u.id, evt.orgId, "owner");
  }
  return c.json(await applyBillingEvent(evt));
});

// ── Notifications ──
export const notificationRoutes = router();
notificationRoutes.get("/", async (c) => {
  const u = requireUser(c);
  const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, u.id)).orderBy(desc(schema.notifications.createdAt)).limit(50);
  const [{ unread }] = await db.select({ unread: sql<number>`count(*)::int` }).from(schema.notifications).where(and(eq(schema.notifications.userId, u.id), isNull(schema.notifications.readAt)));
  return c.json({ notifications: rows, unread });
});
notificationRoutes.post("/read", async (c) => {
  const u = requireUser(c);
  const { ids } = await body(c, z.object({ ids: z.array(z.string().uuid()).max(100).optional() }));
  const where = ids?.length ? and(eq(schema.notifications.userId, u.id), sql`${schema.notifications.id} = any(${ids})`) : eq(schema.notifications.userId, u.id);
  await db.update(schema.notifications).set({ readAt: new Date() }).where(and(where, isNull(schema.notifications.readAt)));
  return c.json({ ok: true });
});

// ── Platform administration (platform admins only; no tenant content access) ──
export const adminRoutes = router();
const requireAdmin = (c: Ctx) => {
  const u = requireUser(c);
  if (!u.isPlatformAdmin) throw forbidden();
  return u;
};
adminRoutes.get("/overview", async (c) => {
  requireAdmin(c);
  const count = async (t: any) => (await db.select({ n: sql<number>`count(*)::int` }).from(t))[0].n;
  const jobs = await db.select({ status: schema.jobs.status, n: sql<number>`count(*)::int` }).from(schema.jobs).groupBy(schema.jobs.status);
  const failedJobs = await db.select().from(schema.jobs).where(eq(schema.jobs.status, "failed")).orderBy(desc(schema.jobs.createdAt)).limit(20);
  return c.json({
    counts: { users: await count(schema.users), organizations: await count(schema.organizations), projects: await count(schema.projects), deployments: await count(schema.deployments) },
    jobs, failedJobs,
    registry: { designSystems: designRegistry.list().map((d) => ({ id: d.id, version: d.version, status: d.status, components: d.components.length })), modules: [...modules.values()].map((m) => ({ id: m.id, version: m.version })) },
  });
});
adminRoutes.get("/users", async (c) => {
  requireAdmin(c);
  const q = (c.req.query("q") ?? "").toLowerCase();
  const rows = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, isPlatformAdmin: schema.users.isPlatformAdmin, disabledAt: schema.users.disabledAt, createdAt: schema.users.createdAt })
    .from(schema.users).where(q ? sql`lower(${schema.users.email}) like ${"%" + q + "%"}` : undefined).orderBy(desc(schema.users.createdAt)).limit(100);
  return c.json({ users: rows });
});
adminRoutes.post("/users/:id/disable", async (c) => {
  const a = requireAdmin(c);
  const { disabled } = await body(c, z.object({ disabled: z.boolean() }));
  await db.update(schema.users).set({ disabledAt: disabled ? new Date() : null }).where(eq(schema.users.id, c.req.param("id")));
  if (disabled) await db.delete(schema.sessions).where(eq(schema.sessions.userId, c.req.param("id")));
  await audit({ actorUserId: a.id, action: disabled ? "admin.user_disabled" : "admin.user_enabled", targetType: "user", targetId: c.req.param("id") });
  return c.json({ ok: true });
});
adminRoutes.get("/orgs", async (c) => {
  requireAdmin(c);
  const rows = await db.select({ org: schema.organizations, plan: schema.subscriptions.planId, status: schema.subscriptions.status })
    .from(schema.organizations).leftJoin(schema.subscriptions, eq(schema.subscriptions.orgId, schema.organizations.id)).orderBy(desc(schema.organizations.createdAt)).limit(200);
  return c.json({ orgs: rows });
});
adminRoutes.put("/orgs/:orgId/entitlements/:key", async (c) => {
  const a = requireAdmin(c);
  const { value, reason } = await body(c, z.object({ value: z.unknown(), reason: z.string().max(300).optional() }));
  const v = { orgId: c.req.param("orgId"), key: c.req.param("key"), value: value as any, reason };
  await db.insert(schema.entitlementOverrides).values(v).onConflictDoUpdate({ target: [schema.entitlementOverrides.orgId, schema.entitlementOverrides.key], set: v });
  await audit({ orgId: v.orgId, actorUserId: a.id, action: "admin.entitlement_override", metadata: { key: v.key, value } });
  return c.json({ ok: true });
});
adminRoutes.get("/flags", async (c) => {
  requireAdmin(c);
  return c.json({ flags: await db.select().from(schema.featureFlags) });
});
adminRoutes.put("/flags/:key", async (c) => {
  const a = requireAdmin(c);
  const input = await body(c, z.object({ description: z.string().max(300).optional(), enabledGlobally: z.boolean().default(false), orgIds: z.array(z.string().uuid()).default([]), plans: z.array(z.string()).default([]) }));
  const v = { key: c.req.param("key"), ...input, updatedAt: new Date() };
  await db.insert(schema.featureFlags).values(v).onConflictDoUpdate({ target: schema.featureFlags.key, set: v });
  await audit({ actorUserId: a.id, action: "admin.flag_updated", targetId: v.key, metadata: input });
  return c.json({ ok: true });
});
adminRoutes.post("/jobs/:id/retry", async (c) => {
  requireAdmin(c);
  await db.update(schema.jobs).set({ status: "queued", runAt: new Date(), attempts: 0 }).where(and(eq(schema.jobs.id, c.req.param("id")), eq(schema.jobs.status, "failed")));
  return c.json({ ok: true });
});
adminRoutes.get("/audit", async (c) => {
  requireAdmin(c);
  return c.json({ events: await db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.createdAt)).limit(200) });
});
