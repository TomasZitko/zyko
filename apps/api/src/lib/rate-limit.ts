import type { MiddlewareHandler } from "hono";
import { tooMany } from "./errors.js";

/**
 * Fixed-window in-memory limiter. Adequate for a single API instance; for horizontal scaling,
 * swap the store for Redis (same interface). See docs/OPERATIONS.md.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): number;
}
class MemoryStore implements RateLimitStore {
  private m = new Map<string, { n: number; reset: number }>();
  hit(key: string, windowMs: number) {
    const now = Date.now();
    const e = this.m.get(key);
    if (!e || e.reset < now) {
      this.m.set(key, { n: 1, reset: now + windowMs });
      if (this.m.size > 50_000) for (const [k, v] of this.m) if (v.reset < now) this.m.delete(k);
      return 1;
    }
    return ++e.n;
  }
}
export const rateStore: RateLimitStore = new MemoryStore();
export let rateLimitEnabled = true;
export const setRateLimitEnabled = (v: boolean) => { rateLimitEnabled = v; };

export function checkRate(key: string, limit: number, windowMs: number) {
  if (!rateLimitEnabled) return;
  if (rateStore.hit(key, windowMs) > limit) throw tooMany();
}

export function rateLimit(name: string, limit: number, windowMs: number, keyFn?: (c: any) => string): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || (c.env as any)?.incoming?.socket?.remoteAddress || "unknown";
    const key = keyFn ? keyFn(c) : (c.get("user")?.id ?? ip);
    checkRate(`${name}:${key}`, limit, windowMs);
    await next();
  };
}
