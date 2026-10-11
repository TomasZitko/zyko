import { and, asc, eq, sql } from "drizzle-orm";
import type { ModuleContext, ModuleDefinition, ModuleRecord, ScopedRecordStore } from "@zyko/contracts";
import { db, schema } from "../db/client.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { decryptSecret, encryptSecret, randomToken } from "../lib/crypto.js";
import { enqueue, registerJob } from "../lib/jobs.js";
import { log } from "../lib/logger.js";
import { audit } from "../lib/platform.js";
import { modules, providers } from "../registry.js";
import { assertModuleAllowed, isFlagEnabled } from "./entitlements.js";

type Installation = typeof schema.moduleInstallations.$inferSelect;

const cmpSemver = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Record store bound to ONE installation. Every query is filtered by installation id AND org id. */
function recordStore(inst: Installation, def: ModuleDefinition<any>): ScopedRecordStore {
  const validate = (collection: string, data: unknown) => {
    const s = def.collections?.[collection];
    if (!s) throw unprocessable(`Module ${def.id} has no collection "${collection}"`);
    const r = s.safeParse(data);
    if (!r.success) throw unprocessable(`Invalid ${collection} record`, r.error.issues);
    if (JSON.stringify(r.data).length > 64_000) throw unprocessable("Record too large");
    return r.data as Record<string, unknown>;
  };
  const scope = (collection: string) => and(eq(schema.moduleRecords.installationId, inst.id), eq(schema.moduleRecords.orgId, inst.orgId), eq(schema.moduleRecords.collection, collection));
  const out = (r: typeof schema.moduleRecords.$inferSelect): ModuleRecord => ({ id: r.id, collection: r.collection, data: r.data as any, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });
  return {
    async list(collection, o = {}) {
      validateName(collection, def);
      const rows = await db.select().from(schema.moduleRecords).where(scope(collection)).orderBy(asc(schema.moduleRecords.createdAt)).limit(Math.min(o.limit ?? 100, 500)).offset(o.offset ?? 0);
      return rows.map(out);
    },
    async get(collection, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [r] = await db.select().from(schema.moduleRecords).where(and(scope(collection), eq(schema.moduleRecords.id, id)));
      return r ? out(r) : null;
    },
    async create(collection, data) {
      const clean = validate(collection, data);
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.moduleRecords).where(eq(schema.moduleRecords.installationId, inst.id));
      if (n >= 10_000) throw unprocessable("Module record quota exceeded");
      const [r] = await db.insert(schema.moduleRecords).values({ orgId: inst.orgId, installationId: inst.id, collection, data: clean }).returning();
      return out(r);
    },
    async update(collection, id, data) {
      const clean = validate(collection, data);
      const [r] = await db.update(schema.moduleRecords).set({ data: clean, updatedAt: new Date() }).where(and(scope(collection), eq(schema.moduleRecords.id, id))).returning();
      if (!r) throw notFound("Record");
      return out(r);
    },
    async delete(collection, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Record");
      await db.delete(schema.moduleRecords).where(and(scope(collection), eq(schema.moduleRecords.id, id)));
    },
    async count(collection) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.moduleRecords).where(scope(collection));
      return n;
    },
  };
}
function validateName(collection: string, def: ModuleDefinition<any>) {
  if (!def.collections?.[collection]) throw unprocessable(`Module ${def.id} has no collection "${collection}"`);
}

export function moduleContext(inst: Installation): ModuleContext<any> {
  const def = modules.get(inst.moduleId);
  if (!def) throw notFound("Module");
  const l = log.child({ module: inst.moduleId, installation: inst.id });
  const has = (cap: string) => def.capabilities.includes(cap as any);
  return {
    installation: { id: inst.id, orgId: inst.orgId, projectId: inst.projectId, moduleId: inst.moduleId, version: inst.version, config: inst.config },
    records: has("records") ? recordStore(inst, def) : (new Proxy({}, { get() { throw new Error("records capability not declared"); } }) as any),
    async emit(type, payload) {
      if (!has("events.emit")) throw new Error("events.emit capability not declared");
      await db.insert(schema.platformEvents).values({ orgId: inst.orgId, projectId: inst.projectId, type: `module:${type}`, payload });
    },
    async provider(kind) {
      if (!has("providers") || !def.providers?.includes(kind) && !def.capabilities.includes("providers")) throw new Error("providers capability not declared");
      return getProviderAdapter(inst.orgId, kind);
    },
    log: l,
  };
}

