import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { moduleAllowed } from "@zyko/contracts";
import { body, requireUser, router } from "../http.js";
import { db, schema } from "../db/client.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { encryptSecret, hmac, safeEqual } from "../lib/crypto.js";
import { checkRate } from "../lib/rate-limit.js";
import { audit } from "../lib/platform.js";
import { reportError } from "../lib/logger.js";
import { requireOrg, requireProject } from "../services/access.js";
import { getEntitlements, isFlagEnabled } from "../services/entitlements.js";
import { configureModule, installModule, moduleContext, uninstallModule, upgradeModule, webhookSecret } from "../services/modules.js";
import { modules, providers } from "../registry.js";

export const moduleRoutes = router();

moduleRoutes.get("/projects/:projectId/modules", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"));
  const { entitlements } = await getEntitlements(project.orgId);
  const installs = await db.select().from(schema.moduleInstallations).where(eq(schema.moduleInstallations.projectId, project.id));
  const catalog = await Promise.all([...modules.values()].map(async (m) => {
    const inst = installs.find((i) => i.moduleId === m.id);
    return {
      id: m.id, version: m.version, name: m.name, description: m.description, capabilities: m.capabilities,
      configSchema: z.toJSONSchema(m.configSchema, { io: "input" }), adminPages: m.adminPages ?? [], widgets: (m.widgets ?? []).map((w) => w.type),
      available: moduleAllowed(entitlements, m.id) && (!m.featureFlag || (await isFlagEnabled(m.featureFlag, project.orgId))),
      installation: inst ? { id: inst.id, version: inst.version, status: inst.status, config: inst.config, lastError: inst.lastError, upgradeAvailable: inst.version !== m.version } : null,
    };
  }));
  return c.json({ modules: catalog });
});

moduleRoutes.post("/projects/:projectId/modules", async (c) => {
  const u = requireUser(c);
  const { project } = await requireProject(u.id, c.req.param("projectId"), "admin");
  const input = await body(c, z.object({ moduleId: z.string(), config: z.unknown().optional() }));
  const r = await installModule({ orgId: project.orgId, projectId: project.id, moduleId: input.moduleId, config: input.config, userId: u.id });
  return c.json({ installation: { ...r.installation, webhookSecretEnc: undefined }, webhookSecret: r.webhookSecret, webhookUrl: `/hooks/modules/${r.installation.id}` }, 201);
});

async function loadInstallation(userId: string, id: string, min: "viewer" | "editor" | "admin") {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Module installation");
  const [inst] = await db.select().from(schema.moduleInstallations).where(eq(schema.moduleInstallations.id, id));
  if (!inst) throw notFound("Module installation");
  await requireProject(userId, inst.projectId, min);
  return inst;
}

moduleRoutes.patch("/module-installations/:id", async (c) => {
  const u = requireUser(c);
  const inst = await loadInstallation(u.id, c.req.param("id"), "admin");
  const { config } = await body(c, z.object({ config: z.unknown() }));
  const up = await configureModule(inst, config);
  return c.json({ installation: { ...up, webhookSecretEnc: undefined } });
});
moduleRoutes.post("/module-installations/:id/upgrade", async (c) => {
  const u = requireUser(c);
  const inst = await loadInstallation(u.id, c.req.param("id"), "admin");
  const up = await upgradeModule(inst);
  await audit({ orgId: inst.orgId, actorUserId: u.id, action: "module.upgraded", targetType: "module", targetId: inst.moduleId, metadata: { from: inst.version, to: up.version } });
  return c.json({ installation: { ...up, webhookSecretEnc: undefined } });
});
moduleRoutes.delete("/module-installations/:id", async (c) => {
  const u = requireUser(c);
  const inst = await loadInstallation(u.id, c.req.param("id"), "admin");
  await uninstallModule(inst, u.id);
  return c.json({ ok: true });
});

