import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

/**
 * Tenancy rule: every tenant-owned row carries org_id (denormalized where needed) so authorization
 * checks and indexes never require joins to establish ownership.
 */
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const orgRef = () => uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" });

// ── Identity ──────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256(token); the raw token only exists in the cookie
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const authTokens = pgTable("auth_tokens", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["email_verify", "password_reset"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ── Organizations ─────────────────────────────────────────────────────────
export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  kind: text("kind", { enum: ["personal", "agency"] }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const memberships = pgTable("memberships", {
  orgId: orgRef(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ROLES }).notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("memberships_user_idx").on(t.userId)]);

export const invitations = pgTable("invitations", {
  id: id(),
  orgId: orgRef(),
  email: text("email").notNull(),
  role: text("role", { enum: ROLES }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("invitations_org_idx").on(t.orgId)]);

export const clients = pgTable("clients", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(),
  email: text("email"),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("clients_org_idx").on(t.orgId)]);

// ── Billing ───────────────────────────────────────────────────────────────
export const subscriptions = pgTable("subscriptions", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().default("free"),
  status: text("status", { enum: ["active", "trialing", "past_due", "canceled", "incomplete"] }).notNull().default("active"),
  provider: text("provider").notNull().default("none"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id").unique(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  updatedAt: updatedAt(),
});

export const entitlementOverrides = pgTable("entitlement_overrides", {
  orgId: orgRef(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  reason: text("reason"),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.key] })]);

