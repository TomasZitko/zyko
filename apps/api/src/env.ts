import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  PORT: z.coerce.number().default(4000),
  SITES_PORT: z.coerce.number().default(4100),
  DATABASE_URL: z.string().default("postgres://zyko:zyko@localhost:5432/zyko_dev"),
  DB_POOL_SIZE: z.coerce.number().default(10),
  /** Origin of the SaaS web app (used for CSRF origin checks and links in emails). */
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  /** Base domain for platform subdomains and preview hosts, e.g. "zykosites.com". Must differ from the app domain. */
  SITES_DOMAIN: z.string().default("sites.localhost"),
  SITES_PUBLIC_SCHEME: z.enum(["http", "https"]).default("http"),
  /** Port suffix used when building public site URLs in development (":4100"); empty in production. */
  SITES_PUBLIC_PORT: z.string().default(":4100"),
  /** 32-byte key, base64. Used for AES-256-GCM secrets at rest and HMAC signatures. */
  APP_ENCRYPTION_KEY: z.string().default("ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE="),
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_DIR: z.string().default(".data/storage"),
  MAX_UPLOAD_MB: z.coerce.number().default(20),
  AI_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().default(6),
  BILLING_PROVIDER: z.enum(["test", "stripe"]).default("test"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_AGENCY: z.string().optional(),
  EMAIL_PROVIDER: z.enum(["log", "resend"]).default("log"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Zyko <no-reply@localhost>"),
  WORKER_INLINE: bool.default(true),
  DNS_MODE: z.enum(["system", "fake"]).default("system"),
  /** Serve the built web app from the API process (production single-origin deployment). */
  SERVE_WEB_DIST: z.string().optional(),
  COOKIE_SECURE: bool.optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;

if (env.NODE_ENV === "production") {
  const problems: string[] = [];
  if (env.APP_ENCRYPTION_KEY === "ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE=") problems.push("APP_ENCRYPTION_KEY must be set");
  if (env.AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY required");
  if (env.BILLING_PROVIDER === "stripe" && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)) problems.push("Stripe keys required");
  if (env.BILLING_PROVIDER === "test") problems.push("BILLING_PROVIDER=test is not allowed in production");
  if (problems.length) {
    console.error("Production configuration errors:", problems);
    process.exit(1);
  }
}

export const cookieSecure = env.COOKIE_SECURE ?? env.NODE_ENV === "production";
export const sitesBaseUrl = (sub: string) => `${env.SITES_PUBLIC_SCHEME}://${sub}.${env.SITES_DOMAIN}${env.SITES_PUBLIC_PORT}`;