export async function getProviderAdapter<T = unknown>(orgId: string, kind: string): Promise<T> {
  const [conn] = await db.select().from(schema.integrationConnections).where(and(eq(schema.integrationConnections.orgId, orgId), eq(schema.integrationConnections.kind, kind), eq(schema.integrationConnections.status, "active")));
  if (!conn) throw unprocessable(`No ${kind} provider connected`);
  const p = providers.get(`${conn.kind}:${conn.providerId}`);
  if (!p) throw unprocessable(`Provider ${conn.providerId} is not registered`);
  return p.create(p.credentialsSchema.parse(JSON.parse(decryptSecret(conn.credentialsEnc)))) as T;
}

export async function checkModuleAvailability(orgId: string, def: ModuleDefinition<any>) {
  await assertModuleAllowed(orgId, def.id);
  if (def.featureFlag && !(await isFlagEnabled(def.featureFlag, orgId))) throw unprocessable(`Module ${def.id} is not enabled for this organization`);
}

export async function installModule(o: { orgId: string; projectId: string; moduleId: string; config: unknown; userId: string }) {
  const def = modules.get(o.moduleId);
  if (!def) throw notFound("Module");
  await checkModuleAvailability(o.orgId, def);
  for (const req of def.requires ?? []) {
    const [dep] = await db.select().from(schema.moduleInstallations).where(and(eq(schema.moduleInstallations.projectId, o.projectId), eq(schema.moduleInstallations.moduleId, req.moduleId)));
    if (!dep || cmpSemver(dep.version, req.version) < 0) throw unprocessable(`Requires module ${req.moduleId}@${req.version}`);
  }
  const cfg = def.configSchema.safeParse(o.config ?? {});
  if (!cfg.success) throw unprocessable("Invalid module configuration", cfg.error.issues);
  const existing = await db.select().from(schema.moduleInstallations).where(and(eq(schema.moduleInstallations.projectId, o.projectId), eq(schema.moduleInstallations.moduleId, o.moduleId)));
  if (existing.length) throw conflict("Module already installed");
  const secret = randomToken(24);
  const [inst] = await db.insert(schema.moduleInstallations).values({
    orgId: o.orgId, projectId: o.projectId, moduleId: def.id, version: def.version, config: cfg.data as object, webhookSecretEnc: encryptSecret(secret), installedBy: o.userId,
  }).returning();
  try {
    await def.hooks?.onInstall?.(moduleContext(inst));
  } catch (e) {
    await db.delete(schema.moduleInstallations).where(eq(schema.moduleInstallations.id, inst.id)); // atomic from the user's view
    throw unprocessable(`Module install failed: ${(e as Error).message}`);
  }
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "module.installed", targetType: "module", targetId: def.id, metadata: { projectId: o.projectId, version: def.version } });
  await emitPlatformEvent(o.orgId, o.projectId, "module.installed", { moduleId: def.id });
  return { installation: inst, webhookSecret: secret };
}

export async function uninstallModule(inst: Installation, userId: string) {
  const def = modules.get(inst.moduleId);
  try {
    await def?.hooks?.onUninstall?.(moduleContext(inst));
  } catch (e) {
    log.warn("module onUninstall failed; continuing", { module: inst.moduleId, err: String(e) });
  }
  await db.delete(schema.moduleInstallations).where(eq(schema.moduleInstallations.id, inst.id)); // cascades records
  await audit({ orgId: inst.orgId, actorUserId: userId, action: "module.uninstalled", targetType: "module", targetId: inst.moduleId, metadata: { projectId: inst.projectId } });
  await emitPlatformEvent(inst.orgId, inst.projectId, "module.uninstalled", { moduleId: inst.moduleId });
}

