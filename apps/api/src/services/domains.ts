import { and, eq, lt } from "drizzle-orm";
import { Resolver } from "node:dns/promises";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { conflict, unprocessable } from "../lib/errors.js";
import { randomLabel } from "../lib/crypto.js";
import { enqueue, registerJob } from "../lib/jobs.js";
import { audit, notify } from "../lib/platform.js";
import { assertFeature } from "./entitlements.js";
import { emitPlatformEvent } from "./modules.js";

/**
 * Custom-domain flow:
 *  1. User adds hostname → we issue a token.
 *  2. User creates TXT  _zyko-challenge.<hostname> = "zyko-verify=<token>"  (ownership)
 *     and points the host at the sites edge (CNAME <subdomain>.<SITES_DOMAIN>, or A/AAAA for apex).
 *  3. Verification job checks the TXT record (retries with backoff for 72h).
 *  4. HTTPS: the edge proxy (Caddy on-demand TLS) asks GET /__zyko/tls-ask?domain=… on the sites
 *     server, which only approves verified hostnames → certificates are issued only for owned domains.
 */
export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}
const system = new Resolver({ timeout: 4000, tries: 2 });
const systemResolver: DnsResolver = {
  txt: async (n) => (await system.resolveTxt(n).catch(() => [])).map((c) => c.join("")),
  cname: async (n) => system.resolveCname(n).catch(() => []),
};
/** In-memory DNS for tests and local development (DNS_MODE=fake). */
export const fakeDns = new Map<string, { txt?: string[]; cname?: string[] }>();
const fakeResolver: DnsResolver = {
  txt: async (n) => fakeDns.get(n.toLowerCase())?.txt ?? [],
  cname: async (n) => fakeDns.get(n.toLowerCase())?.cname ?? [],
};
export const dns: DnsResolver = env.DNS_MODE === "fake" ? fakeResolver : systemResolver;

const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const challengeName = (host: string) => `_zyko-challenge.${host}`;
export const challengeValue = (token: string) => `zyko-verify=${token}`;

export function normalizeHostname(input: string) {
  const h = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!HOST_RE.test(h)) throw unprocessable("Enter a valid domain like www.example.com");
  if (h === env.SITES_DOMAIN || h.endsWith("." + env.SITES_DOMAIN)) throw unprocessable("Platform domains cannot be added as custom domains");
  return h;
}

export async function addDomain(website: typeof schema.websites.$inferSelect, hostnameInput: string, userId: string) {
  await assertFeature(website.orgId, "customDomains");
  const hostname = normalizeHostname(hostnameInput);
  const [exists] = await db.select().from(schema.domains).where(eq(schema.domains.hostname, hostname));
  if (exists) throw conflict("This domain is already connected to a website");
  const [d] = await db.insert(schema.domains).values({ orgId: website.orgId, websiteId: website.id, hostname, verificationToken: randomLabel(32) }).returning();
  await enqueue("domain.verify", { domainId: d.id }, { runAt: new Date(Date.now() + 60_000), dedupeKey: `domain.verify:${d.id}` });
  await audit({ orgId: website.orgId, actorUserId: userId, action: "domain.added", targetType: "domain", targetId: d.id, metadata: { hostname } });
  return d;
}

export function dnsInstructions(d: { hostname: string; verificationToken: string }, subdomain: string) {
  return [
    { type: "TXT", name: challengeName(d.hostname), value: challengeValue(d.verificationToken), purpose: "Proves you own the domain" },
    { type: "CNAME", name: d.hostname, value: `${subdomain}.${env.SITES_DOMAIN}`, purpose: "Routes traffic to the hosting edge (use ALIAS/ANAME at the apex)" },
  ];
}

export async function verifyDomain(domainId: string) {
  const [d] = await db.select().from(schema.domains).where(eq(schema.domains.id, domainId));
  if (!d || d.status === "verified") return d;
  const records = await dns.txt(challengeName(d.hostname));
  const ok = records.includes(challengeValue(d.verificationToken));
  const [updated] = await db.update(schema.domains).set({
    status: ok ? "verified" : d.createdAt.getTime() < Date.now() - 72 * 3600_000 ? "failed" : "pending",
    verifiedAt: ok ? new Date() : null, lastCheckedAt: new Date(), lastError: ok ? null : `TXT record ${challengeName(d.hostname)} not found or mismatched`,
  }).where(eq(schema.domains.id, d.id)).returning();
  if (ok) {
    const [w] = await db.select().from(schema.websites).where(eq(schema.websites.id, d.websiteId));
    const owners = await db.select().from(schema.memberships).where(and(eq(schema.memberships.orgId, d.orgId), eq(schema.memberships.role, "owner")));
    for (const o of owners) await notify({ userId: o.userId, orgId: d.orgId, kind: "domain.verified", title: `${d.hostname} verified`, link: `/app/p/${w.projectId}/publish` });
    await emitPlatformEvent(d.orgId, w.projectId, "domain.verified", { hostname: d.hostname });
  }
  return updated;
}

registerJob("domain.verify", async ({ domainId }: { domainId: string }, job) => {
  const d = await verifyDomain(domainId);
  if (d && d.status === "pending") {
    const delay = Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6)) * 1000;
    await enqueue("domain.verify", { domainId }, { runAt: new Date(Date.now() + delay), dedupeKey: `domain.verify:${domainId}:${Date.now()}` });
  }
});

/** Periodic sweep (scheduled by the worker) for pending domains that lost their job. */
export async function sweepPendingDomains() {
  const rows = await db.select().from(schema.domains).where(and(eq(schema.domains.status, "pending"), lt(schema.domains.lastCheckedAt, new Date(Date.now() - 3600_000))));
  for (const d of rows) await enqueue("domain.verify", { domainId: d.id }, { dedupeKey: `domain.verify:${d.id}` });
}
