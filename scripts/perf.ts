/**
 * Performance measurement: in-process latency of hot API paths, the sites edge, publish build time,
 * and the web bundle budget. Usage: DATABASE_URL=postgres://…/zyko_perf pnpm perf
 * (the target database is wiped). Budgets fail the run with exit code 1.
 */
import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DNS_MODE = "fake";
process.env.STORAGE_DIR ??= ".data/perf-storage";
process.env.SITES_DOMAIN = "sites.test";
process.env.SITES_PUBLIC_PORT = "";
process.env.APP_ORIGIN = "http://localhost:5173";
process.env.DATABASE_URL ??= "postgres://zyko:zyko@localhost:5432/zyko_perf";

const BUDGETS = { apiP95Ms: 50, opsP95Ms: 80, sitesP95Ms: 20, publishMs: 2000, webInitialGzipKb: 120, editorGzipKb: 80 };

const { sqlClient: admin } = await import("../apps/api/src/db/client.js");
await admin.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
const { runMigrations } = await import("../apps/api/src/db/migrate.js");
await runMigrations();
const { createApp } = await import("../apps/api/src/app.js");
const { createSitesApp, clearSitesCache } = await import("../apps/api/src/sites.js");
const { runUntilEmpty } = await import("../apps/api/src/lib/jobs.js");
const { setRateLimitEnabled } = await import("../apps/api/src/lib/rate-limit.js");
setRateLimitEnabled(false);
const app = createApp(), sites = createSitesApp();
let cookie = "";
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.fetch(new Request(`http://x${path}`, { method, headers: { origin: "http://localhost:5173", "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined }));
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return r.json() as any;
};
const time = async (n: number, fn: () => Promise<unknown>) => {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); }
  xs.sort((a, b) => a - b);
  return { p50: +xs[Math.floor(n * 0.5)].toFixed(2), p95: +xs[Math.floor(n * 0.95)].toFixed(2) };
};

await call("POST", "/api/auth/register", { email: `perf${Date.now()}@x.com`, password: "perf password 123", name: "Perf" });
const org = (await call("POST", "/api/orgs", { name: "Perf", kind: "personal" })).org;
const project = (await call("POST", `/api/orgs/${org.id}/projects`, { name: "Perf site" })).project;
const pageId = (await call("GET", `/api/projects/${project.id}/pages`)).pages[0].id;
let page = (await call("GET", `/api/pages/${pageId}`)).page;
const heading = page.document.root[1].slots.default[0].id;
// Grow the page to a realistic size (~120 nodes).
const section = page.document.root[1].id;
for (let i = 0; i < 40; i++) {
  page = (await call("POST", `/api/pages/${pageId}/ops`, { baseVersion: page.version, ops: [
    { op: "insert", parentId: section, slot: "default", index: 0, node: { id: `pf${i}aaaaa`, type: "text", v: 1, props: { body: "Lorem ipsum ".repeat(20) } } },
    { op: "insert", parentId: null, index: 1, node: { id: `ps${i}aaaaa`, type: "section", v: 1, props: {}, slots: { default: [{ id: `ph${i}aaaaa`, type: "heading", v: 1, props: { text: `Section ${i}` } }] } } },
  ] })).page;
}
const results: Record<string, unknown> = {};
results.getProject = await time(200, () => call("GET", `/api/projects/${project.id}`));
results.getPage = await time(200, () => call("GET", `/api/pages/${pageId}`));
let v = page.version;
results.saveOps = await time(200, async () => { const r = await call("POST", `/api/pages/${pageId}/ops`, { baseVersion: v, ops: [{ op: "update_props", nodeId: heading, props: { text: `t${v}` } }] }); v = r.page.version; });
let t = performance.now();
await call("POST", `/api/projects/${project.id}/deployments`, { kind: "production" });
await runUntilEmpty();
results.publishMs = +(performance.now() - t).toFixed(1);
clearSitesCache();
const host = `${project.website.subdomain}.sites.test`;
results.sitesGet = await time(300, async () => (await sites.fetch(new Request(`http://${host}/`, { headers: { host } }))).arrayBuffer());

const dist = "apps/web/dist/assets";
const gz = (f: string) => +(gzipSync(readFileSync(`${dist}/${f}`)).length / 1024).toFixed(1);
let files: string[] = [];
try { files = readdirSync(dist).filter((f) => f.endsWith(".js") || f.endsWith(".css")); } catch { /* not built */ }
const initial = files.filter((f) => f.startsWith("index-")).reduce((a, f) => a + gz(f), 0);
const editor = files.filter((f) => f.startsWith("editor-")).reduce((a, f) => a + gz(f), 0);
results.webInitialGzipKb = +initial.toFixed(1);
results.editorGzipKb = +editor.toFixed(1);
results.pageNodes = JSON.stringify(page.document).match(/"id"/g)?.length;

const r = results as any;
const failures = [
  r.getProject.p95 > BUDGETS.apiP95Ms && "getProject p95", r.getPage.p95 > BUDGETS.apiP95Ms && "getPage p95", r.saveOps.p95 > BUDGETS.opsP95Ms && "saveOps p95",
  r.sitesGet.p95 > BUDGETS.sitesP95Ms && "sites p95", r.publishMs > BUDGETS.publishMs && "publish", files.length && initial > BUDGETS.webInitialGzipKb && "web initial", files.length && editor > BUDGETS.editorGzipKb && "editor chunk",
].filter(Boolean);
console.log(JSON.stringify({ budgets: BUDGETS, results, failures }, null, 2));
const { sqlClient } = await import("../apps/api/src/db/client.js");
await sqlClient.end();
process.exit(failures.length ? 1 : 0);