export const usageRecords = pgTable("usage_records", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: orgRef(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  metric: text("metric").notNull(), // ai.messages, ai.input_tokens, ai.output_tokens, deployments, storage.bytes
  quantity: bigint("quantity", { mode: "number" }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: createdAt(),
}, (t) => [index("usage_org_metric_time_idx").on(t.orgId, t.metric, t.createdAt)]);

export const billingEvents = pgTable("billing_events", {
  id: text("id").primaryKey(), // provider event id → idempotency
  provider: text("provider").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Projects & websites ───────────────────────────────────────────────────
export const projects = pgTable("projects", {
  id: id(),
  orgId: orgRef(),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  brief: jsonb("brief").notNull().default({}),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug), index("projects_org_idx").on(t.orgId, t.status)]);

export const websites = pgTable("websites", {
  id: id(),
  orgId: orgRef(),
  projectId: uuid("project_id").notNull().unique().references(() => projects.id, { onDelete: "cascade" }),
  subdomain: text("subdomain").notNull().unique(),
  settings: jsonb("settings").notNull(),
  designSystemId: text("design_system_id").notNull(),
  designSystemVersion: text("design_system_version").notNull(),
  liveDeploymentId: uuid("live_deployment_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pages = pgTable("pages", {
  id: id(),
  orgId: orgRef(),
  websiteId: uuid("website_id").notNull().references(() => websites.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  title: text("title").notNull(),
  seo: jsonb("seo").notNull().default({}),
  document: jsonb("document").notNull(),
  version: integer("version").notNull().default(1),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("pages_website_path_uq").on(t.websiteId, t.path).where(sql`${t.deletedAt} is null`),
  index("pages_website_idx").on(t.websiteId),
]);

export const pageRevisions = pgTable("page_revisions", {
  id: id(),
  orgId: orgRef(),
  pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  document: jsonb("document").notNull(),
  title: text("title").notNull(),
  seo: jsonb("seo").notNull().default({}),
  ops: jsonb("ops"), // structured change set that produced this revision (null for snapshots)
  source: text("source", { enum: ["user", "ai", "restore", "system", "module"] }).notNull(),
  authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
  aiTaskId: uuid("ai_task_id"),
  message: text("message"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("page_revisions_page_version_uq").on(t.pageId, t.version)]);

// ── Assets & design references ────────────────────────────────────────────
export const assets = pgTable("assets", {
  id: id(),
  orgId: orgRef(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull().unique(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  kind: text("kind", { enum: ["image", "video", "document"] }).notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width"),
  height: integer("height"),
  alt: text("alt"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  metadata: jsonb("metadata").notNull().default({}),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [index("assets_project_idx").on(t.projectId, t.createdAt), index("assets_org_idx").on(t.orgId)]);

export const designReferences = pgTable("design_references", {
  id: id(),
  orgId: orgRef(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }), // null = org-wide library
  kind: text("kind", { enum: ["url", "asset", "note"] }).notNull(),
  url: text("url"),
  assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
  notes: text("notes"),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("design_refs_org_idx").on(t.orgId, t.projectId)]);

// ── AI ────────────────────────────────────────────────────────────────────
export const conversations = pgTable("conversations", {
  id: id(),
  orgId: orgRef(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("conversations_project_idx").on(t.projectId, t.updatedAt)]);

export const messages = pgTable("messages", {
  id: id(),
  orgId: orgRef(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  /** Provider-neutral content blocks: text | tool_use | tool_result */
  content: jsonb("content").notNull(),
  status: text("status", { enum: ["complete", "error", "streaming"] }).notNull().default("complete"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  provider: text("provider"),
  model: text("model"),
  usage: jsonb("usage"),
  createdAt: createdAt(),
}, (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)]);

export const aiTasks = pgTable("ai_tasks", {
  id: id(),
  orgId: orgRef(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  tool: text("tool").notNull(),
  toolUseId: text("tool_use_id"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  status: text("status", { enum: ["awaiting_approval", "running", "succeeded", "failed", "rejected"] }).notNull(),
  error: text("error"),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("ai_tasks_project_idx").on(t.projectId, t.status)]);

// ── Modules & integrations ────────────────────────────────────────────────
export const moduleInstallations = pgTable("module_installations", {
  id: id(),
  orgId: orgRef(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  moduleId: text("module_id").notNull(),
  version: text("version").notNull(),
  status: text("status", { enum: ["active", "disabled", "failed"] }).notNull().default("active"),
  config: jsonb("config").notNull().default({}),
  webhookSecretEnc: text("webhook_secret_enc").notNull(),
  installedBy: uuid("installed_by").references(() => users.id, { onDelete: "set null" }),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("module_inst_project_module_uq").on(t.projectId, t.moduleId), index("module_inst_org_idx").on(t.orgId)]);

export const moduleRecords = pgTable("module_records", {
  id: id(),
  orgId: orgRef(),
  installationId: uuid("installation_id").notNull().references(() => moduleInstallations.id, { onDelete: "cascade" }),
  collection: text("collection").notNull(),
  data: jsonb("data").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("module_records_inst_coll_idx").on(t.installationId, t.collection, t.createdAt)]);

export const integrationConnections = pgTable("integration_connections", {
  id: id(),
  orgId: orgRef(),
  kind: text("kind").notNull(),
  providerId: text("provider_id").notNull(),
  label: text("label").notNull(),
  credentialsEnc: text("credentials_enc").notNull(), // AES-256-GCM; never returned by the API
  status: text("status", { enum: ["active", "error", "revoked"] }).notNull().default("active"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("integration_org_kind_uq").on(t.orgId, t.kind)]);

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  description: text("description"),
  enabledGlobally: boolean("enabled_globally").notNull().default(false),
  orgIds: uuid("org_ids").array().notNull().default(sql`'{}'::uuid[]`),
  plans: text("plans").array().notNull().default(sql`'{}'::text[]`),
  updatedAt: updatedAt(),
});

// ── Hosting ───────────────────────────────────────────────────────────────
export const deployments = pgTable("deployments", {
  id: id(),
  orgId: orgRef(),
  websiteId: uuid("website_id").notNull().references(() => websites.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["preview", "production"] }).notNull(),
  status: text("status", { enum: ["queued", "building", "ready", "failed"] }).notNull().default("queued"),
  previewToken: text("preview_token").unique(),
  manifest: jsonb("manifest"), // {files:[{path,size,sha256,contentType}], pages:[{pageId,version,path}]}
  log: jsonb("log").notNull().default([]),
  error: text("error"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("deployments_website_idx").on(t.websiteId, t.createdAt)]);

export const domains = pgTable("domains", {
  id: id(),
  orgId: orgRef(),
  websiteId: uuid("website_id").notNull().references(() => websites.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull().unique(),
  status: text("status", { enum: ["pending", "verified", "failed"] }).notNull().default("pending"),
  verificationToken: text("verification_token").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
}, (t) => [index("domains_website_idx").on(t.websiteId)]);

export const analyticsEvents = pgTable("analytics_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: orgRef(),
  websiteId: uuid("website_id").notNull().references(() => websites.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  path: text("path").notNull(),
  referrer: text("referrer"),
  visitorHash: text("visitor_hash").notNull(), // daily-rotating salted hash; no cookies, no raw IP
  device: text("device"),
  createdAt: createdAt(),
}, (t) => [index("analytics_site_time_idx").on(t.websiteId, t.createdAt)]);

// ── Platform services ─────────────────────────────────────────────────────
export const notifications = pgTable("notifications", {
  id: id(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt)]);

export const emailOutbox = pgTable("email_outbox", {
  id: id(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  text: text("text").notNull(),
  html: text("html"),
  status: text("status", { enum: ["queued", "sent", "failed"] }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const jobs = pgTable("jobs", {
  id: id(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed"] }).notNull().default("queued"),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  lastError: text("last_error"),
  dedupeKey: text("dedupe_key"),
  createdAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("jobs_ready_idx").on(t.status, t.runAt),
  uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey).where(sql`${t.status} in ('queued','running')`),
]);

export const platformEvents = pgTable("platform_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: orgRef(),
  projectId: uuid("project_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
}, (t) => [index("platform_events_org_idx").on(t.orgId, t.createdAt)]);

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata"),
  ip: text("ip"),
  createdAt: createdAt(),
}, (t) => [index("audit_org_time_idx").on(t.orgId, t.createdAt)]);