export async function configureModule(inst: Installation, config: unknown) {
  const def = modules.get(inst.moduleId);
  if (!def) throw notFound("Module");
  const cfg = def.configSchema.safeParse(config);
  if (!cfg.success) throw unprocessable("Invalid module configuration", cfg.error.issues);
  const [updated] = await db.update(schema.moduleInstallations).set({ config: cfg.data as object, updatedAt: new Date() }).where(eq(schema.moduleInstallations.id, inst.id)).returning();
  await def.hooks?.onConfigChange?.(moduleContext(updated), inst.config);
  return updated;
}

/** Safe upgrade: runs pending migrations in order; on failure the installation keeps its old version and is marked failed. */
export async function upgradeModule(inst: Installation) {
  const def = modules.get(inst.moduleId);
  if (!def) throw notFound("Module");
  if (cmpSemver(def.version, inst.version) <= 0) return inst;
  const cfg = def.configSchema.safeParse(inst.config);
  if (!cfg.success) throw unprocessable("Existing configuration is not valid for the new version; update settings first", cfg.error.issues);
  const pending = (def.migrations ?? []).filter((m) => cmpSemver(m.to, inst.version) > 0 && cmpSemver(m.to, def.version) <= 0).sort((a, b) => cmpSemver(a.to, b.to));
  let current = { ...inst, config: cfg.data };
  try {
    for (const m of pending) {
      await m.up(moduleContext(current as Installation));
      [current] = (await db.update(schema.moduleInstallations).set({ version: m.to, updatedAt: new Date() }).where(eq(schema.moduleInstallations.id, inst.id)).returning()) as any;
    }
    await def.hooks?.onUpgrade?.(moduleContext({ ...current, version: def.version } as Installation), inst.version);
    const [done] = await db.update(schema.moduleInstallations).set({ version: def.version, status: "active", lastError: null, config: cfg.data as object, updatedAt: new Date() }).where(eq(schema.moduleInstallations.id, inst.id)).returning();
    return done;
  } catch (e) {
    await db.update(schema.moduleInstallations).set({ status: "failed", lastError: String((e as Error).message) }).where(eq(schema.moduleInstallations.id, inst.id));
    throw unprocessable(`Upgrade failed: ${(e as Error).message}`);
  }
}

export function webhookSecret(inst: Installation) {
  return decryptSecret(inst.webhookSecretEnc);
}

// ── Platform events → module subscriptions (async, isolated per installation) ──
export async function emitPlatformEvent(orgId: string, projectId: string | null, type: string, payload: Record<string, unknown>) {
  await db.insert(schema.platformEvents).values({ orgId, projectId, type, payload });
  if (!projectId) return;
  const installs = await db.select().from(schema.moduleInstallations).where(and(eq(schema.moduleInstallations.projectId, projectId), eq(schema.moduleInstallations.status, "active")));
  for (const i of installs) {
    const def = modules.get(i.moduleId);
    if (def?.events?.[type as keyof typeof def.events] && def.capabilities.includes("events.subscribe")) {
      await enqueue("module.event", { installationId: i.id, type, payload }, { maxAttempts: 3 });
    }
  }
}

registerJob("module.event", async ({ installationId, type, payload }: { installationId: string; type: string; payload: Record<string, unknown> }) => {
  const [inst] = await db.select().from(schema.moduleInstallations).where(eq(schema.moduleInstallations.id, installationId));
  if (!inst || inst.status !== "active") return;
  const def = modules.get(inst.moduleId);
  const handler = def?.events?.[type as keyof NonNullable<typeof def.events>];
  if (handler) await handler(moduleContext(inst), payload);
});
