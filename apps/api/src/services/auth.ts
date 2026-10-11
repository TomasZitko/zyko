import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { conflict, badRequest, unauthorized } from "../lib/errors.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { audit, sendEmail } from "../lib/platform.js";
import type { SessionUser } from "../http.js";

export const SESSION_COOKIE = "zyko_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

export async function registerUser(input: { email: string; password: string; name: string }, ip: string | null) {
  const email = input.email.trim().toLowerCase();
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
  if (existing.length) throw conflict("An account with this email already exists");
  const [user] = await db.insert(schema.users).values({ email, name: input.name.trim(), passwordHash: await hashPassword(input.password) }).returning();
  await audit({ actorUserId: user.id, action: "user.registered", targetType: "user", targetId: user.id, ip });
  await issueEmailVerification(user.id, email);
  return user;
}

export async function authenticate(emailRaw: string, password: string) {
  const email = emailRaw.trim().toLowerCase();
  const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
  // Always run a hash comparison to avoid user-enumeration timing differences.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH).catch(() => false);
  if (!user || !ok) throw unauthorized("Invalid email or password");
  if (user.disabledAt) throw unauthorized("This account is disabled");
  return user;
}

export async function createSession(userId: string, ip: string | null, userAgent: string | null) {
  const token = randomToken(32);
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS), ip, userAgent: userAgent?.slice(0, 300) });
  return token;
}

export async function resolveSession(token: string): Promise<{ user: SessionUser; sessionId: string } | null> {
  const id = sha256(token);
  const rows = await db
    .select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, new Date()), isNull(schema.users.disabledAt)));
  const r = rows[0];
  if (!r) return null;
  // Sliding expiration, throttled to one write per hour.
  if (Date.now() - r.s.lastSeenAt.getTime() > 3600_000) {
    await db.update(schema.sessions).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }).where(eq(schema.sessions.id, id));
  }
  return { sessionId: id, user: { id: r.u.id, email: r.u.email, name: r.u.name, isPlatformAdmin: r.u.isPlatformAdmin, emailVerified: !!r.u.emailVerifiedAt } };
}

export async function destroySession(sessionId: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

async function issueToken(userId: string, kind: "email_verify" | "password_reset", ttlMs: number) {
  const token = randomToken(32);
  await db.insert(schema.authTokens).values({ userId, kind, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

export async function issueEmailVerification(userId: string, email: string) {
  const token = await issueToken(userId, "email_verify", 3 * 24 * 3600_000);
  await sendEmail({ to: email, subject: "Verify your email", text: `Confirm your email address: ${env.APP_ORIGIN}/verify-email?token=${token}` });
}

async function consumeToken(token: string, kind: "email_verify" | "password_reset") {
  const [row] = await db
    .update(schema.authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.authTokens.tokenHash, sha256(token)), eq(schema.authTokens.kind, kind), isNull(schema.authTokens.usedAt), gt(schema.authTokens.expiresAt, new Date())))
    .returning();
  if (!row) throw badRequest("This link is invalid or has expired");
  return row;
}

export async function verifyEmail(token: string) {
  const t = await consumeToken(token, "email_verify");
  await db.update(schema.users).set({ emailVerifiedAt: new Date() }).where(eq(schema.users.id, t.userId));
}

export async function requestPasswordReset(emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
  if (!user || user.disabledAt) return; // Same response either way (no enumeration).
  const token = await issueToken(user.id, "password_reset", 3600_000);
  await sendEmail({ to: user.email, subject: "Reset your password", text: `Reset your password (valid 1 hour): ${env.APP_ORIGIN}/reset-password?token=${token}` });
}

export async function resetPassword(token: string, password: string, ip: string | null) {
  const t = await consumeToken(token, "password_reset");
  await db.update(schema.users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(schema.users.id, t.userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, t.userId)); // revoke all sessions
  await audit({ actorUserId: t.userId, action: "user.password_reset", targetType: "user", targetId: t.userId, ip });
}
