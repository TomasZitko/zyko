/**
 * Milestone-1 acceptance scenario at the API level (the same flow is exercised through the
 * browser in e2e/foundation.spec.ts).
 */
import { describe, expect, it } from "vitest";
import { Client, PNG_1x1, runUntilEmpty, signup, sitesGet, clearSitesCache } from "./helpers.js";

function parseSSE(text: string) {
  return text.split("\n\n").filter(Boolean).map((chunk) => {
    const ev = chunk.match(/^event: (.*)$/m)?.[1];
    const data = chunk.match(/^data: (.*)$/m)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

describe("milestone 1: connected foundation", () => {
  it("runs the full scenario end to end", async () => {
    // 1. register
    const { c: alice } = await signup("Alice");
    expect((await alice.get("/api/auth/me")).json.user.name).toBe("Alice");

    // 2. organization + project
    const org = (await alice.post("/api/orgs", { name: "Alice Studio", kind: "personal" })).json.org;
    const created = await alice.post(`/api/orgs/${org.id}/projects`, { name: "Corner Bakery" });
    expect(created.status).toBe(201);
    const project = created.json.project;
    expect(project.website.subdomain).toMatch(/^corner-bakery-/);

    // 3. project information
    const brief = { businessName: "Corner Bakery", description: "Sourdough and pastries in Brno", services: ["bread", "cakes"] };
    expect((await alice.patch(`/api/projects/${project.id}`, { brief })).status).toBe(200);

    // 4. AI conversation with stored + retrieved project context
    const conv = (await alice.post(`/api/projects/${project.id}/conversations`, { title: "Kickoff" })).json.conversation;
    const turn1 = await alice.post(`/api/conversations/${conv.id}/messages`, { text: "What do you know about this project?" });
    expect(turn1.status).toBe(200);
    const ev1 = parseSSE(turn1.text);
    const reply = ev1.filter((e) => e.event === "text").map((e) => e.data.delta).join("");
    expect(reply).toContain("Corner Bakery");
    expect(reply).toContain("Sourdough and pastries in Brno");
    expect(ev1.at(-1)?.event).toBe("done");
    const reloaded = (await alice.get(`/api/conversations/${conv.id}`)).json;
    expect(reloaded.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    const turn2 = parseSSE((await alice.post(`/api/conversations/${conv.id}/messages`, { text: "second" })).text);
    expect(turn2.filter((e) => e.event === "text").map((e) => e.data.delta).join("")).toContain("Earlier user messages in this conversation: 1");

    // 5. asset upload
    const fd = new FormData();
    fd.append("file", new Blob([PNG_1x1], { type: "image/png" }), "logo.png");
    fd.append("alt", "Logo");
    const up = await alice.req("POST", `/api/projects/${project.id}/assets`, fd);
    expect(up.status).toBe(201);
    expect(up.json.asset).toMatchObject({ mime: "image/png", width: 1, height: 1, alt: "Logo" });
    const assetId = up.json.asset.id;

    // 6. structured website specification
    const pages = (await alice.get(`/api/projects/${project.id}/pages`)).json.pages;
    expect(pages).toHaveLength(1);
    const home = (await alice.get(`/api/pages/${pages[0].id}`)).json.page;
    expect(home.document.schemaVersion).toBe(1);

    // 7-8. registered test component is available to the editor
    const ds = (await alice.get(`/api/projects/${project.id}/design-system`)).json;
    expect(ds.designSystem.status).toBe("temporary-fixture");
    expect(ds.components.map((x: any) => x.type)).toContain("heading");

    // 9-10. edit properties (insert image + change heading) and persist
    const section = home.document.root.find((n: any) => n.type === "section");
    const heading = section.slots.default.find((n: any) => n.type === "heading");
    const ops = [
      { op: "update_props", nodeId: heading.id, props: { text: "Fresh bread daily" } },
      { op: "insert", parentId: section.id, slot: "default", index: 2, node: { id: "img00001", type: "image", v: 1, props: { asset: assetId, alt: "Logo" } } },
    ];
    const saved = await alice.post(`/api/pages/${home.id}/ops`, { baseVersion: home.version, ops });
    expect(saved.status).toBe(200);
    expect(saved.json.page.version).toBe(home.version + 1);
    expect(saved.json.inverse).toHaveLength(2);
    const stale = await alice.post(`/api/pages/${home.id}/ops`, { baseVersion: home.version, ops: [ops[0]] });
    expect(stale.status).toBe(409);
    const invalid = await alice.post(`/api/pages/${home.id}/ops`, { baseVersion: home.version + 1, ops: [{ op: "update_props", nodeId: heading.id, props: { level: "h9" } }] });
    expect(invalid.status).toBe(422);

    // 11. AI tool safely updates structured content (validated, creates an AI revision)
    const v = saved.json.page.version;
    const toolCall = `/tool apply_page_changes ${JSON.stringify({ pageId: home.id, baseVersion: v, ops: [{ op: "update_props", nodeId: heading.id, props: { text: "Baked by AI" } }] })}`;
    const t3 = parseSSE((await alice.post(`/api/conversations/${conv.id}/messages`, { text: toolCall })).text);
    expect(t3.find((e) => e.event === "tool_result")?.data.ok).toBe(true);
    const afterAi = (await alice.get(`/api/pages/${home.id}`)).json.page;
    expect(afterAi.version).toBe(v + 1);
    const badCall = `/tool apply_page_changes ${JSON.stringify({ pageId: home.id, baseVersion: afterAi.version, ops: [{ op: "update_props", nodeId: heading.id, props: { level: "<script>" } }] })}`;
    const t4 = parseSSE((await alice.post(`/api/conversations/${conv.id}/messages`, { text: badCall })).text);
    expect(t4.find((e) => e.event === "tool_result")?.data.ok).toBe(false);
    expect((await alice.get(`/api/pages/${home.id}`)).json.page.version).toBe(afterAi.version);

    // 12. revert to the user's revision
    const revs = (await alice.get(`/api/pages/${home.id}/revisions`)).json.revisions;
    expect(revs[0].source).toBe("ai");
    const userRev = revs.find((r: any) => r.version === v);
    expect((await alice.post(`/api/pages/${home.id}/revisions/${userRev.id}/restore`)).status).toBe(200);
    const restored = (await alice.get(`/api/pages/${home.id}`)).json.page;
    expect(JSON.stringify(restored.document)).toContain("Fresh bread daily");

    // 13. preview
    const pv = await alice.post(`/api/projects/${project.id}/deployments`, { kind: "preview" });
    expect(pv.status).toBe(202);
    await runUntilEmpty();
    const pvd = (await alice.get(`/api/projects/${project.id}/deployments/${pv.json.deployment.id}`)).json.deployment;
    expect(pvd.status).toBe("ready");
    const previewHost = new URL(pvd.url).host;
    const pvPage = await sitesGet(previewHost);
    expect(pvPage.status).toBe(200);
    expect(pvPage.text).toContain("Fresh bread daily");
    expect(pvPage.headers.get("x-robots-tag")).toContain("noindex");

    // 14-15. publish (via AI approval flow) and fetch at the configured address
    const pub = parseSSE((await alice.post(`/api/conversations/${conv.id}/messages`, { text: "/tool publish_site {}" })).text);
    const approval = pub.find((e) => e.event === "approval_required");
    expect(approval).toBeTruthy();
    const host = `${project.website.subdomain}.sites.test`;
    expect((await sitesGet(host)).status).toBe(404); // nothing published before approval
    const decided = await alice.post(`/api/ai-tasks/${approval!.data.taskId}/approve`);
    expect(decided.json.task.status).toBe("succeeded");
    expect((await alice.post(`/api/ai-tasks/${approval!.data.taskId}/approve`)).status).toBe(409);
    await runUntilEmpty();
    clearSitesCache();
    const live = await sitesGet(host);
    expect(live.status).toBe(200);
    expect(live.text).toContain("Fresh bread daily");
    expect(live.text).toMatch(/<img class="fx-img" src="\/_assets\/[0-9a-f]{16}\.png"/);
    expect(live.headers.get("content-security-policy")).toContain("default-src 'self'");
    const img = live.text.match(/src="(\/_assets\/[^"]+)"/)![1];
    const imgRes = await sitesGet(host, img);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get("cache-control")).toContain("immutable");
    expect((await sitesGet(host, "/sitemap.xml")).text).toContain(`http://${host}/`);
    expect((await sitesGet(host, "/robots.txt")).text).toContain("Sitemap:");
    expect((await sitesGet(host, "/nope")).status).toBe(404);

    // 16. back to the dashboard; editing continues on the draft without affecting live
    const dash = (await alice.get(`/api/orgs/${org.id}/projects`)).json.projects;
    expect(dash[0].website.liveDeploymentId).toBeTruthy();
    const cur = (await alice.get(`/api/pages/${home.id}`)).json.page;
    expect((await alice.post(`/api/pages/${home.id}/ops`, { baseVersion: cur.version, ops: [{ op: "update_props", nodeId: heading.id, props: { text: "Draft only" } }] })).status).toBe(200);
    clearSitesCache();
    expect((await sitesGet(host)).text).toContain("Fresh bread daily");

    // 17. another user cannot access the project
    const { c: mallory } = await signup("Mallory");
    for (const path of [`/api/projects/${project.id}`, `/api/pages/${home.id}`, `/api/conversations/${conv.id}`, `/api/projects/${project.id}/assets`, `/api/orgs/${org.id}`]) {
      expect((await mallory.get(path)).status, path).toBe(404);
    }
    expect((await mallory.post(`/api/pages/${home.id}/ops`, { baseVersion: cur.version + 1, ops: [] })).status).toBe(404);
    expect((await mallory.req("GET", `/api/assets/${assetId}/raw`)).status).toBe(404);
    expect((await new Client().req("GET", `/api/assets/${assetId}/raw?exp=9999999999&sig=forged`)).status).toBe(401);
    const anon = new Client();
    expect((await anon.get(`/api/projects/${project.id}`)).status).toBe(401);
  });
});
