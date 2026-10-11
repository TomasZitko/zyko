import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, PNG_1x1, runUntilEmpty, setupProject, signup, sitesGet, clearSitesCache } from "./helpers.js";
import { db, schema } from "../src/db/client.js";
import { sentEmails } from "../src/lib/platform.js";
import { fakeDns } from "../src/services/domains.js";
import { hmac } from "../src/lib/crypto.js";
import { verifyStripeSignature } from "../src/services/billing.js";

describe("authentication", () => {
  it("logs in/out, rejects bad credentials, resets password and revokes sessions", async () => {
    const { c, email } = await signup("Bob");
    expect((await c.post("/api/auth/logout")).status).toBe(200);
    expect((await c.get("/api/auth/me")).json.user).toBeNull();
    const bad = new Client();
    expect((await bad.post("/api/auth/login", { email, password: "wrong password!!" })).status).toBe(401);
    const good = new Client();
    expect((await good.post("/api/auth/login", { email: email.toUpperCase(), password: "correct horse battery" })).status).toBe(200);
    expect((await good.post("/api/auth/register", { email, password: "another password", name: "Dup" })).status).toBe(409);

    await new Client().post("/api/auth/forgot-password", { email });
    await runUntilEmpty();
    const mail = sentEmails.filter((m) => m.to === email && m.subject.includes("Reset")).at(-1)!;
    const token = mail.text.match(/token=([\w-]+)/)![1];
    expect((await new Client().post("/api/auth/reset-password", { token, password: "brand new password" })).status).toBe(200);
    expect((await new Client().post("/api/auth/reset-password", { token, password: "brand new password" })).status).toBe(400);
    expect((await good.get("/api/auth/me")).json.user).toBeNull(); // sessions revoked
    expect((await new Client().post("/api/auth/login", { email, password: "brand new password" })).status).toBe(200);

    const verify = sentEmails.filter((m) => m.to === email && m.subject.includes("Verify")).at(-1)!;
    expect((await new Client().post("/api/auth/verify-email", { token: verify.text.match(/token=([\w-]+)/)![1] })).status).toBe(200);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const { c } = await signup("Csrf");
    const r = await c.req("POST", "/api/orgs", { name: "x", kind: "personal" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
});

describe("organizations, roles and tenant isolation", () => {
  it("enforces roles for invited members", async () => {
    const { c: owner, org, project } = await setupProject("RoleOwner");
    // Free plan allows 1 member → upgrade via test billing to invite.
    expect((await owner.post(`/api/orgs/${org.id}/invitations`, { email: "v@example.com", role: "viewer" })).status).toBe(402);
    const checkout = (await owner.post(`/api/billing/orgs/${org.id}/checkout`, { planId: "agency" })).json;
    const token = new URL(checkout.url).searchParams.get("token");
    expect((await owner.post("/api/billing/webhook", { token })).json.duplicate).toBe(false);
    expect((await owner.post("/api/billing/webhook", { token })).json.duplicate).toBe(true);
    expect((await owner.get(`/api/orgs/${org.id}`)).json.plan.id).toBe("agency");

    const { c: viewer, email } = await signup("Viewer");
    const inv = (await owner.post(`/api/orgs/${org.id}/invitations`, { email, role: "viewer" })).json;
    const { c: other } = await signup("Other");
    expect((await other.post("/api/invitations/accept", { token: inv.devToken })).status).toBe(403);
    expect((await viewer.post("/api/invitations/accept", { token: inv.devToken })).status).toBe(200);

    expect((await viewer.get(`/api/projects/${project.id}`)).status).toBe(200);
    const pages = (await viewer.get(`/api/projects/${project.id}/pages`)).json.pages;
    expect((await viewer.post(`/api/pages/${pages[0].id}/ops`, { baseVersion: 1, ops: [] })).status).toBe(403);
    expect((await viewer.post(`/api/projects/${project.id}/conversations`, {})).status).toBe(403);
    expect((await viewer.del(`/api/orgs/${org.id}/members/${(await owner.get("/api/auth/me")).json.user.id}`)).status).toBe(403);

    // Agency mode + clients now allowed.
    expect((await owner.patch(`/api/orgs/${org.id}`, { kind: "agency" })).status).toBe(200);
    const client = (await owner.post(`/api/orgs/${org.id}/clients`, { name: "ACME" })).json.client;
    expect((await owner.patch(`/api/projects/${project.id}`, { clientId: client.id })).status).toBe(200);
  });

  it("does not let one tenant reference another tenant's objects", async () => {
    const a = await setupProject("TenantA");
    const b = await setupProject("TenantB");
    const fd = new FormData();
    fd.append("file", new Blob([PNG_1x1]), "a.png");
    const assetA = (await a.c.req("POST", `/api/projects/${a.project.id}/assets`, fd)).json.asset;
    // B tries to reference A's asset as a design reference in B's project
    expect((await b.c.post(`/api/projects/${b.project.id}/design-references`, { kind: "asset", assetId: assetA.id })).status).toBe(404);
    // B tries to put A's asset into B's page and publish: asset is not resolved (not copied)
    const pageB = (await b.c.get(`/api/projects/${b.project.id}/pages`)).json.pages[0];
    const docB = (await b.c.get(`/api/pages/${pageB.id}`)).json.page;
    const section = docB.document.root.find((n: any) => n.type === "section");
    const steal = await b.c.post(`/api/pages/${pageB.id}/ops`, { baseVersion: docB.version, ops: [{ op: "insert", parentId: section.id, slot: "default", index: 0, node: { id: "steal001", type: "image", v: 1, props: { asset: assetA.id } } }] });
    expect(steal.status).toBe(422);
    expect(JSON.stringify(steal.json)).toContain("does not exist in this project");
    await b.c.post(`/api/projects/${b.project.id}/deployments`, { kind: "production" });
    await runUntilEmpty();
    clearSitesCache();
    const live = await sitesGet(`${b.project.website.subdomain}.sites.test`);
    expect(live.status).toBe(200);
    expect(live.text).not.toContain("_assets/");
    // B cannot read A's org or approve A's AI tasks
    expect((await b.c.get(`/api/orgs/${a.org.id}/members`)).status).toBe(404);
    expect((await b.c.post(`/api/ai-tasks/00000000-0000-0000-0000-000000000000/approve`)).status).toBe(404);
  });

  it("enforces plan limits on projects", async () => {
    const { c, org } = await setupProject("Limits");
    expect((await c.post(`/api/orgs/${org.id}/projects`, { name: "Second" })).status).toBe(201);
    expect((await c.post(`/api/orgs/${org.id}/projects`, { name: "Third" })).status).toBe(402);
  });
});

describe("uploads", () => {
  it("accepts only sniffed allow-listed types", async () => {
    const { c, project } = await setupProject("Uploader");
    const send = (data: Buffer | string, name: string) => {
      const fd = new FormData();
      fd.append("file", new Blob([data as any]), name);
      return c.req("POST", `/api/projects/${project.id}/assets`, fd);
    };
    expect((await send("<svg onload=alert(1)>", "x.svg")).status).toBe(422);
    expect((await send("<html><script>", "x.png")).status).toBe(422);
    const ok = await send(PNG_1x1, "../../etc/passwd.png");
    expect(ok.status).toBe(201);
    expect(ok.json.asset.filename).not.toContain("/");
    const raw = await c.req("GET", new URL(ok.json.asset.url, "http://x").pathname + new URL(ok.json.asset.url, "http://x").search);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("editor engine", () => {
  it("supports insert/move/remove, layout and undo via inverse ops", async () => {
    const { c, project } = await setupProject("Editor");
    const pageId = (await c.get(`/api/projects/${project.id}/pages`)).json.pages[0].id;
    let page = (await c.get(`/api/pages/${pageId}`)).json.page;
    const section = page.document.root.find((n: any) => n.type === "section");
    const before = JSON.stringify(page.document);
    const r1 = await c.post(`/api/pages/${pageId}/ops`, { baseVersion: page.version, ops: [
      { op: "insert", parentId: section.id, slot: "default", index: 0, node: { id: "btn00001", type: "button", v: 1, props: { label: "Go", href: "/contact" } } },
      { op: "move", nodeId: "btn00001", parentId: section.id, slot: "default", index: 2 },
      { op: "set_layout", nodeId: "btn00001", layout: { hideOn: ["mobile"] } },
    ] });
    expect(r1.status).toBe(200);
    // javascript: URLs are rejected by the field schema
    expect((await c.post(`/api/pages/${pageId}/ops`, { baseVersion: r1.json.page.version, ops: [{ op: "update_props", nodeId: "btn00001", props: { href: "javascript:alert(1)" } }] })).status).toBe(422);
    // placement rules: a heading cannot sit at the root
    expect((await c.post(`/api/pages/${pageId}/ops`, { baseVersion: r1.json.page.version, ops: [{ op: "insert", parentId: null, index: 0, node: { id: "h0000001", type: "heading", v: 1, props: { text: "x" } } }] })).status).toBe(422);
    const undo = await c.post(`/api/pages/${pageId}/ops`, { baseVersion: r1.json.page.version, ops: r1.json.inverse });
    expect(undo.status).toBe(200);
    expect(JSON.stringify(undo.json.page.document)).toBe(before);
    page = undo.json.page;
    const meta = await c.post(`/api/pages/${pageId}/ops`, { baseVersion: page.version, meta: { title: "Start", seo: { description: "Hello" } } });
    expect(meta.json.page.title).toBe("Start");
    expect((await c.post(`/api/projects/${project.id}/pages`, { path: "/About Us", title: "About" })).status).toBe(422);
    expect((await c.post(`/api/projects/${project.id}/pages`, { path: "/about", title: "About", templateId: "blank-with-heading" })).status).toBe(201);
    expect((await c.post(`/api/projects/${project.id}/pages`, { path: "/about", title: "Dup" })).status).toBe(409);
    expect((await c.get(`/api/projects/${project.id}/seo`)).json.issues).toBeInstanceOf(Array);
  });
});

describe("hosting", () => {
  it("rolls back, verifies domains, serves custom domains, and collects analytics", async () => {
    const { c, org, project } = await setupProject("Host");
    const host = `${project.website.subdomain}.sites.test`;
    const pageId = (await c.get(`/api/projects/${project.id}/pages`)).json.pages[0].id;
    const d1 = (await c.post(`/api/projects/${project.id}/deployments`, { kind: "production" })).json.deployment;
    await runUntilEmpty();
    let page = (await c.get(`/api/pages/${pageId}`)).json.page;
    const heading = page.document.root[1].slots.default[0];
    await c.post(`/api/pages/${pageId}/ops`, { baseVersion: page.version, ops: [{ op: "update_props", nodeId: heading.id, props: { text: "Version two" } }] });
    await c.post(`/api/projects/${project.id}/deployments`, { kind: "production" });
    await runUntilEmpty();
    clearSitesCache();
    expect((await sitesGet(host)).text).toContain("Version two");
    expect((await c.post(`/api/projects/${project.id}/deployments/${d1.id}/rollback`)).status).toBe(200);
    clearSitesCache();
    expect((await sitesGet(host)).text).toContain("Welcome");
    const list = (await c.get(`/api/projects/${project.id}/deployments`)).json.deployments;
    expect(list.find((d: any) => d.isLive).id).toBe(d1.id);
    expect(list[0].log.join("\n")).toContain("Rendered 1 page");

    // Custom domain requires a paid plan
    expect((await c.post(`/api/projects/${project.id}/domains`, { hostname: "www.bakery-test.com" })).status).toBe(402);
    const token = new URL((await c.post(`/api/billing/orgs/${org.id}/checkout`, { planId: "pro" })).json.url).searchParams.get("token");
    await c.post("/api/billing/webhook", { token });
    expect((await c.post(`/api/projects/${project.id}/domains`, { hostname: "x.sites.test" })).status).toBe(422);
    const dom = (await c.post(`/api/projects/${project.id}/domains`, { hostname: "https://WWW.Bakery-Test.com/" })).json.domain;
    expect(dom.hostname).toBe("www.bakery-test.com");
    const txt = dom.dns.find((r: any) => r.type === "TXT");
    expect((await sitesGet("www.bakery-test.com")).status).toBe(404);
    expect((await sitesGet("localhost", "/__zyko/tls-ask?domain=www.bakery-test.com")).status).toBe(404);
    expect((await c.post(`/api/projects/${project.id}/domains/${dom.id}/verify`)).json.domain.status).toBe("pending");
    fakeDns.set(txt.name, { txt: [txt.value] });
    expect((await c.post(`/api/projects/${project.id}/domains/${dom.id}/verify`)).json.domain.status).toBe("verified");
    clearSitesCache();
    expect((await sitesGet("www.bakery-test.com")).status).toBe(200);
    expect((await sitesGet("localhost", "/__zyko/tls-ask?domain=www.bakery-test.com")).status).toBe(200);
    expect((await sitesGet("localhost", "/__zyko/tls-ask?domain=evil.com")).status).toBe(404);

    // Analytics beacon → reporting
    for (const p of ["/", "/", "/about"]) {
      const { sites } = await import("./helpers.js");
      await sites.fetch(new Request(`http://${host}/__zyko/collect`, { method: "POST", headers: { host, "user-agent": "test" }, body: JSON.stringify({ p, r: "https://google.com/x", w: 400 }) }));
    }
    const a = (await c.get(`/api/projects/${project.id}/analytics?days=7`)).json;
    expect(a.totals.views).toBe(3);
    expect(a.totals.visitors).toBe(1);
    expect(a.topPages[0]).toEqual({ path: "/", views: 2 });
    expect(a.referrers[0].referrer).toBe("google.com");

    const notes = (await c.get("/api/notifications")).json;
    expect(notes.notifications.some((n: any) => n.kind === "deployment.production.ready")).toBe(true);
    expect(notes.notifications.some((n: any) => n.kind === "domain.verified")).toBe(true);

    // Unpublish
    await c.post(`/api/projects/${project.id}/unpublish`);
    clearSitesCache();
    expect((await sitesGet(host)).status).toBe(404);
  });
});

describe("module framework", () => {
  it("installs, configures, receives signed webhooks, handles events, upgrades and isolates data", async () => {
    const { c, project } = await setupProject("Mods");
    const catalog = (await c.get(`/api/projects/${project.id}/modules`)).json.modules;
    expect(catalog.find((m: any) => m.id === "fixture.notes").available).toBe(true);
    expect((await c.post(`/api/projects/${project.id}/modules`, { moduleId: "fixture.notes", config: { maxEntries: -1 } })).status).toBe(422);
    const inst = (await c.post(`/api/projects/${project.id}/modules`, { moduleId: "fixture.notes", config: { maxEntries: 2 } })).json;
    expect(inst.installation.config).toEqual({ label: "Notes", maxEntries: 2 });

    const send = (body: object, secret = inst.webhookSecret) => {
      const raw = JSON.stringify(body);
      return new Client().req("POST", inst.webhookUrl, undefined, { "x-zyko-signature": `sha256=${hmac(raw, secret)}`, "content-type": "application/json" }).then(() => null) as any;
    };
    const { app } = await import("./helpers.js");
    const hook = async (body: object, secret = inst.webhookSecret) => {
      const raw = JSON.stringify(body);
      return app.fetch(new Request(`http://api.test${inst.webhookUrl}`, { method: "POST", body: raw, headers: { "x-zyko-signature": `sha256=${hmac(raw, secret)}` } }));
    };
    void send;
    expect((await hook({ title: "x" }, "wrong-secret")).status).toBe(401);
    expect((await hook({ nope: 1 })).status).toBe(422);
    expect((await hook({ title: "From webhook" })).status).toBe(201);
    expect((await hook({ title: "Second" })).status).toBe(201);
    expect((await hook({ title: "Third" })).status).toBe(409); // config-enforced limit

    const recs = (await c.get(`/api/module-installations/${inst.installation.id}/records/entries`)).json.records;
    expect(recs.map((r: any) => r.data.title)).toEqual(["From webhook", "Second"]);
    expect((await c.post(`/api/module-installations/${inst.installation.id}/records/entries`, { title: "" })).status).toBe(422);
    expect((await c.post(`/api/module-installations/${inst.installation.id}/records/stats`, { publishes: 1 })).status).toBe(422); // no admin page allows it

    // Widget gating: module widgets are only valid while installed
    const pageId = (await c.get(`/api/projects/${project.id}/pages`)).json.pages[0].id;
    const page = (await c.get(`/api/pages/${pageId}`)).json.page;
    const section = page.document.root.find((n: any) => n.type === "section");
    const ins = await c.post(`/api/pages/${pageId}/ops`, { baseVersion: page.version, ops: [{ op: "insert", parentId: section.id, slot: "default", index: 0, node: { id: "badge001", type: "fixture-notes.badge", v: 1, props: { label: "N" } } }] });
    expect(ins.status).toBe(200);

    // Events: publishing increments the module's counter
    await c.post(`/api/projects/${project.id}/deployments`, { kind: "production" });
    await runUntilEmpty();
    const stats = (await c.get(`/api/module-installations/${inst.installation.id}/records/stats`)).json.records;
    expect(stats[0].data.publishes).toBe(1);

    // Another tenant cannot reach this installation
    const other = await setupProject("ModsOther");
    expect((await other.c.get(`/api/module-installations/${inst.installation.id}/records/entries`)).status).toBe(404);

    // Safe upgrade path: simulate an installation on an older version
    await db.update(schema.moduleInstallations).set({ version: "1.0.0" }).where(eq(schema.moduleInstallations.id, inst.installation.id));
    const up = await c.post(`/api/module-installations/${inst.installation.id}/upgrade`);
    expect(up.json.installation.version).toBe("1.1.0");

    // Uninstall removes data; widget now invalid in new edits
    expect((await c.del(`/api/module-installations/${inst.installation.id}`)).status).toBe(200);
    const [{ n }] = (await db.execute(`select count(*)::int as n from module_records where installation_id = '${inst.installation.id}'`)) as any;
    expect(n).toBe(0);
    const p2 = (await c.get(`/api/pages/${pageId}`)).json.page;
    expect((await c.post(`/api/pages/${pageId}/ops`, { baseVersion: p2.version, ops: [{ op: "update_props", nodeId: "badge001", props: { label: "M" } }] })).status).toBe(422);
  });

  it("stores provider credentials encrypted and never returns them", async () => {
    const { c, org } = await setupProject("Integr");
    const r = await c.post(`/api/orgs/${org.id}/integrations`, { kind: "echo", providerId: "fixture-echo", credentials: { apiKey: "secret-key-123" } });
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.json)).not.toContain("secret-key-123");
    const [row] = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.orgId, org.id));
    expect(row.credentialsEnc).not.toContain("secret-key-123");
    expect(JSON.stringify((await c.get(`/api/orgs/${org.id}/integrations`)).json)).not.toContain("secret");
  });
});

describe("AI controls", () => {
  it("rejects invalid tool input, unknown tools, and respects rejection", async () => {
    const { c, project } = await setupProject("AiCtl");
    const conv = (await c.post(`/api/projects/${project.id}/conversations`, {})).json.conversation;
    const r1 = await c.post(`/api/conversations/${conv.id}/messages`, { text: "/tool apply_page_changes {\"pageId\": 5}" });
    expect(r1.text).toContain("Invalid tool input");
    const r2 = await c.post(`/api/conversations/${conv.id}/messages`, { text: "/tool drop_database {}" });
    expect(r2.text).toContain("Unknown tool");
    const r3 = await c.post(`/api/conversations/${conv.id}/messages`, { text: "/tool request_design_generation {\"stage\":\"generate\"}" });
    const taskId = JSON.parse(r3.text.split("\n").find((l) => l.startsWith("data:") && l.includes("approval_required"))!.slice(5)).taskId;
    const decided = await c.post(`/api/ai-tasks/${taskId}/approve`);
    expect(decided.json.task.status).toBe("failed");
    expect(decided.json.task.error).toContain("No design-generation engine is configured");
    const r4 = await c.post(`/api/conversations/${conv.id}/messages`, { text: "/tool publish_site {}" });
    const t2 = JSON.parse(r4.text.split("\n").find((l) => l.startsWith("data:") && l.includes("approval_required"))!.slice(5)).taskId;
    expect((await c.post(`/api/ai-tasks/${t2}/reject`)).json.task.status).toBe("rejected");
    const usage = (await c.get(`/api/orgs/${project.orgId}`)).json.usage;
    expect(usage.aiMessages).toBe(4);
  });
});

describe("billing signatures", () => {
  it("verifies Stripe-style webhook signatures", () => {
    const body = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${hmac(`${t}.${body}`, "whsec_test")}`;
    expect(verifyStripeSignature(body, sig, "whsec_test")).toBe(true);
    expect(verifyStripeSignature(body + " ", sig, "whsec_test")).toBe(false);
    expect(verifyStripeSignature(body, `t=${t - 1000},v1=${hmac(`${t - 1000}.${body}`, "whsec_test")}`, "whsec_test")).toBe(false);
  });
});
