import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { PLANS, moduleAllowed, type Entitlements, type Plan } from "@zyko/contracts";
import { db, schema } from "../db/client.js";
import { paymentRequired } from "../lib/errors.js";

export async function getSubscription(orgId: string) {
  const [s] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId));
  return s ?? { orgId, planId: "free", status: "active" as const, provider: "none", cancelAtPeriodEnd: false, currentPeriodEnd: null };
}

export async function getEntitlements(orgId: string): Promise<{ plan: Plan; entitlements: Entitlements }> {
  const sub = await getSubscription(orgId);
  const active = sub.status === "active" || sub.status === "trialing";
  const plan = PLANS[(active ? sub.planId : "free") as Plan["id"]] ?? PLANS.free;
  const overrides = await db.select().from(schema.entitlementOverrides).where(eq(schema.entitlementOverrides.orgId, orgId));
  const entitlements: any = { ...plan.entitlements };
  for (const o of overrides) if (o.key in entitlements) entitlements[o.key] = o.value;
  return { plan, entitlements };
}

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export async function usageThisMonth(orgId: string, metric: string) {
  const [r] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.usageRecords.quantity}),0)` })
    .from(schema.usageRecords)
    .where(and(eq(schema.usageRecords.orgId, orgId), eq(schema.usageRecords.metric, metric), gte(schema.usageRecords.createdAt, monthStart())));
  return Number(r.total);
}

export async function recordUsage(orgId: string, userId: string | null, metric: string, quantity: number, metadata?: object) {
  if (quantity <= 0) return;
  await db.insert(schema.usageRecords).values({ orgId, userId, metric, quantity, metadata });
}

export async function storageBytes(orgId: string) {
  const [r] = await db.select({ total: sql<string>`coalesce(sum(${schema.assets.size}),0)` }).from(schema.assets).where(and(eq(schema.assets.orgId, orgId), isNull(schema.assets.deletedAt)));
  return Number(r.total);
}

export async function assertCanCreateProject(orgId: string) {
  const { entitlements } = await getEntitlements(orgId);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(and(eq(schema.projects.orgId, orgId), eq(schema.projects.status, "active")));
  if (r.n >= entitlements.maxProjects) throw paymentRequired(`Your plan allows ${entitlements.maxProjects} active projects`, { limit: "maxProjects" });
}

export async function assertAiMessageAllowed(orgId: string) {
  const { entitlements } = await getEntitlements(orgId);
  if ((await usageThisMonth(orgId, "ai.messages")) >= entitlements.aiMessagesPerMonth)
    throw paymentRequired("Monthly AI message limit reached", { limit: "aiMessagesPerMonth" });
}

export async function assertStorageAvailable(orgId: string, addBytes: number) {
  const { entitlements } = await getEntitlements(orgId);
  if ((await storageBytes(orgId)) + addBytes > entitlements.maxStorageMb * 1024 * 1024) throw paymentRequired("Storage limit reached", { limit: "maxStorageMb" });
}

export async function assertFeature(orgId: string, key: "customDomains" | "agencyClients") {
  const { entitlements } = await getEntitlements(orgId);
  if (!entitlements[key]) throw paymentRequired(`Your plan does not include ${key}`, { limit: key });
}

export async function assertModuleAllowed(orgId: string, moduleId: string) {
  const { entitlements } = await getEntitlements(orgId);
  if (!moduleAllowed(entitlements, moduleId)) throw paymentRequired(`Module ${moduleId} is not available on your plan`, { limit: "modules" });
}

export async function assertDeploymentAllowed(orgId: string) {
  const { entitlements } = await getEntitlements(orgId);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.deployments)
    .where(and(eq(schema.deployments.orgId, orgId), gte(schema.deployments.createdAt, new Date(Date.now() - 86400_000))));
  if (r.n >= entitlements.deploymentsPerDay) throw paymentRequired("Daily deployment limit reached", { limit: "deploymentsPerDay" });
}

export async function isFlagEnabled(key: string, orgId: string) {
  const [f] = await db.select().from(schema.featureFlags).where(eq(schema.featureFlags.key, key));
  if (!f) return false;
  if (f.enabledGlobally || f.orgIds.includes(orgId)) return true;
  if (f.plans.length) return f.plans.includes((await getEntitlements(orgId)).plan.id);
  return false;
}
