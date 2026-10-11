import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { enqueue, registerJob } from "./jobs.js";
import { log } from "./logger.js";

// ── Audit ─────────────────────────────────────────────────────────────────
export async function audit(e: { orgId?: string | null; actorUserId?: string | null; action: string; targetType?: string; targetId?: string; metadata?: object; ip?: string | null }) {
  await db.insert(schema.auditEvents).values({ ...e, orgId: e.orgId ?? null, actorUserId: e.actorUserId ?? null });
}

// ── Notifications ─────────────────────────────────────────────────────────
export async function notify(n: { userId: string; orgId?: string | null; kind: string; title: string; body?: string; link?: string }) {
  await db.insert(schema.notifications).values({ ...n, orgId: n.orgId ?? null });
}

// ── Email (outbox + provider adapter) ─────────────────────────────────────
export interface EmailMessage { to: string; subject: string; text: string; html?: string }
export interface EmailProvider { send(m: EmailMessage): Promise<void> }

export const sentEmails: EmailMessage[] = []; // inspected by tests in log mode
const logProvider: EmailProvider = {
  async send(m) {
    sentEmails.push(m);
    if (sentEmails.length > 200) sentEmails.shift();
    log.info("email (log provider)", { to: m.to, subject: m.subject, text: m.text.slice(0, 500) });
  },
};
const resendProvider: EmailProvider = {
  async send(m) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!r.ok) throw new Error(`Resend error ${r.status}: ${await r.text()}`);
  },
};
export const emailProvider: EmailProvider = env.EMAIL_PROVIDER === "resend" ? resendProvider : logProvider;

export async function sendEmail(m: EmailMessage) {
  const [row] = await db.insert(schema.emailOutbox).values(m).returning({ id: schema.emailOutbox.id });
  await enqueue("email.send", { id: row.id });
}

registerJob("email.send", async ({ id }: { id: string }) => {
  const { eq } = await import("drizzle-orm");
  const [m] = await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, id));
  if (!m || m.status === "sent") return;
  try {
    await emailProvider.send({ to: m.to, subject: m.subject, text: m.text, html: m.html ?? undefined });
    await db.update(schema.emailOutbox).set({ status: "sent", sentAt: new Date(), attempts: m.attempts + 1 }).where(eq(schema.emailOutbox.id, id));
  } catch (e) {
    await db.update(schema.emailOutbox).set({ attempts: m.attempts + 1, lastError: String(e), status: "failed" }).where(eq(schema.emailOutbox.id, id));
    throw e;
  }
});
