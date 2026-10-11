import { createApp } from "../src/app.js";
import { createSitesApp, clearSitesCache } from "../src/sites.js";
import { runUntilEmpty } from "../src/lib/jobs.js";
import { setRateLimitEnabled } from "../src/lib/rate-limit.js";

setRateLimitEnabled(false);
export const app = createApp();
export const sites = createSitesApp();
export { runUntilEmpty, clearSitesCache };

const ORIGIN = "http://localhost:5173";

/** Minimal API client with a cookie jar, mirroring what the browser does. */
export class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { origin: ORIGIN, ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as any)["content-type"] = "application/json";
    }
    if (this.cookie) (init.headers as any).cookie = this.cookie;
    const res = await app.fetch(new Request(`http://api.test${path}`, init));
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, text, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req("POST", p, b ?? {}, h);
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
  del = (p: string) => this.req("DELETE", p);
}

let n = 0;
export async function signup(name = "User") {
  const c = new Client();
  const email = `${name.toLowerCase().replace(/\W/g, "")}-${Date.now()}-${n++}@example.com`;
  const r = await c.post("/api/auth/register", { email, password: "correct horse battery", name });
  if (r.status !== 201) throw new Error(`signup failed ${r.status} ${r.text}`);
  return { c, email, userId: r.json.user.id as string };
}

export async function setupProject(name = "Owner") {
  const u = await signup(name);
  const org = (await u.c.post("/api/orgs", { name: `${name} Org`, kind: "personal" })).json.org;
  const project = (await u.c.post(`/api/orgs/${org.id}/projects`, { name: "Test Bakery", brief: { description: "A neighbourhood bakery" } })).json.project;
  return { ...u, org, project };
}

export async function sitesGet(host: string, path = "/") {
  const res = await sites.fetch(new Request(`http://${host}${path}`, { headers: { host } }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
