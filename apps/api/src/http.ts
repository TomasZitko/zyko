import { Hono, type Context } from "hono";
import type { z } from "zod";
import { unauthorized, unprocessable } from "./lib/errors.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  emailVerified: boolean;
}
export type AppEnv = { Variables: { user: SessionUser | null; sessionId: string | null; requestId: string } };
export const router = () => new Hono<AppEnv>();
export type Ctx = Context<AppEnv>;

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw unprocessable("Invalid input", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  return parse(schema, data);
}

export function requireUser(c: Ctx): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

export const clientIp = (c: Ctx) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || ((c.env as any)?.incoming?.socket?.remoteAddress as string | undefined) || null;
