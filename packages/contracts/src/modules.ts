import { z } from "zod";
import type { ComponentDefinition } from "./components.js";

/**
 * Functional module contract. Modules are code-reviewed packages registered at build time.
 * They never receive a database handle: all persistence goes through the installation-scoped
 * ModuleContext, which enforces tenant isolation (org + project + installation) on every call.
 */
export const MODULE_CAPABILITIES = [
  "records",          // scoped record storage (module_records)
  "webhooks.inbound", // receive signed HTTP callbacks at /hooks/modules/:installationId
  "events.subscribe", // react to platform events (page.published, deployment.ready, ...)
  "events.emit",      // emit module events to the platform event log
  "admin.pages",      // contribute admin pages to the project dashboard
  "site.widgets",     // contribute renderable components to customer websites
  "providers",        // use external provider adapters through integration connections
] as const;
export type ModuleCapability = (typeof MODULE_CAPABILITIES)[number];

export const PLATFORM_EVENTS = ["page.updated", "page.published", "deployment.ready", "deployment.failed", "domain.verified", "module.installed", "module.uninstalled"] as const;
export type PlatformEventType = (typeof PLATFORM_EVENTS)[number];

export interface ModuleRecord<T = Record<string, unknown>> {
  id: string;
  collection: string;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface ScopedRecordStore {
  list(collection: string, opts?: { limit?: number; offset?: number }): Promise<ModuleRecord[]>;
  get(collection: string, id: string): Promise<ModuleRecord | null>;
  create(collection: string, data: unknown): Promise<ModuleRecord>;
  update(collection: string, id: string, data: unknown): Promise<ModuleRecord>;
  delete(collection: string, id: string): Promise<void>;
  count(collection: string): Promise<number>;
}

export interface ModuleContext<Config = unknown> {
  installation: { id: string; orgId: string; projectId: string; moduleId: string; version: string; config: Config };
  records: ScopedRecordStore;
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Returns a configured provider adapter for this org, or throws if none is connected. */
  provider<T = unknown>(kind: string): Promise<T>;
  log: { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void };
}

export interface InboundWebhookRequest {
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

export interface ModuleAdminPage {
  id: string;
  title: string;
  /** Declarative views the platform renders; no module-supplied UI code runs in the app shell. */
  view:
    | { kind: "records"; collection: string; columns: { key: string; label: string }[]; allowCreate?: boolean; allowDelete?: boolean }
    | { kind: "settings" };
}

export interface ModuleMigration {
  /** Version this migration brings the installation to. */
  to: string;
  up(ctx: ModuleContext<any>): Promise<void>;
}

export interface ModuleDefinition<C extends z.ZodType = z.ZodType> {
  id: string;           // "vendor.name", lowercase
  version: string;      // semver
  name: string;
  description: string;
  platformApi: number;
  capabilities: ModuleCapability[];
  /** Typed configuration. Validated on install and on every settings change. */
  configSchema: C;
  /** Record collections this module owns, each with a schema validated on write. */
  collections?: Record<string, z.ZodType>;
  /** Optional feature flag key that must be enabled for the org. */
  featureFlag?: string;
  /** Other modules this one depends on. */
  requires?: { moduleId: string; version: string }[];
  /** Provider kinds the module needs connected (e.g. "calendar"). */
  providers?: string[];
  adminPages?: ModuleAdminPage[];
  widgets?: ComponentDefinition<any>[];
  migrations?: ModuleMigration[];
  hooks?: {
    onInstall?(ctx: ModuleContext<z.infer<C>>): Promise<void>;
    onUninstall?(ctx: ModuleContext<z.infer<C>>): Promise<void>;
    onUpgrade?(ctx: ModuleContext<z.infer<C>>, fromVersion: string): Promise<void>;
    onConfigChange?(ctx: ModuleContext<z.infer<C>>, previous: z.infer<C>): Promise<void>;
  };
  events?: Partial<Record<PlatformEventType, (ctx: ModuleContext<z.infer<C>>, payload: Record<string, unknown>) => Promise<void>>>;
  webhook?(ctx: ModuleContext<z.infer<C>>, req: InboundWebhookRequest): Promise<{ status: number; body: unknown }>;
}

export function defineModule<C extends z.ZodType>(def: ModuleDefinition<C>): ModuleDefinition<C> {
  return def;
}

/**
 * External service provider adapter contract (email, payments, calendar, storage, DNS, ...).
 * Credentials are stored encrypted in integration_connections and decrypted only server-side.
 */
export interface ProviderDefinition<Cfg extends z.ZodType = z.ZodType, Adapter = unknown> {
  kind: string;     // "calendar", "email", "payments", ...
  id: string;       // "google-calendar", "fixture-echo"
  name: string;
  credentialsSchema: Cfg;
  create(credentials: z.infer<Cfg>): Adapter;
  /** Optional connectivity check used by "Test connection". */
  test?(adapter: Adapter): Promise<{ ok: boolean; message?: string }>;
}
export function defineProvider<Cfg extends z.ZodType, A>(def: ProviderDefinition<Cfg, A>) {
  return def;
}
