import { eq } from "drizzle-orm";
import { PLANS } from "@zyko/contracts";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { hmac, safeEqual } from "../lib/crypto.js";
import { audit } from "../lib/platform.js";
import { log } from "../lib/logger.js";

/**
 * Billing provider abstraction. "stripe" talks to the Stripe REST API (requires live credentials,
 * not exercised in CI). "test" simulates checkout for development and automated tests and is
 * refused in production by env validation.
 */
export interface BillingEvent {
  id: string;
  type: "subscription.updated" | "subscription.deleted";
  orgId: string;
  planId: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "incomplete";
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  raw: unknown;
}

export interface BillingProvider {
  id: string;
  createCheckout(o: { orgId: string; planId: string; email: string; successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortal(o: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): BillingEvent | null;
}

async function stripeApi(path: string, params: Record<string, string>) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path} failed: ${j?.error?.message ?? r.status}`);
  return j;
}

/** Stripe signature: header "t=..,v1=.." signing `${t}.${body}` with the endpoint secret. */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = hmac(`${t}.${rawBody}`, secret);
  return header.split(",").filter((p) => p.startsWith("v1=")).some((p) => safeEqual(p.slice(3), expected));
}

const priceToPlan = () => ({ [env.STRIPE_PRICE_PRO ?? "_pro"]: "pro", [env.STRIPE_PRICE_AGENCY ?? "_agency"]: "agency" }) as Record<string, string>;

export const stripeProvider: BillingProvider = {
  id: "stripe",
  async createCheckout({ orgId, planId, email, successUrl, cancelUrl }) {
    const price = planId === "pro" ? env.STRIPE_PRICE_PRO : planId === "agency" ? env.STRIPE_PRICE_AGENCY : undefined;
    if (!price) throw badRequest("Plan is not purchasable");
    const s = await stripeApi("checkout/sessions", {
      mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": "1", customer_email: email,
      client_reference_id: orgId, "subscription_data[metadata][org_id]": orgId, success_url: successUrl, cancel_url: cancelUrl,
    });
    return { url: s.url };
  },
  async createPortal({ customerId, returnUrl }) {
    const s = await stripeApi("billing_portal/sessions", { customer: customerId, return_url: returnUrl });
    return { url: s.url };
  },
  parseWebhook(rawBody, headers) {
    if (!verifyStripeSignature(rawBody, headers["stripe-signature"], env.STRIPE_WEBHOOK_SECRET ?? "")) throw badRequest("Invalid signature");
    const evt = JSON.parse(rawBody);
    if (!["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(evt.type)) return null;
    const sub = evt.data.object;
    const orgId = sub.metadata?.org_id;
    if (!orgId) return null;
    return {
      id: evt.id,
      type: evt.type === "customer.subscription.deleted" ? "subscription.deleted" : "subscription.updated",
      orgId,
      planId: priceToPlan()[sub.items?.data?.[0]?.price?.id] ?? "free",
      status: sub.status === "unpaid" ? "past_due" : sub.status,
      customerId: sub.customer,
      subscriptionId: sub.id,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      raw: evt,
    };
  },
};

/** Development/test provider: checkout redirects to an in-app confirm screen that posts a signed event. */
export const testProvider: BillingProvider = {
  id: "test",
  async createCheckout({ orgId, planId, successUrl }) {
    const payload = JSON.stringify({ orgId, planId, t: Date.now() });
    const token = Buffer.from(payload).toString("base64url") + "." + hmac(payload);
    return { url: `${env.APP_ORIGIN}/app/billing/test-checkout?token=${token}&next=${encodeURIComponent(successUrl)}` };
  },
  async createPortal({ returnUrl }) {
    return { url: returnUrl };
  },
  parseWebhook(rawBody) {
    const { token } = JSON.parse(rawBody);
    const [b64, sig] = String(token).split(".");
    const payload = Buffer.from(b64, "base64url").toString();
    if (!safeEqual(hmac(payload), sig ?? "")) throw badRequest("Invalid test checkout token");
    const { orgId, planId, t } = JSON.parse(payload);
    if (!(planId in PLANS)) throw badRequest("Unknown plan");
    return { id: `test_${t}_${orgId}`, type: "subscription.updated", orgId, planId, status: "active", customerId: `cus_test_${orgId.slice(0, 8)}`, subscriptionId: `sub_test_${orgId}`, currentPeriodEnd: new Date(Date.now() + 30 * 86400_000), raw: { planId } };
  },
};

export const billing: BillingProvider = env.BILLING_PROVIDER === "stripe" ? stripeProvider : testProvider;

/** Idempotent application of a provider event to the subscription row. */
export async function applyBillingEvent(e: BillingEvent) {
  const inserted = await db.insert(schema.billingEvents).values({ id: e.id, provider: billing.id, type: e.type, payload: e.raw as object }).onConflictDoNothing().returning();
  if (!inserted.length) return { duplicate: true };
  const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, e.orgId));
  if (!org) {
    log.warn("billing event for unknown org", { orgId: e.orgId });
    return { duplicate: false };
  }
  const values = {
    planId: e.type === "subscription.deleted" ? "free" : e.planId,
    status: e.type === "subscription.deleted" ? ("canceled" as const) : e.status,
    provider: billing.id,
    providerCustomerId: e.customerId,
    providerSubscriptionId: e.subscriptionId,
    currentPeriodEnd: e.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: e.cancelAtPeriodEnd ?? false,
    updatedAt: new Date(),
  };
  await db.insert(schema.subscriptions).values({ orgId: e.orgId, ...values }).onConflictDoUpdate({ target: schema.subscriptions.orgId, set: values });
  await audit({ orgId: e.orgId, action: "billing.subscription_changed", metadata: { planId: values.planId, status: values.status } });
  return { duplicate: false };
}