// Generic admin-page data API: records views declared in the module manifest.
moduleRoutes.get("/module-installations/:id/records/:collection", async (c) => {
  const u = requireUser(c);
  const inst = await loadInstallation(u.id, c.req.param("id"), "viewer");
  const ctx = moduleContext(inst);
  return c.json({ records: await ctx.records.list(c.req.param("collection"), { limit: 200 }) });
});
moduleRoutes.post("/module-installations/:id/records/:collection", async (c) => {
  const u = requireUser(c);
  const inst = await loadInstallation(u.id, c.req.param("id"), "editor");
  assertAdminPageAllows(inst.moduleId, c.req.param("collection"), "allowCreate");
  const rec = await moduleContext(inst).records.create(c.req.param("collection"), await c.req.json().catch(() => ({})));
  return c.json({ record: rec }, 201);
});
moduleRoutes.delete("/module-installations/:id/records/:collection/:recordId", async (c) => {
  const u = requireUser(c);
  const inst = await loadInstallation(u.id, c.req.param("id"), "editor");
  assertAdminPageAllows(inst.moduleId, c.req.param("collection"), "allowDelete");
  await moduleContext(inst).records.delete(c.req.param("collection"), c.req.param("recordId"));
  return c.json({ ok: true });
});
function assertAdminPageAllows(moduleId: string, collection: string, flag: "allowCreate" | "allowDelete") {
  const def = modules.get(moduleId);
  const ok = def?.adminPages?.some((p) => p.view.kind === "records" && p.view.collection === collection && p.view[flag]);
  if (!ok) throw unprocessable("This action is not available for this collection");
}

// ── Integration connections (provider adapters) ──
moduleRoutes.get("/orgs/:orgId/integrations", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"));
  const rows = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.orgId, org.id));
  return c.json({
    available: [...providers.values()].map((p) => ({ kind: p.kind, id: p.id, name: p.name, credentialsSchema: z.toJSONSchema(p.credentialsSchema) })),
    connections: rows.map(({ credentialsEnc, ...r }) => r),
  });
});
moduleRoutes.post("/orgs/:orgId/integrations", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  const input = await body(c, z.object({ kind: z.string(), providerId: z.string(), label: z.string().max(100).default(""), credentials: z.unknown() }));
  const p = providers.get(`${input.kind}:${input.providerId}`);
  if (!p) throw notFound("Provider");
  const creds = p.credentialsSchema.safeParse(input.credentials);
  if (!creds.success) throw unprocessable("Invalid credentials", creds.error.issues);
  if (p.test) {
    const t = await p.test(p.create(creds.data)).catch((e: Error) => ({ ok: false, message: e.message }));
    if (!t.ok) throw unprocessable(`Connection test failed${t.message ? `: ${t.message}` : ""}`);
  }
  const values = { orgId: org.id, kind: p.kind, providerId: p.id, label: input.label || p.name, credentialsEnc: encryptSecret(JSON.stringify(creds.data)), status: "active" as const };
  const [row] = await db.insert(schema.integrationConnections).values(values).onConflictDoUpdate({ target: [schema.integrationConnections.orgId, schema.integrationConnections.kind], set: values }).returning();
  await audit({ orgId: org.id, actorUserId: u.id, action: "integration.connected", metadata: { kind: p.kind, provider: p.id } });
  const { credentialsEnc, ...safe } = row;
  return c.json({ connection: safe }, 201);
});
moduleRoutes.delete("/orgs/:orgId/integrations/:id", async (c) => {
  const u = requireUser(c);
  const { org } = await requireOrg(u.id, c.req.param("orgId"), "admin");
  await db.delete(schema.integrationConnections).where(and(eq(schema.integrationConnections.id, c.req.param("id")), eq(schema.integrationConnections.orgId, org.id)));
  return c.json({ ok: true });
});

/**
 * Inbound module webhooks (public). Authenticated by HMAC-SHA256 of the raw body with the
 * installation's secret: header  X-Zyko-Signature: sha256=<hex>
 */
export const hookRoutes = router();
hookRoutes.post("/modules/:installationId", async (c) => {
  const id = c.req.param("installationId");
  checkRate(`hook:${id}`, 120, 60_000);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Webhook");
  const [inst] = await db.select().from(schema.moduleInstallations).where(eq(schema.moduleInstallations.id, id));
  const def = inst ? modules.get(inst.moduleId) : null;
  if (!inst || inst.status !== "active" || !def?.webhook || !def.capabilities.includes("webhooks.inbound")) throw notFound("Webhook");
  const raw = await c.req.text();
  if (raw.length > 256_000) throw unprocessable("Payload too large");
  const sig = (c.req.header("x-zyko-signature") ?? "").replace(/^sha256=/, "");
  if (!sig || !safeEqual(hmac(raw, webhookSecret(inst)), sig)) return c.json({ error: "invalid signature" }, 401);
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { return c.json({ error: "invalid json" }, 400); }
  try {
    const r = await def.webhook(moduleContext(inst), { headers: Object.fromEntries(c.req.raw.headers), body: parsed, rawBody: raw });
    return c.json(r.body as any, r.status as any);
  } catch (e) {
    reportError(e, { module: inst.moduleId, installation: inst.id });
    return c.json({ error: "module error" }, 500);
  }
});
