import { z } from "zod";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { body, clientIp, requireUser, router } from "../http.js";
import { cookieSecure } from "../env.js";
import { db, schema } from "../db/client.js";
import { rateLimit } from "../lib/rate-limit.js";
import { authenticate, createSession, destroySession, registerUser, requestPasswordReset, resetPassword, SESSION_COOKIE, SESSION_TTL_MS, verifyEmail, issueEmailVerification } from "../services/auth.js";

const Password = z.string().min(10, "Use at least 10 characters").max(200);
const Email = z.string().email().max(254);

export const authRoutes = router();
const setSessionCookie = (c: any, token: string) =>
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: cookieSecure, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });

const byIp = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0] ?? c.env?.incoming?.socket?.remoteAddress ?? "ip";

authRoutes.post("/register", rateLimit("register", 10, 3600_000, byIp), async (c) => {
  const input = await body(c, z.object({ email: Email, password: Password, name: z.string().min(1).max(120) }));
  const user = await registerUser(input, clientIp(c));
  setSessionCookie(c, await createSession(user.id, clientIp(c), c.req.header("user-agent") ?? null));
  return c.json({ user: { id: user.id, email: user.email, name: user.name } }, 201);
});

authRoutes.post("/login", rateLimit("login", 20, 15 * 60_000, byIp), async (c) => {
  const { email, password } = await body(c, z.object({ email: z.string().max(254), password: z.string().max(200) }));
  const user = await authenticate(email, password);
  setSessionCookie(c, await createSession(user.id, clientIp(c), c.req.header("user-agent") ?? null));
  return c.json({ user: { id: user.id, email: user.email, name: user.name } });
});

authRoutes.post("/logout", async (c) => {
  const sid = c.get("sessionId");
  if (sid) await destroySession(sid);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const orgs = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug, kind: schema.organizations.kind, role: schema.memberships.role })
    .from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(eq(schema.memberships.userId, user.id));
  return c.json({ user, orgs });
});

authRoutes.post("/forgot-password", rateLimit("forgot", 5, 3600_000, byIp), async (c) => {
  const { email } = await body(c, z.object({ email: Email }));
  await requestPasswordReset(email);
  return c.json({ ok: true });
});

authRoutes.post("/reset-password", rateLimit("reset", 10, 3600_000, byIp), async (c) => {
  const { token, password } = await body(c, z.object({ token: z.string().min(10).max(200), password: Password }));
  await resetPassword(token, password, clientIp(c));
  return c.json({ ok: true });
});

authRoutes.post("/verify-email", async (c) => {
  const { token } = await body(c, z.object({ token: z.string().min(10).max(200) }));
  await verifyEmail(token);
  return c.json({ ok: true });
});

authRoutes.post("/resend-verification", rateLimit("resend", 3, 3600_000), async (c) => {
  const u = requireUser(c);
  if (!u.emailVerified) await issueEmailVerification(u.id, u.email);
  return c.json({ ok: true });
});

export const readSessionToken = (c: any) => getCookie(c, SESSION_COOKIE);
